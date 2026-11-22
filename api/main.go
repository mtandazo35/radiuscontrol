package main

import (
	"context"
	"embed"
	"fmt"
	"log"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migraciones/*.sql
var migraciones embed.FS

type Config struct {
	DirCompilado   string
	DirRaddb       string
	DirRegistro    string
	EsperaAplicar  time.Duration
	ServidorRadius string
}

type App struct {
	db        *pgxpool.Pool
	cifra     *Cifrador
	cfg       Config
	aplicarMu sync.Mutex
	autoMu    sync.Mutex
	autoTimer *time.Timer
	purgaMu   sync.Mutex
	accesosMu sync.Mutex
	// Un archivo de migración a la vez (ver migracion.go).
	migracionMu sync.Mutex
	// Solo lo usa el bucle de limpieza: evita repetir el mismo aviso en el log.
	avisoDiscoAjeno bool
	senuelo         string
	// Tope de verificaciones de contraseña simultáneas (ver verificarLimitado).
	argon chan struct{}
	// Fallos al repetir la contraseña con la sesión abierta (ver limite.go).
	claves limiteClave
}

func env(clave, defecto string) string {
	if v := os.Getenv(clave); v != "" {
		return v
	}
	return defecto
}

// esperaAplicar es el tiempo que se deja pasar tras un cambio antes de
// aplicarlo solo. Con APLICAR_AUTOMATICO=no los cambios se aplican a mano.
func esperaAplicar() time.Duration {
	if env("APLICAR_AUTOMATICO", "si") == "no" {
		return 0
	}
	return 2 * time.Second
}

func leerArchivo(ruta string) (string, error) {
	b, err := os.ReadFile(ruta)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(b)), nil
}

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)
	ctx := context.Background()

	// Descifrar un archivo de migración no necesita la base: instalar.sh lo
	// usa antes de que exista, en una instalación nueva.
	if len(os.Args) > 1 && os.Args[1] == "descifrar-migracion" {
		os.Exit(comandoDescifrarMigracion(os.Args[2:]))
	}

	claveBD, err := leerArchivo(env("DB_CLAVE_ARCHIVO", "/run/secrets/postgres_clave"))
	if err != nil {
		log.Fatalf("no se pudo leer la clave de la base: %v", err)
	}
	pcfg, err := pgxpool.ParseConfig(fmt.Sprintf("host=%s port=%s dbname=%s user=%s sslmode=disable",
		env("DB_HOST", "postgres"), env("DB_PUERTO", "5432"),
		env("DB_NOMBRE", "radiuscontrol"), env("DB_USUARIO", "radiuscontrol")))
	if err != nil {
		log.Fatal(err)
	}
	pcfg.ConnConfig.Password = claveBD
	pcfg.MaxConns = 8
	pool, err := pgxpool.NewWithConfig(ctx, pcfg)
	if err != nil {
		log.Fatal(err)
	}
	for i := 0; ; i++ {
		if err = pool.Ping(ctx); err == nil {
			break
		}
		if i >= 30 {
			log.Fatalf("la base de datos no responde: %v", err)
		}
		time.Sleep(time.Second)
	}

	claveMaestra, err := leerArchivo(env("CLAVE_MAESTRA_ARCHIVO", "/run/secrets/clave_maestra"))
	if err != nil {
		log.Fatalf("no se pudo leer la clave maestra: %v", err)
	}
	cifra, err := nuevoCifrador(claveMaestra)
	if err != nil {
		log.Fatal(err)
	}

	senuelo, err := hashArgon2(aleatorioHex(16))
	if err != nil {
		log.Fatal(err)
	}
	app := &App{
		db:    pool,
		cifra: cifra,
		cfg: Config{
			DirCompilado:   env("DIR_COMPILADO", "/compilado"),
			DirRaddb:       env("DIR_RADDB", "/etc/freeradius"),
			DirRegistro:    env("DIR_REGISTRO", "/registro"),
			EsperaAplicar:  esperaAplicar(),
			ServidorRadius: env("SERVIDOR_RADIUS", "192.0.2.1"),
		},
		senuelo: senuelo,
		argon:   make(chan struct{}, 4),
	}

	if err := app.migrar(ctx); err != nil {
		log.Fatalf("migraciones: %v", err)
	}
	if err := app.convertirHuellas(ctx); err != nil {
		log.Fatalf("huellas: %v", err)
	}
	// Con argumentos, el binario ejecuta una orden de consola y termina.
	if len(os.Args) > 1 {
		os.Exit(app.comando(ctx, os.Args[1:]))
	}
	if err := app.crearOperadorInicial(ctx); err != nil {
		log.Fatalf("operador inicial: %v", err)
	}
	if err := app.restaurarCompilado(ctx); err != nil {
		log.Printf("aviso: no se pudo restaurar la configuración activa: %v", err)
	}
	// La lista de accesos al servidor se deja siempre escrita, aunque esté
	// vacía: sin ella, el agente de firewall no toca ninguna regla.
	if err := app.escribirAccesos(ctx); err != nil {
		log.Printf("aviso: no se pudo escribir la lista de accesos al servidor: %v", err)
	}

	go app.bucleRegistro(ctx)
	go app.bucleDescartes(ctx)
	go app.bucleSesiones(ctx)
	go app.bucleLimpieza(ctx)
	// Al arrancar se aplica lo que haya pendiente. Tras una actualización, el
	// formato de la configuración compilada puede haber cambiado.
	app.programarAplicar("sistema")

	srv := &http.Server{
		Addr:              ":8080",
		Handler:           app.rutas(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      90 * time.Second,
	}
	log.Printf("API de RadiusControl escuchando en %s", srv.Addr)
	log.Fatal(srv.ListenAndServe())
}

func (a *App) migrar(ctx context.Context) error {
	if _, err := a.db.Exec(ctx, `CREATE TABLE IF NOT EXISTS migraciones_aplicadas (
		nombre text PRIMARY KEY, fecha timestamptz NOT NULL DEFAULT now())`); err != nil {
		return err
	}
	entradas, err := migraciones.ReadDir("migraciones")
	if err != nil {
		return err
	}
	nombres := make([]string, 0, len(entradas))
	for _, e := range entradas {
		nombres = append(nombres, e.Name())
	}
	sort.Strings(nombres)
	for _, nombre := range nombres {
		var existe bool
		if err := a.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM migraciones_aplicadas WHERE nombre = $1)`,
			nombre).Scan(&existe); err != nil {
			return err
		}
		if existe {
			continue
		}
		sql, err := migraciones.ReadFile("migraciones/" + nombre)
		if err != nil {
			return err
		}
		err = pgx.BeginFunc(ctx, a.db, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, string(sql)); err != nil {
				return err
			}
			_, err := tx.Exec(ctx, `INSERT INTO migraciones_aplicadas (nombre) VALUES ($1)`, nombre)
			return err
		})
		if err != nil {
			return fmt.Errorf("%s: %w", nombre, err)
		}
		log.Printf("migración aplicada: %s", nombre)
	}
	return nil
}

func (a *App) crearOperadorInicial(ctx context.Context) error {
	var n int
	if err := a.db.QueryRow(ctx, `SELECT count(*) FROM operadores`).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	clave, err := leerArchivo(env("ADMIN_CLAVE_ARCHIVO", "/run/secrets/admin_clave"))
	if err != nil {
		return err
	}
	if len(clave) < 12 {
		// El instalador vacía el archivo tras el primer arranque para no dejar la
		// contraseña inicial en disco.
		log.Printf("aviso: no hay operadores ni contraseña inicial; crea uno con «radiuscontrol operador-emergencia <usuario>»")
		return nil
	}
	hash, err := hashArgon2(clave)
	if err != nil {
		return err
	}
	usuario := env("ADMIN_USUARIO", "admin")
	_, err = a.db.Exec(ctx, `INSERT INTO operadores (usuario, clave_hash) VALUES ($1, $2)`, usuario, hash)
	if err == nil {
		log.Printf("operador inicial creado: %s", usuario)
	}
	return err
}

// comando atiende las órdenes de consola. Devuelve el código de salida.
//
//	radiuscontrol operador-emergencia <usuario>
//
// Crea esa cuenta como administrador, o la recupera si ya existe: contraseña
// nueva, sin bloqueo, sin doble factor y con las sesiones cerradas.
//
//	radiuscontrol desbloquear-ip <dirección | todas>
//
// Levanta el bloqueo de inicio de sesión de una dirección, o de todas.
//
// Sirven para volver a entrar cuando se ha perdido el acceso. Solo puede
// ejecutarlas quien ya tiene acceso de administrador al servidor.
func (a *App) comando(ctx context.Context, args []string) int {
	uso := func() int {
		fmt.Fprintln(os.Stderr, "uso: radiuscontrol operador-emergencia <usuario>")
		fmt.Fprintln(os.Stderr, "     radiuscontrol desbloquear-ip <dirección | todas>")
		return 2
	}
	if len(args) != 2 {
		return uso()
	}
	switch args[0] {
	case "operador-emergencia":
		return a.comandoOperador(ctx, args[1])
	case "desbloquear-ip":
		return a.comandoDesbloquear(ctx, args[1])
	}
	return uso()
}

func (a *App) comandoDesbloquear(ctx context.Context, ip string) int {
	if ip == "todas" {
		if _, err := a.db.Exec(ctx, `DELETE FROM bloqueos_ip; DELETE FROM intentos_ip`); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		a.auditar(ctx, "consola del servidor", "local", "ip.desbloqueada", "todas", nil)
		fmt.Println("todas las direcciones desbloqueadas")
		return 0
	}
	hecho, err := a.quitarBloqueo(ctx, ip)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if hecho {
		a.auditar(ctx, "consola del servidor", "local", "ip.desbloqueada", ip, nil)
		fmt.Println("dirección desbloqueada")
	} else {
		fmt.Println("esa dirección no estaba bloqueada")
	}
	return 0
}

func (a *App) comandoOperador(ctx context.Context, usuario string) int {
	if !reUsuario.MatchString(usuario) {
		fmt.Fprintln(os.Stderr, "nombre de usuario no válido")
		return 2
	}
	clave := aleatorioHex(12)
	hash, err := hashArgon2(clave)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	err = pgx.BeginFunc(ctx, a.db, func(tx pgx.Tx) error {
		var id int64
		if err := tx.QueryRow(ctx, `INSERT INTO operadores (usuario, clave_hash, rol) VALUES ($1, $2, $3)
			ON CONFLICT (usuario) DO UPDATE SET clave_hash = EXCLUDED.clave_hash, rol = EXCLUDED.rol,
				activo = true, intentos_fallidos = 0, bloqueado_hasta = NULL, clave_cambiada = now(),
				totp_cifrado = NULL, totp_pendiente_cifrado = NULL, totp_ultimo = 0
			RETURNING id`, usuario, hash, rolAdmin).Scan(&id); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `DELETE FROM sesiones WHERE operador_id = $1`, id)
		return err
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	a.auditar(ctx, "consola del servidor", "local", "operador.acceso_de_emergencia", usuario, nil)
	fmt.Println(clave)
	return 0
}

func (a *App) rutas() http.Handler {
	m := http.NewServeMux()
	cambia := func(h manejador) http.HandlerFunc {
		return a.admin(func(w http.ResponseWriter, r *http.Request, op *Operador) error {
			err := h(w, r, op)
			if err == nil {
				a.programarAplicar(op.Usuario)
			}
			return err
		})
	}
	m.HandleFunc("POST /api/sesion", a.publico(a.iniciarSesion))
	m.HandleFunc("GET /api/sesion", a.privado(a.verSesion))
	m.HandleFunc("DELETE /api/sesion", a.privado(a.cerrarSesion))

	m.HandleFunc("GET /api/routers", a.privado(a.listarRouters))
	m.HandleFunc("POST /api/routers", cambia(a.crearRouter))
	m.HandleFunc("PUT /api/routers/{id}", cambia(a.editarRouter))
	m.HandleFunc("DELETE /api/routers/{id}", cambia(a.borrarRouter))
	m.HandleFunc("GET /api/routers/{id}/secreto", a.admin(a.verSecreto))
	m.HandleFunc("POST /api/routers/{id}/secreto", cambia(a.rotarSecreto))
	m.HandleFunc("POST /api/accesos/masivo", cambia(a.cambioMasivo))

	m.HandleFunc("GET /api/empresas", a.privado(a.listarEmpresas))
	m.HandleFunc("GET /api/origenes", a.privado(a.listarOrigenes))
	m.HandleFunc("POST /api/origenes", a.admin(a.guardarOrigen))
	m.HandleFunc("DELETE /api/origenes/{id}", a.admin(a.borrarOrigen))
	m.HandleFunc("GET /api/autenticaciones", a.privado(a.listarAutenticaciones))
	m.HandleFunc("GET /api/descartes", a.privado(a.listarDescartes))

	m.HandleFunc("GET /api/usuarios", a.privado(a.listarUsuarios))
	m.HandleFunc("POST /api/usuarios", cambia(a.crearUsuario))
	m.HandleFunc("PUT /api/usuarios/{id}", cambia(a.editarUsuario))
	m.HandleFunc("DELETE /api/usuarios/{id}", cambia(a.borrarUsuario))
	m.HandleFunc("GET /api/usuarios/{id}/clave", a.admin(a.verClaveUsuario))
	m.HandleFunc("POST /api/usuarios/{id}/clave", cambia(a.cambiarClaveUsuario))

	m.HandleFunc("GET /api/estado", a.privado(a.verEstado))
	m.HandleFunc("GET /api/resumen", a.privado(a.verResumen))
	m.HandleFunc("POST /api/aplicar", a.admin(a.aplicar))

	// Acceso y seguridad del panel.
	m.HandleFunc("POST /api/cuenta/clave", a.privado(a.cambiarMiClave))
	m.HandleFunc("POST /api/cuenta/totp", a.privado(a.iniciarTOTP))
	m.HandleFunc("POST /api/cuenta/totp/confirmar", a.privado(a.confirmarTOTP))
	m.HandleFunc("POST /api/cuenta/totp/desactivar", a.privado(a.desactivarTOTP))
	m.HandleFunc("GET /api/sesiones", a.privado(a.listarSesiones))
	m.HandleFunc("DELETE /api/sesiones/{id}", a.privado(a.revocarSesion))
	m.HandleFunc("DELETE /api/sesiones", a.privado(a.cerrarOtrasSesiones))
	m.HandleFunc("GET /api/operadores", a.admin(a.listarOperadores))
	m.HandleFunc("POST /api/operadores", a.admin(a.crearOperador))
	m.HandleFunc("PUT /api/operadores/{id}", a.admin(a.editarOperador))
	m.HandleFunc("DELETE /api/operadores/{id}", a.admin(a.borrarOperador))
	m.HandleFunc("POST /api/operadores/{id}/clave", a.admin(a.restablecerOperador))
	m.HandleFunc("POST /api/operadores/{id}/desbloquear", a.admin(a.desbloquearOperador))
	m.HandleFunc("DELETE /api/operadores/{id}/totp", a.admin(a.quitarTOTPOperador))
	m.HandleFunc("GET /api/auditoria", a.admin(a.listarAuditoria))
	m.HandleFunc("GET /api/actualizacion", a.admin(a.verActualizacion))
	m.HandleFunc("POST /api/actualizacion/buscar", a.admin(a.buscarActualizacion))
	m.HandleFunc("POST /api/actualizacion/aplicar", a.admin(a.pedirActualizacion))
	m.HandleFunc("GET /api/bloqueos", a.admin(a.listarBloqueos))
	m.HandleFunc("POST /api/bloqueos/desbloquear", a.admin(a.desbloquearIP))

	// Purga de registros: inicios de sesión y registro de actividad.
	m.HandleFunc("GET /api/purga", a.admin(a.verPurga))
	m.HandleFunc("PUT /api/purga", a.admin(a.guardarPurga))
	m.HandleFunc("POST /api/purga/ejecutar", a.admin(a.ejecutarPurgaManual))
	m.HandleFunc("POST /api/purga/vaciar", a.admin(a.vaciarRegistros))
	m.HandleFunc("POST /api/migracion/exportar", a.admin(a.exportarMigracion))

	// Accesos al servidor: quién llega al panel (443/tcp) y al SSH.
	m.HandleFunc("GET /api/servidor/accesos", a.admin(a.verAccesosServidor))
	m.HandleFunc("POST /api/servidor/accesos", a.admin(a.crearAccesoServidor))
	m.HandleFunc("DELETE /api/servidor/accesos/{id}", a.admin(a.quitarAccesoServidor))
	return m
}
