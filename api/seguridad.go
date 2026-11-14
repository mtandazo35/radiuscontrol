package main

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1" //nolint:gosec // TOTP (RFC 6238) usa HMAC-SHA1.
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

const (
	dominioTOTP   = "panel-totp"
	rolAdmin      = "administrador"
	rolLectura    = "lectura"
	periodoTOTP   = 30
	intentosTope  = 5
	minutosBloque = 15
)

var base32SinRelleno = base32.StdEncoding.WithPadding(base32.NoPadding)

// codigoTOTP calcula el código de 6 cifras de RFC 6238 para un contador.
func codigoTOTP(secreto []byte, contador uint64) string {
	var b [8]byte
	binary.BigEndian.PutUint64(b[:], contador)
	mac := hmac.New(sha1.New, secreto)
	mac.Write(b[:])
	h := mac.Sum(nil)
	pos := h[len(h)-1] & 0x0f
	valor := binary.BigEndian.Uint32(h[pos:pos+4]) & 0x7fffffff
	return fmt.Sprintf("%06d", valor%1000000)
}

// verificarTOTP acepta el código del periodo actual, el anterior o el
// siguiente, y nunca uno de un periodo ya usado: un código no sirve dos veces.
func verificarTOTP(secreto []byte, codigo string, ahora time.Time, ultimo int64) (int64, bool) {
	codigo = strings.ReplaceAll(strings.TrimSpace(codigo), " ", "")
	if len(codigo) != 6 {
		return 0, false
	}
	actual := ahora.Unix() / periodoTOTP
	for _, c := range []int64{actual - 1, actual, actual + 1} {
		if c <= ultimo {
			continue
		}
		if subtle.ConstantTimeCompare([]byte(codigoTOTP(secreto, uint64(c))), []byte(codigo)) == 1 {
			return c, true
		}
	}
	return 0, false
}

func validarClavePanel(c string) error {
	if !utf8.ValidString(c) || utf8.RuneCountInString(c) < 12 || len(c) > 128 {
		return malo("La contraseña del panel debe tener entre 12 y 128 caracteres.")
	}
	return nil
}

func validarRol(r string) error {
	if r != rolAdmin && r != rolLectura {
		return malo("El rol debe ser «administrador» o «lectura».")
	}
	return nil
}

// ------------------------------------------------------------------ mi cuenta

func (a *App) cambiarMiClave(w http.ResponseWriter, r *http.Request, op *Operador) error {
	var in struct {
		Actual string `json:"actual"`
		Nueva  string `json:"nueva"`
	}
	if err := leerJSON(w, r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	var hash string
	if err := a.db.QueryRow(ctx, `SELECT clave_hash FROM operadores WHERE id = $1`, op.ID).Scan(&hash); err != nil {
		return err
	}
	if !verificarArgon2(in.Actual, hash) {
		a.auditar(ctx, op.Usuario, ipCliente(r), "cuenta.clave_rechazada", op.Usuario, nil)
		return malo("La contraseña actual no es correcta.")
	}
	if err := validarClavePanel(in.Nueva); err != nil {
		return err
	}
	if in.Nueva == in.Actual {
		return malo("La contraseña nueva debe ser distinta de la actual.")
	}
	nuevo, err := hashArgon2(in.Nueva)
	if err != nil {
		return err
	}
	err = pgx.BeginFunc(ctx, a.db, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE operadores SET clave_hash = $2, clave_cambiada = now() WHERE id = $1`,
			op.ID, nuevo); err != nil {
			return err
		}
		// Las demás sesiones de esta cuenta dejan de valer.
		_, err := tx.Exec(ctx, `DELETE FROM sesiones WHERE operador_id = $1 AND id <> $2`, op.ID, op.SesionID)
		return err
	})
	if err != nil {
		return err
	}
	a.auditar(ctx, op.Usuario, ipCliente(r), "cuenta.clave_cambiada", op.Usuario, nil)
	escribirJSON(w, http.StatusOK, map[string]any{"ok": true})
	return nil
}

func (a *App) iniciarTOTP(w http.ResponseWriter, r *http.Request, op *Operador) error {
	ctx := r.Context()
	if op.TOTP {
		return conflicto("El doble factor ya está activado. Desactívalo antes de generar otro.")
	}
	secreto := make([]byte, 20)
	if _, err := rand.Read(secreto); err != nil {
		return err
	}
	cifrado, err := a.cifra.Cifrar(secreto, dominioTOTP)
	if err != nil {
		return err
	}
	if _, err := a.db.Exec(ctx, `UPDATE operadores SET totp_pendiente_cifrado = $2 WHERE id = $1`,
		op.ID, cifrado); err != nil {
		return err
	}
	texto := base32SinRelleno.EncodeToString(secreto)
	uri := fmt.Sprintf("otpauth://totp/%s?secret=%s&issuer=RadiusControl&algorithm=SHA1&digits=6&period=%d",
		url.PathEscape("RadiusControl:"+op.Usuario), texto, periodoTOTP)
	escribirJSON(w, http.StatusOK, map[string]any{"secreto": texto, "uri": uri})
	return nil
}

func (a *App) confirmarTOTP(w http.ResponseWriter, r *http.Request, op *Operador) error {
	var in struct {
		Codigo string `json:"codigo"`
	}
	if err := leerJSON(w, r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	var pendiente []byte
	if err := a.db.QueryRow(ctx, `SELECT totp_pendiente_cifrado FROM operadores WHERE id = $1`, op.ID).
		Scan(&pendiente); err != nil {
		return err
	}
	if pendiente == nil {
		return malo("No hay ningún doble factor pendiente de confirmar.")
	}
	secreto, err := a.cifra.Descifrar(pendiente, dominioTOTP)
	if err != nil {
		return err
	}
	contador, ok := verificarTOTP(secreto, in.Codigo, time.Now(), 0)
	if !ok {
		return malo("El código no es correcto. Comprueba la hora del teléfono e inténtalo con el código siguiente.")
	}
	if _, err := a.db.Exec(ctx, `UPDATE operadores SET totp_cifrado = totp_pendiente_cifrado,
		totp_pendiente_cifrado = NULL, totp_ultimo = $2 WHERE id = $1`, op.ID, contador); err != nil {
		return err
	}
	a.auditar(ctx, op.Usuario, ipCliente(r), "cuenta.doble_factor_activado", op.Usuario, nil)
	escribirJSON(w, http.StatusOK, map[string]any{"ok": true})
	return nil
}

func (a *App) desactivarTOTP(w http.ResponseWriter, r *http.Request, op *Operador) error {
	var in struct {
		Clave string `json:"clave"`
	}
	if err := leerJSON(w, r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	var hash string
	if err := a.db.QueryRow(ctx, `SELECT clave_hash FROM operadores WHERE id = $1`, op.ID).Scan(&hash); err != nil {
		return err
	}
	if !verificarArgon2(in.Clave, hash) {
		return malo("La contraseña no es correcta.")
	}
	if _, err := a.db.Exec(ctx, `UPDATE operadores SET totp_cifrado = NULL, totp_pendiente_cifrado = NULL,
		totp_ultimo = 0 WHERE id = $1`, op.ID); err != nil {
		return err
	}
	a.auditar(ctx, op.Usuario, ipCliente(r), "cuenta.doble_factor_desactivado", op.Usuario, nil)
	escribirJSON(w, http.StatusOK, map[string]any{"ok": true})
	return nil
}

// ------------------------------------------------------------------ operadores

type OperadorDetalle struct {
	ID             int64      `json:"id"`
	Usuario        string     `json:"usuario"`
	Rol            string     `json:"rol"`
	Activo         bool       `json:"activo"`
	TOTP           bool       `json:"totp"`
	Bloqueado      bool       `json:"bloqueado"`
	UltimoAcceso   *time.Time `json:"ultimo_acceso"`
	ClaveCambiada  time.Time  `json:"clave_cambiada"`
	Creado         time.Time  `json:"creado"`
	SesionesVivas  int        `json:"sesiones"`
	IntentosFallos int        `json:"intentos_fallidos"`
}

const consultaOperadores = `SELECT o.id, o.usuario, o.rol, o.activo, o.totp_cifrado IS NOT NULL,
	COALESCE(o.bloqueado_hasta > now(), false), o.ultimo_acceso, o.clave_cambiada, o.creado,
	(SELECT count(*) FROM sesiones s WHERE s.operador_id = o.id AND s.expira > now()), o.intentos_fallidos
	FROM operadores o`

func leerOperador(fila pgx.Row) (*OperadorDetalle, error) {
	var o OperadorDetalle
	if err := fila.Scan(&o.ID, &o.Usuario, &o.Rol, &o.Activo, &o.TOTP, &o.Bloqueado, &o.UltimoAcceso,
		&o.ClaveCambiada, &o.Creado, &o.SesionesVivas, &o.IntentosFallos); err != nil {
		return nil, err
	}
	return &o, nil
}

func (a *App) operadorPorID(ctx context.Context, id int64) (*OperadorDetalle, error) {
	o, err := leerOperador(a.db.QueryRow(ctx, consultaOperadores+` WHERE o.id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, noEncontrado()
	}
	return o, err
}

func (a *App) listarOperadores(w http.ResponseWriter, r *http.Request, _ *Operador) error {
	filas, err := a.db.Query(r.Context(), consultaOperadores+` ORDER BY lower(o.usuario)`)
	if err != nil {
		return err
	}
	defer filas.Close()
	lista := []*OperadorDetalle{}
	for filas.Next() {
		o, err := leerOperador(filas)
		if err != nil {
			return err
		}
		lista = append(lista, o)
	}
	if err := filas.Err(); err != nil {
		return err
	}
	escribirJSON(w, http.StatusOK, lista)
	return nil
}

// otrosAdministradores cuenta los administradores activos distintos de id. El
// panel nunca debe quedarse sin ninguno.
func otrosAdministradores(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, id int64) (int, error) {
	var n int
	err := q.QueryRow(ctx, `SELECT count(*) FROM operadores WHERE activo AND rol = $1 AND id <> $2`,
		rolAdmin, id).Scan(&n)
	return n, err
}

func (a *App) crearOperador(w http.ResponseWriter, r *http.Request, op *Operador) error {
	var in struct {
		Usuario string `json:"usuario"`
		Rol     string `json:"rol"`
	}
	if err := leerJSON(w, r, &in); err != nil {
		return err
	}
	in.Usuario = strings.TrimSpace(in.Usuario)
	if !reUsuario.MatchString(in.Usuario) {
		return malo("El usuario admite letras, números, punto, guion, guion bajo y arroba (máximo 64 caracteres).")
	}
	if err := validarRol(in.Rol); err != nil {
		return err
	}
	clave := aleatorioHex(10)
	hash, err := hashArgon2(clave)
	if err != nil {
		return err
	}
	ctx := r.Context()
	var id int64
	err = a.db.QueryRow(ctx, `INSERT INTO operadores (usuario, clave_hash, rol) VALUES ($1, $2, $3) RETURNING id`,
		in.Usuario, hash, in.Rol).Scan(&id)
	if err != nil {
		if errorPG(err, "23505") {
			return conflicto("Ya existe un operador con ese usuario.")
		}
		return err
	}
	a.auditar(ctx, op.Usuario, ipCliente(r), "operador.creado", in.Usuario, map[string]any{"rol": in.Rol})
	o, err := a.operadorPorID(ctx, id)
	if err != nil {
		return err
	}
	escribirJSON(w, http.StatusCreated, map[string]any{"operador": o, "clave_generada": clave})
	return nil
}

func (a *App) editarOperador(w http.ResponseWriter, r *http.Request, op *Operador) error {
	id, err := idRuta(r)
	if err != nil {
		return err
	}
	var in struct {
		Rol    string `json:"rol"`
		Activo *bool  `json:"activo"`
	}
	if err := leerJSON(w, r, &in); err != nil {
		return err
	}
	if err := validarRol(in.Rol); err != nil {
		return err
	}
	activo := in.Activo == nil || *in.Activo
	ctx := r.Context()
	var usuario string
	err = pgx.BeginFunc(ctx, a.db, func(tx pgx.Tx) error {
		if !activo || in.Rol != rolAdmin {
			if id == op.ID {
				return malo("No puedes suspender tu propia cuenta ni quitarte el rol de administrador.")
			}
			otros, err := otrosAdministradores(ctx, tx, id)
			if err != nil {
				return err
			}
			if otros == 0 {
				return malo("Debe quedar al menos un administrador activo.")
			}
		}
		err := tx.QueryRow(ctx, `UPDATE operadores SET rol = $2, activo = $3 WHERE id = $1 RETURNING usuario`,
			id, in.Rol, activo).Scan(&usuario)
		if errors.Is(err, pgx.ErrNoRows) {
			return noEncontrado()
		}
		if err != nil {
			return err
		}
		if !activo {
			_, err = tx.Exec(ctx, `DELETE FROM sesiones WHERE operador_id = $1`, id)
		}
		return err
	})
	if err != nil {
		return err
	}
	a.auditar(ctx, op.Usuario, ipCliente(r), "operador.editado", usuario, map[string]any{"rol": in.Rol, "activo": activo})
	o, err := a.operadorPorID(ctx, id)
	if err != nil {
		return err
	}
	escribirJSON(w, http.StatusOK, map[string]any{"operador": o})
	return nil
}

func (a *App) borrarOperador(w http.ResponseWriter, r *http.Request, op *Operador) error {
	id, err := idRuta(r)
	if err != nil {
		return err
	}
	if id == op.ID {
		return malo("No puedes eliminar tu propia cuenta.")
	}
	ctx := r.Context()
	var usuario string
	err = pgx.BeginFunc(ctx, a.db, func(tx pgx.Tx) error {
		otros, err := otrosAdministradores(ctx, tx, id)
		if err != nil {
			return err
		}
		if otros == 0 {
			return malo("Debe quedar al menos un administrador activo.")
		}
		err = tx.QueryRow(ctx, `DELETE FROM operadores WHERE id = $1 RETURNING usuario`, id).Scan(&usuario)
		if errors.Is(err, pgx.ErrNoRows) {
			return noEncontrado()
		}
		return err
	})
	if err != nil {
		return err
	}
	a.auditar(ctx, op.Usuario, ipCliente(r), "operador.eliminado", usuario, nil)
	escribirJSON(w, http.StatusOK, map[string]any{"ok": true})
	return nil
}

// restablecerOperador genera una contraseña nueva, quita el bloqueo y cierra
// las sesiones de esa cuenta.
func (a *App) restablecerOperador(w http.ResponseWriter, r *http.Request, op *Operador) error {
	id, err := idRuta(r)
	if err != nil {
		return err
	}
	clave := aleatorioHex(10)
	hash, err := hashArgon2(clave)
	if err != nil {
		return err
	}
	ctx := r.Context()
	var usuario string
	err = pgx.BeginFunc(ctx, a.db, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `UPDATE operadores SET clave_hash = $2, clave_cambiada = now(),
			intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = $1 RETURNING usuario`, id, hash).Scan(&usuario)
		if errors.Is(err, pgx.ErrNoRows) {
			return noEncontrado()
		}
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `DELETE FROM sesiones WHERE operador_id = $1 AND id <> $2`, id, op.SesionID)
		return err
	})
	if err != nil {
		return err
	}
	a.auditar(ctx, op.Usuario, ipCliente(r), "operador.clave_restablecida", usuario, nil)
	escribirJSON(w, http.StatusOK, map[string]any{"clave_generada": clave})
	return nil
}

func (a *App) desbloquearOperador(w http.ResponseWriter, r *http.Request, op *Operador) error {
	id, err := idRuta(r)
	if err != nil {
		return err
	}
	var usuario string
	err = a.db.QueryRow(r.Context(), `UPDATE operadores SET intentos_fallidos = 0, bloqueado_hasta = NULL
		WHERE id = $1 RETURNING usuario`, id).Scan(&usuario)
	if errors.Is(err, pgx.ErrNoRows) {
		return noEncontrado()
	}
	if err != nil {
		return err
	}
	a.auditar(r.Context(), op.Usuario, ipCliente(r), "operador.desbloqueado", usuario, nil)
	escribirJSON(w, http.StatusOK, map[string]any{"ok": true})
	return nil
}

func (a *App) quitarTOTPOperador(w http.ResponseWriter, r *http.Request, op *Operador) error {
	id, err := idRuta(r)
	if err != nil {
		return err
	}
	var usuario string
	err = a.db.QueryRow(r.Context(), `UPDATE operadores SET totp_cifrado = NULL, totp_pendiente_cifrado = NULL,
		totp_ultimo = 0 WHERE id = $1 RETURNING usuario`, id).Scan(&usuario)
	if errors.Is(err, pgx.ErrNoRows) {
		return noEncontrado()
	}
	if err != nil {
		return err
	}
	a.auditar(r.Context(), op.Usuario, ipCliente(r), "operador.doble_factor_retirado", usuario, nil)
	escribirJSON(w, http.StatusOK, map[string]any{"ok": true})
	return nil
}

// ------------------------------------------------------------------ sesiones

func (a *App) listarSesiones(w http.ResponseWriter, r *http.Request, op *Operador) error {
	// Un administrador ve todas; los demás, solo las suyas.
	filas, err := a.db.Query(r.Context(), `SELECT s.id, o.usuario, s.ip, s.creada, s.expira
		FROM sesiones s JOIN operadores o ON o.id = s.operador_id
		WHERE s.expira > now() AND ($1 OR s.operador_id = $2)
		ORDER BY s.creada DESC`, op.Rol == rolAdmin, op.ID)
	if err != nil {
		return err
	}
	defer filas.Close()
	type sesion struct {
		ID       int64     `json:"id"`
		Operador string    `json:"operador"`
		IP       string    `json:"ip"`
		Creada   time.Time `json:"creada"`
		Expira   time.Time `json:"expira"`
		Actual   bool      `json:"actual"`
	}
	lista := []sesion{}
	for filas.Next() {
		var s sesion
		if err := filas.Scan(&s.ID, &s.Operador, &s.IP, &s.Creada, &s.Expira); err != nil {
			return err
		}
		s.Actual = s.ID == op.SesionID
		lista = append(lista, s)
	}
	if err := filas.Err(); err != nil {
		return err
	}
	escribirJSON(w, http.StatusOK, lista)
	return nil
}

func (a *App) revocarSesion(w http.ResponseWriter, r *http.Request, op *Operador) error {
	id, err := idRuta(r)
	if err != nil {
		return err
	}
	var usuario string
	err = a.db.QueryRow(r.Context(), `DELETE FROM sesiones s USING operadores o
		WHERE o.id = s.operador_id AND s.id = $1 AND ($2 OR s.operador_id = $3) RETURNING o.usuario`,
		id, op.Rol == rolAdmin, op.ID).Scan(&usuario)
	if errors.Is(err, pgx.ErrNoRows) {
		return noEncontrado()
	}
	if err != nil {
		return err
	}
	a.auditar(r.Context(), op.Usuario, ipCliente(r), "sesion.revocada", usuario, nil)
	escribirJSON(w, http.StatusOK, map[string]any{"ok": true})
	return nil
}

// ------------------------------------------------------------------ actividad

func (a *App) listarAuditoria(w http.ResponseWriter, r *http.Request, _ *Operador) error {
	q := r.URL.Query()
	tamano, _ := strconv.Atoi(q.Get("tamano"))
	if tamano <= 0 || tamano > 100 {
		tamano = 25
	}
	pagina, _ := strconv.Atoi(q.Get("pagina"))
	if pagina < 1 {
		pagina = 1
	}
	buscar := strings.TrimSpace(q.Get("buscar"))
	const filtro = `$1 = '' OR operador ILIKE '%' || $1 || '%' OR accion ILIKE '%' || $1 || '%'
		OR objeto ILIKE '%' || $1 || '%' OR ip LIKE $1 || '%'`

	ctx := r.Context()
	var total int
	if err := a.db.QueryRow(ctx, `SELECT count(*) FROM auditoria WHERE `+filtro, buscar).Scan(&total); err != nil {
		return err
	}
	paginas := (total + tamano - 1) / tamano
	if paginas < 1 {
		paginas = 1
	}
	// Una página más allá del final se corrige a la última.
	if pagina > paginas {
		pagina = paginas
	}

	filas, err := a.db.Query(ctx, `SELECT id, fecha, operador, ip, accion, objeto, detalle::text
		FROM auditoria WHERE `+filtro+` ORDER BY id DESC LIMIT $2 OFFSET $3`,
		buscar, tamano, (pagina-1)*tamano)
	if err != nil {
		return err
	}
	defer filas.Close()
	type evento struct {
		ID       int64     `json:"id"`
		Fecha    time.Time `json:"fecha"`
		Operador string    `json:"operador"`
		IP       string    `json:"ip"`
		Accion   string    `json:"accion"`
		Objeto   string    `json:"objeto"`
		Detalle  string    `json:"detalle"`
	}
	lista := []evento{}
	for filas.Next() {
		var e evento
		if err := filas.Scan(&e.ID, &e.Fecha, &e.Operador, &e.IP, &e.Accion, &e.Objeto, &e.Detalle); err != nil {
			return err
		}
		lista = append(lista, e)
	}
	if err := filas.Err(); err != nil {
		return err
	}
	escribirJSON(w, http.StatusOK, map[string]any{
		"eventos": lista, "total": total, "pagina": pagina, "paginas": paginas, "tamano": tamano,
	})
	return nil
}
