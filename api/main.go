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
	ServidorRadius string
}

type App struct {
	db        *pgxpool.Pool
	cifra     *Cifrador
	cfg       Config
	aplicarMu sync.Mutex
	senuelo   string
}

func env(clave, defecto string) string {
	if v := os.Getenv(clave); v != "" {
		return v
	}
	return defecto
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
			ServidorRadius: env("SERVIDOR_RADIUS", "192.0.2.1"),
		},
		senuelo: senuelo,
	}

	if err := app.migrar(ctx); err != nil {
		log.Fatalf("migraciones: %v", err)
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
		return fmt.Errorf("la clave inicial del operador debe tener al menos 12 caracteres")
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

func (a *App) rutas() http.Handler {
	m := http.NewServeMux()
	m.HandleFunc("POST /api/sesion", a.publico(a.iniciarSesion))
	m.HandleFunc("GET /api/sesion", a.privado(a.verSesion))
	m.HandleFunc("DELETE /api/sesion", a.privado(a.cerrarSesion))

	m.HandleFunc("GET /api/routers", a.privado(a.listarRouters))
	m.HandleFunc("POST /api/routers", a.privado(a.crearRouter))
	m.HandleFunc("PUT /api/routers/{id}", a.privado(a.editarRouter))
	m.HandleFunc("DELETE /api/routers/{id}", a.privado(a.borrarRouter))
	m.HandleFunc("POST /api/routers/{id}/secreto", a.privado(a.rotarSecreto))

	m.HandleFunc("GET /api/empresas", a.privado(a.listarEmpresas))
	m.HandleFunc("GET /api/autenticaciones", a.privado(a.listarAutenticaciones))

	m.HandleFunc("GET /api/usuarios", a.privado(a.listarUsuarios))
	m.HandleFunc("POST /api/usuarios", a.privado(a.crearUsuario))
	m.HandleFunc("PUT /api/usuarios/{id}", a.privado(a.editarUsuario))
	m.HandleFunc("DELETE /api/usuarios/{id}", a.privado(a.borrarUsuario))
	m.HandleFunc("POST /api/usuarios/{id}/clave", a.privado(a.cambiarClaveUsuario))

	m.HandleFunc("GET /api/estado", a.privado(a.verEstado))
	m.HandleFunc("POST /api/aplicar", a.privado(a.aplicar))
	m.HandleFunc("GET /api/versiones", a.privado(a.listarVersiones))
	m.HandleFunc("POST /api/versiones/{id}/activar", a.privado(a.activarVersion))
	return m
}
