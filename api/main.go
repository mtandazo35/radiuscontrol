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
	senuelo   string
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
	}

	if err := app.migrar(ctx); err != nil {
		log.Fatalf("migraciones: %v", err)
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

	go app.bucleRegistro(ctx)

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
// nueva, sin bloqueo, sin doble factor y con las sesiones cerradas. Sirve para
// volver a entrar cuando se ha perdido el acceso. Solo puede ejecutarla quien
// ya tiene acceso de administrador al servidor.
func (a *App) comando(ctx context.Context, args []string) int {
	if len(args) != 2 || args[0] != "operador-emergencia" {
		fmt.Fprintln(os.Stderr, "uso: radiuscontrol operador-emergencia <usuario>")
		return 2
	}
	usuario := args[1]
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
	m.HandleFunc("POST /api/routers/{id}/secreto", cambia(a.rotarSecreto))

	m.HandleFunc("GET /api/empresas", a.privado(a.listarEmpresas))
	m.HandleFunc("GET /api/autenticaciones", a.privado(a.listarAutenticaciones))

	m.HandleFunc("GET /api/usuarios", a.privado(a.listarUsuarios))
	m.HandleFunc("POST /api/usuarios", cambia(a.crearUsuario))
	m.HandleFunc("PUT /api/usuarios/{id}", cambia(a.editarUsuario))
	m.HandleFunc("DELETE /api/usuarios/{id}", cambia(a.borrarUsuario))
	m.HandleFunc("POST /api/usuarios/{id}/clave", cambia(a.cambiarClaveUsuario))

	m.HandleFunc("GET /api/estado", a.privado(a.verEstado))
	m.HandleFunc("POST /api/aplicar", a.admin(a.aplicar))

	// Acceso y seguridad del panel.
	m.HandleFunc("POST /api/cuenta/clave", a.privado(a.cambiarMiClave))
	m.HandleFunc("POST /api/cuenta/totp", a.privado(a.iniciarTOTP))
	m.HandleFunc("POST /api/cuenta/totp/confirmar", a.privado(a.confirmarTOTP))
	m.HandleFunc("POST /api/cuenta/totp/desactivar", a.privado(a.desactivarTOTP))
	m.HandleFunc("GET /api/sesiones", a.privado(a.listarSesiones))
	m.HandleFunc("DELETE /api/sesiones/{id}", a.privado(a.revocarSesion))
	m.HandleFunc("GET /api/operadores", a.admin(a.listarOperadores))
	m.HandleFunc("POST /api/operadores", a.admin(a.crearOperador))
	m.HandleFunc("PUT /api/operadores/{id}", a.admin(a.editarOperador))
	m.HandleFunc("DELETE /api/operadores/{id}", a.admin(a.borrarOperador))
	m.HandleFunc("POST /api/operadores/{id}/clave", a.admin(a.restablecerOperador))
	m.HandleFunc("POST /api/operadores/{id}/desbloquear", a.admin(a.desbloquearOperador))
	m.HandleFunc("DELETE /api/operadores/{id}/totp", a.admin(a.quitarTOTPOperador))
	m.HandleFunc("GET /api/auditoria", a.admin(a.listarAuditoria))
	return m
}
