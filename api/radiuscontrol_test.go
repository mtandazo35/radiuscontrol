package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestHashNTVectorConocido(t *testing.T) {
	// Vector público: el hash NT de "password".
	if got := hashNT("password"); got != "8846F7EAEE8FB117AD06BDD830B7586C" {
		t.Fatalf("hash NT incorrecto: %s", got)
	}
}

func TestHashNTNoAscii(t *testing.T) {
	if hashNT("contraseña") == hashNT("contrasena") {
		t.Fatal("la ñ debe producir un hash distinto")
	}
}

func cifradorDePrueba(t *testing.T) *Cifrador {
	t.Helper()
	c, err := nuevoCifrador(base64.StdEncoding.EncodeToString(make([]byte, 32)))
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestCifradoSeparaDominios(t *testing.T) {
	c := cifradorDePrueba(t)
	dato, err := c.Cifrar([]byte("valor"), dominioSecreto)
	if err != nil {
		t.Fatal(err)
	}
	claro, err := c.Descifrar(dato, dominioSecreto)
	if err != nil || string(claro) != "valor" {
		t.Fatalf("no se recuperó el valor: %v", err)
	}
	if _, err := c.Descifrar(dato, dominioHashNT); err == nil {
		t.Fatal("un dato de un dominio no debe descifrarse como si fuera de otro")
	}
	dato[len(dato)-1] ^= 1
	if _, err := c.Descifrar(dato, dominioSecreto); err == nil {
		t.Fatal("un dato alterado no debe descifrarse")
	}
}

func TestClaveMaestraInvalida(t *testing.T) {
	if _, err := nuevoCifrador("corta"); err == nil {
		t.Fatal("debe rechazar una clave que no tenga 32 bytes")
	}
}

func TestArgon2(t *testing.T) {
	h, err := hashArgon2("una clave larga")
	if err != nil {
		t.Fatal(err)
	}
	if !verificarArgon2("una clave larga", h) {
		t.Fatal("la clave correcta debe verificar")
	}
	if verificarArgon2("otra clave", h) {
		t.Fatal("una clave distinta no debe verificar")
	}
	if verificarArgon2("una clave larga", "basura") {
		t.Fatal("un hash mal formado no debe verificar")
	}
}

func TestNormalizarRedes(t *testing.T) {
	redes, err := normalizarRedes([]string{" 192.0.2.10 ", "198.51.100.9/29", "2001:db8::1", ""})
	if err != nil {
		t.Fatal(err)
	}
	got := []string{redes[0].String(), redes[1].String(), redes[2].String()}
	want := []string{"192.0.2.10/32", "198.51.100.8/29", "2001:db8::1/128"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("red %d: %s, se esperaba %s", i, got[i], want[i])
		}
	}
}

func TestNormalizarRedesRechaza(t *testing.T) {
	casos := map[string][]string{
		"vacío":             {},
		"todas las v4":      {"0.0.0.0/0"},
		"todas las v6":      {"::/0"},
		"texto":             {"router-a"},
		"superpuestas":      {"192.0.2.0/24", "192.0.2.128/25"},
		"v4 dentro de v6":   {"::ffff:192.0.2.1"},
		"máscara imposible": {"192.0.2.0/33"},
	}
	for nombre, entrada := range casos {
		if _, err := normalizarRedes(entrada); err == nil {
			t.Errorf("%s: debía rechazarse", nombre)
		}
	}
}

func TestNombresReservados(t *testing.T) {
	for _, u := range []string{"DEFAULT", "default", "Default", "", "con espacio", "a\nb", `a"b`, "-inicio"} {
		if validarNombreUsuario(u) == nil {
			t.Errorf("el usuario %q debía rechazarse", u)
		}
	}
	for _, u := range []string{"tecnico1", "ana.perez", "soporte_n2", "a@b"} {
		if err := validarNombreUsuario(u); err != nil {
			t.Errorf("el usuario %q debía aceptarse: %v", u, err)
		}
	}
	for _, g := range []string{"", "full\"", "a b", "x\ny"} {
		if validarGrupo(g) == nil {
			t.Errorf("el grupo %q debía rechazarse", g)
		}
	}
}

func TestValidarSecreto(t *testing.T) {
	if validarSecreto("") == nil || validarSecreto("con\nsalto") == nil || validarSecreto("eñe") == nil {
		t.Fatal("debía rechazar secretos vacíos, con saltos de línea o no ASCII")
	}
	if validarSecreto(`termina-en-barra\`) == nil || validarSecreto(`barra\'comilla`) == nil {
		t.Fatal("debía rechazar las dos formas que FreeRADIUS no puede representar")
	}
	if err := validarSecreto(`raro' "x" a\b ${x} #ok`); err != nil {
		t.Fatalf("debía aceptar ASCII imprimible: %v", err)
	}
}

func TestParsearLineaDelRegistro(t *testing.T) {
	linea := func(campos ...string) string { return strings.Join(campos, "\t") }

	a, err := parsearLinea(linea("1794690000", "aceptado", "tecnico%20uno", "192.0.2.10", "rc-7-12",
		"Router%20A", "192.0.2.10", "198.51.100.4", "MS-CHAPv2", "full", ""))
	if err != nil {
		t.Fatal(err)
	}
	if a.Resultado != "aceptado" || a.Usuario != "tecnico uno" || a.IPOrigen != "192.0.2.10" ||
		a.RouterID == nil || *a.RouterID != 7 || a.NASIdentifier != "Router A" ||
		a.Origen != "198.51.100.4" || a.Metodo != "MS-CHAPv2" || a.Grupo != "full" || a.Motivo != "" {
		t.Fatalf("línea mal interpretada: %+v", a)
	}
	if a.Fecha.Unix() != 1794690000 {
		t.Fatalf("fecha incorrecta: %v", a.Fecha)
	}

	// Un usuario con tabulador o salto de línea llega codificado y no rompe el formato.
	b, err := parsearLinea(linea("1794690000", "rechazado", "a%09b%0Ac", "192.0.2.10", "otro",
		"", "", "", "PAP", "", "motivo%3A%20x"))
	if err != nil {
		t.Fatal(err)
	}
	if b.Usuario != "a\tb\nc" || b.RouterID != nil || b.Motivo != "motivo: x" {
		t.Fatalf("línea mal interpretada: %+v", b)
	}

	malas := []string{
		"",
		linea("x", "aceptado"),
		linea("abc", "aceptado", "", "", "", "", "", "", "", "", ""),
		linea("1", "quizas", "", "", "", "", "", "", "", "", ""),
	}
	for _, mala := range malas {
		if _, err := parsearLinea(mala); err == nil {
			t.Errorf("la línea %q debía rechazarse", mala)
		}
	}
}

func TestRenderizarEsDeterminista(t *testing.T) {
	clientes := []clienteComp{
		{RouterID: 1, RedID: 1, Red: "192.0.2.10/32", Secreto: "abc", ExigirMA: true},
		{RouterID: 1, RedID: 2, Red: "2001:db8::/64", Secreto: "abc", ExigirMA: true},
		{RouterID: 2, RedID: 3, Red: "198.51.100.8/29", Secreto: "xyz", ExigirMA: false},
	}
	usuarios := []usuarioComp{{ID: 12, Usuario: "tecnico1", Grupo: "full", HashNT: "8846F7EAEE8FB117AD06BDD830B7586C"}}
	a, b := renderizar(clientes, usuarios), renderizar(clientes, usuarios)
	if a.ShaClients != b.ShaClients || a.ShaAuthorize != b.ShaAuthorize {
		t.Fatal("la misma entrada debe dar la misma huella")
	}
	if a.Routers != 2 || a.Usuarios != 1 {
		t.Fatalf("conteo incorrecto: %d routers, %d usuarios", a.Routers, a.Usuarios)
	}
	texto := string(a.Clients)
	for _, esperado := range []string{
		"client rc_1_1 {", "ipaddr = 192.0.2.10/32", "ipaddr = 2001:db8::/64",
		"secret = 'abc'", "require_message_authenticator = yes",
		"client rc_2_3 {", "require_message_authenticator = no", "limit_proxy_state = yes",
		"\tlimit_proxy_state = yes\n\trc_acceso = general\n}\n",
	} {
		if !strings.Contains(texto, esperado) {
			t.Errorf("falta %q en clients.conf", esperado)
		}
	}
	if n := strings.Count(texto, "\trc_acceso = general\n"); n != 3 {
		t.Errorf("cada sección client debe llevar su modo de acceso: %d de 3", n)
	}
	if strings.Contains(texto, "rc_u_") || strings.Contains(texto, "restringido") {
		t.Errorf("un router general no lleva permisos por usuario:\n%s", texto)
	}
	if !strings.Contains(string(a.Authorize), "\ntecnico1\tNT-Password := \"8846F7EAEE8FB117AD06BDD830B7586C\", Tmp-Integer-0 := 12\n\tMikrotik-Group := \"full\"\n") {
		t.Errorf("authorize inesperado:\n%s", a.Authorize)
	}
	usuarios[0].Grupo = "read"
	if renderizar(clientes, usuarios).ShaAuthorize == a.ShaAuthorize {
		t.Fatal("un cambio de grupo debe cambiar la huella")
	}
}

func TestTOTPVectoresRFC6238(t *testing.T) {
	secreto := []byte("12345678901234567890")
	// Vectores de la RFC 6238 (SHA-1), recortados a 6 cifras.
	casos := map[int64]string{59: "287082", 1111111109: "081804", 1234567890: "005924", 2000000000: "279037"}
	for instante, esperado := range casos {
		if got := codigoTOTP(secreto, uint64(instante/periodoTOTP)); got != esperado {
			t.Errorf("instante %d: %s, se esperaba %s", instante, got, esperado)
		}
	}
}

func TestTOTPVentanaYRepeticion(t *testing.T) {
	secreto := []byte("12345678901234567890")
	ahora := time.Unix(1111111109, 0)
	actual := ahora.Unix() / periodoTOTP

	contador, ok := verificarTOTP(secreto, "081804", ahora, 0)
	if !ok || contador != actual {
		t.Fatalf("el código del periodo actual debe aceptarse (contador %d, ok %v)", contador, ok)
	}
	if _, ok := verificarTOTP(secreto, "081804", ahora, contador); ok {
		t.Fatal("un código ya usado no debe aceptarse otra vez")
	}
	if _, ok := verificarTOTP(secreto, " 081 804 ", ahora, 0); !ok {
		t.Fatal("deben tolerarse los espacios al escribir el código")
	}
	if _, ok := verificarTOTP(secreto, codigoTOTP(secreto, uint64(actual-1)), ahora, 0); !ok {
		t.Fatal("el código del periodo anterior debe aceptarse")
	}
	if _, ok := verificarTOTP(secreto, codigoTOTP(secreto, uint64(actual-3)), ahora, 0); ok {
		t.Fatal("un código de hace tres periodos no debe aceptarse")
	}
	for _, malo := range []string{"", "12345", "1234567", "abcdef"} {
		if _, ok := verificarTOTP(secreto, malo, ahora, 0); ok {
			t.Errorf("el código %q no debe aceptarse", malo)
		}
	}
}

func TestListaRedes(t *testing.T) {
	c := renderizar([]clienteComp{
		{RouterID: 1, RedID: 1, Red: "192.0.2.10/32", Secreto: "ipaddr = 203.0.113.9"},
		{RouterID: 2, RedID: 2, Red: "2001:db8::/64", Secreto: "x"},
	}, nil)
	got := string(listaRedes(c.Clients))
	want := "# Generado por RadiusControl. Redes con acceso a 1812/udp.\n192.0.2.10/32\n2001:db8::/64\n# fin\n"
	if got != want {
		t.Fatalf("lista de redes inesperada:\n%s", got)
	}
	if vacia := string(listaRedes(renderizar(nil, nil).Clients)); !strings.HasSuffix(vacia, "# fin\n") || strings.Count(vacia, "\n") != 2 {
		t.Fatalf("la lista vacía debe llevar solo la cabecera y el final:\n%s", vacia)
	}
}

func TestRenderizarAccesosPorRouter(t *testing.T) {
	permisos := []permisoComp{{UsuarioID: 30, Grupo: "read"}, {UsuarioID: 4, Grupo: "full"}, {UsuarioID: 12, Grupo: "write"}}
	clientes := func() []clienteComp {
		return []clienteComp{
			{RouterID: 1, RedID: 1, Red: "192.0.2.10/32", Secreto: "abc", ExigirMA: true,
				Acceso: accesoRestringido, Permisos: permisos},
			{RouterID: 1, RedID: 2, Red: "192.0.2.11/32", Secreto: "abc", ExigirMA: true,
				Acceso: accesoRestringido, Permisos: permisos},
			// Un router general no compila sus asignaciones aunque las tenga.
			{RouterID: 2, RedID: 3, Red: "198.51.100.8/29", Secreto: "xyz", ExigirMA: true,
				Acceso: accesoGeneral, Permisos: []permisoComp{{UsuarioID: 99, Grupo: "full"}}},
		}
	}
	a := renderizar(clientes(), nil)
	texto := string(a.Clients)

	// Las líneas van ordenadas por identificador de usuario y se repiten en
	// cada red del router restringido.
	bloque := "\tlimit_proxy_state = yes\n\trc_acceso = restringido\n" +
		"\trc_u_4 = 'full'\n\trc_u_12 = 'write'\n\trc_u_30 = 'read'\n}\n"
	if n := strings.Count(texto, bloque); n != 2 {
		t.Fatalf("el router restringido debe llevar sus permisos ordenados en sus 2 redes (%d):\n%s", n, texto)
	}
	if permisos[0].UsuarioID != 30 {
		t.Fatal("renderizar no debe reordenar la lista que recibe")
	}

	general := texto[strings.Index(texto, "client rc_2_3 {"):]
	if !strings.Contains(general, "\trc_acceso = general\n}\n") {
		t.Errorf("el router general debe declarar su modo:\n%s", general)
	}
	if strings.Contains(general, "rc_u_") {
		t.Errorf("un router general no lleva ningún permiso por usuario:\n%s", general)
	}
	if n := strings.Count(texto, "rc_u_"); n != 6 {
		t.Errorf("se esperaban 6 líneas de permisos y hay %d", n)
	}

	// El mismo dato en otro orden da los mismos bytes.
	otro := clientes()
	otro[0].Permisos = []permisoComp{{UsuarioID: 12, Grupo: "write"}, {UsuarioID: 30, Grupo: "read"}, {UsuarioID: 4, Grupo: "full"}}
	otro[1].Permisos = otro[0].Permisos
	if renderizar(otro, nil).ShaClients != a.ShaClients {
		t.Fatal("el orden de los permisos no debe cambiar la huella")
	}

	// Cambiar una asignación, quitarla o cambiar el modo cambia la huella.
	cambiado := clientes()
	cambiado[0].Permisos = []permisoComp{{UsuarioID: 30, Grupo: "full"}, {UsuarioID: 4, Grupo: "full"}, {UsuarioID: 12, Grupo: "write"}}
	if renderizar(cambiado, nil).ShaClients == a.ShaClients {
		t.Fatal("cambiar el grupo de una asignación debe cambiar la huella de clients")
	}
	quitado := clientes()
	quitado[0].Permisos = permisos[:2]
	if renderizar(quitado, nil).ShaClients == a.ShaClients {
		t.Fatal("quitar una asignación debe cambiar la huella de clients")
	}
	modo := clientes()
	modo[2].Acceso = accesoRestringido
	if renderizar(modo, nil).ShaClients == a.ShaClients {
		t.Fatal("cambiar el modo de un router debe cambiar la huella de clients")
	}

	// Las redes que ve el firewall no dependen de los accesos.
	want := "# Generado por RadiusControl. Redes con acceso a 1812/udp.\n192.0.2.10/32\n192.0.2.11/32\n198.51.100.8/29\n# fin\n"
	if got := string(listaRedes(a.Clients)); got != want {
		t.Fatalf("lista de redes inesperada:\n%s", got)
	}
}

func TestPlanEmergencia(t *testing.T) {
	casos := []struct {
		dias int
		plan []int
	}{
		{180, []int{90, 45, 22, 11, 7}},
		{3650, []int{1825, 912, 456, 228, 114, 57, 28, 14, 7}},
		{365, []int{182, 91, 45, 22, 11, 7}},
		{14, []int{7}},
		{10, []int{7}},
		{8, []int{7}},
		{7, nil},
		{3, nil},
	}
	for _, c := range casos {
		got := planEmergencia(c.dias)
		if !slices.Equal(got, c.plan) {
			t.Errorf("%d días: %v, se esperaba %v", c.dias, got, c.plan)
		}
		for i, d := range got {
			if d < minDiasAutenticaciones || d >= c.dias || (i > 0 && d >= got[i-1]) {
				t.Errorf("%d días: el plan %v baja del mínimo o repite una retención", c.dias, got)
			}
		}
	}
}

func TestValidarAjustesPurga(t *testing.T) {
	if err := ajustesPurgaPorOmision().validar(); err != nil {
		t.Fatalf("los ajustes por omisión deben ser válidos: %v", err)
	}
	if aj := ajustesPurgaPorOmision(); aj.DiasAutenticaciones != 180 || aj.DiasActividad != 365 ||
		aj.CadaHoras != 24 || aj.PorcentajeDisco != 50 {
		t.Fatalf("ajustes por omisión inesperados: %+v", aj)
	}
	campos := []struct {
		nombre         string
		campo          func(*AjustesPurga) *int
		minimo, maximo int
	}{
		{"dias_autenticaciones", func(a *AjustesPurga) *int { return &a.DiasAutenticaciones }, 7, 3650},
		{"dias_actividad", func(a *AjustesPurga) *int { return &a.DiasActividad }, 30, 3650},
		{"cada_horas", func(a *AjustesPurga) *int { return &a.CadaHoras }, 1, 720},
		{"porcentaje_disco", func(a *AjustesPurga) *int { return &a.PorcentajeDisco }, 20, 95},
	}
	for _, c := range campos {
		for _, v := range []int{c.minimo, c.maximo} {
			aj := ajustesPurgaPorOmision()
			*c.campo(&aj) = v
			if err := aj.validar(); err != nil {
				t.Errorf("%s = %d debía aceptarse: %v", c.nombre, v, err)
			}
		}
		for _, v := range []int{c.minimo - 1, c.maximo + 1, 0, -1} {
			aj := ajustesPurgaPorOmision()
			*c.campo(&aj) = v
			if aj.validar() == nil {
				t.Errorf("%s = %d debía rechazarse", c.nombre, v)
			}
		}
	}
	// Un cuerpo vacío deja todos los campos a cero y no debe aceptarse.
	if (AjustesPurga{}).validar() == nil {
		t.Error("unos ajustes vacíos debían rechazarse")
	}
}

func TestRenderizarEscapaElSecreto(t *testing.T) {
	c := renderizar([]clienteComp{{RouterID: 1, RedID: 1, Red: "192.0.2.1/32", Secreto: `a'b\c${d}`}}, nil)
	if !strings.Contains(string(c.Clients), `secret = 'a\'b\c${d}'`) {
		t.Fatalf("secreto mal escapado:\n%s", c.Clients)
	}
	if got := c.enmascarar(`error cerca de a'b\c${d}`); strings.Contains(got, "${d}") {
		t.Fatalf("el secreto no se enmascaró: %s", got)
	}
}

// codigoDe devuelve el código HTTP con el que se respondería ese error, o cero.
func codigoDe(err error) int {
	var e *errHTTP
	if errors.As(err, &e) {
		return e.codigo
	}
	return 0
}

func TestNormalizarRedAcceso(t *testing.T) {
	// Cada pareja es lo que escribe el operador y lo que se guarda.
	validas := [][2]string{
		{" 192.0.2.7 ", "192.0.2.7/32"},
		{"192.0.2.9/24", "192.0.2.0/24"},
		{"198.51.100.8/29", "198.51.100.8/29"},
		{"2001:db8::1", "2001:db8::1/128"},
		{"2001:DB8:0:0::5/64", "2001:db8::/64"},
		{"cualquiera", "cualquiera"},
		{" Cualquiera ", "cualquiera"},
	}
	for _, c := range validas {
		got, err := normalizarRedAcceso(c[0])
		if err != nil || got != c[1] {
			t.Errorf("%q: %q (%v), se esperaba %q", c[0], got, err, c[1])
		}
	}
	// Abrir a todos se pide con la palabra, no con un prefijo /0.
	for _, todo := range []string{"0.0.0.0/0", "::/0", " 0.0.0.0/0 ", "192.0.2.1/0"} {
		_, err := normalizarRedAcceso(todo)
		if codigoDe(err) != http.StatusBadRequest || !strings.Contains(err.Error(), "cualquiera") {
			t.Errorf("%q debía rechazarse indicando que se use «cualquiera»: %v", todo, err)
		}
	}
	basura := []string{"", "   ", "router-a", "any", "todas", "192.0.2.0/33", "192.0.2.256", "192.0.2.1/",
		"::ffff:192.0.2.1", "fe80::1%eth0", "192.0.2.1, 192.0.2.2", "192.0.2.1 198.51.100.1",
		"192.0.2.1\n198.51.100.1", "cualquiera/24", "2001:db8::/129"}
	for _, mala := range basura {
		if got, err := normalizarRedAcceso(mala); codigoDe(err) != http.StatusBadRequest {
			t.Errorf("%q debía rechazarse con un 400: %q (%v)", mala, got, err)
		}
	}
}

func TestTextoAccesos(t *testing.T) {
	got := string(textoAccesos([]reglaAcceso{
		{servicioSSH, "cualquiera"},
		{servicioPanel, "2001:db8::/64"},
		{servicioPanel, "192.0.2.0/24"},
		{servicioSSH, "203.0.113.7/32"},
		// Nada que no sea canónico llega al archivo.
		{servicioPanel, "0.0.0.0/0"},
		{servicioPanel, "192.0.2.7"},
		{servicioPanel, "192.0.2.1/32 ssh cualquiera"},
		{"otro", "192.0.2.0/24"},
	}))
	want := "# Generado por RadiusControl. Accesos al panel y al SSH gestionados desde el panel.\n" +
		"panel 192.0.2.0/24\npanel 2001:db8::/64\nssh 203.0.113.7/32\nssh cualquiera\n# fin\n"
	if got != want {
		t.Fatalf("lista de accesos inesperada:\n%s", got)
	}
	if vacia := string(textoAccesos(nil)); !strings.HasSuffix(vacia, "# fin\n") || strings.Count(vacia, "\n") != 2 {
		t.Fatalf("la lista vacía debe llevar solo la cabecera y el final:\n%s", vacia)
	}
}

func TestSalvaguardaPanel(t *testing.T) {
	casos := []struct {
		nombre         string
		antes, despues []reglaAcceso
		ip             string
		bloquea        bool
	}{
		{"pierde la única red que lo cubre",
			[]reglaAcceso{{servicioPanel, "192.0.2.0/24"}, {servicioPanel, "203.0.113.0/24"}},
			[]reglaAcceso{{servicioPanel, "203.0.113.0/24"}}, "192.0.2.200", true},
		{"queda cubierto por otra red más pequeña",
			[]reglaAcceso{{servicioPanel, "192.0.2.0/24"}, {servicioPanel, "192.0.2.128/25"}},
			[]reglaAcceso{{servicioPanel, "192.0.2.128/25"}}, "192.0.2.200", false},
		{"queda cubierto por una dirección suelta",
			[]reglaAcceso{{servicioPanel, "192.0.2.0/24"}, {servicioPanel, "192.0.2.200/32"}},
			[]reglaAcceso{{servicioPanel, "192.0.2.200/32"}}, "192.0.2.200", false},
		{"queda cubierto por «cualquiera»",
			[]reglaAcceso{{servicioPanel, "192.0.2.0/24"}, {servicioPanel, "cualquiera"}},
			[]reglaAcceso{{servicioPanel, "cualquiera"}}, "192.0.2.200", false},
		{"pierde «cualquiera» y ninguna red lo cubre",
			[]reglaAcceso{{servicioPanel, "cualquiera"}, {servicioPanel, "203.0.113.0/24"}},
			[]reglaAcceso{{servicioPanel, "203.0.113.0/24"}}, "192.0.2.200", true},
		{"ya no tenía acceso antes del cambio",
			[]reglaAcceso{{servicioPanel, "203.0.113.0/24"}, {servicioPanel, "198.51.100.0/24"}},
			[]reglaAcceso{{servicioPanel, "198.51.100.0/24"}}, "192.0.2.200", false},
		{"una regla de SSH no da acceso al panel",
			[]reglaAcceso{{servicioPanel, "192.0.2.0/24"}, {servicioSSH, "cualquiera"}},
			[]reglaAcceso{{servicioSSH, "cualquiera"}}, "192.0.2.200", true},
		{"IPv6: pierde su red",
			[]reglaAcceso{{servicioPanel, "2001:db8::/32"}, {servicioPanel, "192.0.2.0/24"}},
			[]reglaAcceso{{servicioPanel, "192.0.2.0/24"}}, "2001:db8::9", true},
		{"IPv6: queda cubierto por otra red",
			[]reglaAcceso{{servicioPanel, "2001:db8::/32"}, {servicioPanel, "2001:db8::/64"}},
			[]reglaAcceso{{servicioPanel, "2001:db8::/64"}}, "2001:db8::9", false},
		{"IPv6: queda cubierto por «cualquiera»",
			[]reglaAcceso{{servicioPanel, "2001:db8::/32"}, {servicioPanel, "cualquiera"}},
			[]reglaAcceso{{servicioPanel, "cualquiera"}}, "2001:db8::9", false},
		{"una dirección IPv4 escrita como IPv6 cuenta como IPv4",
			[]reglaAcceso{{servicioPanel, "192.0.2.0/24"}}, nil, "::ffff:192.0.2.200", true},
		{"una dirección con espacios alrededor se interpreta igual",
			[]reglaAcceso{{servicioPanel, "192.0.2.0/24"}}, nil, " 192.0.2.200 ", true},
		{"una dirección que no se entiende no bloquea",
			[]reglaAcceso{{servicioPanel, "cualquiera"}}, nil, "desconocida", false},
		{"sin dirección no bloquea",
			[]reglaAcceso{{servicioPanel, "cualquiera"}}, nil, "", false},
	}
	for _, c := range casos {
		err := salvaguardaPanel(c.antes, c.despues, c.ip)
		if c.bloquea != (codigoDe(err) == http.StatusConflict) {
			t.Errorf("%s: bloquea = %v, se esperaba %v (%v)", c.nombre, err != nil, c.bloquea, err)
		}
	}
	err := salvaguardaPanel([]reglaAcceso{{servicioPanel, "192.0.2.0/24"}}, nil, "192.0.2.200")
	if err == nil || !strings.Contains(err.Error(), "(192.0.2.200)") {
		t.Errorf("el mensaje debe decir la dirección que se quedaría fuera: %v", err)
	}
}

func TestSalvaguardaSSH(t *testing.T) {
	ssh := reglaAcceso{servicioSSH, "203.0.113.0/24"}
	casos := []struct {
		nombre  string
		quitada reglaAcceso
		despues []reglaAcceso
		bloquea bool
	}{
		{"no queda ninguna regla", ssh, nil, true},
		{"solo quedan reglas del panel", ssh, []reglaAcceso{{servicioPanel, "cualquiera"}}, true},
		{"queda otra red de SSH", ssh, []reglaAcceso{{servicioSSH, "198.51.100.7/32"}}, false},
		{"queda SSH abierto a cualquiera", ssh, []reglaAcceso{{servicioSSH, "cualquiera"}}, false},
		{"queda una red IPv6 de SSH", ssh, []reglaAcceso{{servicioSSH, "2001:db8::/64"}}, false},
		{"quitar un acceso del panel no depende del SSH", reglaAcceso{servicioPanel, "192.0.2.0/24"}, nil, false},
	}
	for _, c := range casos {
		err := salvaguardaSSH(c.quitada, c.despues)
		if c.bloquea != (codigoDe(err) == http.StatusConflict) {
			t.Errorf("%s: bloquea = %v, se esperaba %v (%v)", c.nombre, err != nil, c.bloquea, err)
		}
	}
}

func TestComprobarBaja(t *testing.T) {
	ahora := time.Date(2026, 3, 4, 12, 0, 0, 0, time.UTC)
	// informe reciente del agente con esas reglas de UFW
	informe := func(reglas ...reglaFirewall) *informeFirewall {
		return &informeFirewall{UFWActivo: true, Desde: ahora.Add(-30 * time.Second).Format(time.RFC3339),
			Servidor: &estadoServidor{Estado: "sincronizado", PuertoSSH: 22, Reglas: reglas}}
	}
	panelA := reglaAcceso{servicioPanel, "192.0.2.0/24"}
	panelB := reglaAcceso{servicioPanel, "198.51.100.0/24"}
	sshA := reglaAcceso{servicioSSH, "203.0.113.0/24"}
	const dentro, fuera = "192.0.2.200", "203.0.113.5"

	// Sin datos del agente no se quita nada, aunque por lo demás fuera seguro.
	antiguo := informe(reglaFirewall{Servicio: servicioSSH, Red: "cualquiera"})
	antiguo.Desde = ahora.Add(-10 * time.Minute).Format(time.RFC3339)
	ilegible := informe(reglaFirewall{Servicio: servicioSSH, Red: "cualquiera"})
	ilegible.Desde = "ayer"
	sinServidor := &informeFirewall{UFWActivo: true, Desde: ahora.Format(time.RFC3339)}
	sinDatos := []struct {
		nombre string
		inf    *informeFirewall
	}{
		{"sin informe", nil},
		{"informe sin el objeto servidor", sinServidor},
		{"informe antiguo", antiguo},
		{"informe con una fecha que no se lee", ilegible},
	}
	for _, c := range sinDatos {
		err := comprobarBaja(c.inf, []reglaAcceso{panelA, panelB, sshA}, panelB, fuera, ahora)
		if codigoDe(err) != http.StatusConflict || !strings.Contains(err.Error(), "agente de firewall") {
			t.Errorf("%s: la baja debía rechazarse por falta de datos del agente: %v", c.nombre, err)
		}
	}
	// El mismo cambio, con un informe reciente, sí se permite.
	if err := comprobarBaja(informe(), []reglaAcceso{panelA, panelB, sshA}, panelB, fuera, ahora); err != nil {
		t.Errorf("con un informe reciente la baja debía permitirse: %v", err)
	}

	casos := []struct {
		nombre      string
		inf         *informeFirewall
		gestionadas []reglaAcceso
		quitada     reglaAcceso
		ip          string
		bloquea     string // parte del mensaje esperado; vacío si debe permitirse
	}{
		{"panel: la red del operador es la única que lo cubre",
			informe(reglaFirewall{Servicio: servicioPanel, Red: "203.0.113.0/24", Comentario: "Panel"}),
			[]reglaAcceso{panelA}, panelA, dentro, "sin acceso al panel"},
		{"panel: el operador entra por una regla cargada a mano",
			informe(reglaFirewall{Servicio: servicioPanel, Red: "203.0.113.0/24", Comentario: "Panel"}),
			[]reglaAcceso{panelA}, panelA, fuera, ""},
		{"panel: una dirección suelta que el agente informa sin máscara también cubre",
			informe(reglaFirewall{Servicio: servicioPanel, Red: "192.0.2.200"}),
			[]reglaAcceso{panelA}, panelA, dentro, ""},
		{"panel: queda otra red gestionada que lo cubre",
			informe(), []reglaAcceso{panelA, {servicioPanel, "192.0.2.128/25"}}, panelA, dentro, ""},
		{"panel: quitar otra red no afecta al operador",
			informe(), []reglaAcceso{panelA, panelB}, panelB, dentro, ""},
		{"panel: queda abierto a cualquiera por una regla manual",
			informe(reglaFirewall{Servicio: servicioPanel, Red: "cualquiera"}),
			[]reglaAcceso{panelA}, panelA, dentro, ""},
		{"panel: una regla gestionada que informa el agente no cuenta como manual",
			informe(reglaFirewall{Servicio: servicioPanel, Red: "192.0.2.0/24", Gestionada: true, Comentario: "radiuscontrol-panel"}),
			[]reglaAcceso{panelA}, panelA, dentro, "sin acceso al panel"},
		{"panel: una regla manual idéntica aún sin adoptar se iría con la baja",
			informe(reglaFirewall{Servicio: servicioPanel, Red: "192.0.2.0/24", Comentario: "Oficina"}),
			[]reglaAcceso{panelA}, panelA, dentro, "sin acceso al panel"},
		{"panel: una regla manual idéntica que convive con la ya aplicada se queda",
			informe(reglaFirewall{Servicio: servicioPanel, Red: "192.0.2.0/24", Gestionada: true, Comentario: "radiuscontrol-panel"},
				reglaFirewall{Servicio: servicioPanel, Red: "192.0.2.0/24"}),
			[]reglaAcceso{panelA}, panelA, dentro, ""},
		{"panel IPv6: la red del operador es la única que lo cubre",
			informe(reglaFirewall{Servicio: servicioPanel, Red: "192.0.2.0/24"}),
			[]reglaAcceso{{servicioPanel, "2001:db8::/48"}}, reglaAcceso{servicioPanel, "2001:db8::/48"}, "2001:db8::9", "sin acceso al panel"},
		{"panel IPv6: queda una regla manual que lo cubre",
			informe(reglaFirewall{Servicio: servicioPanel, Red: "2001:db8::9"}),
			[]reglaAcceso{{servicioPanel, "2001:db8::/48"}}, reglaAcceso{servicioPanel, "2001:db8::/48"}, "2001:db8::9", ""},
		{"ssh: es la última regla de SSH",
			informe(reglaFirewall{Servicio: servicioPanel, Red: "cualquiera"}),
			[]reglaAcceso{sshA, panelA}, sshA, fuera, "sin ningún acceso por SSH"},
		{"ssh: queda una regla manual",
			informe(reglaFirewall{Servicio: servicioSSH, Red: "198.51.100.7", Comentario: "SSH gestion"}),
			[]reglaAcceso{sshA}, sshA, fuera, ""},
		{"ssh: queda abierto a cualquiera por una regla manual",
			informe(reglaFirewall{Servicio: servicioSSH, Red: "cualquiera"}),
			[]reglaAcceso{sshA}, sshA, fuera, ""},
		{"ssh: queda otra regla gestionada",
			informe(), []reglaAcceso{sshA, {servicioSSH, "2001:db8::/64"}}, sshA, fuera, ""},
		{"ssh: la única otra regla es una gestionada que ya no está en la lista",
			informe(reglaFirewall{Servicio: servicioSSH, Red: "198.51.100.0/24", Gestionada: true, Comentario: "radiuscontrol-ssh"}),
			[]reglaAcceso{sshA}, sshA, fuera, "sin ningún acceso por SSH"},
		{"ssh: una regla de otro servicio desconocido no cuenta",
			informe(reglaFirewall{Servicio: "otro", Red: "cualquiera"}),
			[]reglaAcceso{sshA}, sshA, fuera, "sin ningún acceso por SSH"},
	}
	for _, c := range casos {
		err := comprobarBaja(c.inf, c.gestionadas, c.quitada, c.ip, ahora)
		if c.bloquea == "" {
			if err != nil {
				t.Errorf("%s: la baja debía permitirse: %v", c.nombre, err)
			}
			continue
		}
		if codigoDe(err) != http.StatusConflict || !strings.Contains(err.Error(), c.bloquea) {
			t.Errorf("%s: la baja debía rechazarse con «%s»: %v", c.nombre, c.bloquea, err)
		}
	}
}

func TestVistaAccesos(t *testing.T) {
	// Sin datos del agente: valores por omisión y listas vacías, nunca null.
	j, err := json.Marshal(vistaAccesos(nil, nil, "198.51.100.9"))
	if err != nil {
		t.Fatal(err)
	}
	for _, esperado := range []string{
		`"puerto_ssh":22`, `"tu_ip":"198.51.100.9"`, `"gestionadas":[]`, `"ajenas":[]`,
		`"firewall":{"desde":"","estado":"sin-datos","ufw_activo":false}`,
	} {
		if !strings.Contains(string(j), esperado) {
			t.Errorf("falta %s en la respuesta sin datos del agente:\n%s", esperado, j)
		}
	}

	lista := []AccesoServidor{
		{ID: 1, Servicio: servicioPanel, Red: "192.0.2.0/24", Descripcion: "Oficina", Operador: "admin"},
		{ID: 2, Servicio: servicioSSH, Red: "192.0.2.7/32", Operador: "admin"},
		{ID: 3, Servicio: servicioSSH, Red: "cualquiera", Operador: "admin"},
	}
	reglas := []reglaFirewall{
		// El agente informa de las direcciones sueltas sin máscara.
		{Servicio: servicioSSH, Red: "192.0.2.7", Gestionada: true, Comentario: "radiuscontrol-ssh"},
		{Servicio: servicioSSH, Red: "203.0.113.0/24", Comentario: "SSH gestion"},
		{Servicio: servicioPanel, Red: "cualquiera"},
		// La misma red, pero de otro servicio: no marca como aplicada la del panel.
		{Servicio: servicioSSH, Red: "192.0.2.0/24", Gestionada: true, Comentario: "radiuscontrol-ssh"},
	}
	inf := &informeFirewall{UFWActivo: true, Desde: "2026-03-04T12:00:00Z",
		Servidor: &estadoServidor{Estado: "sincronizado", PuertoSSH: 2222, Reglas: reglas}}
	v := vistaAccesos(lista, inf, "198.51.100.9")
	gestionadas, ok := v["gestionadas"].([]AccesoServidor)
	if !ok || len(gestionadas) != 3 {
		t.Fatalf("gestionadas inesperadas: %#v", v["gestionadas"])
	}
	if gestionadas[0].Aplicada || !gestionadas[1].Aplicada || gestionadas[2].Aplicada {
		t.Errorf("solo debe figurar como aplicada la que el agente informa como gestionada: %+v", gestionadas)
	}
	if lista[1].Aplicada {
		t.Error("vistaAccesos no debe modificar la lista que recibe")
	}
	if j, err = json.Marshal(v); err != nil {
		t.Fatal(err)
	}
	for _, esperado := range []string{
		`"puerto_ssh":2222`,
		`"ajenas":[{"servicio":"ssh","red":"203.0.113.0/24","comentario":"SSH gestion"},{"servicio":"panel","red":"cualquiera","comentario":""}]`,
		`"firewall":{"desde":"2026-03-04T12:00:00Z","estado":"sincronizado","ufw_activo":true}`,
	} {
		if !strings.Contains(string(j), esperado) {
			t.Errorf("falta %s en la respuesta:\n%s", esperado, j)
		}
	}
}
