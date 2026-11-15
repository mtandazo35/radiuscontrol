package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

// Accesos al propio servidor: quién llega a la web del panel (443/tcp) y al
// SSH. La API no puede tocar el firewall: deja la lista en el volumen
// compartido y el agente del servidor la convierte en reglas de UFW. Las reglas
// que el operador cargó a mano no se gestionan aquí; solo se muestran.
const (
	servicioPanel = "panel"
	servicioSSH   = "ssh"
	// redCualquiera abre el servicio a cualquier dirección.
	redCualquiera = "cualquiera"

	puertoSSHPorOmision = 22
	// Un informe del agente más antiguo que esto no sirve para decidir una baja.
	caducaInformeFirewall = 5 * time.Minute
)

// AccesoServidor es un acceso gestionado desde el panel.
type AccesoServidor struct {
	ID          int64     `json:"id"`
	Servicio    string    `json:"servicio"`
	Red         string    `json:"red"`
	Descripcion string    `json:"descripcion"`
	Operador    string    `json:"operador"`
	Creado      time.Time `json:"creado"`
	// Aplicada dice si el agente informa de esa regla como gestionada en UFW.
	Aplicada bool `json:"aplicada"`
}

// reglaAcceso es lo que cuenta para decidir quién entra: el servicio y la red,
// en forma canónica o «cualquiera».
type reglaAcceso struct{ Servicio, Red string }

// reglaFirewall es una regla de UFW tal como la informa el agente.
type reglaFirewall struct {
	Servicio   string `json:"servicio"`
	Red        string `json:"red"`
	Gestionada bool   `json:"gestionada"`
	Comentario string `json:"comentario"`
}

// estadoServidor es el objeto «servidor» del informe del agente.
type estadoServidor struct {
	Estado    string          `json:"estado"`
	PuertoSSH int             `json:"puerto_ssh"`
	Reglas    []reglaFirewall `json:"reglas"`
}

// informeFirewall es la parte de estado/firewall.json que interesa aquí.
type informeFirewall struct {
	UFWActivo bool            `json:"ufw_activo"`
	Desde     string          `json:"desde"`
	Servidor  *estadoServidor `json:"servidor"`
}

func servicioValido(s string) bool { return s == servicioPanel || s == servicioSSH }

// normalizarRedAcceso convierte lo que escribe el operador (una dirección, un
// prefijo o la palabra «cualquiera») en la forma canónica que se guarda.
func normalizarRedAcceso(texto string) (string, error) {
	texto = strings.TrimSpace(texto)
	if texto == "" {
		return "", malo("Indica una dirección, una red o la palabra «cualquiera».")
	}
	if strings.EqualFold(texto, redCualquiera) {
		return redCualquiera, nil
	}
	// Una dirección con zona («fe80::1%eth0») no sirve como origen en el firewall.
	if strings.Contains(texto, "%") {
		return "", malo(fmt.Sprintf("«%s» no es una red admitida.", texto))
	}
	if p, err := netip.ParsePrefix(texto); err == nil && p.Bits() == 0 {
		return "", malo(fmt.Sprintf(
			"«%s» abarca todas las direcciones. Para abrir a cualquier dirección escribe la palabra «cualquiera».", texto))
	}
	redes, err := normalizarRedes([]string{texto})
	if err != nil {
		return "", err
	}
	return redes[0].String(), nil
}

// redCanonica pasa a la forma guardada una red informada por el agente, que
// escribe las direcciones sueltas sin máscara. Si no se entiende, se deja igual.
func redCanonica(red string) string {
	if c, err := normalizarRedAcceso(red); err == nil {
		return c
	}
	return strings.TrimSpace(red)
}

// tieneAcceso dice si alguna regla de ese servicio deja entrar a la dirección.
func tieneAcceso(reglas []reglaAcceso, servicio string, ip netip.Addr) bool {
	for _, r := range reglas {
		if r.Servicio != servicio {
			continue
		}
		if r.Red == redCualquiera {
			return true
		}
		if p, err := netip.ParsePrefix(r.Red); err == nil && p.Contains(ip) {
			return true
		}
	}
	return false
}

// salvaguardaPanel impide un cambio que dejaría al operador sin acceso al panel
// desde la dirección con la que está conectado. Si la dirección no se puede
// interpretar, no decide nada.
func salvaguardaPanel(antes, despues []reglaAcceso, tuIP string) error {
	ip, err := netip.ParseAddr(strings.TrimSpace(tuIP))
	if err != nil {
		return nil
	}
	ip = ip.Unmap().WithZone("")
	if tieneAcceso(antes, servicioPanel, ip) && !tieneAcceso(despues, servicioPanel, ip) {
		return conflicto(fmt.Sprintf(
			"No se puede quitar: te quedarías sin acceso al panel desde tu dirección (%s).", ip))
	}
	return nil
}

// salvaguardaSSH impide quitar un acceso de SSH si después no quedaría ninguna
// regla de SSH, ni gestionada ni cargada a mano.
func salvaguardaSSH(quitada reglaAcceso, despues []reglaAcceso) error {
	if quitada.Servicio != servicioSSH {
		return nil
	}
	for _, r := range despues {
		if r.Servicio == servicioSSH {
			return nil
		}
	}
	return conflicto("No se puede quitar: el servidor quedaría sin ningún acceso por SSH.")
}

// salvaguardaAgente impide las bajas cuando no se sabe qué reglas hay de verdad
// en el firewall: sin informe del agente, o con uno demasiado antiguo.
func salvaguardaAgente(inf *informeFirewall, ahora time.Time) error {
	if inf == nil || inf.Servidor == nil {
		return conflicto("El agente de firewall no ha informado todavía; no es seguro quitar accesos.")
	}
	desde, err := time.Parse(time.RFC3339, inf.Desde)
	if err != nil || ahora.Sub(desde) > caducaInformeFirewall {
		return conflicto(fmt.Sprintf(
			"El agente de firewall lleva más de %d minutos sin informar; no es seguro quitar accesos.",
			int(caducaInformeFirewall.Minutes())))
	}
	return nil
}

// comprobarBaja aplica las tres salvaguardas a la baja de un acceso gestionado.
// Recibe todos los accesos gestionados (incluido el que se quita) y el informe
// del agente, de donde salen las reglas que el operador cargó a mano.
func comprobarBaja(inf *informeFirewall, gestionadas []reglaAcceso, quitada reglaAcceso, tuIP string, ahora time.Time) error {
	if err := salvaguardaAgente(inf, ahora); err != nil {
		return err
	}
	var ajenas []reglaAcceso
	aplicada := false
	for _, r := range inf.Servidor.Reglas {
		if !servicioValido(r.Servicio) {
			continue
		}
		regla := reglaAcceso{Servicio: r.Servicio, Red: redCanonica(r.Red)}
		if !r.Gestionada {
			ajenas = append(ajenas, regla)
		} else if regla == quitada {
			aplicada = true
		}
	}

	antes := append(append([]reglaAcceso(nil), gestionadas...), ajenas...)
	var despues []reglaAcceso
	for _, g := range gestionadas {
		if g != quitada {
			despues = append(despues, g)
		}
	}
	for _, aj := range ajenas {
		// Si el agente todavía no ha aplicado este acceso, una regla manual
		// idéntica está a punto de pasar a gestionada, y la baja se la
		// llevaría: no cuenta como acceso que vaya a quedar.
		if aj == quitada && !aplicada {
			continue
		}
		despues = append(despues, aj)
	}
	if err := salvaguardaPanel(antes, despues, tuIP); err != nil {
		return err
	}
	return salvaguardaSSH(quitada, despues)
}

// textoAccesos genera la lista que lee el agente de firewall. Es determinista:
// va ordenada por servicio y red. La última línea marca que está completa.
func textoAccesos(reglas []reglaAcceso) []byte {
	orden := append([]reglaAcceso(nil), reglas...)
	sort.Slice(orden, func(i, j int) bool {
		if orden[i].Servicio != orden[j].Servicio {
			return orden[i].Servicio < orden[j].Servicio
		}
		return orden[i].Red < orden[j].Red
	})
	var b bytes.Buffer
	b.WriteString("# Generado por RadiusControl. Accesos al panel y al SSH gestionados desde el panel.\n")
	for _, r := range orden {
		// Defensa adicional: nada que no haya pasado la validación llega al archivo.
		if c, err := normalizarRedAcceso(r.Red); err != nil || c != r.Red || !servicioValido(r.Servicio) {
			continue
		}
		fmt.Fprintf(&b, "%s %s\n", r.Servicio, r.Red)
	}
	b.WriteString("# fin\n")
	return b.Bytes()
}

// vistaAccesos reúne lo que muestra el panel: los accesos gestionados, las
// reglas que el operador cargó a mano y el estado del agente.
func vistaAccesos(lista []AccesoServidor, inf *informeFirewall, tuIP string) map[string]any {
	type ajena struct {
		Servicio   string `json:"servicio"`
		Red        string `json:"red"`
		Comentario string `json:"comentario"`
	}
	puerto := puertoSSHPorOmision
	firewall := map[string]any{"estado": "sin-datos", "ufw_activo": false, "desde": ""}
	aplicadas := map[reglaAcceso]bool{}
	ajenas := []ajena{}
	if inf != nil && inf.Servidor != nil {
		if inf.Servidor.PuertoSSH > 0 {
			puerto = inf.Servidor.PuertoSSH
		}
		firewall = map[string]any{
			"estado": inf.Servidor.Estado, "ufw_activo": inf.UFWActivo, "desde": inf.Desde,
		}
		for _, r := range inf.Servidor.Reglas {
			if !servicioValido(r.Servicio) {
				continue
			}
			red := redCanonica(r.Red)
			if r.Gestionada {
				aplicadas[reglaAcceso{Servicio: r.Servicio, Red: red}] = true
				continue
			}
			ajenas = append(ajenas, ajena{Servicio: r.Servicio, Red: red, Comentario: r.Comentario})
		}
	}
	gestionadas := make([]AccesoServidor, 0, len(lista))
	for _, g := range lista {
		g.Aplicada = aplicadas[reglaAcceso{Servicio: g.Servicio, Red: g.Red}]
		gestionadas = append(gestionadas, g)
	}
	return map[string]any{
		"puerto_ssh":  puerto,
		"tu_ip":       tuIP,
		"gestionadas": gestionadas,
		"ajenas":      ajenas,
		"firewall":    firewall,
	}
}

// leerInformeFirewall devuelve lo que el agente dejó en el volumen compartido,
// o nil si todavía no hay nada que se pueda leer.
func (a *App) leerInformeFirewall() *informeFirewall {
	b, err := os.ReadFile(filepath.Join(a.cfg.DirCompilado, "estado", "firewall.json"))
	if err != nil {
		return nil
	}
	var inf informeFirewall
	if json.Unmarshal(b, &inf) != nil {
		return nil
	}
	return &inf
}

func (a *App) accesosServidor(ctx context.Context) ([]AccesoServidor, error) {
	filas, err := a.db.Query(ctx, `SELECT id, servicio, red, descripcion, operador, creado
		FROM accesos_servidor ORDER BY servicio, red, id`)
	if err != nil {
		return nil, err
	}
	defer filas.Close()
	lista := []AccesoServidor{}
	for filas.Next() {
		var ac AccesoServidor
		if err := filas.Scan(&ac.ID, &ac.Servicio, &ac.Red, &ac.Descripcion, &ac.Operador, &ac.Creado); err != nil {
			return nil, err
		}
		lista = append(lista, ac)
	}
	return lista, filas.Err()
}

// escribirAccesos deja en el volumen compartido la lista de accesos gestionados
// para el agente de firewall. Se escribe aparte y se renombra, para que el
// agente nunca lea una lista a medias.
func (a *App) escribirAccesos(ctx context.Context) error {
	lista, err := a.accesosServidor(ctx)
	if err != nil {
		return err
	}
	reglas := make([]reglaAcceso, 0, len(lista))
	for _, ac := range lista {
		reglas = append(reglas, reglaAcceso{Servicio: ac.Servicio, Red: ac.Red})
	}
	dir := filepath.Join(a.cfg.DirCompilado, "servidor")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	// Los permisos se fijan aparte porque la máscara del proceso puede recortarlos.
	if err := os.Chmod(dir, 0o755); err != nil {
		return err
	}
	tmp := filepath.Join(dir, "accesos.txt.tmp")
	if err := os.WriteFile(tmp, textoAccesos(reglas), 0o644); err != nil {
		return err
	}
	if err := os.Chmod(tmp, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(dir, "accesos.txt"))
}

func (a *App) responderAccesos(ctx context.Context, w http.ResponseWriter, r *http.Request, codigo int) error {
	lista, err := a.accesosServidor(ctx)
	if err != nil {
		return err
	}
	escribirJSON(w, codigo, vistaAccesos(lista, a.leerInformeFirewall(), ipCliente(r)))
	return nil
}

func (a *App) verAccesosServidor(w http.ResponseWriter, r *http.Request, _ *Operador) error {
	return a.responderAccesos(r.Context(), w, r, http.StatusOK)
}

// Las altas y las bajas no pasan por «aplicar» ni reinician FreeRADIUS: basta
// con reescribir la lista; el agente la recoge en unos segundos.
func (a *App) crearAccesoServidor(w http.ResponseWriter, r *http.Request, op *Operador) error {
	var in struct {
		Servicio    string `json:"servicio"`
		Red         string `json:"red"`
		Descripcion string `json:"descripcion"`
	}
	if err := leerJSON(w, r, &in); err != nil {
		return err
	}
	servicio := strings.TrimSpace(in.Servicio)
	if !servicioValido(servicio) {
		return malo("El servicio debe ser «panel» o «ssh».")
	}
	red, err := normalizarRedAcceso(in.Red)
	if err != nil {
		return err
	}
	descripcion := strings.TrimSpace(in.Descripcion)
	if utf8.RuneCountInString(descripcion) > 120 {
		return malo("La descripción admite como máximo 120 caracteres.")
	}

	// Un alta empezada se termina aunque el navegador corte.
	ctx := context.WithoutCancel(r.Context())
	a.accesosMu.Lock()
	defer a.accesosMu.Unlock()
	if _, err := a.db.Exec(ctx, `INSERT INTO accesos_servidor (servicio, red, descripcion, operador)
		VALUES ($1, $2, $3, $4)`, servicio, red, descripcion, op.Usuario); err != nil {
		if errorPG(err, "23505") {
			return conflicto("Esa red ya tiene acceso.")
		}
		return err
	}
	a.auditar(ctx, op.Usuario, ipCliente(r), "servidor.acceso_añadido", servicio+" "+red,
		map[string]any{"descripcion": descripcion})
	if err := a.escribirAccesos(ctx); err != nil {
		return err
	}
	return a.responderAccesos(ctx, w, r, http.StatusCreated)
}

func (a *App) quitarAccesoServidor(w http.ResponseWriter, r *http.Request, op *Operador) error {
	id, err := idRuta(r)
	if err != nil {
		return err
	}
	// Una baja empezada se termina aunque el navegador corte.
	ctx := context.WithoutCancel(r.Context())
	// El candado cubre la comprobación y la baja: dos bajas a la vez no pueden
	// saltarse entre las dos una salvaguarda.
	a.accesosMu.Lock()
	defer a.accesosMu.Unlock()

	lista, err := a.accesosServidor(ctx)
	if err != nil {
		return err
	}
	var quitado *AccesoServidor
	gestionadas := make([]reglaAcceso, 0, len(lista))
	for i := range lista {
		gestionadas = append(gestionadas, reglaAcceso{Servicio: lista[i].Servicio, Red: lista[i].Red})
		if lista[i].ID == id {
			quitado = &lista[i]
		}
	}
	if quitado == nil {
		return noEncontrado()
	}
	regla := reglaAcceso{Servicio: quitado.Servicio, Red: quitado.Red}
	if err := comprobarBaja(a.leerInformeFirewall(), gestionadas, regla, ipCliente(r), time.Now()); err != nil {
		return err
	}
	if _, err := a.db.Exec(ctx, `DELETE FROM accesos_servidor WHERE id = $1`, id); err != nil {
		return err
	}
	a.auditar(ctx, op.Usuario, ipCliente(r), "servidor.acceso_quitado", regla.Servicio+" "+regla.Red,
		map[string]any{"descripcion": quitado.Descripcion})
	if err := a.escribirAccesos(ctx); err != nil {
		return err
	}
	return a.responderAccesos(ctx, w, r, http.StatusOK)
}
