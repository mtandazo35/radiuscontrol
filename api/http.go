package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const cookieSesion = "rc_sesion"

type Operador struct {
	ID      int64  `json:"-"`
	Usuario string `json:"usuario"`
	Rol     string `json:"rol"`
}

type errHTTP struct {
	codigo int
	msg    string
	extra  map[string]any
}

func (e *errHTTP) Error() string { return e.msg }

func malo(msg string) error      { return &errHTTP{codigo: http.StatusBadRequest, msg: msg} }
func conflicto(msg string) error { return &errHTTP{codigo: http.StatusConflict, msg: msg} }
func noEncontrado() error {
	return &errHTTP{codigo: http.StatusNotFound, msg: "El elemento no existe."}
}

func errorPG(err error, codigo string) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == codigo
}

func escribirJSON(w http.ResponseWriter, codigo int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(codigo)
	_ = json.NewEncoder(w).Encode(v)
}

func leerJSON(w http.ResponseWriter, r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return malo("El cuerpo de la solicitud no es válido.")
	}
	return nil
}

func responderError(w http.ResponseWriter, err error) {
	var e *errHTTP
	if errors.As(err, &e) {
		cuerpo := map[string]any{"error": e.msg}
		for k, v := range e.extra {
			cuerpo[k] = v
		}
		escribirJSON(w, e.codigo, cuerpo)
		return
	}
	log.Printf("error interno: %v", err)
	escribirJSON(w, http.StatusInternalServerError, map[string]any{"error": "Error interno del servidor."})
}

func ipCliente(r *http.Request) string {
	// La API solo escucha en el equipo local, detrás del proxy del panel.
	if x := r.Header.Get("X-Forwarded-For"); x != "" {
		return strings.TrimSpace(strings.Split(x, ",")[0])
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func idRuta(r *http.Request) (int64, error) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		return 0, noEncontrado()
	}
	return id, nil
}

func (a *App) publico(h func(http.ResponseWriter, *http.Request) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-RC") != "1" {
			responderError(w, &errHTTP{codigo: http.StatusForbidden, msg: "Solicitud no permitida."})
			return
		}
		if err := h(w, r); err != nil {
			responderError(w, err)
		}
	}
}

type manejador func(http.ResponseWriter, *http.Request, *Operador) error

func (a *App) privado(h manejador) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// La cabecera propia impide que otra página lance cambios con la sesión abierta.
		if r.Method != http.MethodGet && r.Header.Get("X-RC") != "1" {
			responderError(w, &errHTTP{codigo: http.StatusForbidden, msg: "Solicitud no permitida."})
			return
		}
		op, err := a.operadorDeSesion(r)
		if err != nil {
			responderError(w, err)
			return
		}
		if err := h(w, r, op); err != nil {
			responderError(w, err)
		}
	}
}

func hashToken(token string) []byte {
	s := sha256.Sum256([]byte(token))
	return s[:]
}

func (a *App) operadorDeSesion(r *http.Request) (*Operador, error) {
	sinSesion := &errHTTP{codigo: http.StatusUnauthorized, msg: "Sesión no iniciada o caducada."}
	c, err := r.Cookie(cookieSesion)
	if err != nil || c.Value == "" {
		return nil, sinSesion
	}
	var op Operador
	err = a.db.QueryRow(r.Context(), `
		SELECT o.id, o.usuario, o.rol
		FROM sesiones s JOIN operadores o ON o.id = s.operador_id
		WHERE s.token_hash = $1 AND s.expira > now() AND o.activo`,
		hashToken(c.Value)).Scan(&op.ID, &op.Usuario, &op.Rol)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, sinSesion
	}
	if err != nil {
		return nil, err
	}
	return &op, nil
}

func (a *App) auditar(ctx context.Context, operador, ip, accion, objeto string, detalle map[string]any) {
	if detalle == nil {
		detalle = map[string]any{}
	}
	j, _ := json.Marshal(detalle)
	if _, err := a.db.Exec(ctx, `INSERT INTO auditoria (operador, ip, accion, objeto, detalle)
		VALUES ($1, $2, $3, $4, $5::jsonb)`, operador, ip, accion, objeto, string(j)); err != nil {
		log.Printf("no se pudo registrar la auditoría (%s %s): %v", accion, objeto, err)
	}
}

func (a *App) iniciarSesion(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Usuario string `json:"usuario"`
		Clave   string `json:"clave"`
	}
	if err := leerJSON(w, r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	ip := ipCliente(r)
	incorrecto := &errHTTP{codigo: http.StatusUnauthorized, msg: "Usuario o contraseña incorrectos."}

	var id int64
	var hash, rol string
	var activo bool
	var bloqueado *time.Time
	err := a.db.QueryRow(ctx, `SELECT id, clave_hash, rol, activo, bloqueado_hasta
		FROM operadores WHERE usuario = $1`, in.Usuario).Scan(&id, &hash, &rol, &activo, &bloqueado)
	if errors.Is(err, pgx.ErrNoRows) {
		verificarArgon2(in.Clave, a.senuelo)
		a.auditar(ctx, in.Usuario, ip, "sesion.fallida", "operador", map[string]any{"motivo": "usuario desconocido"})
		return incorrecto
	}
	if err != nil {
		return err
	}
	if bloqueado != nil && bloqueado.After(time.Now()) {
		a.auditar(ctx, in.Usuario, ip, "sesion.fallida", "operador", map[string]any{"motivo": "cuenta bloqueada"})
		return &errHTTP{codigo: http.StatusTooManyRequests,
			msg: "La cuenta está bloqueada temporalmente por intentos fallidos. Inténtalo más tarde."}
	}
	if !verificarArgon2(in.Clave, hash) || !activo {
		if _, err := a.db.Exec(ctx, `UPDATE operadores SET
			intentos_fallidos = intentos_fallidos + 1,
			bloqueado_hasta = CASE WHEN intentos_fallidos + 1 >= 5
				THEN now() + interval '15 minutes' ELSE bloqueado_hasta END
			WHERE id = $1`, id); err != nil {
			return err
		}
		a.auditar(ctx, in.Usuario, ip, "sesion.fallida", "operador", map[string]any{"motivo": "contraseña incorrecta"})
		return incorrecto
	}

	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return err
	}
	token := hex.EncodeToString(b)
	expira := time.Now().Add(12 * time.Hour)
	err = pgx.BeginFunc(ctx, a.db, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE operadores SET intentos_fallidos = 0, bloqueado_hasta = NULL
			WHERE id = $1`, id); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM sesiones WHERE expira < now()`); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `INSERT INTO sesiones (token_hash, operador_id, ip, expira)
			VALUES ($1, $2, $3, $4)`, hashToken(token), id, ip, expira)
		return err
	})
	if err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{
		Name: cookieSesion, Value: token, Path: "/", Expires: expira,
		HttpOnly: true, Secure: true, SameSite: http.SameSiteStrictMode,
	})
	a.auditar(ctx, in.Usuario, ip, "sesion.iniciada", "operador", nil)
	escribirJSON(w, http.StatusOK, Operador{Usuario: in.Usuario, Rol: rol})
	return nil
}

func (a *App) verSesion(w http.ResponseWriter, r *http.Request, op *Operador) error {
	escribirJSON(w, http.StatusOK, op)
	return nil
}

func (a *App) cerrarSesion(w http.ResponseWriter, r *http.Request, op *Operador) error {
	if c, err := r.Cookie(cookieSesion); err == nil {
		if _, err := a.db.Exec(r.Context(), `DELETE FROM sesiones WHERE token_hash = $1`,
			hashToken(c.Value)); err != nil {
			return err
		}
	}
	http.SetCookie(w, &http.Cookie{Name: cookieSesion, Value: "", Path: "/", MaxAge: -1,
		HttpOnly: true, Secure: true, SameSite: http.SameSiteStrictMode})
	a.auditar(r.Context(), op.Usuario, ipCliente(r), "sesion.cerrada", "operador", nil)
	escribirJSON(w, http.StatusOK, map[string]any{"ok": true})
	return nil
}
