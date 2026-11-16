package main

import (
	"net/http"
	"sync"
	"time"
)

// Con la sesión ya abierta hay operaciones que vuelven a pedir la contraseña
// (cambiarla, quitar la verificación en dos pasos). Sin tope, quien se hiciera
// con una sesión podría probar contraseñas ahí sin pasar por los bloqueos del
// inicio de sesión.
const (
	clavesFallidasTope    = 5
	clavesFallidasVentana = 15 * time.Minute
)

type limiteClave struct {
	mu     sync.Mutex
	fallos map[int64][]time.Time
}

// recientes devuelve los fallos de ese operador que siguen dentro de la ventana.
// Quien llama debe tener tomado el candado.
func (l *limiteClave) recientes(id int64, ahora time.Time) []time.Time {
	vivos := l.fallos[id][:0]
	for _, t := range l.fallos[id] {
		if ahora.Sub(t) < clavesFallidasVentana {
			vivos = append(vivos, t)
		}
	}
	if len(vivos) == 0 {
		delete(l.fallos, id)
		return nil
	}
	l.fallos[id] = vivos
	return vivos
}

func (l *limiteClave) bloqueado(id int64, ahora time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.recientes(id, ahora)) >= clavesFallidasTope
}

func (l *limiteClave) fallo(id int64, ahora time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.fallos == nil {
		l.fallos = map[int64][]time.Time{}
	}
	l.fallos[id] = append(l.recientes(id, ahora), ahora)
}

func (l *limiteClave) limpiar(id int64) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.fallos, id)
}

// comprobarClaveActual verifica la contraseña de quien ya tiene sesión, con el
// tope de intentos y sin saltarse el límite de verificaciones simultáneas.
func (a *App) comprobarClaveActual(r *http.Request, op *Operador, clave, hash, mensaje string) error {
	ahora := time.Now()
	if a.claves.bloqueado(op.ID, ahora) {
		a.auditar(r.Context(), op.Usuario, ipCliente(r), "cuenta.clave_bloqueada", op.Usuario, nil)
		return &errHTTP{codigo: http.StatusTooManyRequests,
			msg: "Demasiados intentos con una contraseña incorrecta. Espera 15 minutos antes de volver a probar."}
	}
	if !a.verificarLimitado(clave, hash) {
		a.claves.fallo(op.ID, ahora)
		return malo(mensaje)
	}
	a.claves.limpiar(op.ID)
	return nil
}
