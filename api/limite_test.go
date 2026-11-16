package main

import (
	"testing"
	"time"
)

func TestLimiteClave(t *testing.T) {
	var l limiteClave
	ahora := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)

	for i := 0; i < clavesFallidasTope-1; i++ {
		l.fallo(7, ahora)
	}
	if l.bloqueado(7, ahora) {
		t.Fatal("con un fallo menos que el tope no debe bloquear")
	}
	l.fallo(7, ahora)
	if !l.bloqueado(7, ahora) {
		t.Fatal("al llegar al tope debe bloquear")
	}
	if l.bloqueado(8, ahora) {
		t.Fatal("el bloqueo de un operador no debe afectar a otro")
	}
	if !l.bloqueado(7, ahora.Add(clavesFallidasVentana-time.Second)) {
		t.Fatal("dentro de la ventana debe seguir bloqueado")
	}
	if l.bloqueado(7, ahora.Add(clavesFallidasVentana+time.Second)) {
		t.Fatal("pasada la ventana debe quedar libre")
	}

	for i := 0; i < clavesFallidasTope; i++ {
		l.fallo(9, ahora)
	}
	l.limpiar(9)
	if l.bloqueado(9, ahora) {
		t.Fatal("un acierto debe borrar los fallos")
	}
}
