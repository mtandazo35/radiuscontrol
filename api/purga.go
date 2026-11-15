package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
)

// Motivos por los que se ejecuta una purga de registros.
const (
	motivoProgramada = "programada"
	motivoManual     = "manual"
	motivoDisco      = "disco"
)

// Ni la purga de emergencia borra nada más reciente que esto.
const (
	minDiasAutenticaciones = 7
	minDiasActividad       = 30
)

// AjustesPurga dice cuánto tiempo se conservan los registros, cada cuánto se
// limpian y con qué uso del disco se hace una limpieza de emergencia.
type AjustesPurga struct {
	DiasAutenticaciones int `json:"dias_autenticaciones"`
	DiasActividad       int `json:"dias_actividad"`
	CadaHoras           int `json:"cada_horas"`
	PorcentajeDisco     int `json:"porcentaje_disco"`
}

func ajustesPurgaPorOmision() AjustesPurga {
	return AjustesPurga{DiasAutenticaciones: 180, DiasActividad: 365, CadaHoras: 24, PorcentajeDisco: 50}
}

func (aj AjustesPurga) validar() error {
	if aj.DiasAutenticaciones < minDiasAutenticaciones || aj.DiasAutenticaciones > 3650 {
		return malo("Los días que se conservan los inicios de sesión deben estar entre 7 y 3650.")
	}
	if aj.DiasActividad < minDiasActividad || aj.DiasActividad > 3650 {
		return malo("Los días que se conserva el registro de actividad deben estar entre 30 y 3650.")
	}
	if aj.CadaHoras < 1 || aj.CadaHoras > 720 {
		return malo("El intervalo entre limpiezas debe estar entre 1 y 720 horas.")
	}
	if aj.PorcentajeDisco < 20 || aj.PorcentajeDisco > 95 {
		return malo("El porcentaje de uso del disco debe estar entre 20 y 95.")
	}
	return nil
}

// leerAjustesPurga devuelve los ajustes guardados, o los de por omisión si
// todavía no se ha guardado ninguno.
func (a *App) leerAjustesPurga(ctx context.Context) (AjustesPurga, error) {
	aj := ajustesPurgaPorOmision()
	var valor string
	err := a.db.QueryRow(ctx, `SELECT valor::text FROM ajustes WHERE clave = 'purga'`).Scan(&valor)
	if errors.Is(err, pgx.ErrNoRows) {
		return aj, nil
	}
	if err != nil {
		return aj, err
	}
	if err := json.Unmarshal([]byte(valor), &aj); err != nil || aj.validar() != nil {
		// Unos ajustes ilegibles no deben acabar borrando más de la cuenta.
		log.Printf("purga: los ajustes guardados no son válidos; se usan los de por omisión")
		return ajustesPurgaPorOmision(), nil
	}
	return aj, nil
}

// UsoDisco es la ocupación del disco donde viven los registros.
type UsoDisco struct {
	Porcentaje int    `json:"porcentaje"`
	TotalBytes uint64 `json:"total_bytes"`
	LibreBytes uint64 `json:"libre_bytes"`
}

// usoDisco mide el sistema de archivos que contiene esa ruta.
func usoDisco(ruta string) (UsoDisco, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(ruta, &st); err != nil {
		return UsoDisco{}, fmt.Errorf("no se pudo medir el disco en %s: %w", ruta, err)
	}
	bloques, disponibles := uint64(st.Blocks), uint64(st.Bavail)
	if bloques == 0 {
		return UsoDisco{}, fmt.Errorf("el disco de %s no informa de su tamaño", ruta)
	}
	if disponibles > bloques {
		disponibles = bloques
	}
	tamano := uint64(st.Bsize)
	return UsoDisco{
		Porcentaje: int((bloques - disponibles) * 100 / bloques),
		TotalBytes: bloques * tamano,
		LibreBytes: disponibles * tamano,
	}, nil
}

// planEmergencia devuelve las retenciones, en días, que prueba la purga de
// emergencia: cada una la mitad de la anterior, sin bajar del mínimo.
func planEmergencia(dias int) []int {
	plan := []int{}
	for dias > minDiasAutenticaciones {
		dias /= 2
		if dias < minDiasAutenticaciones {
			dias = minDiasAutenticaciones
		}
		plan = append(plan, dias)
	}
	return plan
}

// Purga es una purga ya ejecutada, tal como queda anotada.
type Purga struct {
	ID              int64     `json:"id"`
	Fecha           time.Time `json:"fecha"`
	Motivo          string    `json:"motivo"`
	Operador        string    `json:"operador"`
	Autenticaciones int64     `json:"autenticaciones"`
	Actividad       int64     `json:"actividad"`
	DiscoAntes      int       `json:"disco_antes"`
	DiscoDespues    int       `json:"disco_despues"`
}

// borrarAntiguos borra los registros más antiguos que esos días y suma a p lo
// borrado.
func (a *App) borrarAntiguos(ctx context.Context, diasAutenticaciones, diasActividad int, p *Purga) error {
	if diasAutenticaciones < minDiasAutenticaciones || diasActividad < minDiasActividad {
		return fmt.Errorf("retención demasiado corta: %d y %d días", diasAutenticaciones, diasActividad)
	}
	ct, err := a.db.Exec(ctx, `DELETE FROM autenticaciones WHERE fecha < now() - make_interval(days => $1)`,
		diasAutenticaciones)
	if err != nil {
		return err
	}
	p.Autenticaciones += ct.RowsAffected()
	ct, err = a.db.Exec(ctx, `DELETE FROM auditoria WHERE fecha < now() - make_interval(days => $1)`,
		diasActividad)
	if err != nil {
		return err
	}
	p.Actividad += ct.RowsAffected()
	return nil
}

// compactarRegistros devuelve al disco el espacio de lo borrado. Un fallo aquí
// no anula la purga: se anota y se sigue.
func (a *App) compactarRegistros(ctx context.Context) {
	for _, sentencia := range []string{`VACUUM FULL autenticaciones`, `VACUUM FULL auditoria`} {
		if _, err := a.db.Exec(ctx, sentencia); err != nil {
			log.Printf("purga: %s: %v", sentencia, err)
		}
	}
}

// purgarPorDisco es la limpieza de emergencia: tras la limpieza normal, acorta
// la retención paso a paso hasta que el uso del disco baja del umbral.
func (a *App) purgarPorDisco(ctx context.Context, aj AjustesPurga, p *Purga) error {
	// La limpieza normal no devuelve espacio al disco hasta compactar.
	a.compactarRegistros(ctx)
	for _, dias := range planEmergencia(aj.DiasAutenticaciones) {
		uso, err := usoDisco(a.cfg.DirRegistro)
		if err != nil {
			return err
		}
		if uso.Porcentaje < aj.PorcentajeDisco {
			return nil
		}
		if err := a.borrarAntiguos(ctx, dias, max(dias, minDiasActividad), p); err != nil {
			return err
		}
		a.compactarRegistros(ctx)
	}
	return nil
}

// ejecutarPurga borra los registros antiguos según los ajustes y lo deja
// anotado. El motivo es «programada», «manual» o «disco»; este último es la
// limpieza de emergencia. Nunca corren dos a la vez.
func (a *App) ejecutarPurga(ctx context.Context, motivo, operador, ip string) (*Purga, error) {
	a.purgaMu.Lock()
	defer a.purgaMu.Unlock()

	aj, err := a.leerAjustesPurga(ctx)
	if err != nil {
		return nil, err
	}
	antes, err := usoDisco(a.cfg.DirRegistro)
	if err != nil {
		return nil, err
	}
	p := &Purga{Motivo: motivo, Operador: operador, DiscoAntes: antes.Porcentaje, DiscoDespues: antes.Porcentaje}
	errBorrado := a.borrarAntiguos(ctx, aj.DiasAutenticaciones, aj.DiasActividad, p)
	if errBorrado == nil && motivo == motivoDisco {
		errBorrado = a.purgarPorDisco(ctx, aj, p)
	}
	// Si falló sin haber borrado nada, no hay nada que anotar.
	if errBorrado != nil && p.Autenticaciones == 0 && p.Actividad == 0 {
		return nil, errBorrado
	}
	if despues, err := usoDisco(a.cfg.DirRegistro); err == nil {
		p.DiscoDespues = despues.Porcentaje
	}
	if err := a.db.QueryRow(ctx, `INSERT INTO purgas (motivo, operador, autenticaciones, actividad, disco_antes, disco_despues)
		VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, fecha`,
		p.Motivo, p.Operador, p.Autenticaciones, p.Actividad, p.DiscoAntes, p.DiscoDespues).
		Scan(&p.ID, &p.Fecha); err != nil {
		return nil, err
	}
	// El evento se anota después de borrar, para que la purga no se lo lleve.
	a.auditar(ctx, operador, ip, "sistema.purga", motivo, map[string]any{
		"autenticaciones": p.Autenticaciones, "actividad": p.Actividad,
		"disco_antes": p.DiscoAntes, "disco_despues": p.DiscoDespues,
		"dias_autenticaciones": aj.DiasAutenticaciones, "dias_actividad": aj.DiasActividad,
	})
	return p, errBorrado
}

// vaciarRegistros borra a petición expresa de un administrador, sin esperar a
// que los registros superen el tiempo de conservación: todo, o lo anterior a
// unos días. Es distinto de la limpieza: aquí la persona decide borrar datos
// recientes, así que queda anotado con su nombre.
func (a *App) vaciarRegistros(w http.ResponseWriter, r *http.Request, op *Operador) error {
	var in struct {
		Registro string `json:"registro"`
		Dias     int    `json:"dias"`
	}
	if err := leerJSON(w, r, &in); err != nil {
		return err
	}
	if in.Registro != "autenticaciones" && in.Registro != "actividad" && in.Registro != "ambos" {
		return malo("Indica qué borrar: «autenticaciones», «actividad» o «ambos».")
	}
	if in.Dias < 0 || in.Dias > 3650 {
		return malo("Los días deben estar entre 0 (borrar todo) y 3650.")
	}
	// Una vez empezado, se termina y se anota aunque el navegador corte.
	ctx := context.WithoutCancel(r.Context())
	a.purgaMu.Lock()
	defer a.purgaMu.Unlock()

	antes, err := usoDisco(a.cfg.DirRegistro)
	if err != nil {
		return err
	}
	p := &Purga{Motivo: "vaciado", Operador: op.Usuario, DiscoAntes: antes.Porcentaje, DiscoDespues: antes.Porcentaje}
	if in.Registro != "actividad" {
		ct, err := a.db.Exec(ctx, `DELETE FROM autenticaciones WHERE fecha < now() - make_interval(days => $1)`, in.Dias)
		if err != nil {
			return err
		}
		p.Autenticaciones = ct.RowsAffected()
	}
	if in.Registro != "autenticaciones" {
		ct, err := a.db.Exec(ctx, `DELETE FROM auditoria WHERE fecha < now() - make_interval(days => $1)`, in.Dias)
		if err != nil {
			return err
		}
		p.Actividad = ct.RowsAffected()
	}
	if despues, err := usoDisco(a.cfg.DirRegistro); err == nil {
		p.DiscoDespues = despues.Porcentaje
	}
	if err := a.db.QueryRow(ctx, `INSERT INTO purgas (motivo, operador, autenticaciones, actividad, disco_antes, disco_despues)
		VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, fecha`,
		p.Motivo, p.Operador, p.Autenticaciones, p.Actividad, p.DiscoAntes, p.DiscoDespues).
		Scan(&p.ID, &p.Fecha); err != nil {
		return err
	}
	// Se anota después de borrar: aunque se vacíe la actividad, queda quién lo hizo.
	a.auditar(ctx, op.Usuario, ipCliente(r), "sistema.registros_vaciados", in.Registro, map[string]any{
		"dias": in.Dias, "autenticaciones": p.Autenticaciones, "actividad": p.Actividad,
	})
	escribirJSON(w, http.StatusOK, map[string]any{"purga": p})
	return nil
}

// revisarLimpieza decide si toca una purga programada o una de emergencia.
func (a *App) revisarLimpieza(ctx context.Context) error {
	aj, err := a.leerAjustesPurga(ctx)
	if err != nil {
		return err
	}
	var toca bool
	if err := a.db.QueryRow(ctx, `SELECT COALESCE(max(fecha) <= now() - make_interval(hours => $1), true)
		FROM purgas WHERE motivo = $2`, aj.CadaHoras, motivoProgramada).Scan(&toca); err != nil {
		return err
	}
	if toca {
		if _, err := a.ejecutarPurga(ctx, motivoProgramada, "sistema", "servidor"); err != nil {
			return err
		}
	}

	uso, err := usoDisco(a.cfg.DirRegistro)
	if err != nil {
		return err
	}
	if uso.Porcentaje < aj.PorcentajeDisco {
		return nil
	}
	var reciente bool
	if err := a.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM purgas
		WHERE motivo = $1 AND fecha > now() - interval '1 hour')`, motivoDisco).Scan(&reciente); err != nil {
		return err
	}
	if reciente {
		return nil
	}
	// Si los registros apenas ocupan, el disco lo llena otra cosa (imágenes de
	// Docker, respaldos): borrarlos no arreglaría nada y se perderían para nada.
	ocupan, err := a.tamanoRegistros(ctx)
	if err != nil {
		return err
	}
	if !registrosPesan(ocupan, uso.TotalBytes) {
		if !a.avisoDiscoAjeno {
			log.Printf("purga: el disco está al %d %% (umbral %d %%), pero los registros solo ocupan %d bytes: no se borra nada",
				uso.Porcentaje, aj.PorcentajeDisco, ocupan)
			a.avisoDiscoAjeno = true
		}
		return nil
	}
	a.avisoDiscoAjeno = false
	log.Printf("purga: el disco está al %d %% (umbral %d %%); limpieza de emergencia", uso.Porcentaje, aj.PorcentajeDisco)
	_, err = a.ejecutarPurga(ctx, motivoDisco, "sistema", "servidor")
	return err
}

// tamanoRegistros devuelve lo que ocupan en disco las dos tablas de registros,
// con sus índices, más el archivo que escribe FreeRADIUS.
func (a *App) tamanoRegistros(ctx context.Context) (uint64, error) {
	var tablas int64
	if err := a.db.QueryRow(ctx, `SELECT pg_total_relation_size('autenticaciones') +
		pg_total_relation_size('auditoria')`).Scan(&tablas); err != nil {
		return 0, err
	}
	total := uint64(tablas)
	if info, err := os.Stat(filepath.Join(a.cfg.DirRegistro, "auth.log")); err == nil {
		total += uint64(info.Size())
	}
	return total, nil
}

// registrosPesan dice si los registros ocupan lo bastante como para que
// borrarlos libere algo apreciable: al menos 64 MB y al menos el 1 % del disco.
func registrosPesan(ocupan, discoTotal uint64) bool {
	const minimo = 64 << 20
	return ocupan >= minimo && ocupan >= discoTotal/100
}

// bucleLimpieza purga los registros cada cierto tiempo y cuando el disco se
// llena, según los ajustes.
func (a *App) bucleLimpieza(ctx context.Context) {
	for {
		if err := a.revisarLimpieza(ctx); err != nil {
			log.Printf("purga: %v", err)
		}
		time.Sleep(5 * time.Minute)
	}
}

// ------------------------------------------------------------------ API

// estadoPurga reúne lo que muestra el panel: ajustes, disco, cuánto hay
// guardado y las últimas purgas.
func (a *App) estadoPurga(ctx context.Context) (map[string]any, error) {
	aj, err := a.leerAjustesPurga(ctx)
	if err != nil {
		return nil, err
	}
	uso, err := usoDisco(a.cfg.DirRegistro)
	if err != nil {
		return nil, err
	}
	var filasAut, filasAct int64
	var antiguaAut, antiguaAct *time.Time
	if err := a.db.QueryRow(ctx, `SELECT count(*), min(fecha) FROM autenticaciones`).
		Scan(&filasAut, &antiguaAut); err != nil {
		return nil, err
	}
	if err := a.db.QueryRow(ctx, `SELECT count(*), min(fecha) FROM auditoria`).
		Scan(&filasAct, &antiguaAct); err != nil {
		return nil, err
	}

	filas, err := a.db.Query(ctx, `SELECT id, fecha, motivo, operador, autenticaciones, actividad,
		disco_antes, disco_despues FROM purgas ORDER BY id DESC LIMIT 10`)
	if err != nil {
		return nil, err
	}
	defer filas.Close()
	ultimas := []*Purga{}
	for filas.Next() {
		var p Purga
		if err := filas.Scan(&p.ID, &p.Fecha, &p.Motivo, &p.Operador, &p.Autenticaciones, &p.Actividad,
			&p.DiscoAntes, &p.DiscoDespues); err != nil {
			return nil, err
		}
		ultimas = append(ultimas, &p)
	}
	if err := filas.Err(); err != nil {
		return nil, err
	}
	ocupan, err := a.tamanoRegistros(ctx)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"ajustes": aj,
		"disco":   uso,
		// Cuánto ocupan los registros y si borrarlos serviría de algo: si el
		// disco está lleno pero no pesan, lo llena otra cosa.
		"registros_bytes": ocupan,
		"registros_pesan": registrosPesan(ocupan, uso.TotalBytes),
		"filas":           map[string]any{"autenticaciones": filasAut, "actividad": filasAct},
		"mas_antiguo":     map[string]any{"autenticaciones": antiguaAut, "actividad": antiguaAct},
		"ultimas":         ultimas,
	}, nil
}

func (a *App) verPurga(w http.ResponseWriter, r *http.Request, _ *Operador) error {
	estado, err := a.estadoPurga(r.Context())
	if err != nil {
		return err
	}
	escribirJSON(w, http.StatusOK, estado)
	return nil
}

func (a *App) guardarPurga(w http.ResponseWriter, r *http.Request, op *Operador) error {
	var aj AjustesPurga
	if err := leerJSON(w, r, &aj); err != nil {
		return err
	}
	if err := aj.validar(); err != nil {
		return err
	}
	j, err := json.Marshal(aj)
	if err != nil {
		return err
	}
	ctx := r.Context()
	if _, err := a.db.Exec(ctx, `INSERT INTO ajustes (clave, valor) VALUES ('purga', $1::jsonb)
		ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`, string(j)); err != nil {
		return err
	}
	a.auditar(ctx, op.Usuario, ipCliente(r), "sistema.purga_ajustada", "purga", map[string]any{
		"dias_autenticaciones": aj.DiasAutenticaciones, "dias_actividad": aj.DiasActividad,
		"cada_horas": aj.CadaHoras, "porcentaje_disco": aj.PorcentajeDisco,
	})
	estado, err := a.estadoPurga(ctx)
	if err != nil {
		return err
	}
	escribirJSON(w, http.StatusOK, estado)
	return nil
}

func (a *App) ejecutarPurgaManual(w http.ResponseWriter, r *http.Request, op *Operador) error {
	// Una purga empezada se termina y se anota aunque el navegador corte.
	ctx := context.WithoutCancel(r.Context())
	p, err := a.ejecutarPurga(ctx, motivoManual, op.Usuario, ipCliente(r))
	if err != nil {
		return err
	}
	escribirJSON(w, http.StatusOK, map[string]any{"purga": p})
	return nil
}
