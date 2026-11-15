package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"unicode/utf16"

	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/md4" //nolint:staticcheck // MS-CHAP exige MD4.
)

// Cada dominio de credenciales se cifra con un contexto distinto: un dato
// cifrado para un dominio no se puede descifrar como si fuera de otro.
const (
	dominioSecreto = "radius-secreto"
	dominioHashNT  = "mikrotik-hash-nt"
	dominioVersion = "config-version"
)

type Cifrador struct {
	aead cipher.AEAD
	// Clave derivada de la maestra, solo para las huellas (ver Huella).
	claveHuellas []byte
}

func nuevoCifrador(claveB64 string) (*Cifrador, error) {
	clave, err := base64.StdEncoding.DecodeString(strings.TrimSpace(claveB64))
	if err != nil || len(clave) != 32 {
		return nil, errors.New("la clave maestra debe tener 32 bytes en base64")
	}
	bloque, err := aes.NewCipher(clave)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(bloque)
	if err != nil {
		return nil, err
	}
	derivada := hmac.New(sha256.New, clave)
	derivada.Write([]byte("radiuscontrol-huellas"))
	return &Cifrador{aead: aead, claveHuellas: derivada.Sum(nil)}, nil
}

// Huella convierte el SHA-256 de un archivo compilado en una huella con clave.
// Los archivos compilados llevan secretos y hashes de contraseñas; su SHA-256
// a secas permitiría comprobar contraseñas candidatas fuera de línea a quien lo
// viera. La huella con clave sirve igual para comparar dos versiones, pero no
// se puede recalcular sin la clave maestra. Lo que sale de la API y lo que se
// guarda en la base es siempre esta huella, nunca el SHA-256.
func (c *Cifrador) Huella(sha string) string {
	if sha == "" {
		return ""
	}
	m := hmac.New(sha256.New, c.claveHuellas)
	m.Write([]byte(sha))
	return hex.EncodeToString(m.Sum(nil))
}

func (c *Cifrador) Cifrar(claro []byte, dominio string) ([]byte, error) {
	nonce := make([]byte, c.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return c.aead.Seal(nonce, nonce, claro, []byte(dominio)), nil
}

func (c *Cifrador) Descifrar(dato []byte, dominio string) ([]byte, error) {
	n := c.aead.NonceSize()
	if len(dato) < n {
		return nil, errors.New("dato cifrado demasiado corto")
	}
	return c.aead.Open(nil, dato[:n], dato[n:], []byte(dominio))
}

// hashNT devuelve el hash NT (MD4 de la contraseña en UTF-16LE) en hexadecimal.
// Sirve a FreeRADIUS tanto para PAP como para MS-CHAP.
func hashNT(clave string) string {
	u := utf16.Encode([]rune(clave))
	b := make([]byte, 2*len(u))
	for i, v := range u {
		binary.LittleEndian.PutUint16(b[2*i:], v)
	}
	h := md4.New()
	h.Write(b)
	return strings.ToUpper(hex.EncodeToString(h.Sum(nil)))
}

const (
	argonMemoria = 64 * 1024
	argonPasadas = 3
	argonHilos   = 2
	argonLargo   = 32
)

func hashArgon2(clave string) (string, error) {
	sal := make([]byte, 16)
	if _, err := rand.Read(sal); err != nil {
		return "", err
	}
	h := argon2.IDKey([]byte(clave), sal, argonPasadas, argonMemoria, argonHilos, argonLargo)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s", argon2.Version,
		argonMemoria, argonPasadas, argonHilos,
		base64.RawStdEncoding.EncodeToString(sal),
		base64.RawStdEncoding.EncodeToString(h)), nil
}

func verificarArgon2(clave, codificado string) bool {
	p := strings.Split(codificado, "$")
	if len(p) != 6 || p[1] != "argon2id" {
		return false
	}
	var version int
	var memoria, pasadas uint32
	var hilos uint8
	if _, err := fmt.Sscanf(p[2], "v=%d", &version); err != nil || version != argon2.Version {
		return false
	}
	if _, err := fmt.Sscanf(p[3], "m=%d,t=%d,p=%d", &memoria, &pasadas, &hilos); err != nil {
		return false
	}
	sal, err := base64.RawStdEncoding.DecodeString(p[4])
	if err != nil {
		return false
	}
	esperado, err := base64.RawStdEncoding.DecodeString(p[5])
	if err != nil || len(esperado) == 0 {
		return false
	}
	h := argon2.IDKey([]byte(clave), sal, pasadas, memoria, hilos, uint32(len(esperado)))
	return subtle.ConstantTimeCompare(h, esperado) == 1
}

func aleatorioHex(bytes int) string {
	b := make([]byte, bytes)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
