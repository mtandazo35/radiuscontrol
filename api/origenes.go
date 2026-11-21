package main

import (
	"errors"
	"net/http"
	"net/netip"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Orígenes con nombre: una descripción para una dirección o una red desde la
// que entran a los routers (un servidor de respaldos, la oficina, un sistema
// de monitoreo). Solo sirve para leer mejor las autenticaciones: no cambia
// quién puede entrar ni la configuración de FreeRADIUS.

type Origen struct {
	ID       int64     `json:"id"`
	Red      string    `json:"red"`
	Nombre   string    `json:"nombre"`
	Operador string    `json:"operador"`
	Creado   time.Time `json:"creado"`
}

type origenEntrada struct {
	Red    string `json:"red"`
	Nombre string `json:"nombre"`
}

// normalizarOrigen acepta una dirección suelta o una red y devuelve la red en
// su forma canónica (una dirección suelta es una red de un solo equipo).
func normalizarOrigen(texto string) (string, error) {
	texto = strings.TrimSpace(texto)
	if dir, err := netip.ParseAddr(texto); err == nil {
		return netip.PrefixFrom(dir, dir.BitLen()).String(), nil
	}
	red, err := netip.ParsePrefix(texto)
	if err != nil {
		return "", malo("Escribe una dirección IP (192.0.2.10) o una red (192.0.2.0/24).")
	}
	return red.Masked().String(), nil
}

func validarNombreOrigen(nombre string) (string, error) {
	nombre = strings.TrimSpace(nombre)
	if nombre == "" || len(nombre) > 60 {
		return "", malo("La descripción debe tener entre 1 y 60 caracteres.")
	}
	for _, c := range nombre {
		if c < 0x20 || c == 0x7f {
			return "", malo("La descripción no admite saltos de línea ni caracteres de control.")
		}
	}
	return nombre, nil
}

func (a *App) listarOrigenes(w http.ResponseWriter, r *http.Request, _ *Operador) error {
	filas, err := a.db.Query(r.Context(), `SELECT id, host(red) || CASE WHEN masklen(red) = CASE family(red) WHEN 4 THEN 32 ELSE 128 END
		THEN '' ELSE '/' || masklen(red) END, nombre, operador, creado FROM origenes ORDER BY red`)
	if err != nil {
		return err
	}
	defer filas.Close()
	lista := []Origen{}
	for filas.Next() {
		var o Origen
		if err := filas.Scan(&o.ID, &o.Red, &o.Nombre, &o.Operador, &o.Creado); err != nil {
			return err
		}
		lista = append(lista, o)
	}
	if err := filas.Err(); err != nil {
		return err
	}
	escribirJSON(w, http.StatusOK, lista)
	return nil
}

// guardarOrigen da nombre a una dirección o red. Si ya tenía uno, lo cambia:
// así se puede nombrar una dirección con un clic desde Autenticaciones.
func (a *App) guardarOrigen(w http.ResponseWriter, r *http.Request, op *Operador) error {
	var in origenEntrada
	if err := leerJSON(w, r, &in); err != nil {
		return err
	}
	red, err := normalizarOrigen(in.Red)
	if err != nil {
		return err
	}
	nombre, err := validarNombreOrigen(in.Nombre)
	if err != nil {
		return err
	}
	ctx := r.Context()
	var id int64
	if err := a.db.QueryRow(ctx, `INSERT INTO origenes (red, nombre, operador) VALUES ($1::inet, $2, $3)
		ON CONFLICT (red) DO UPDATE SET nombre = EXCLUDED.nombre, operador = EXCLUDED.operador, creado = now()
		RETURNING id`, red, nombre, op.Usuario).Scan(&id); err != nil {
		return err
	}
	a.auditar(ctx, op.Usuario, ipCliente(r), "origen.guardado", red, map[string]any{"nombre": nombre})
	escribirJSON(w, http.StatusOK, map[string]any{"id": id, "red": red, "nombre": nombre})
	return nil
}

func (a *App) borrarOrigen(w http.ResponseWriter, r *http.Request, op *Operador) error {
	id, err := idRuta(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	var red, nombre string
	err = a.db.QueryRow(ctx, `DELETE FROM origenes WHERE id = $1 RETURNING red::text, nombre`, id).Scan(&red, &nombre)
	if errors.Is(err, pgx.ErrNoRows) {
		return noEncontrado()
	}
	if err != nil {
		return err
	}
	a.auditar(ctx, op.Usuario, ipCliente(r), "origen.borrado", red, map[string]any{"nombre": nombre})
	escribirJSON(w, http.StatusOK, map[string]any{"ok": true})
	return nil
}
