package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
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
	ID       int64  `json:"-"`
	SesionID int64  `json:"-"`
	Usuario  string `json:"usuario"`
	Rol      string `json:"rol"`
	TOTP     bool   `json:"totp"`
	// Para la cuenta atrás del panel.
	Expira          time.Time `json:"expira"`
	MinutosInactivo int       `json:"minutos_inactividad"`
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

// admin exige el rol de administrador. Las cuentas de solo lectura pueden
// consultar, pero no cambiar nada.
func (a *App) admin(h manejador) http.HandlerFunc {
	return a.privado(func(w http.ResponseWriter, r *http.Request, op *Operador) error {
		if op.Rol != rolAdmin {
			return &errHTTP{codigo: http.StatusForbidden, msg: "Tu cuenta es de solo lectura y no puede hacer cambios."}
		}
		return h(w, r, op)
	})
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

// Una sesión sin actividad de la persona durante inactividadMax se cierra sola.
const inactividadMax = 30 * time.Minute

func (a *App) operadorDeSesion(r *http.Request) (*Operador, error) {
	sinSesion := &errHTTP{codigo: http.StatusUnauthorized, msg: "Sesión no iniciada o caducada."}
	c, err := r.Cookie(cookieSesion)
	if err != nil || c.Value == "" {
		return nil, sinSesion
	}
	ctx := r.Context()
	var op Operador
	var inactiva bool
	err = a.db.QueryRow(ctx, `
		SELECT o.id, s.id, o.usuario, o.rol, o.totp_cifrado IS NOT NULL, s.expira,
		       s.ultima_actividad < now() - $2::interval
		FROM sesiones s JOIN operadores o ON o.id = s.operador_id
		WHERE s.token_hash = $1 AND s.expira > now() AND o.activo`,
		hashToken(c.Value), inactividadMax.String()).
		Scan(&op.ID, &op.SesionID, &op.Usuario, &op.Rol, &op.TOTP, &op.Expira, &inactiva)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, sinSesion
	}
	if err != nil {
		return nil, err
	}
	if inactiva {
		a.cerrarInactivas(ctx, op.SesionID)
		return nil, &errHTTP{codigo: http.StatusUnauthorized,
			msg:   fmt.Sprintf("Tu sesión se cerró tras %d minutos sin actividad.", int(inactividadMax.Minutes())),
			extra: map[string]any{"motivo": "inactividad"}}
	}
	// Las consultas que el panel hace solo (refrescos periódicos) llevan esta
	// cabecera y no cuentan como actividad de la persona.
	if r.Header.Get("X-RC-Auto") != "1" {
		if _, err := a.db.Exec(ctx, `UPDATE sesiones SET ultima_actividad = now()
			WHERE id = $1 AND ultima_actividad < now() - interval '15 seconds'`, op.SesionID); err != nil {
			return nil, err
		}
	}
	op.MinutosInactivo = int(inactividadMax.Minutes())
	return &op, nil
}

// cerrarInactivas cierra las sesiones que llevan demasiado tiempo sin
// actividad y lo deja anotado. Con sesionID distinto de cero, solo esa.
func (a *App) cerrarInactivas(ctx context.Context, sesionID int64) {
	filas, err := a.db.Query(ctx, `DELETE FROM sesiones s USING operadores o
		WHERE o.id = s.operador_id AND s.ultima_actividad < now() - $1::interval AND ($2 = 0 OR s.id = $2)
		RETURNING o.usuario, s.ip, s.ultima_actividad`, inactividadMax.String(), sesionID)
	if err != nil {
		log.Printf("no se pudieron cerrar las sesiones inactivas: %v", err)
		return
	}
	type cerrada struct {
		usuario, ip string
		ultima      time.Time
	}
	var lista []cerrada
	for filas.Next() {
		var c cerrada
		if err := filas.Scan(&c.usuario, &c.ip, &c.ultima); err == nil {
			lista = append(lista, c)
		}
	}
	filas.Close()
	for _, c := range lista {
		a.auditar(ctx, c.usuario, c.ip, "sesion.cerrada_por_inactividad", "operador", map[string]any{
			"motivo":           fmt.Sprintf("más de %d minutos sin actividad", int(inactividadMax.Minutes())),
			"ultima_actividad": c.ultima.UTC().Format(time.RFC3339),
		})
	}
}

// bucleSesiones cierra las sesiones inactivas aunque nadie vuelva a usarlas.
func (a *App) bucleSesiones(ctx context.Context) {
	for {
		a.cerrarInactivas(ctx, 0)
		time.Sleep(30 * time.Second)
	}
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
		Codigo  string `json:"codigo"`
	}
	if err := leerJSON(w, r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	ip := ipCliente(r)
	incorrecto := &errHTTP{codigo: http.StatusUnauthorized, msg: "Usuario o contraseña incorrectos."}

	// Una dirección bloqueada no llega a probar ninguna contraseña.
	queda, err := a.ipBloqueada(ctx, ip)
	if err != nil {
		return err
	}
	if queda > 0 {
		return errorBloqueoIP(queda)
	}

	var id, totpUltimo int64
	var hash, rol, usuario string
	var activo bool
	var bloqueado *time.Time
	var totpCifrado []byte
	err = a.db.QueryRow(ctx, `SELECT id, usuario, clave_hash, rol, activo, bloqueado_hasta, totp_cifrado, totp_ultimo
		FROM operadores WHERE lower(usuario) = lower($1)`, in.Usuario).
		Scan(&id, &usuario, &hash, &rol, &activo, &bloqueado, &totpCifrado, &totpUltimo)
	if errors.Is(err, pgx.ErrNoRows) {
		verificarArgon2(in.Clave, a.senuelo)
		a.auditar(ctx, in.Usuario, ip, "sesion.fallida", "operador", map[string]any{"motivo": "usuario desconocido"})
		a.registrarFalloIP(ctx, ip)
		return incorrecto
	}
	if err != nil {
		return err
	}
	if bloqueado != nil && bloqueado.After(time.Now()) {
		a.auditar(ctx, usuario, ip, "sesion.fallida", "operador", map[string]any{"motivo": "cuenta bloqueada"})
		a.registrarFalloIP(ctx, ip)
		return &errHTTP{codigo: http.StatusTooManyRequests,
			msg: "Esta cuenta está bloqueada temporalmente por intentos fallidos. Inténtalo más tarde o pide a un administrador que la desbloquee."}
	}
	fallo := func(motivo string) error {
		_, err := a.db.Exec(ctx, `UPDATE operadores SET
			intentos_fallidos = intentos_fallidos + 1,
			bloqueado_hasta = CASE WHEN intentos_fallidos + 1 >= $2
				THEN now() + make_interval(mins => $3) ELSE bloqueado_hasta END
			WHERE id = $1`, id, intentosTope, minutosBloque)
		a.auditar(ctx, usuario, ip, "sesion.fallida", "operador", map[string]any{"motivo": motivo})
		a.registrarFalloIP(ctx, ip)
		return err
	}
	if !verificarArgon2(in.Clave, hash) || !activo {
		if err := fallo("contraseña incorrecta"); err != nil {
			return err
		}
		return incorrecto
	}

	// Segundo factor, si la cuenta lo tiene activado.
	contador := totpUltimo
	if totpCifrado != nil {
		pideCodigo := map[string]any{"requiere_codigo": true}
		if strings.TrimSpace(in.Codigo) == "" {
			return &errHTTP{codigo: http.StatusUnauthorized,
				msg: "Introduce el código de tu aplicación de autenticación.", extra: pideCodigo}
		}
		secreto, err := a.cifra.Descifrar(totpCifrado, dominioTOTP)
		if err != nil {
			return err
		}
		c, ok := verificarTOTP(secreto, in.Codigo, time.Now(), totpUltimo)
		if !ok {
			if err := fallo("código incorrecto"); err != nil {
				return err
			}
			return &errHTTP{codigo: http.StatusUnauthorized, msg: "El código no es correcto.", extra: pideCodigo}
		}
		contador = c
	}

	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return err
	}
	token := hex.EncodeToString(b)
	expira := time.Now().Add(12 * time.Hour)
	err = pgx.BeginFunc(ctx, a.db, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE operadores SET intentos_fallidos = 0, bloqueado_hasta = NULL,
			ultimo_acceso = now(), totp_ultimo = $2 WHERE id = $1`, id, contador); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM sesiones WHERE expira < now()`); err != nil {
			return err
		}
		// Un acceso correcto borra los intentos fallidos anteriores de esa dirección.
		if _, err := tx.Exec(ctx, `DELETE FROM intentos_ip WHERE ip = $1`, ip); err != nil {
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
	a.auditar(ctx, usuario, ip, "sesion.iniciada", "operador", map[string]any{"doble_factor": totpCifrado != nil})
	escribirJSON(w, http.StatusOK, Operador{Usuario: usuario, Rol: rol, TOTP: totpCifrado != nil,
		Expira: expira, MinutosInactivo: int(inactividadMax.Minutes())})
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
