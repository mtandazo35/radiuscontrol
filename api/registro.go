package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
)

type Autenticacion struct {
	ID            int64     `json:"id"`
	Fecha         time.Time `json:"fecha"`
	Resultado     string    `json:"resultado"`
	Usuario       string    `json:"usuario"`
	IPOrigen      string    `json:"ip_origen"`
	RouterID      *int64    `json:"router_id"`
	Router        string    `json:"router"`
	Empresa       string    `json:"empresa"`
	NASIdentifier string    `json:"nas_identifier"`
	NASIP         string    `json:"nas_ip"`
	Origen        string    `json:"origen"`
	Metodo        string    `json:"metodo"`
	Grupo         string    `json:"grupo"`
	Motivo        string    `json:"motivo"`
}

const camposRegistro = 11

func descodificar(s string) string {
	if v, err := url.PathUnescape(s); err == nil {
		return v
	}
	return s
}

// parsearLinea interpreta una línea del registro que escribe FreeRADIUS
// (ver despliegue/freeradius/rc_registro.mod).
func parsearLinea(linea string) (*Autenticacion, error) {
	c := strings.Split(linea, "\t")
	if len(c) != camposRegistro {
		return nil, fmt.Errorf("se esperaban %d campos y hay %d", camposRegistro, len(c))
	}
	epoca, err := strconv.ParseInt(c[0], 10, 64)
	if err != nil {
		return nil, fmt.Errorf("fecha no válida: %q", c[0])
	}
	if c[1] != "aceptado" && c[1] != "rechazado" {
		return nil, fmt.Errorf("resultado no válido: %q", c[1])
	}
	a := &Autenticacion{
		Fecha:         time.Unix(epoca, 0).UTC(),
		Resultado:     c[1],
		Usuario:       descodificar(c[2]),
		IPOrigen:      c[3],
		NASIdentifier: descodificar(c[5]),
		NASIP:         c[6],
		Origen:        descodificar(c[7]),
		Metodo:        c[8],
		Grupo:         descodificar(c[9]),
		Motivo:        descodificar(c[10]),
	}
	// El nombre corto del cliente lo genera el compilador: rc-<router>-<red>.
	if p := strings.Split(descodificar(c[4]), "-"); len(p) == 3 && p[0] == "rc" {
		if id, err := strconv.ParseInt(p[1], 10, 64); err == nil {
			a.RouterID = &id
		}
	}
	return a, nil
}

// cargarRegistro lee del archivo las líneas nuevas desde la posición guardada
// y las inserta junto con la posición nueva, en una sola transacción.
func (a *App) cargarRegistro(ctx context.Context) error {
	ruta := filepath.Join(a.cfg.DirRegistro, "auth.log")
	f, err := os.Open(ruta)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	var inodo int64
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		inodo = int64(st.Ino)
	}

	var inodoPrevio, desde int64
	err = a.db.QueryRow(ctx, `SELECT inodo, desplazamiento FROM registro_posicion WHERE id = 1`).
		Scan(&inodoPrevio, &desde)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	// Archivo distinto o más corto que lo ya leído: se empieza desde el principio.
	if inodoPrevio != inodo || info.Size() < desde {
		desde = 0
	}
	if info.Size() == desde {
		return nil
	}

	const trozo = 4 << 20
	buf := make([]byte, min(int64(trozo), info.Size()-desde))
	n, err := f.ReadAt(buf, desde)
	if err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	buf = buf[:n]
	fin := bytes.LastIndexByte(buf, '\n')
	if fin < 0 {
		return nil // Todavía no hay una línea completa.
	}
	buf = buf[:fin+1]

	var nuevas []*Autenticacion
	for _, linea := range strings.Split(strings.TrimSuffix(string(buf), "\n"), "\n") {
		reg, err := parsearLinea(linea)
		if err != nil {
			log.Printf("registro: línea descartada: %v", err)
			continue
		}
		nuevas = append(nuevas, reg)
	}

	return pgx.BeginFunc(ctx, a.db, func(tx pgx.Tx) error {
		nombres := map[int64][2]string{}
		filas, err := tx.Query(ctx, `SELECT r.id, r.nombre, COALESCE(e.nombre, '')
			FROM routers r LEFT JOIN empresas e ON e.id = r.empresa_id`)
		if err != nil {
			return err
		}
		for filas.Next() {
			var id int64
			var nombre, empresa string
			if err := filas.Scan(&id, &nombre, &empresa); err != nil {
				filas.Close()
				return err
			}
			nombres[id] = [2]string{nombre, empresa}
		}
		filas.Close()
		if err := filas.Err(); err != nil {
			return err
		}
		for _, r := range nuevas {
			if r.RouterID != nil {
				r.Router, r.Empresa = nombres[*r.RouterID][0], nombres[*r.RouterID][1]
			}
			if _, err := tx.Exec(ctx, `INSERT INTO autenticaciones
				(fecha, resultado, usuario, ip_origen, router_id, router_nombre, empresa_nombre,
				 nas_identifier, nas_ip, origen, metodo, grupo, motivo)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
				r.Fecha, r.Resultado, r.Usuario, r.IPOrigen, r.RouterID, r.Router, r.Empresa,
				r.NASIdentifier, r.NASIP, r.Origen, r.Metodo, r.Grupo, r.Motivo); err != nil {
				return err
			}
		}
		_, err = tx.Exec(ctx, `INSERT INTO registro_posicion (id, inodo, desplazamiento) VALUES (1, $1, $2)
			ON CONFLICT (id) DO UPDATE SET inodo = EXCLUDED.inodo, desplazamiento = EXCLUDED.desplazamiento`,
			inodo, desde+int64(len(buf)))
		return err
	})
}

func (a *App) bucleRegistro(ctx context.Context) {
	ultimaLimpieza := time.Time{}
	for {
		if err := a.cargarRegistro(ctx); err != nil {
			log.Printf("registro: %v", err)
		}
		if time.Since(ultimaLimpieza) > time.Hour {
			ultimaLimpieza = time.Now()
			if _, err := a.db.Exec(ctx, `DELETE FROM autenticaciones WHERE fecha < now() - interval '180 days'`); err != nil {
				log.Printf("registro: limpieza: %v", err)
			}
		}
		time.Sleep(2 * time.Second)
	}
}

func (a *App) listarAutenticaciones(w http.ResponseWriter, r *http.Request, _ *Operador) error {
	q := r.URL.Query()
	limite, _ := strconv.Atoi(q.Get("limite"))
	if limite <= 0 || limite > 500 {
		limite = 100
	}
	resultado := q.Get("resultado")
	if resultado != "" && resultado != "aceptado" && resultado != "rechazado" {
		return malo("Filtro de resultado no válido.")
	}
	buscar := strings.TrimSpace(q.Get("buscar"))

	filas, err := a.db.Query(r.Context(), `SELECT id, fecha, resultado, usuario, ip_origen, router_id,
		router_nombre, empresa_nombre, nas_identifier, nas_ip, origen, metodo, grupo, motivo
		FROM autenticaciones
		WHERE ($1 = '' OR resultado = $1)
		  AND ($2 = '' OR usuario ILIKE '%' || $2 || '%' OR router_nombre ILIKE '%' || $2 || '%'
		       OR empresa_nombre ILIKE '%' || $2 || '%' OR ip_origen LIKE $2 || '%')
		ORDER BY id DESC LIMIT $3`, resultado, buscar, limite)
	if err != nil {
		return err
	}
	defer filas.Close()
	lista := []*Autenticacion{}
	for filas.Next() {
		var x Autenticacion
		if err := filas.Scan(&x.ID, &x.Fecha, &x.Resultado, &x.Usuario, &x.IPOrigen, &x.RouterID,
			&x.Router, &x.Empresa, &x.NASIdentifier, &x.NASIP, &x.Origen, &x.Metodo, &x.Grupo, &x.Motivo); err != nil {
			return err
		}
		lista = append(lista, &x)
	}
	if err := filas.Err(); err != nil {
		return err
	}
	escribirJSON(w, http.StatusOK, lista)
	return nil
}
