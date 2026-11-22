package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
)

// Peticiones descartadas: las que FreeRADIUS tira sin responder aunque vengan
// de un router dado de alta (por tanto, de una dirección que el firewall deja
// pasar). Las más habituales son un secreto que no coincide y un router que no
// manda Message-Authenticator cuando se le exige. El router no puede
// autenticar a nadie mientras siga así, y sin este aviso no se vería en el
// panel: FreeRADIUS solo lo anota en su salida.
//
// arranque.sh copia esas líneas a descartes.log con la hora delante; aquí se
// leen de forma incremental, como el registro de autenticaciones.

type Descarte struct {
	Fecha    time.Time
	IP       string
	RouterID int64
	Motivo   string
	Detalle  string
}

var (
	reDescarteIP     = regexp.MustCompile(`Received packet from ([0-9A-Fa-f.:]+)`)
	reDescarteRouter = regexp.MustCompile(`\(from client rc-(\d+)-\d+\)`)
)

// parsearDescarte interpreta una línea «<época>\t<línea de FreeRADIUS>».
// Solo cuentan las que FreeRADIUS atribuye a un router del panel.
func parsearDescarte(linea string) (*Descarte, bool) {
	partes := strings.SplitN(linea, "\t", 2)
	if len(partes) != 2 {
		return nil, false
	}
	epoca, err := strconv.ParseInt(partes[0], 10, 64)
	if err != nil {
		return nil, false
	}
	texto := partes[1]
	ip := reDescarteIP.FindStringSubmatch(texto)
	router := reDescarteRouter.FindStringSubmatch(texto)
	if ip == nil || router == nil {
		return nil, false
	}
	id, err := strconv.ParseInt(router[1], 10, 64)
	if err != nil {
		return nil, false
	}
	d := &Descarte{Fecha: time.Unix(epoca, 0).UTC(), IP: ip[1], RouterID: id, Motivo: "otro"}
	switch {
	case strings.Contains(texto, "Shared secret is incorrect"):
		d.Motivo = "secreto"
	case strings.Contains(texto, "Message-Authenticator"):
		d.Motivo = "message_authenticator"
	}
	if i := strings.Index(texto, "because of error: "); i >= 0 {
		d.Detalle = strings.TrimSpace(texto[i+len("because of error: "):])
	}
	if len(d.Detalle) > 300 {
		d.Detalle = d.Detalle[:300]
	}
	return d, true
}

// cargarDescartes lee las líneas nuevas de descartes.log y las guarda junto con
// la posición, en una sola transacción.
func (a *App) cargarDescartes(ctx context.Context) error {
	ruta := filepath.Join(a.cfg.DirRegistro, "descartes.log")
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
	err = a.db.QueryRow(ctx, `SELECT inodo, desplazamiento FROM descartes_posicion WHERE id = 1`).Scan(&inodoPrevio, &desde)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if inodoPrevio != inodo || info.Size() < desde {
		desde = 0
	}
	if info.Size() == desde {
		return nil
	}
	const trozo = 1 << 20
	buf := make([]byte, min(int64(trozo), info.Size()-desde))
	n, err := f.ReadAt(buf, desde)
	if err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	buf = buf[:n]
	fin := bytes.LastIndexByte(buf, '\n')
	if fin < 0 {
		return nil
	}
	buf = buf[:fin+1]

	posicion := desde + int64(len(buf))
	err = pgx.BeginFunc(ctx, a.db, func(tx pgx.Tx) error {
		for _, linea := range strings.Split(strings.TrimSuffix(string(buf), "\n"), "\n") {
			d, ok := parsearDescarte(linea)
			if !ok {
				continue
			}
			if _, err := tx.Exec(ctx, `INSERT INTO descartes (fecha, ip, router_id, motivo, detalle)
				VALUES ($1, $2, $3, $4, $5)`, d.Fecha, d.IP, d.RouterID, d.Motivo, d.Detalle); err != nil {
				return err
			}
		}
		_, err := tx.Exec(ctx, `INSERT INTO descartes_posicion (id, inodo, desplazamiento) VALUES (1, $1, $2)
			ON CONFLICT (id) DO UPDATE SET inodo = EXCLUDED.inodo, desplazamiento = EXCLUDED.desplazamiento`,
			inodo, posicion)
		return err
	})
	if err != nil {
		return err
	}
	// Leído entero y grande: se vacía para que no crezca sin límite.
	if posicion == info.Size() && info.Size() > tamanoRotacion {
		if actual, err := os.Stat(ruta); err == nil && actual.Size() == info.Size() {
			if err := os.Truncate(ruta, 0); err != nil {
				return err
			}
			_, err = a.db.Exec(ctx, `UPDATE descartes_posicion SET desplazamiento = 0 WHERE id = 1`)
			return err
		}
	}
	return nil
}

func (a *App) bucleDescartes(ctx context.Context) {
	for {
		if err := a.cargarDescartes(ctx); err != nil {
			log.Printf("descartes: %v", err)
		}
		time.Sleep(3 * time.Second)
	}
}

type grupoDescartes struct {
	RouterID int64     `json:"router_id"`
	Router   string    `json:"router"`
	Empresa  string    `json:"empresa"`
	Motivo   string    `json:"motivo"`
	IP       string    `json:"ip"`
	Total    int       `json:"total"`
	Primero  time.Time `json:"primero"`
	Ultimo   time.Time `json:"ultimo"`
	Detalle  string    `json:"detalle"`
}

// listarDescartes resume las peticiones descartadas de las últimas 24 horas,
// agrupadas por router, motivo y dirección, de la más reciente a la más antigua.
// Un grupo deja de salir en cuanto ese router tiene una autenticación registrada
// después de su último descarte: si FreeRADIUS le respondió (aceptando o
// rechazando), el secreto ya coincide y el problema está resuelto.
func (a *App) listarDescartes(w http.ResponseWriter, r *http.Request, _ *Operador) error {
	router, _ := strconv.Atoi(r.URL.Query().Get("router"))
	if router < 0 {
		router = 0
	}
	filas, err := a.db.Query(r.Context(), `SELECT d.router_id, COALESCE(ro.nombre, ''), COALESCE(e.nombre, ''),
		d.motivo, d.ip, count(*), min(d.fecha), max(d.fecha), max(d.detalle)
		FROM descartes d
		LEFT JOIN routers ro ON ro.id = d.router_id
		LEFT JOIN empresas e ON e.id = ro.empresa_id
		WHERE d.fecha > now() - interval '24 hours' AND ($1 = 0 OR d.router_id = $1)
		GROUP BY 1, 2, 3, 4, 5
		HAVING NOT EXISTS (SELECT 1 FROM autenticaciones a
			WHERE a.router_id = d.router_id AND a.fecha > max(d.fecha))
		ORDER BY max(d.fecha) DESC LIMIT 20`, router)
	if err != nil {
		return err
	}
	defer filas.Close()
	lista := []grupoDescartes{}
	for filas.Next() {
		var g grupoDescartes
		if err := filas.Scan(&g.RouterID, &g.Router, &g.Empresa, &g.Motivo, &g.IP, &g.Total, &g.Primero, &g.Ultimo, &g.Detalle); err != nil {
			return err
		}
		lista = append(lista, g)
	}
	if err := filas.Err(); err != nil {
		return err
	}
	escribirJSON(w, http.StatusOK, map[string]any{"ahora": time.Now(), "descartes": lista})
	return nil
}
