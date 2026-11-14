package main

import (
	"encoding/base64"
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
		"vacío":              {},
		"todas las v4":       {"0.0.0.0/0"},
		"todas las v6":       {"::/0"},
		"texto":              {"router-a"},
		"superpuestas":       {"192.0.2.0/24", "192.0.2.128/25"},
		"v4 dentro de v6":    {"::ffff:192.0.2.1"},
		"máscara imposible":  {"192.0.2.0/33"},
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
	usuarios := []usuarioComp{{Usuario: "tecnico1", Grupo: "full", HashNT: "8846F7EAEE8FB117AD06BDD830B7586C"}}
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
	} {
		if !strings.Contains(texto, esperado) {
			t.Errorf("falta %q en clients.conf", esperado)
		}
	}
	if !strings.Contains(string(a.Authorize), "tecnico1\tNT-Password := \"8846F7EAEE8FB117AD06BDD830B7586C\"\n\tMikrotik-Group := \"full\"\n") {
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

func TestRenderizarEscapaElSecreto(t *testing.T) {
	c := renderizar([]clienteComp{{RouterID: 1, RedID: 1, Red: "192.0.2.1/32", Secreto: `a'b\c${d}`}}, nil)
	if !strings.Contains(string(c.Clients), `secret = 'a\'b\c${d}'`) {
		t.Fatalf("secreto mal escapado:\n%s", c.Clients)
	}
	if got := c.enmascarar(`error cerca de a'b\c${d}`); strings.Contains(got, "${d}") {
		t.Fatalf("el secreto no se enmascaró: %s", got)
	}
}
