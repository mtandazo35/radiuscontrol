package main

import (
	"archive/tar"
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
)

// Migración a otro servidor.
//
// Un administrador descarga desde el panel un archivo con toda la base y la
// clave maestra, cifrado con una frase que escribe en ese momento. En el
// servidor nuevo, instalar.sh lo restaura (RESTAURAR=/root/archivo.rcm): pide
// la frase, descifra con «radiuscontrol descifrar-migracion» y carga la base.
//
// La clave maestra tiene que viajar: con ella están cifrados los secretos de
// los routers, los hashes NT y las contraseñas consultables. Sin ella, la base
// copiada no sirve de nada en otro servidor.
//
// Formato del archivo:
//
//	«RCMIG001» | sal (16) | nonce (12) | AES-256-GCM(tar.gz)
//
// La clave sale de la frase con Argon2id; el encabezado va autenticado como
// dato adicional. Dentro del tar.gz: manifiesto.json, clave_maestra y
// base.dump (pg_dump en formato propio de PostgreSQL).

const (
	migracionMagia     = "RCMIG001"
	migracionLargoSal  = 16
	migracionFraseMin  = 12
	migracionEspera    = 60 * time.Second
	migracionTamanoMax = 2 << 30
)

type ManifiestoMigracion struct {
	Formato         int       `json:"formato"`
	Fecha           time.Time `json:"fecha"`
	Origen          string    `json:"origen"`
	Version         string    `json:"version"`
	UltimaMigracion string    `json:"ultima_migracion"`
	Routers         int       `json:"routers"`
	Usuarios        int       `json:"usuarios"`
	Operadores      int       `json:"operadores"`
	Operador        string    `json:"operador"`
}

func claveMigracion(frase string, sal []byte) []byte {
	return argon2.IDKey([]byte(frase), sal, 3, 64*1024, 4, 32)
}

func cifrarMigracion(claro []byte, frase string) ([]byte, error) {
	sal := make([]byte, migracionLargoSal)
	if _, err := rand.Read(sal); err != nil {
		return nil, err
	}
	bloque, err := aes.NewCipher(claveMigracion(frase, sal))
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(bloque)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	salida := make([]byte, 0, len(migracionMagia)+len(sal)+len(nonce)+len(claro)+aead.Overhead())
	salida = append(salida, migracionMagia...)
	salida = append(salida, sal...)
	salida = append(salida, nonce...)
	return aead.Seal(salida, nonce, claro, []byte(migracionMagia)), nil
}

var errFraseMigracion = errors.New("la frase no es correcta o el archivo está dañado")

func descifrarMigracion(dato []byte, frase string) ([]byte, error) {
	if len(dato) < len(migracionMagia)+migracionLargoSal+12+16 || string(dato[:len(migracionMagia)]) != migracionMagia {
		return nil, errors.New("no es un archivo de migración de RadiusControl")
	}
	resto := dato[len(migracionMagia):]
	sal := resto[:migracionLargoSal]
	resto = resto[migracionLargoSal:]
	bloque, err := aes.NewCipher(claveMigracion(frase, sal))
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(bloque)
	if err != nil {
		return nil, err
	}
	n := aead.NonceSize()
	claro, err := aead.Open(nil, resto[:n], resto[n:], []byte(migracionMagia))
	if err != nil {
		return nil, errFraseMigracion
	}
	return claro, nil
}

// empaquetarMigracion arma el tar.gz con los tres archivos.
func empaquetarMigracion(m ManifiestoMigracion, claveMaestra string, volcado []byte) ([]byte, error) {
	manifiesto, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, f := range []struct {
		nombre string
		datos  []byte
	}{
		{"manifiesto.json", append(manifiesto, '\n')},
		{"clave_maestra", []byte(claveMaestra + "\n")},
		{"base.dump", volcado},
	} {
		if err := tw.WriteHeader(&tar.Header{Name: f.nombre, Mode: 0o600, Size: int64(len(f.datos)), ModTime: m.Fecha}); err != nil {
			return nil, err
		}
		if _, err := tw.Write(f.datos); err != nil {
			return nil, err
		}
	}
	if err := tw.Close(); err != nil {
		return nil, err
	}
	if err := gz.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// pedirVolcado pide al agente del servidor un pg_dump y lo espera. La API no
// lleva el cliente de PostgreSQL; el agente ya hace los volcados de los
// respaldos de cada actualización.
func (a *App) pedirVolcado(ctx context.Context) ([]byte, error) {
	id := aleatorioHex(8)
	volcado := a.archivoEstado("migracion-" + id + ".dump")
	fallo := a.archivoEstado("migracion-" + id + ".error")
	pedido := a.archivoEstado("migracion-pedido.json")
	defer os.Remove(volcado)
	defer os.Remove(fallo)
	if err := os.WriteFile(pedido, []byte(`{"id":"`+id+`"}`+"\n"), 0o600); err != nil {
		return nil, err
	}
	limite := time.Now().Add(migracionEspera)
	for time.Now().Before(limite) {
		if b, err := os.ReadFile(fallo); err == nil {
			return nil, &errHTTP{codigo: http.StatusServiceUnavailable,
				msg: "El servidor no pudo volcar la base: " + strings.TrimSpace(string(b))}
		}
		if b, err := os.ReadFile(volcado); err == nil {
			return b, nil
		}
		select {
		case <-ctx.Done():
			os.Remove(pedido)
			return nil, ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}
	os.Remove(pedido)
	return nil, &errHTTP{codigo: http.StatusServiceUnavailable,
		msg: "El agente del servidor no respondió. Si hay una actualización en curso, espera a que termine y vuelve a probar."}
}

// exportarMigracion entrega el archivo de migración cifrado con la frase que
// escribe el administrador, tras confirmar su contraseña.
func (a *App) exportarMigracion(w http.ResponseWriter, r *http.Request, op *Operador) error {
	var in struct {
		Clave string `json:"clave"`
		Frase string `json:"frase"`
	}
	if err := leerJSON(w, r, &in); err != nil {
		return err
	}
	if utf8.RuneCountInString(in.Frase) < migracionFraseMin {
		return malo(fmt.Sprintf("La frase debe tener al menos %d caracteres.", migracionFraseMin))
	}
	if len(in.Frase) > 1024 {
		return malo("La frase es demasiado larga.")
	}
	ctx := r.Context()
	var hash string
	if err := a.db.QueryRow(ctx, `SELECT clave_hash FROM operadores WHERE id = $1`, op.ID).Scan(&hash); err != nil {
		return err
	}
	if err := a.comprobarClaveActual(r, op, in.Clave, hash, "La contraseña no es correcta."); err != nil {
		return err
	}
	if !a.migracionMu.TryLock() {
		return conflicto("Ya se está preparando otro archivo de migración. Espera a que termine.")
	}
	defer a.migracionMu.Unlock()

	volcado, err := a.pedirVolcado(ctx)
	if err != nil {
		return err
	}
	claveMaestra, err := leerArchivo(env("CLAVE_MAESTRA_ARCHIVO", "/run/secrets/clave_maestra"))
	if err != nil {
		return err
	}
	m := ManifiestoMigracion{Formato: 1, Fecha: time.Now().UTC(), Origen: a.cfg.ServidorRadius, Operador: op.Usuario}
	var busqueda struct {
		Instalado string `json:"instalado"`
	}
	_ = json.Unmarshal(leerCrudo(a.archivoEstado("actualizacion.json")), &busqueda)
	m.Version = busqueda.Instalado
	if err := a.db.QueryRow(ctx, `SELECT COALESCE(max(nombre), ''),
		(SELECT count(*) FROM routers), (SELECT count(*) FROM usuarios_mikrotik), (SELECT count(*) FROM operadores)
		FROM migraciones_aplicadas`).Scan(&m.UltimaMigracion, &m.Routers, &m.Usuarios, &m.Operadores); err != nil {
		return err
	}
	paquete, err := empaquetarMigracion(m, claveMaestra, volcado)
	if err != nil {
		return err
	}
	// Argon2id usa 64 MB: cuenta dentro del tope de verificaciones simultáneas.
	a.argon <- struct{}{}
	archivo, err := cifrarMigracion(paquete, in.Frase)
	<-a.argon
	if err != nil {
		return err
	}
	a.auditar(ctx, op.Usuario, ipCliente(r), "sistema.migracion_descargada", "base de datos",
		map[string]any{"routers": m.Routers, "usuarios": m.Usuarios, "operadores": m.Operadores, "bytes": len(archivo)})

	nombre := "radiuscontrol-migracion-" + time.Now().In(time.FixedZone("ECT", -5*3600)).Format("20060102-1504") + ".rcm"
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", `attachment; filename="`+nombre+`"`)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Length", fmt.Sprint(len(archivo)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(archivo)
	return nil
}

// comandoDescifrarMigracion: «radiuscontrol descifrar-migracion <archivo>».
// Lee la frase de la primera línea de la entrada y escribe el tar.gz en la
// salida. No toca la base: lo usa instalar.sh antes de arrancar la API.
func comandoDescifrarMigracion(args []string) int {
	if len(args) != 1 {
		fmt.Fprintln(os.Stderr, "uso: radiuscontrol descifrar-migracion <archivo>  (la frase, por la entrada)")
		return 2
	}
	info, err := os.Stat(args[0])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if info.Size() > migracionTamanoMax {
		fmt.Fprintln(os.Stderr, "el archivo es demasiado grande")
		return 1
	}
	dato, err := os.ReadFile(args[0])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	frase, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	claro, err := descifrarMigracion(dato, strings.TrimRight(frase, "\r\n"))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if _, err := os.Stdout.Write(claro); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}
