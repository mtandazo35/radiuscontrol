package main

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
)

// Modos de acceso de un router. En «general» entran todos los usuarios activos,
// cada uno con su grupo general. En «restringido» solo entran los asignados a
// ese router, cada uno con el grupo que tenga en él.
const (
	accesoGeneral     = "general"
	accesoRestringido = "restringido"
)

func accesoValido(modo string) bool {
	return modo == accesoGeneral || modo == accesoRestringido
}

// AccesoRouter es una asignación tal como la devuelve la API.
type AccesoRouter struct {
	UsuarioID int64  `json:"usuario_id"`
	Usuario   string `json:"usuario"`
	Grupo     string `json:"grupo"`
}

type accesoEntrada struct {
	UsuarioID int64  `json:"usuario_id"`
	Grupo     string `json:"grupo"`
}

const (
	msgAccesoNoValido   = "El modo de acceso debe ser «general» o «restringido»."
	msgUsuarioNoExiste  = "El usuario indicado no existe."
	msgUsuarioRepetido  = "Un mismo usuario no puede aparecer dos veces."
	msgCriterioDeRouter = "Elige los routers con un solo criterio: todos, una empresa o una lista."
)

// validarAccesos revisa el modo y la lista de asignaciones de un router. Que
// los usuarios existan se comprueba después, dentro de la transacción.
func validarAccesos(in *routerEntrada) error {
	in.Acceso = strings.TrimSpace(in.Acceso)
	if in.Acceso != "" && !accesoValido(in.Acceso) {
		return malo(msgAccesoNoValido)
	}
	if in.Accesos == nil {
		return nil
	}
	lista := *in.Accesos
	vistos := map[int64]bool{}
	for i := range lista {
		lista[i].Grupo = strings.TrimSpace(lista[i].Grupo)
		if err := validarGrupo(lista[i].Grupo); err != nil {
			return err
		}
		if lista[i].UsuarioID <= 0 {
			return malo(msgUsuarioNoExiste)
		}
		if vistos[lista[i].UsuarioID] {
			return malo(msgUsuarioRepetido)
		}
		vistos[lista[i].UsuarioID] = true
	}
	return nil
}

// comprobarUsuarios falla si alguno de los identificadores no corresponde a un
// usuario. Los identificadores no deben venir repetidos.
func comprobarUsuarios(ctx context.Context, tx pgx.Tx, ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	var n int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM usuarios_mikrotik WHERE id = ANY($1::bigint[])`,
		ids).Scan(&n); err != nil {
		return err
	}
	if n != len(ids) {
		return malo(msgUsuarioNoExiste)
	}
	return nil
}

// guardarAccesos deja al router con exactamente estas asignaciones.
func guardarAccesos(ctx context.Context, tx pgx.Tx, routerID int64, lista []accesoEntrada) error {
	ids := make([]int64, 0, len(lista))
	for _, ac := range lista {
		ids = append(ids, ac.UsuarioID)
	}
	if err := comprobarUsuarios(ctx, tx, ids); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM router_accesos WHERE router_id = $1`, routerID); err != nil {
		return err
	}
	for _, ac := range lista {
		if _, err := tx.Exec(ctx, `INSERT INTO router_accesos (router_id, usuario_id, grupo)
			VALUES ($1, $2, $3)`, routerID, ac.UsuarioID, ac.Grupo); err != nil {
			// El usuario se borró entre la comprobación y la inserción.
			if errorPG(err, "23503") {
				return malo(msgUsuarioNoExiste)
			}
			return err
		}
	}
	return nil
}

type masivoEntrada struct {
	Routers struct {
		Todos   bool    `json:"todos"`
		Empresa string  `json:"empresa"`
		IDs     []int64 `json:"ids"`
	} `json:"routers"`
	Usuarios []int64 `json:"usuarios"`
	Accion   string  `json:"accion"`
	Grupo    string  `json:"grupo"`
	Modo     string  `json:"modo"`
}

func sinRepetidos(ids []int64) []int64 {
	vistos := map[int64]bool{}
	salida := make([]int64, 0, len(ids))
	for _, id := range ids {
		if !vistos[id] {
			vistos[id] = true
			salida = append(salida, id)
		}
	}
	return salida
}

// routersSeleccionados devuelve los routers que cumplen el criterio, ya validado.
func routersSeleccionados(ctx context.Context, tx pgx.Tx, in *masivoEntrada) ([]int64, error) {
	var filas pgx.Rows
	var err error
	switch {
	case in.Routers.Todos:
		filas, err = tx.Query(ctx, `SELECT id FROM routers ORDER BY id`)
	case in.Routers.Empresa != "":
		filas, err = tx.Query(ctx, `SELECT r.id FROM routers r JOIN empresas e ON e.id = r.empresa_id
			WHERE lower(e.nombre) = lower($1) ORDER BY r.id`, in.Routers.Empresa)
	default:
		filas, err = tx.Query(ctx, `SELECT id FROM routers WHERE id = ANY($1::bigint[]) ORDER BY id`,
			in.Routers.IDs)
	}
	if err != nil {
		return nil, err
	}
	defer filas.Close()
	var ids []int64
	for filas.Next() {
		var id int64
		if err := filas.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := filas.Err(); err != nil {
		return nil, err
	}
	return ids, nil
}

// cambioMasivo asigna o quita usuarios, o cambia el modo de acceso, en muchos
// routers a la vez. Todo ocurre en una sola transacción.
func (a *App) cambioMasivo(w http.ResponseWriter, r *http.Request, op *Operador) error {
	var in masivoEntrada
	if err := leerJSON(w, r, &in); err != nil {
		return err
	}
	in.Routers.Empresa = strings.TrimSpace(in.Routers.Empresa)
	in.Routers.IDs = sinRepetidos(in.Routers.IDs)
	in.Usuarios = sinRepetidos(in.Usuarios)
	in.Grupo = strings.TrimSpace(in.Grupo)
	in.Modo = strings.TrimSpace(in.Modo)

	criterios, seleccion := 0, ""
	if in.Routers.Todos {
		criterios, seleccion = criterios+1, "todos"
	}
	if in.Routers.Empresa != "" {
		criterios, seleccion = criterios+1, "empresa"
	}
	if len(in.Routers.IDs) > 0 {
		criterios, seleccion = criterios+1, "lista"
	}
	if criterios != 1 {
		return malo(msgCriterioDeRouter)
	}

	if in.Modo != "" && !accesoValido(in.Modo) {
		return malo(msgAccesoNoValido)
	}
	switch in.Accion {
	case "asignar":
		if len(in.Usuarios) == 0 {
			return malo("Indica al menos un usuario.")
		}
		if err := validarGrupo(in.Grupo); err != nil {
			return err
		}
	case "quitar":
		if len(in.Usuarios) == 0 {
			return malo("Indica al menos un usuario.")
		}
		in.Grupo = ""
	case "modo":
		if in.Modo == "" {
			return malo(msgAccesoNoValido)
		}
		in.Usuarios, in.Grupo = nil, ""
	default:
		return malo("La acción debe ser «asignar», «quitar» o «modo».")
	}
	for _, id := range in.Usuarios {
		if id <= 0 {
			return malo(msgUsuarioNoExiste)
		}
	}

	ctx := r.Context()
	var routers []int64
	var asignaciones int64
	err := pgx.BeginFunc(ctx, a.db, func(tx pgx.Tx) error {
		var err error
		if routers, err = routersSeleccionados(ctx, tx, &in); err != nil {
			return err
		}
		if len(routers) == 0 {
			return malo("Ningún router coincide con la selección.")
		}
		if err := comprobarUsuarios(ctx, tx, in.Usuarios); err != nil {
			return err
		}
		switch in.Accion {
		case "asignar":
			ct, err := tx.Exec(ctx, `INSERT INTO router_accesos (router_id, usuario_id, grupo)
				SELECT ro.id, us.id, $3::text
				FROM unnest($1::bigint[]) AS ro(id) CROSS JOIN unnest($2::bigint[]) AS us(id)
				ON CONFLICT (router_id, usuario_id) DO UPDATE SET grupo = EXCLUDED.grupo`,
				routers, in.Usuarios, in.Grupo)
			if err != nil {
				if errorPG(err, "23503") {
					return malo(msgUsuarioNoExiste)
				}
				return err
			}
			asignaciones = ct.RowsAffected()
		case "quitar":
			ct, err := tx.Exec(ctx, `DELETE FROM router_accesos
				WHERE router_id = ANY($1::bigint[]) AND usuario_id = ANY($2::bigint[])`,
				routers, in.Usuarios)
			if err != nil {
				return err
			}
			asignaciones = ct.RowsAffected()
		}
		if in.Modo != "" {
			if _, err := tx.Exec(ctx, `UPDATE routers SET acceso = $2::text, actualizado = now()
				WHERE id = ANY($1::bigint[]) AND acceso <> $2::text`, routers, in.Modo); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return err
	}

	objeto := fmt.Sprintf("%d routers", len(routers))
	if len(routers) == 1 {
		objeto = "1 router"
	}
	a.auditar(ctx, op.Usuario, ipCliente(r), "accesos.cambio_masivo", objeto, map[string]any{
		"accion": in.Accion, "grupo": in.Grupo, "modo": in.Modo, "seleccion": seleccion,
		"usuarios": len(in.Usuarios), "routers": len(routers), "asignaciones": asignaciones,
	})
	escribirJSON(w, http.StatusOK, map[string]any{"routers": len(routers), "asignaciones": asignaciones})
	return nil
}
