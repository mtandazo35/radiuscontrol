package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/netip"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type Router struct {
	ID            int64     `json:"id"`
	Nombre        string    `json:"nombre"`
	Empresa       string    `json:"empresa"`
	Descripcion   string    `json:"descripcion"`
	Activo        bool      `json:"activo"`
	Redes         []string  `json:"redes"`
	SecretoRotado time.Time `json:"secreto_rotado"`
	ExigirMA      bool      `json:"exigir_message_authenticator"`
	Creado        time.Time `json:"creado"`
}

type routerEntrada struct {
	Nombre      string   `json:"nombre"`
	Empresa     string   `json:"empresa"`
	Descripcion string   `json:"descripcion"`
	Activo      *bool    `json:"activo"`
	Redes       []string `json:"redes"`
	Secreto     string   `json:"secreto"`
	ExigirMA    *bool    `json:"exigir_message_authenticator"`
}

var reNombreRouter = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9 ._-]{0,62}$`)

// normalizarRedes convierte las redes escritas por el operador en prefijos
// canónicos y rechaza las que no se pueden usar para identificar un router.
func normalizarRedes(entrada []string) ([]netip.Prefix, error) {
	var redes []netip.Prefix
	for _, texto := range entrada {
		texto = strings.TrimSpace(texto)
		if texto == "" {
			continue
		}
		var p netip.Prefix
		if strings.Contains(texto, "/") {
			var err error
			if p, err = netip.ParsePrefix(texto); err != nil {
				return nil, malo(fmt.Sprintf("«%s» no es una red válida.", texto))
			}
		} else {
			dir, err := netip.ParseAddr(texto)
			if err != nil {
				return nil, malo(fmt.Sprintf("«%s» no es una dirección válida.", texto))
			}
			p = netip.PrefixFrom(dir, dir.BitLen())
		}
		if p.Addr().Zone() != "" || p.Addr().Is4In6() {
			return nil, malo(fmt.Sprintf("«%s» no es una red admitida.", texto))
		}
		p = p.Masked()
		if p.Bits() == 0 {
			return nil, malo(fmt.Sprintf("«%s» abarca todas las direcciones y no identifica a ningún router.", texto))
		}
		for _, otra := range redes {
			if otra.Overlaps(p) {
				return nil, malo(fmt.Sprintf("Las redes %s y %s se superponen.", otra, p))
			}
		}
		redes = append(redes, p)
	}
	if len(redes) == 0 {
		return nil, malo("Indica al menos una dirección o red de origen.")
	}
	if len(redes) > 64 {
		return nil, malo("Demasiadas redes para un solo router.")
	}
	return redes, nil
}

func validarSecreto(s string) error {
	if len(s) == 0 || len(s) > 128 {
		return malo("El secreto debe tener entre 1 y 128 caracteres.")
	}
	for _, c := range s {
		if c < 0x20 || c > 0x7e {
			return malo("El secreto solo admite caracteres ASCII imprimibles.")
		}
	}
	// Ver comillaSimple: estas dos formas no se pueden escribir sin ambigüedad
	// en la configuración de FreeRADIUS.
	if strings.HasSuffix(s, `\`) || strings.Contains(s, `\'`) {
		return malo("El secreto no puede terminar en barra invertida ni contener una barra invertida seguida de comilla simple.")
	}
	return nil
}

func (a *App) scriptRouter(secreto string) string {
	s := strings.NewReplacer(`\`, `\\`, `"`, `\"`, `$`, `\$`).Replace(secreto)
	return fmt.Sprintf("/radius add service=login address=%s secret=\"%s\" comment=\"RadiusControl\"\n/user aaa set use-radius=yes\n",
		a.cfg.ServidorRadius, s)
}

const consultaRouters = `
	SELECT r.id, r.nombre, r.descripcion, r.activo, r.secreto_rotado,
	       r.exigir_message_authenticator, r.creado, COALESCE(e.nombre, ''),
	       COALESCE(array_agg(text(rr.red) ORDER BY rr.red) FILTER (WHERE rr.id IS NOT NULL), '{}')
	FROM routers r LEFT JOIN router_redes rr ON rr.router_id = r.id
	LEFT JOIN empresas e ON e.id = r.empresa_id`

func leerRouter(fila pgx.Row) (*Router, error) {
	var r Router
	if err := fila.Scan(&r.ID, &r.Nombre, &r.Descripcion, &r.Activo, &r.SecretoRotado,
		&r.ExigirMA, &r.Creado, &r.Empresa, &r.Redes); err != nil {
		return nil, err
	}
	return &r, nil
}

func (a *App) routerPorID(ctx context.Context, id int64) (*Router, error) {
	r, err := leerRouter(a.db.QueryRow(ctx, consultaRouters+` WHERE r.id = $1 GROUP BY r.id, e.nombre`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, noEncontrado()
	}
	return r, err
}

func (a *App) listarRouters(w http.ResponseWriter, r *http.Request, _ *Operador) error {
	filas, err := a.db.Query(r.Context(), consultaRouters+` GROUP BY r.id, e.nombre ORDER BY lower(COALESCE(e.nombre, '')), lower(r.nombre)`)
	if err != nil {
		return err
	}
	defer filas.Close()
	lista := []*Router{}
	for filas.Next() {
		ro, err := leerRouter(filas)
		if err != nil {
			return err
		}
		lista = append(lista, ro)
	}
	if err := filas.Err(); err != nil {
		return err
	}
	escribirJSON(w, http.StatusOK, lista)
	return nil
}

// idEmpresa devuelve la empresa con ese nombre y la crea si no existe. Los
// nombres no distinguen mayúsculas: se conserva la primera forma escrita.
func idEmpresa(ctx context.Context, tx pgx.Tx, nombre string) (int64, error) {
	var id int64
	err := tx.QueryRow(ctx, `INSERT INTO empresas (nombre) VALUES ($1)
		ON CONFLICT (lower(nombre)) DO UPDATE SET nombre = empresas.nombre RETURNING id`, nombre).Scan(&id)
	return id, err
}

func (a *App) listarEmpresas(w http.ResponseWriter, r *http.Request, _ *Operador) error {
	filas, err := a.db.Query(r.Context(), `SELECT e.nombre, count(r.id)
		FROM empresas e LEFT JOIN routers r ON r.empresa_id = e.id
		GROUP BY e.id ORDER BY lower(e.nombre)`)
	if err != nil {
		return err
	}
	defer filas.Close()
	type empresa struct {
		Nombre  string `json:"nombre"`
		Routers int    `json:"routers"`
	}
	lista := []empresa{}
	for filas.Next() {
		var e empresa
		if err := filas.Scan(&e.Nombre, &e.Routers); err != nil {
			return err
		}
		lista = append(lista, e)
	}
	if err := filas.Err(); err != nil {
		return err
	}
	escribirJSON(w, http.StatusOK, lista)
	return nil
}

// guardarRedes sustituye las redes de un router dentro de una transacción.
func guardarRedes(ctx context.Context, tx pgx.Tx, routerID int64, redes []netip.Prefix) error {
	if _, err := tx.Exec(ctx, `DELETE FROM router_redes WHERE router_id = $1`, routerID); err != nil {
		return err
	}
	for _, red := range redes {
		var nombre, otra string
		err := tx.QueryRow(ctx, `SELECT r.nombre, text(rr.red)
			FROM router_redes rr JOIN routers r ON r.id = rr.router_id
			WHERE rr.red && $1::inet LIMIT 1`, red.String()).Scan(&nombre, &otra)
		if err == nil {
			return conflicto(fmt.Sprintf(
				"La red %s se superpone con %s del router «%s». Dos routers no pueden compartir dirección de origen.",
				red, otra, nombre))
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO router_redes (router_id, red) VALUES ($1, $2::inet)`,
			routerID, red.String()); err != nil {
			if errorPG(err, "23P01") {
				return conflicto(fmt.Sprintf("La red %s se superpone con la de otro router.", red))
			}
			return err
		}
	}
	return nil
}

func validarRouter(in *routerEntrada) ([]netip.Prefix, error) {
	in.Nombre = strings.TrimSpace(in.Nombre)
	in.Descripcion = strings.TrimSpace(in.Descripcion)
	if !reNombreRouter.MatchString(in.Nombre) {
		return nil, malo("El nombre admite letras, números, espacios, punto, guion y guion bajo (máximo 63 caracteres).")
	}
	if len(in.Descripcion) > 200 {
		return nil, malo("La descripción es demasiado larga.")
	}
	in.Empresa = strings.TrimSpace(in.Empresa)
	if !reNombreRouter.MatchString(in.Empresa) {
		return nil, malo("Indica la empresa a la que pertenece el router (letras, números, espacios, punto, guion y guion bajo).")
	}
	return normalizarRedes(in.Redes)
}

func (a *App) crearRouter(w http.ResponseWriter, r *http.Request, op *Operador) error {
	var in routerEntrada
	if err := leerJSON(w, r, &in); err != nil {
		return err
	}
	redes, err := validarRouter(&in)
	if err != nil {
		return err
	}
	secreto, generado := in.Secreto, false
	if secreto == "" {
		secreto, generado = aleatorioHex(24), true
	} else if err := validarSecreto(secreto); err != nil {
		return err
	}
	cifrado, err := a.cifra.Cifrar([]byte(secreto), dominioSecreto)
	if err != nil {
		return err
	}
	activo := in.Activo == nil || *in.Activo
	exigir := in.ExigirMA == nil || *in.ExigirMA

	ctx := r.Context()
	var id int64
	err = pgx.BeginFunc(ctx, a.db, func(tx pgx.Tx) error {
		empresaID, err := idEmpresa(ctx, tx, in.Empresa)
		if err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `INSERT INTO routers
			(nombre, descripcion, activo, secreto_cifrado, exigir_message_authenticator, empresa_id)
			VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
			in.Nombre, in.Descripcion, activo, cifrado, exigir, empresaID).Scan(&id); err != nil {
			if errorPG(err, "23505") {
				return conflicto("Ya existe un router con ese nombre.")
			}
			return err
		}
		return guardarRedes(ctx, tx, id, redes)
	})
	if err != nil {
		return err
	}
	a.auditar(ctx, op.Usuario, ipCliente(r), "router.creado", in.Nombre,
		map[string]any{"empresa": in.Empresa, "redes": len(redes), "secreto_generado": generado})
	ro, err := a.routerPorID(ctx, id)
	if err != nil {
		return err
	}
	salida := map[string]any{"router": ro}
	if generado {
		salida["secreto_generado"] = secreto
		salida["script_rsc"] = a.scriptRouter(secreto)
	}
	escribirJSON(w, http.StatusCreated, salida)
	return nil
}

func (a *App) editarRouter(w http.ResponseWriter, r *http.Request, op *Operador) error {
	id, err := idRuta(r)
	if err != nil {
		return err
	}
	var in routerEntrada
	if err := leerJSON(w, r, &in); err != nil {
		return err
	}
	redes, err := validarRouter(&in)
	if err != nil {
		return err
	}
	if in.Secreto != "" {
		return malo("El secreto se cambia con la acción de rotar, no al editar.")
	}
	activo := in.Activo == nil || *in.Activo
	exigir := in.ExigirMA == nil || *in.ExigirMA

	ctx := r.Context()
	err = pgx.BeginFunc(ctx, a.db, func(tx pgx.Tx) error {
		empresaID, err := idEmpresa(ctx, tx, in.Empresa)
		if err != nil {
			return err
		}
		ct, err := tx.Exec(ctx, `UPDATE routers SET nombre = $2, descripcion = $3, activo = $4,
			exigir_message_authenticator = $5, empresa_id = $6, actualizado = now() WHERE id = $1`,
			id, in.Nombre, in.Descripcion, activo, exigir, empresaID)
		if err != nil {
			if errorPG(err, "23505") {
				return conflicto("Ya existe un router con ese nombre.")
			}
			return err
		}
		if ct.RowsAffected() == 0 {
			return noEncontrado()
		}
		return guardarRedes(ctx, tx, id, redes)
	})
	if err != nil {
		return err
	}
	a.auditar(ctx, op.Usuario, ipCliente(r), "router.editado", in.Nombre,
		map[string]any{"redes": len(redes), "activo": activo})
	ro, err := a.routerPorID(ctx, id)
	if err != nil {
		return err
	}
	escribirJSON(w, http.StatusOK, map[string]any{"router": ro})
	return nil
}

func (a *App) borrarRouter(w http.ResponseWriter, r *http.Request, op *Operador) error {
	id, err := idRuta(r)
	if err != nil {
		return err
	}
	var nombre string
	err = a.db.QueryRow(r.Context(), `DELETE FROM routers WHERE id = $1 RETURNING nombre`, id).Scan(&nombre)
	if errors.Is(err, pgx.ErrNoRows) {
		return noEncontrado()
	}
	if err != nil {
		return err
	}
	a.auditar(r.Context(), op.Usuario, ipCliente(r), "router.eliminado", nombre, nil)
	escribirJSON(w, http.StatusOK, map[string]any{"ok": true})
	return nil
}

func (a *App) rotarSecreto(w http.ResponseWriter, r *http.Request, op *Operador) error {
	id, err := idRuta(r)
	if err != nil {
		return err
	}
	var in struct {
		Secreto string `json:"secreto"`
	}
	if err := leerJSON(w, r, &in); err != nil {
		return err
	}
	secreto, generado := in.Secreto, false
	if secreto == "" {
		secreto, generado = aleatorioHex(24), true
	} else if err := validarSecreto(secreto); err != nil {
		return err
	}
	cifrado, err := a.cifra.Cifrar([]byte(secreto), dominioSecreto)
	if err != nil {
		return err
	}
	ctx := r.Context()
	var nombre string
	err = a.db.QueryRow(ctx, `UPDATE routers SET secreto_cifrado = $2, secreto_rotado = now(),
		actualizado = now() WHERE id = $1 RETURNING nombre`, id, cifrado).Scan(&nombre)
	if errors.Is(err, pgx.ErrNoRows) {
		return noEncontrado()
	}
	if err != nil {
		return err
	}
	a.auditar(ctx, op.Usuario, ipCliente(r), "router.secreto_rotado", nombre,
		map[string]any{"secreto_generado": generado})
	ro, err := a.routerPorID(ctx, id)
	if err != nil {
		return err
	}
	salida := map[string]any{"router": ro}
	if generado {
		salida["secreto_generado"] = secreto
		salida["script_rsc"] = a.scriptRouter(secreto)
	}
	escribirJSON(w, http.StatusOK, salida)
	return nil
}
