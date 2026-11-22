package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"io"
	"testing"
	"time"
)

func TestMigracionCifrado(t *testing.T) {
	frase := "frase de prueba larga"
	m := ManifiestoMigracion{Formato: 1, Fecha: time.Unix(1795291478, 0).UTC(), Origen: "192.0.2.10", Routers: 3}
	paquete, err := empaquetarMigracion(m, "Q2xhdmUgbWFlc3RyYSBkZSBwcnVlYmEgMzIgYnl0ZXM=", []byte("PGDMP volcado"))
	if err != nil {
		t.Fatal(err)
	}
	archivo, err := cifrarMigracion(paquete, frase)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(archivo, []byte("PGDMP")) || bytes.Contains(archivo, []byte("Q2xhdmUg")) {
		t.Fatal("el archivo cifrado deja ver el contenido")
	}

	claro, err := descifrarMigracion(archivo, frase)
	if err != nil {
		t.Fatalf("con la frase correcta: %v", err)
	}
	archivos := map[string]string{}
	gz, err := gzip.NewReader(bytes.NewReader(claro))
	if err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(tr)
		archivos[h.Name] = string(b)
	}
	if archivos["base.dump"] != "PGDMP volcado" || archivos["clave_maestra"] != "Q2xhdmUgbWFlc3RyYSBkZSBwcnVlYmEgMzIgYnl0ZXM=\n" {
		t.Fatalf("contenido inesperado: %q", archivos)
	}
	var leido ManifiestoMigracion
	if err := json.Unmarshal([]byte(archivos["manifiesto.json"]), &leido); err != nil || leido.Routers != 3 || leido.Formato != 1 {
		t.Fatalf("manifiesto: %v %+v", err, leido)
	}

	if _, err := descifrarMigracion(archivo, "otra frase distinta"); !errors.Is(err, errFraseMigracion) {
		t.Fatalf("con la frase equivocada: %v", err)
	}
	manipulado := bytes.Clone(archivo)
	manipulado[len(manipulado)-1] ^= 1
	if _, err := descifrarMigracion(manipulado, frase); !errors.Is(err, errFraseMigracion) {
		t.Fatalf("manipulado: %v", err)
	}
	if _, err := descifrarMigracion([]byte("no es un archivo de migracion, solo texto cualquiera"), frase); err == nil {
		t.Fatal("aceptó un archivo que no es de migración")
	}

	// Dos cifrados de lo mismo no se parecen: sal y nonce nuevos cada vez.
	otro, _ := cifrarMigracion(paquete, frase)
	if bytes.Equal(otro[8:24], archivo[8:24]) {
		t.Fatal("la sal se repite")
	}
}
