package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
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
	// Acceso es «general» o «restringido». Los permisos solo cuentan en un
	// router restringido.
	Acceso   string
	Permisos []permisoComp
}

// permisoComp es el grupo que recibe un usuario en un router restringido.
type permisoComp struct {
	UsuarioID int64
	Grupo     string
}

type usuarioComp struct {
	ID      int64
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
		c.WriteString("\tlimit_proxy_state = yes\n")
		// Accesos por router: los lee la política rc_accesos con %{client:...}.
		if cl.Acceso == accesoRestringido {
			c.WriteString("\trc_acceso = restringido\n")
			permisos := append([]permisoComp(nil), cl.Permisos...)
			sort.SliceStable(permisos, func(i, j int) bool { return permisos[i].UsuarioID < permisos[j].UsuarioID })
			for _, p := range permisos {
				fmt.Fprintf(&c, "\trc_u_%d = %s\n", p.UsuarioID, comillaSimple(p.Grupo))
			}
		} else {
			c.WriteString("\trc_acceso = general\n")
		}
		c.WriteString("}\n")
	}

	var u bytes.Buffer
	u.WriteString("# Generado por RadiusControl. No editar a mano.\n")
	for _, us := range usuarios {
		sensibles = append(sensibles, us.HashNT)
		// El identificador viaja en un atributo de control para que rc_accesos
		// pueda buscar el permiso del usuario en el router.
		fmt.Fprintf(&u, "\n%s\tNT-Password := \"%s\", Tmp-Integer-0 := %d\n\tMikrotik-Group := \"%s\"\n",
			us.Usuario, us.HashNT, us.ID, us.Grupo)
	}

	return &Compilado{
		Clients: c.Bytes(), Authorize: u.Bytes(),
		ShaClients: sha(c.Bytes()), ShaAuthorize: sha(u.Bytes()),
		Routers: len(routers), Usuarios: len(usuarios), sensibles: sensibles,
	}
}

// compilarDeseado lee el estado deseado de la base y lo renderiza.
func (a *App) compilarDeseado(ctx context.Context) (*Compilado, error) {
	// Permisos de los routers restringidos. Solo cuentan los usuarios activos:
	// los demás no tienen entrada en authorize y no podrían entrar igualmente.
	permisos := map[int64][]permisoComp{}
	filas, err := a.db.Query(ctx, `SELECT ra.router_id, ra.usuario_id, ra.grupo
		FROM router_accesos ra JOIN routers r ON r.id = ra.router_id
		JOIN usuarios_mikrotik u ON u.id = ra.usuario_id
		WHERE r.activo AND r.acceso = 'restringido' AND u.activo
		ORDER BY ra.router_id, ra.usuario_id`)
	if err != nil {
		return nil, err
	}
	for filas.Next() {
		var routerID int64
		var p permisoComp
		if err := filas.Scan(&routerID, &p.UsuarioID, &p.Grupo); err != nil {
			filas.Close()
			return nil, err
		}
		// Defensa adicional: nada que no haya pasado la validación llega al archivo.
		if validarGrupo(p.Grupo) != nil {
			filas.Close()
			return nil, fmt.Errorf("el router %d tiene un acceso que no se puede compilar", routerID)
		}
		permisos[routerID] = append(permisos[routerID], p)
	}
	filas.Close()
	if err := filas.Err(); err != nil {
		return nil, err
	}

	var clientes []clienteComp
	filas, err = a.db.Query(ctx, `SELECT r.id, rr.id, text(rr.red), r.secreto_cifrado,
		r.exigir_message_authenticator, r.acceso
		FROM routers r JOIN router_redes rr ON rr.router_id = r.id
		WHERE r.activo ORDER BY r.id, rr.id`)
	if err != nil {
		return nil, err
	}
	for filas.Next() {
		var cl clienteComp
		var cifrado []byte
		if err := filas.Scan(&cl.RouterID, &cl.RedID, &cl.Red, &cifrado, &cl.ExigirMA, &cl.Acceso); err != nil {
			filas.Close()
			return nil, err
		}
		if !accesoValido(cl.Acceso) {
			filas.Close()
			return nil, fmt.Errorf("el router %d tiene un modo de acceso que no se puede compilar", cl.RouterID)
		}
		cl.Permisos = permisos[cl.RouterID]
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
	filas, err = a.db.Query(ctx, `SELECT id, usuario, grupo, hash_nt_cifrado
		FROM usuarios_mikrotik WHERE activo ORDER BY usuario`)
	if err != nil {
		return nil, err
	}
	for filas.Next() {
		var us usuarioComp
		var cifrado []byte
		if err := filas.Scan(&us.ID, &us.Usuario, &us.Grupo, &cifrado); err != nil {
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
	// En la base está la huella con clave; dentro del programa se trabaja con
	// el SHA-256 del contenido recién descifrado.
	if a.cifra.Huella(sha(c.Clients)) != c.ShaClients || a.cifra.Huella(sha(c.Authorize)) != c.ShaAuthorize {
		return nil, errors.New("la versión guardada no coincide con su huella")
	}
	c.ShaClients, c.ShaAuthorize = sha(c.Clients), sha(c.Authorize)
	return c, nil
}

// convertirHuellas pasa a huella con clave las versiones guardadas antes de
// que existiera. Se ejecuta al arrancar y no hace nada si ya están convertidas.
func (a *App) convertirHuellas(ctx context.Context) error {
	filas, err := a.db.Query(ctx, `SELECT id, sha_clients, sha_authorize FROM versiones_config
		WHERE NOT huella_con_clave`)
	if err != nil {
		return err
	}
	type fila struct {
		id     int64
		sc, sa string
	}
	var pendientes []fila
	for filas.Next() {
		var f fila
		if err := filas.Scan(&f.id, &f.sc, &f.sa); err != nil {
			filas.Close()
			return err
		}
		pendientes = append(pendientes, f)
	}
	filas.Close()
	if err := filas.Err(); err != nil {
		return err
	}
	for _, f := range pendientes {
		if _, err := a.db.Exec(ctx, `UPDATE versiones_config SET sha_clients = $2, sha_authorize = $3,
			huella_con_clave = true WHERE id = $1 AND NOT huella_con_clave`,
			f.id, a.cifra.Huella(f.sc), a.cifra.Huella(f.sa)); err != nil {
			return err
		}
	}
	if len(pendientes) > 0 {
		log.Printf("huellas: %d versiones pasadas a huella con clave", len(pendientes))
	}
	return nil
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

// aplicarDeseado compila el estado deseado, lo valida y lo activa. Si ya
// coincide con la versión activa no hace nada y devuelve hecho = false.
func (a *App) aplicarDeseado(ctx context.Context, operador, ip string) (id int64, hecho bool, salida string, err error) {
	a.aplicarMu.Lock()
	defer a.aplicarMu.Unlock()

	c, err := a.compilarDeseado(ctx)
	if err != nil {
		return 0, false, "", err
	}
	var shaC, shaA string
	err = a.db.QueryRow(ctx, `SELECT id, sha_clients, sha_authorize FROM versiones_config WHERE activa`).
		Scan(&id, &shaC, &shaA)
	if err == nil && shaC == a.cifra.Huella(c.ShaClients) && shaA == a.cifra.Huella(c.ShaAuthorize) {
		return id, false, "", nil
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return 0, false, "", err
	}

	cc, err := a.cifra.Cifrar(c.Clients, dominioVersion)
	if err != nil {
		return 0, false, "", err
	}
	ac, err := a.cifra.Cifrar(c.Authorize, dominioVersion)
	if err != nil {
		return 0, false, "", err
	}
	if err := a.db.QueryRow(ctx, `INSERT INTO versiones_config
		(operador, estado, routers, usuarios, sha_clients, sha_authorize, clients_cifrado, authorize_cifrado,
		 huella_con_clave)
		VALUES ($1, 'validando', $2, $3, $4, $5, $6, $7, true) RETURNING id`,
		operador, c.Routers, c.Usuarios, a.cifra.Huella(c.ShaClients), a.cifra.Huella(c.ShaAuthorize), cc, ac).
		Scan(&id); err != nil {
		return 0, false, "", err
	}

	salida, err = a.validar(ctx, c)
	if err != nil {
		_, _ = a.db.Exec(ctx, `UPDATE versiones_config SET estado = 'fallida', mensaje = $2 WHERE id = $1`,
			id, salida)
		a.auditar(ctx, operador, ip, "config.rechazada", fmt.Sprintf("versión %d", id), nil)
		return id, false, salida, errRechazada
	}
	if err := a.activar(id, c); err != nil {
		_, _ = a.db.Exec(ctx, `UPDATE versiones_config SET estado = 'fallida', mensaje = $2 WHERE id = $1`,
			id, err.Error())
		return id, false, "", err
	}
	if err := a.marcarActiva(ctx, id); err != nil {
		return id, false, "", err
	}
	// Solo se conservan las últimas versiones; no hay historial que consultar.
	if _, err := a.db.Exec(ctx, `DELETE FROM versiones_config WHERE NOT activa AND id < $1 - 10`, id); err != nil {
		log.Printf("no se pudieron limpiar versiones antiguas: %v", err)
	}
	a.auditar(ctx, operador, ip, "config.aplicada", fmt.Sprintf("versión %d", id),
		map[string]any{"routers": c.Routers, "usuarios": c.Usuarios})
	return id, true, "", nil
}

var errRechazada = errors.New("FreeRADIUS rechazó la configuración")

func (a *App) aplicar(w http.ResponseWriter, r *http.Request, op *Operador) error {
	id, hecho, salida, err := a.aplicarDeseado(r.Context(), op.Usuario, ipCliente(r))
	if errors.Is(err, errRechazada) {
		return &errHTTP{codigo: http.StatusUnprocessableEntity,
			msg:   "FreeRADIUS rechazó la configuración. No se cambió nada.",
			extra: map[string]any{"detalle": salida}}
	}
	if err != nil {
		return err
	}
	escribirJSON(w, http.StatusOK, map[string]any{"version": id, "sin_cambios": !hecho})
	return nil
}

// programarAplicar aplica los cambios por su cuenta poco después de guardarlos.
// Varios cambios seguidos se juntan en una sola aplicación.
func (a *App) programarAplicar(operador string) {
	if a.cfg.EsperaAplicar <= 0 {
		return
	}
	a.autoMu.Lock()
	defer a.autoMu.Unlock()
	if a.autoTimer != nil {
		a.autoTimer.Stop()
	}
	a.autoTimer = time.AfterFunc(a.cfg.EsperaAplicar, func() {
		ctx, cancelar := context.WithTimeout(context.Background(), 90*time.Second)
		defer cancelar()
		id, hecho, _, err := a.aplicarDeseado(ctx, operador, "automático")
		switch {
		case err != nil:
			log.Printf("aplicación automática: versión %d no aplicada: %v", id, err)
		case hecho:
			log.Printf("aplicación automática: versión %d activada", id)
		}
	})
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

// ultimoFallo devuelve el mensaje del último intento rechazado, si es posterior
// a la versión activa.
func (a *App) ultimoFallo(ctx context.Context, activa *Version) string {
	var desde int64
	if activa != nil {
		desde = activa.ID
	}
	var mensaje string
	err := a.db.QueryRow(ctx, `SELECT mensaje FROM versiones_config
		WHERE estado = 'fallida' AND id > $1 ORDER BY id DESC LIMIT 1`, desde).Scan(&mensaje)
	if err != nil {
		return ""
	}
	if mensaje == "" {
		mensaje = "FreeRADIUS rechazó la configuración."
	}
	return mensaje
}

func (a *App) verEstado(w http.ResponseWriter, r *http.Request, op *Operador) error {
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

	// Todo lo que sale de aquí son huellas con clave: ni el SHA-256 de lo
	// deseado ni el que declara FreeRADIUS llegan al navegador.
	huellaDeseadoC, huellaDeseadoA := a.cifra.Huella(deseado.ShaClients), a.cifra.Huella(deseado.ShaAuthorize)
	if cargado != nil {
		cargado.ShaClients, cargado.ShaAuthorize = a.cifra.Huella(cargado.ShaClients), a.cifra.Huella(cargado.ShaAuthorize)
	}
	pendiente := activa == nil ||
		activa.ShaClients != huellaDeseadoC || activa.ShaAuthorize != huellaDeseadoA
	sincronizado := activa != nil && cargado != nil && cargado.Estado == "en-marcha" &&
		cargado.ShaClients == activa.ShaClients && cargado.ShaAuthorize == activa.ShaAuthorize

	fallo := a.ultimoFallo(ctx, activa)
	if fallo != "" && op.Rol != rolAdmin {
		fallo = "El último cambio no se pudo aplicar. Avisa a un administrador."
	}
	escribirJSON(w, http.StatusOK, map[string]any{
		"cambios_pendientes": pendiente,
		"sincronizado":       sincronizado,
		"deseado": map[string]any{
			"routers": deseado.Routers, "usuarios": deseado.Usuarios,
			"sha_clients": huellaDeseadoC, "sha_authorize": huellaDeseadoA,
		},
		"activa":          activa,
		"freeradius":      cargado,
		"firewall":        firewall,
		"firewall_al_dia": firewallAlDia,
		"ultimo_fallo":    fallo,
	})
	return nil
}
