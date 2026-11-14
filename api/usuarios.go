package main

import (
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

type Usuario struct {
	ID             int64     `json:"id"`
	Usuario        string    `json:"usuario"`
	NombreCompleto string    `json:"nombre_completo"`
	Grupo          string    `json:"grupo"`
	Activo         bool      `json:"activo"`
	ClaveCambiada  time.Time `json:"clave_cambiada"`
	Creado         time.Time `json:"creado"`
}

type usuarioEntrada struct {
	Usuario        string `json:"usuario"`
	NombreCompleto string `json:"nombre_completo"`
	Grupo          string `json:"grupo"`
	Activo         *bool  `json:"activo"`
	Clave          string `json:"clave"`
}

var (
	reUsuario = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$`)
	reGrupo   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$`)
)

func validarNombreUsuario(u string) error {
	if !reUsuario.MatchString(u) {
		return malo("El usuario admite letras, números, punto, guion, guion bajo y arroba (máximo 64 caracteres).")
	}
	// «DEFAULT» es una palabra reservada del archivo de usuarios de FreeRADIUS:
	// una entrada con ese nombre se aplicaría a cualquier login.
	if strings.EqualFold(u, "DEFAULT") {
		return malo("«DEFAULT» es un nombre reservado y no se puede usar.")
	}
	return nil
}

func validarGrupo(g string) error {
	if !reGrupo.MatchString(g) {
		return malo("El grupo admite letras, números, punto, guion y guion bajo (máximo 32 caracteres).")
	}
	return nil
}

func validarClaveUsuario(c string) error {
	if !utf8.ValidString(c) || utf8.RuneCountInString(c) < 8 || len(c) > 128 {
		return malo("La contraseña debe tener entre 8 y 128 caracteres.")
	}
	return nil
}

const columnasUsuario = `id, usuario, nombre_completo, grupo, activo, clave_cambiada, creado`

func leerUsuario(fila pgx.Row) (*Usuario, error) {
	var u Usuario
	if err := fila.Scan(&u.ID, &u.Usuario, &u.NombreCompleto, &u.Grupo, &u.Activo,
		&u.ClaveCambiada, &u.Creado); err != nil {
		return nil, err
	}
	return &u, nil
}

func (a *App) listarUsuarios(w http.ResponseWriter, r *http.Request, _ *Operador) error {
	filas, err := a.db.Query(r.Context(),
		`SELECT `+columnasUsuario+` FROM usuarios_mikrotik ORDER BY lower(usuario)`)
	if err != nil {
		return err
	}
	defer filas.Close()
	lista := []*Usuario{}
	for filas.Next() {
		u, err := leerUsuario(filas)
		if err != nil {
			return err
		}
		lista = append(lista, u)
	}
	if err := filas.Err(); err != nil {
		return err
	}
	escribirJSON(w, http.StatusOK, lista)
	return nil
}

// prepararClave devuelve el hash NT cifrado. La contraseña en claro no se guarda.
func (a *App) prepararClave(clave string) (cifrado []byte, usada string, generada bool, err error) {
	if clave == "" {
		clave, generada = aleatorioHex(12), true
	} else if err = validarClaveUsuario(clave); err != nil {
		return nil, "", false, err
	}
	cifrado, err = a.cifra.Cifrar([]byte(hashNT(clave)), dominioHashNT)
	return cifrado, clave, generada, err
}

func (a *App) crearUsuario(w http.ResponseWriter, r *http.Request, op *Operador) error {
	var in usuarioEntrada
	if err := leerJSON(w, r, &in); err != nil {
		return err
	}
	in.Usuario = strings.TrimSpace(in.Usuario)
	in.NombreCompleto = strings.TrimSpace(in.NombreCompleto)
	in.Grupo = strings.TrimSpace(in.Grupo)
	if err := validarNombreUsuario(in.Usuario); err != nil {
		return err
	}
	if err := validarGrupo(in.Grupo); err != nil {
		return err
	}
	if len(in.NombreCompleto) > 120 {
		return malo("El nombre completo es demasiado largo.")
	}
	cifrado, clave, generada, err := a.prepararClave(in.Clave)
	if err != nil {
		return err
	}
	activo := in.Activo == nil || *in.Activo
	u, err := leerUsuario(a.db.QueryRow(r.Context(), `INSERT INTO usuarios_mikrotik
		(usuario, nombre_completo, grupo, activo, hash_nt_cifrado)
		VALUES ($1, $2, $3, $4, $5) RETURNING `+columnasUsuario,
		in.Usuario, in.NombreCompleto, in.Grupo, activo, cifrado))
	if err != nil {
		if errorPG(err, "23505") {
			return conflicto("Ya existe un usuario con ese nombre.")
		}
		return err
	}
	a.auditar(r.Context(), op.Usuario, ipCliente(r), "usuario.creado", in.Usuario,
		map[string]any{"grupo": in.Grupo, "clave_generada": generada})
	salida := map[string]any{"usuario": u}
	if generada {
		salida["clave_generada"] = clave
	}
	escribirJSON(w, http.StatusCreated, salida)
	return nil
}

func (a *App) editarUsuario(w http.ResponseWriter, r *http.Request, op *Operador) error {
	id, err := idRuta(r)
	if err != nil {
		return err
	}
	var in usuarioEntrada
	if err := leerJSON(w, r, &in); err != nil {
		return err
	}
	in.NombreCompleto = strings.TrimSpace(in.NombreCompleto)
	in.Grupo = strings.TrimSpace(in.Grupo)
	if err := validarGrupo(in.Grupo); err != nil {
		return err
	}
	if len(in.NombreCompleto) > 120 {
		return malo("El nombre completo es demasiado largo.")
	}
	if in.Clave != "" {
		return malo("La contraseña se cambia con su propia acción, no al editar.")
	}
	activo := in.Activo == nil || *in.Activo
	u, err := leerUsuario(a.db.QueryRow(r.Context(), `UPDATE usuarios_mikrotik
		SET nombre_completo = $2, grupo = $3, activo = $4, actualizado = now()
		WHERE id = $1 RETURNING `+columnasUsuario, id, in.NombreCompleto, in.Grupo, activo))
	if errors.Is(err, pgx.ErrNoRows) {
		return noEncontrado()
	}
	if err != nil {
		return err
	}
	a.auditar(r.Context(), op.Usuario, ipCliente(r), "usuario.editado", u.Usuario,
		map[string]any{"grupo": in.Grupo, "activo": activo})
	escribirJSON(w, http.StatusOK, map[string]any{"usuario": u})
	return nil
}

func (a *App) borrarUsuario(w http.ResponseWriter, r *http.Request, op *Operador) error {
	id, err := idRuta(r)
	if err != nil {
		return err
	}
	var nombre string
	err = a.db.QueryRow(r.Context(), `DELETE FROM usuarios_mikrotik WHERE id = $1 RETURNING usuario`,
		id).Scan(&nombre)
	if errors.Is(err, pgx.ErrNoRows) {
		return noEncontrado()
	}
	if err != nil {
		return err
	}
	a.auditar(r.Context(), op.Usuario, ipCliente(r), "usuario.eliminado", nombre, nil)
	escribirJSON(w, http.StatusOK, map[string]any{"ok": true})
	return nil
}

func (a *App) cambiarClaveUsuario(w http.ResponseWriter, r *http.Request, op *Operador) error {
	id, err := idRuta(r)
	if err != nil {
		return err
	}
	var in struct {
		Clave string `json:"clave"`
	}
	if err := leerJSON(w, r, &in); err != nil {
		return err
	}
	cifrado, clave, generada, err := a.prepararClave(in.Clave)
	if err != nil {
		return err
	}
	u, err := leerUsuario(a.db.QueryRow(r.Context(), `UPDATE usuarios_mikrotik
		SET hash_nt_cifrado = $2, clave_cambiada = now(), actualizado = now()
		WHERE id = $1 RETURNING `+columnasUsuario, id, cifrado))
	if errors.Is(err, pgx.ErrNoRows) {
		return noEncontrado()
	}
	if err != nil {
		return err
	}
	a.auditar(r.Context(), op.Usuario, ipCliente(r), "usuario.clave_cambiada", u.Usuario,
		map[string]any{"clave_generada": generada})
	salida := map[string]any{"usuario": u}
	if generada {
		salida["clave_generada"] = clave
	}
	escribirJSON(w, http.StatusOK, salida)
	return nil
}
