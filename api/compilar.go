package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
)

// Datos ya descifrados que entran al compilador.
type clienteComp struct {
	RouterID int64
	RedID    int64
	Red      string
	Secreto  string
	ExigirMA bool
}

type usuarioComp struct {
	Usuario string
	Grupo   string
	HashNT  string
}

type Compilado struct {
	Clients      []byte
	Authorize    []byte
	ShaClients   string
	ShaAuthorize string
	Routers      int
	Usuarios     int
	sensibles    []string
}

func sha(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// comillaSimple escribe un valor entre comillas simples para la configuración
// de FreeRADIUS. Comprobado contra FreeRADIUS 3.2.10: entre comillas simples no
// se expanden variables y la barra invertida es literal, salvo delante de una
// comilla simple. Por eso solo se escapa la comilla, y validarSecreto rechaza
// los dos casos que así no se pueden representar.
func comillaSimple(s string) string {
	return "'" + strings.ReplaceAll(s, `'`, `\'`) + "'"
}

// renderizar genera los dos archivos de FreeRADIUS. Es determinista: los mismos
// datos producen siempre los mismos bytes, y por eso su huella sirve para
// comparar el estado deseado con el aplicado.
func renderizar(clientes []clienteComp, usuarios []usuarioComp) *Compilado {
	var c bytes.Buffer
	c.WriteString("# Generado por RadiusControl. No editar a mano.\n")
	routers := map[int64]bool{}
	var sensibles []string
	for _, cl := range clientes {
		routers[cl.RouterID] = true
		sensibles = append(sensibles, cl.Secreto)
		exigir := "no"
		if cl.ExigirMA {
			exigir = "yes"
		}
		fmt.Fprintf(&c, "\nclient rc_%d_%d {\n", cl.RouterID, cl.RedID)
		fmt.Fprintf(&c, "\tipaddr = %s\n", cl.Red)
		fmt.Fprintf(&c, "\tsecret = %s\n", comillaSimple(cl.Secreto))
		fmt.Fprintf(&c, "\tshortname = rc-%d-%d\n", cl.RouterID, cl.RedID)
		fmt.Fprintf(&c, "\trequire_message_authenticator = %s\n", exigir)
		c.WriteString("\tlimit_proxy_state = yes\n}\n")
	}

	var u bytes.Buffer
	u.WriteString("# Generado por RadiusControl. No editar a mano.\n")
	for _, us := range usuarios {
		sensibles = append(sensibles, us.HashNT)
		fmt.Fprintf(&u, "\n%s\tNT-Password := \"%s\"\n\tMikrotik-Group := \"%s\"\n", us.Usuario, us.HashNT, us.Grupo)
	}

	return &Compilado{
		Clients: c.Bytes(), Authorize: u.Bytes(),
		ShaClients: sha(c.Bytes()), ShaAuthorize: sha(u.Bytes()),
		Routers: len(routers), Usuarios: len(usuarios), sensibles: sensibles,
	}
}

// compilarDeseado lee el estado deseado de la base y lo renderiza.
func (a *App) compilarDeseado(ctx context.Context) (*Compilado, error) {
	var clientes []clienteComp
	filas, err := a.db.Query(ctx, `SELECT r.id, rr.id, text(rr.red), r.secreto_cifrado,
		r.exigir_message_authenticator
		FROM routers r JOIN router_redes rr ON rr.router_id = r.id
		WHERE r.activo ORDER BY r.id, rr.id`)
	if err != nil {
		return nil, err
	}
	for filas.Next() {
		var cl clienteComp
		var cifrado []byte
		if err := filas.Scan(&cl.RouterID, &cl.RedID, &cl.Red, &cifrado, &cl.ExigirMA); err != nil {
			filas.Close()
			return nil, err
		}
		claro, err := a.cifra.Descifrar(cifrado, dominioSecreto)
		if err != nil {
			filas.Close()
			return nil, fmt.Errorf("no se pudo descifrar el secreto del router %d: %w", cl.RouterID, err)
		}
		cl.Secreto = string(claro)
		clientes = append(clientes, cl)
	}
	filas.Close()
	if err := filas.Err(); err != nil {
		return nil, err
	}

	var usuarios []usuarioComp
	filas, err = a.db.Query(ctx, `SELECT usuario, grupo, hash_nt_cifrado
		FROM usuarios_mikrotik WHERE activo ORDER BY usuario`)
	if err != nil {
		return nil, err
	}
	for filas.Next() {
		var us usuarioComp
		var cifrado []byte
		if err := filas.Scan(&us.Usuario, &us.Grupo, &cifrado); err != nil {
			filas.Close()
			return nil, err
		}
		claro, err := a.cifra.Descifrar(cifrado, dominioHashNT)
		if err != nil {
			filas.Close()
			return nil, fmt.Errorf("no se pudo descifrar la credencial de %s: %w", us.Usuario, err)
		}
		us.HashNT = string(claro)
		// Defensa adicional: nada que no haya pasado la validación llega al archivo.
		if validarNombreUsuario(us.Usuario) != nil || validarGrupo(us.Grupo) != nil || len(us.HashNT) != 32 {
			filas.Close()
			return nil, fmt.Errorf("el usuario %q tiene datos que no se pueden compilar", us.Usuario)
		}
		usuarios = append(usuarios, us)
	}
	filas.Close()
	if err := filas.Err(); err != nil {
		return nil, err
	}
	return renderizar(clientes, usuarios), nil
}

func (c *Compilado) enmascarar(texto string) string {
	for _, s := range c.sensibles {
		if s != "" {
			texto = strings.ReplaceAll(texto, s, "<oculto>")
		}
	}
	return texto
}

// escribirDeTrabajo deja un archivo con el mismo propietario y grupo que el
// resto de la configuración, para que FreeRADIUS pueda leerlo al validar.
func (a *App) escribirDeTrabajo(ruta string, dato []byte) error {
	if err := os.WriteFile(ruta, dato, 0o640); err != nil {
		return err
	}
	info, err := os.Stat(filepath.Join(a.cfg.DirRaddb, "radiusd.conf"))
	if err != nil {
		return err
	}
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		return os.Chown(ruta, int(st.Uid), int(st.Gid))
	}
	return nil
}

// validar comprueba la configuración con el propio FreeRADIUS antes de
// activarla. Este contenedor lleva el binario solo para eso: su carpeta de
// configuración es de trabajo y no atiende tráfico.
func (a *App) validar(ctx context.Context, c *Compilado) (string, error) {
	if err := a.escribirDeTrabajo(filepath.Join(a.cfg.DirRaddb, "clients.conf"), c.Clients); err != nil {
		return "", err
	}
	if err := a.escribirDeTrabajo(filepath.Join(a.cfg.DirRaddb, "mods-config", "files", "authorize"),
		c.Authorize); err != nil {
		return "", err
	}
	ctx, cancelar := context.WithTimeout(ctx, 30*time.Second)
	defer cancelar()
	salida, err := exec.CommandContext(ctx, "freeradius", "-C", "-l", "stdout").CombinedOutput()
	texto := c.enmascarar(string(salida))
	if err != nil {
		return texto, fmt.Errorf("FreeRADIUS rechazó la configuración: %w", err)
	}
	return texto, nil
}

var reIpaddr = regexp.MustCompile(`(?m)^\tipaddr = (\S+)$`)

// listaRedes extrae las redes de origen del clients.conf compilado. Sale del
// mismo archivo que carga FreeRADIUS, así que el firewall abre exactamente lo
// que FreeRADIUS acepta. La última línea marca que la lista está completa.
func listaRedes(clients []byte) []byte {
	var b bytes.Buffer
	b.WriteString("# Generado por RadiusControl. Redes con acceso a 1812/udp.\n")
	for _, m := range reIpaddr.FindAllSubmatch(clients, -1) {
		b.Write(m[1])
		b.WriteByte('\n')
	}
	b.WriteString("# fin\n")
	return b.Bytes()
}

// activar deja la versión en el volumen compartido y cambia el enlace «actual»
// de forma atómica. El contenedor de FreeRADIUS detecta el cambio y se recarga.
func (a *App) activar(id int64, c *Compilado) error {
	dirVersiones := filepath.Join(a.cfg.DirCompilado, "versiones")
	nombre := strconv.FormatInt(id, 10)
	dir := filepath.Join(dirVersiones, nombre)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "clients.conf"), c.Clients, 0o640); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "authorize"), c.Authorize, 0o640); err != nil {
		return err
	}
	// Lista de redes para el agente de firewall del servidor.
	if err := os.WriteFile(filepath.Join(dir, "redes.txt"), listaRedes(c.Clients), 0o644); err != nil {
		return err
	}
	tmp := filepath.Join(a.cfg.DirCompilado, "actual.tmp")
	_ = os.Remove(tmp)
	if err := os.Symlink(filepath.Join("versiones", nombre), tmp); err != nil {
		return err
	}
	if err := os.Rename(tmp, filepath.Join(a.cfg.DirCompilado, "actual")); err != nil {
		return err
	}
	// En disco solo queda la versión activa; las demás están cifradas en la base.
	if entradas, err := os.ReadDir(dirVersiones); err == nil {
		for _, e := range entradas {
			if e.Name() != nombre {
				_ = os.RemoveAll(filepath.Join(dirVersiones, e.Name()))
			}
		}
	}
	return nil
}

func (a *App) descifrarVersion(ctx context.Context, id int64) (*Compilado, error) {
	var cc, ac []byte
	c := &Compilado{}
	err := a.db.QueryRow(ctx, `SELECT clients_cifrado, authorize_cifrado, sha_clients, sha_authorize,
		routers, usuarios FROM versiones_config WHERE id = $1 AND estado = 'aplicada'`, id).
		Scan(&cc, &ac, &c.ShaClients, &c.ShaAuthorize, &c.Routers, &c.Usuarios)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, noEncontrado()
	}
	if err != nil {
		return nil, err
	}
	if c.Clients, err = a.cifra.Descifrar(cc, dominioVersion); err != nil {
		return nil, err
	}
	if c.Authorize, err = a.cifra.Descifrar(ac, dominioVersion); err != nil {
		return nil, err
	}
	if sha(c.Clients) != c.ShaClients || sha(c.Authorize) != c.ShaAuthorize {
		return nil, errors.New("la versión guardada no coincide con su huella")
	}
	return c, nil
}

// restaurarCompilado vuelve a escribir la versión activa si el volumen
// compartido está vacío, por ejemplo tras recrearlo.
func (a *App) restaurarCompilado(ctx context.Context) error {
	// Se mira la lista de redes porque es el último archivo que se escribe: si
	// está, la versión en disco está completa.
	if _, err := os.Stat(filepath.Join(a.cfg.DirCompilado, "actual", "redes.txt")); err == nil {
		return nil
	}
	var id int64
	err := a.db.QueryRow(ctx, `SELECT id FROM versiones_config WHERE activa`).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	c, err := a.descifrarVersion(ctx, id)
	if err != nil {
		return err
	}
	return a.activar(id, c)
}

func (a *App) marcarActiva(ctx context.Context, id int64) error {
	return pgx.BeginFunc(ctx, a.db, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE versiones_config SET activa = false WHERE activa`); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `UPDATE versiones_config SET activa = true, estado = 'aplicada' WHERE id = $1`, id)
		return err
	})
}

func (a *App) aplicar(w http.ResponseWriter, r *http.Request, op *Operador) error {
	a.aplicarMu.Lock()
	defer a.aplicarMu.Unlock()
	ctx := r.Context()

	c, err := a.compilarDeseado(ctx)
	if err != nil {
		return err
	}
	cc, err := a.cifra.Cifrar(c.Clients, dominioVersion)
	if err != nil {
		return err
	}
	ac, err := a.cifra.Cifrar(c.Authorize, dominioVersion)
	if err != nil {
		return err
	}
	var id int64
	if err := a.db.QueryRow(ctx, `INSERT INTO versiones_config
		(operador, estado, routers, usuarios, sha_clients, sha_authorize, clients_cifrado, authorize_cifrado)
		VALUES ($1, 'validando', $2, $3, $4, $5, $6, $7) RETURNING id`,
		op.Usuario, c.Routers, c.Usuarios, c.ShaClients, c.ShaAuthorize, cc, ac).Scan(&id); err != nil {
		return err
	}

	salida, err := a.validar(ctx, c)
	if err != nil {
		_, _ = a.db.Exec(ctx, `UPDATE versiones_config SET estado = 'fallida', mensaje = $2 WHERE id = $1`,
			id, salida)
		a.auditar(ctx, op.Usuario, ipCliente(r), "config.rechazada", fmt.Sprintf("versión %d", id), nil)
		return &errHTTP{codigo: http.StatusUnprocessableEntity,
			msg:   "FreeRADIUS rechazó la configuración. No se cambió nada.",
			extra: map[string]any{"detalle": salida}}
	}
	if err := a.activar(id, c); err != nil {
		_, _ = a.db.Exec(ctx, `UPDATE versiones_config SET estado = 'fallida', mensaje = $2 WHERE id = $1`,
			id, err.Error())
		return err
	}
	if err := a.marcarActiva(ctx, id); err != nil {
		return err
	}
	a.auditar(ctx, op.Usuario, ipCliente(r), "config.aplicada", fmt.Sprintf("versión %d", id),
		map[string]any{"routers": c.Routers, "usuarios": c.Usuarios})
	escribirJSON(w, http.StatusOK, map[string]any{"version": id})
	return nil
}

func (a *App) activarVersion(w http.ResponseWriter, r *http.Request, op *Operador) error {
	id, err := idRuta(r)
	if err != nil {
		return err
	}
	a.aplicarMu.Lock()
	defer a.aplicarMu.Unlock()
	ctx := r.Context()

	c, err := a.descifrarVersion(ctx, id)
	if err != nil {
		return err
	}
	if salida, err := a.validar(ctx, c); err != nil {
		return &errHTTP{codigo: http.StatusUnprocessableEntity,
			msg:   "FreeRADIUS rechazó esa versión. No se cambió nada.",
			extra: map[string]any{"detalle": salida}}
	}
	if err := a.activar(id, c); err != nil {
		return err
	}
	if err := a.marcarActiva(ctx, id); err != nil {
		return err
	}
	a.auditar(ctx, op.Usuario, ipCliente(r), "config.version_reactivada", fmt.Sprintf("versión %d", id), nil)
	escribirJSON(w, http.StatusOK, map[string]any{"version": id})
	return nil
}

type Version struct {
	ID           int64     `json:"id"`
	Creada       time.Time `json:"creada"`
	Operador     string    `json:"operador"`
	Estado       string    `json:"estado"`
	Mensaje      string    `json:"mensaje"`
	Activa       bool      `json:"activa"`
	Routers      int       `json:"routers"`
	Usuarios     int       `json:"usuarios"`
	ShaClients   string    `json:"sha_clients"`
	ShaAuthorize string    `json:"sha_authorize"`
}

const columnasVersion = `id, creada, operador, estado, mensaje, activa, routers, usuarios, sha_clients, sha_authorize`

func leerVersion(fila pgx.Row) (*Version, error) {
	var v Version
	if err := fila.Scan(&v.ID, &v.Creada, &v.Operador, &v.Estado, &v.Mensaje, &v.Activa,
		&v.Routers, &v.Usuarios, &v.ShaClients, &v.ShaAuthorize); err != nil {
		return nil, err
	}
	return &v, nil
}

func (a *App) listarVersiones(w http.ResponseWriter, r *http.Request, _ *Operador) error {
	filas, err := a.db.Query(r.Context(),
		`SELECT `+columnasVersion+` FROM versiones_config ORDER BY id DESC LIMIT 30`)
	if err != nil {
		return err
	}
	defer filas.Close()
	lista := []*Version{}
	for filas.Next() {
		v, err := leerVersion(filas)
		if err != nil {
			return err
		}
		lista = append(lista, v)
	}
	if err := filas.Err(); err != nil {
		return err
	}
	escribirJSON(w, http.StatusOK, lista)
	return nil
}

// Cargado es lo que el contenedor de FreeRADIUS declara tener en marcha.
type Cargado struct {
	Estado       string `json:"estado"`
	Version      string `json:"version"`
	ShaClients   string `json:"sha_clients"`
	ShaAuthorize string `json:"sha_authorize"`
	Desde        string `json:"desde"`
}

// Firewall es lo que el agente del servidor declara tener abierto en UFW.
type Firewall struct {
	Estado    string   `json:"estado"`
	Version   string   `json:"version"`
	UFWActivo bool     `json:"ufw_activo"`
	Redes     []string `json:"redes"`
	Desde     string   `json:"desde"`
}

func (a *App) verEstado(w http.ResponseWriter, r *http.Request, _ *Operador) error {
	ctx := r.Context()
	deseado, err := a.compilarDeseado(ctx)
	if err != nil {
		return err
	}
	var activa *Version
	v, err := leerVersion(a.db.QueryRow(ctx, `SELECT `+columnasVersion+` FROM versiones_config WHERE activa`))
	if err == nil {
		activa = v
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}

	var cargado *Cargado
	if b, err := os.ReadFile(filepath.Join(a.cfg.DirCompilado, "estado", "cargado.json")); err == nil {
		var c Cargado
		if json.Unmarshal(b, &c) == nil {
			cargado = &c
		}
	}

	var firewall *Firewall
	if b, err := os.ReadFile(filepath.Join(a.cfg.DirCompilado, "estado", "firewall.json")); err == nil {
		var f Firewall
		if json.Unmarshal(b, &f) == nil {
			firewall = &f
		}
	}
	firewallAlDia := activa != nil && firewall != nil && firewall.Estado == "sincronizado" &&
		firewall.UFWActivo && firewall.Version == strconv.FormatInt(activa.ID, 10)

	pendiente := activa == nil ||
		activa.ShaClients != deseado.ShaClients || activa.ShaAuthorize != deseado.ShaAuthorize
	sincronizado := activa != nil && cargado != nil && cargado.Estado == "en-marcha" &&
		cargado.ShaClients == activa.ShaClients && cargado.ShaAuthorize == activa.ShaAuthorize

	escribirJSON(w, http.StatusOK, map[string]any{
		"cambios_pendientes": pendiente,
		"sincronizado":       sincronizado,
		"deseado": map[string]any{
			"routers": deseado.Routers, "usuarios": deseado.Usuarios,
			"sha_clients": deseado.ShaClients, "sha_authorize": deseado.ShaAuthorize,
		},
		"activa":     activa,
		"freeradius": cargado,
		"firewall":           firewall,
		"firewall_al_dia":    firewallAlDia,
	})
	return nil
}
