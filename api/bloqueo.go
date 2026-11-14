package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math"
	"net/http"
	"net/netip"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Una dirección que falla el inicio de sesión intentosPorIP veces dentro de la
// ventana queda bloqueada: el intento siguiente ya no se atiende, sea cual sea
// la cuenta y aunque la contraseña sea correcta.
const (
	intentosPorIP    = 4
	ventanaIntentos  = 15 * time.Minute
	duracionBloqueo  = 30 * time.Minute
	conservaIntentos = 24 * time.Hour
)

// ipBloqueada devuelve cuánto le queda de bloqueo a esa dirección, o cero.
func (a *App) ipBloqueada(ctx context.Context, ip string) (time.Duration, error) {
	var hasta time.Time
	err := a.db.QueryRow(ctx, `SELECT hasta FROM bloqueos_ip WHERE ip = $1 AND hasta > now()`, ip).Scan(&hasta)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return time.Until(hasta), nil
}

func errorBloqueoIP(queda time.Duration) error {
	minutos := int(math.Ceil(queda.Minutes()))
	if minutos < 1 {
		minutos = 1
	}
	return &errHTTP{codigo: http.StatusTooManyRequests,
		msg: fmt.Sprintf("Demasiados intentos fallidos desde tu dirección. El acceso está bloqueado durante %d minuto(s).", minutos)}
}

// registrarFalloIP anota un intento fallido y bloquea la dirección si llega al
// tope. Un error al anotar no debe impedir responder al intento.
func (a *App) registrarFalloIP(ctx context.Context, ip string) {
	var n int
	err := pgx.BeginFunc(ctx, a.db, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `INSERT INTO intentos_ip (ip) VALUES ($1)`, ip); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM intentos_ip WHERE ip = $1 AND fecha > now() - $2::interval`,
			ip, ventanaIntentos.String()).Scan(&n); err != nil {
			return err
		}
		if n < intentosPorIP {
			n = 0
			return nil
		}
		if _, err := tx.Exec(ctx, `INSERT INTO bloqueos_ip (ip, hasta, intentos) VALUES ($1, now() + $2::interval, $3)
			ON CONFLICT (ip) DO UPDATE SET desde = now(), hasta = EXCLUDED.hasta, intentos = EXCLUDED.intentos`,
			ip, duracionBloqueo.String(), n); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `DELETE FROM intentos_ip WHERE ip = $1 OR fecha < now() - $2::interval`,
			ip, conservaIntentos.String())
		return err
	})
	if err != nil {
		log.Printf("no se pudo anotar el intento fallido de %s: %v", ip, err)
		return
	}
	if n > 0 {
		a.auditar(ctx, "sistema", ip, "ip.bloqueada", ip,
			map[string]any{"intentos": n, "minutos": int(duracionBloqueo.Minutes())})
	}
}

func (a *App) listarBloqueos(w http.ResponseWriter, r *http.Request, _ *Operador) error {
	filas, err := a.db.Query(r.Context(), `SELECT ip, desde, hasta, intentos FROM bloqueos_ip
		WHERE hasta > now() ORDER BY desde DESC`)
	if err != nil {
		return err
	}
	defer filas.Close()
	type bloqueo struct {
		IP       string    `json:"ip"`
		Desde    time.Time `json:"desde"`
		Hasta    time.Time `json:"hasta"`
		Intentos int       `json:"intentos"`
	}
	lista := []bloqueo{}
	for filas.Next() {
		var b bloqueo
		if err := filas.Scan(&b.IP, &b.Desde, &b.Hasta, &b.Intentos); err != nil {
			return err
		}
		lista = append(lista, b)
	}
	if err := filas.Err(); err != nil {
		return err
	}
	escribirJSON(w, http.StatusOK, map[string]any{
		"bloqueos": lista,
		"regla": map[string]any{
			"intentos": intentosPorIP, "ventana_minutos": int(ventanaIntentos.Minutes()),
			"bloqueo_minutos": int(duracionBloqueo.Minutes()),
		},
	})
	return nil
}

// quitarBloqueo levanta el bloqueo de una dirección y olvida sus intentos.
func (a *App) quitarBloqueo(ctx context.Context, ip string) (bool, error) {
	var hecho bool
	err := pgx.BeginFunc(ctx, a.db, func(tx pgx.Tx) error {
		ct, err := tx.Exec(ctx, `DELETE FROM bloqueos_ip WHERE ip = $1`, ip)
		if err != nil {
			return err
		}
		hecho = ct.RowsAffected() > 0
		_, err = tx.Exec(ctx, `DELETE FROM intentos_ip WHERE ip = $1`, ip)
		return err
	})
	return hecho, err
}

func (a *App) desbloquearIP(w http.ResponseWriter, r *http.Request, op *Operador) error {
	var in struct {
		IP string `json:"ip"`
	}
	if err := leerJSON(w, r, &in); err != nil {
		return err
	}
	in.IP = strings.TrimSpace(in.IP)
	if _, err := netip.ParseAddr(in.IP); err != nil {
		return malo("La dirección IP no es válida.")
	}
	hecho, err := a.quitarBloqueo(r.Context(), in.IP)
	if err != nil {
		return err
	}
	if !hecho {
		return noEncontrado()
	}
	a.auditar(r.Context(), op.Usuario, ipCliente(r), "ip.desbloqueada", in.IP, nil)
	escribirJSON(w, http.StatusOK, map[string]any{"ok": true})
	return nil
}
