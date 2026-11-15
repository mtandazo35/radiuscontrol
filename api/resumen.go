package main

import (
	"net/http"
	"strconv"
	"time"
)

// Resumen para la pantalla de inicio. Todo sale del registro de
// autenticaciones y de las tablas del panel: no se sondea ningún router.

type resumenTramo struct {
	Inicio     time.Time `json:"inicio"`
	Aceptados  int       `json:"aceptados"`
	Rechazados int       `json:"rechazados"`
}

type resumenRouter struct {
	ID         int64      `json:"id"`
	Nombre     string     `json:"nombre"`
	Empresa    string     `json:"empresa"`
	Activo     bool       `json:"activo"`
	Redes      int        `json:"redes"`
	Aceptados  int        `json:"aceptados"`
	Rechazados int        `json:"rechazados"`
	Ultimo     *time.Time `json:"ultimo"`
}

type resumenRechazado struct {
	Usuario    string    `json:"usuario"`
	Rechazados int       `json:"rechazados"`
	Ultimo     time.Time `json:"ultimo"`
}

const (
	resumenHorasSerie = 12
	resumenMinTramo   = 10
)

func (a *App) verResumen(w http.ResponseWriter, r *http.Request, op *Operador) error {
	// 0 = todos los routers.
	router, _ := strconv.Atoi(r.URL.Query().Get("router"))
	if router < 0 {
		router = 0
	}
	ctx := r.Context()

	var acept24, rech24, aceptHora, rechHora int
	if err := a.db.QueryRow(ctx, `SELECT
		count(*) FILTER (WHERE resultado = 'aceptado'),
		count(*) FILTER (WHERE resultado = 'rechazado'),
		count(*) FILTER (WHERE resultado = 'aceptado' AND fecha > now() - interval '1 hour'),
		count(*) FILTER (WHERE resultado = 'rechazado' AND fecha > now() - interval '1 hour')
		FROM autenticaciones
		WHERE fecha > now() - interval '24 hours' AND ($1 = 0 OR router_id = $1)`, router).
		Scan(&acept24, &rech24, &aceptHora, &rechHora); err != nil {
		return err
	}

	var routersTotal, routersActivos, usuariosTotal, usuariosActivos int
	if err := a.db.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM routers), (SELECT count(*) FROM routers WHERE activo),
		(SELECT count(*) FROM usuarios_mikrotik), (SELECT count(*) FROM usuarios_mikrotik WHERE activo)`).
		Scan(&routersTotal, &routersActivos, &usuariosTotal, &usuariosActivos); err != nil {
		return err
	}

	// Los bloqueos del panel solo los ven los administradores.
	var bloqueos *int
	if op.Rol == "administrador" {
		var n int
		if err := a.db.QueryRow(ctx, `SELECT count(*) FROM bloqueos_ip WHERE hasta > now()`).Scan(&n); err != nil {
			return err
		}
		bloqueos = &n
	}

	serie := []resumenTramo{}
	filas, err := a.db.Query(ctx, `SELECT
		to_timestamp(floor(extract(epoch FROM fecha) / $2::int) * $2::int) AS tramo,
		count(*) FILTER (WHERE resultado = 'aceptado'),
		count(*) FILTER (WHERE resultado = 'rechazado')
		FROM autenticaciones
		WHERE fecha > now() - make_interval(hours => $3::int) AND ($1 = 0 OR router_id = $1)
		GROUP BY tramo ORDER BY tramo`, router, resumenMinTramo*60, resumenHorasSerie)
	if err != nil {
		return err
	}
	for filas.Next() {
		var t resumenTramo
		if err := filas.Scan(&t.Inicio, &t.Aceptados, &t.Rechazados); err != nil {
			filas.Close()
			return err
		}
		serie = append(serie, t)
	}
	filas.Close()
	if err := filas.Err(); err != nil {
		return err
	}

	routers := []resumenRouter{}
	filas, err = a.db.Query(ctx, `SELECT r.id, r.nombre, coalesce(e.nombre, ''), r.activo,
		(SELECT count(*) FROM router_redes d WHERE d.router_id = r.id),
		(SELECT count(*) FROM autenticaciones x WHERE x.router_id = r.id AND x.resultado = 'aceptado'
			AND x.fecha > now() - interval '24 hours'),
		(SELECT count(*) FROM autenticaciones x WHERE x.router_id = r.id AND x.resultado = 'rechazado'
			AND x.fecha > now() - interval '24 hours'),
		(SELECT max(x.fecha) FROM autenticaciones x WHERE x.router_id = r.id AND x.resultado = 'aceptado')
		FROM routers r LEFT JOIN empresas e ON e.id = r.empresa_id
		WHERE $1 = 0 OR r.id = $1
		ORDER BY lower(r.nombre)`, router)
	if err != nil {
		return err
	}
	conActividad := 0
	for filas.Next() {
		var x resumenRouter
		if err := filas.Scan(&x.ID, &x.Nombre, &x.Empresa, &x.Activo, &x.Redes, &x.Aceptados, &x.Rechazados, &x.Ultimo); err != nil {
			filas.Close()
			return err
		}
		if x.Aceptados+x.Rechazados > 0 {
			conActividad++
		}
		routers = append(routers, x)
	}
	filas.Close()
	if err := filas.Err(); err != nil {
		return err
	}

	rechazados := []resumenRechazado{}
	filas, err = a.db.Query(ctx, `SELECT usuario, count(*), max(fecha) FROM autenticaciones
		WHERE resultado = 'rechazado' AND fecha > now() - interval '24 hours' AND ($1 = 0 OR router_id = $1)
		GROUP BY usuario ORDER BY count(*) DESC, max(fecha) DESC LIMIT 6`, router)
	if err != nil {
		return err
	}
	for filas.Next() {
		var x resumenRechazado
		if err := filas.Scan(&x.Usuario, &x.Rechazados, &x.Ultimo); err != nil {
			filas.Close()
			return err
		}
		rechazados = append(rechazados, x)
	}
	filas.Close()
	if err := filas.Err(); err != nil {
		return err
	}

	escribirJSON(w, http.StatusOK, map[string]any{
		"ahora":                 time.Now(),
		"aceptados_24h":         acept24,
		"rechazados_24h":        rech24,
		"aceptados_hora":        aceptHora,
		"rechazados_hora":       rechHora,
		"routers_total":         routersTotal,
		"routers_activos":       routersActivos,
		"routers_con_actividad": conActividad,
		"usuarios_total":        usuariosTotal,
		"usuarios_activos":      usuariosActivos,
		"bloqueos_ip":           bloqueos,
		"minutos_tramo":         resumenMinTramo,
		"horas_serie":           resumenHorasSerie,
		"serie":                 serie,
		"routers":               routers,
		"rechazados":            rechazados,
	})
	return nil
}
