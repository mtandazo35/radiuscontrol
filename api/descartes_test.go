package main

import "testing"

func TestParsearDescarte(t *testing.T) {
	casos := []struct {
		linea  string
		ok     bool
		motivo string
		ip     string
		router int64
	}{
		{"1795291478\tSat Nov 21 19:44:38 2026 : Info: Dropping packet without response because of error: Received packet from 192.0.2.130 with invalid Message-Authenticator!  (Shared secret is incorrect.) (from client rc-123-87)",
			true, "secreto", "192.0.2.130", 123},
		{"1795291478\tInfo: Dropping packet without response because of error: Received packet from 198.51.100.7 without Message-Authenticator (from client rc-9-3)",
			true, "message_authenticator", "198.51.100.7", 9},
		{"1795291478\tInfo: Dropping packet without response because of error: Received packet from 203.0.113.5 something else (from client rc-4-1)",
			true, "otro", "203.0.113.5", 4},
		// Un cliente desconocido no es un router del panel: no cuenta.
		{"1795291478\tIgnoring request to auth address * port 1812 bound to server default from unknown client 203.0.113.9 port 4321 proto udp", false, "", "", 0},
		{"sin tabulador", false, "", "", 0},
		{"no-es-numero\tDropping packet ... Received packet from 192.0.2.1 (from client rc-1-1)", false, "", "", 0},
	}
	for _, c := range casos {
		d, ok := parsearDescarte(c.linea)
		if ok != c.ok {
			t.Fatalf("%q: ok = %v, se esperaba %v", c.linea, ok, c.ok)
		}
		if !ok {
			continue
		}
		if d.Motivo != c.motivo || d.IP != c.ip || d.RouterID != c.router {
			t.Fatalf("%q: motivo=%s ip=%s router=%d", c.linea, d.Motivo, d.IP, d.RouterID)
		}
	}
}
