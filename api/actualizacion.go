package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"time"
)

// La actualización la hace un agente del servidor (despliegue/actualizar). La
// API solo muestra lo que el agente deja escrito y le pasa los pedidos del
// panel mediante archivos en el volumen compartido.

var reCommit = regexp.MustCompile(`^[0-9a-f]{40}$`)

func (a *App) archivoEstado(nombre string) string {
	return filepath.Join(a.cfg.DirCompilado, "estado", nombre)
}

func leerCrudo(ruta string) json.RawMessage {
	b, err := os.ReadFile(ruta)
	if err != nil || !json.Valid(b) {
		return json.RawMessage("null")
	}
	return b
}

func (a *App) verActualizacion(w http.ResponseWriter, r *http.Request, _ *Operador) error {
	escribirJSON(w, http.StatusOK, map[string]any{
		"busqueda": leerCrudo(a.archivoEstado("actualizacion.json")),
		"proceso":  leerCrudo(a.archivoEstado("actualizacion-proceso.json")),
	})
	return nil
}

func (a *App) buscarActualizacion(w http.ResponseWriter, r *http.Request, _ *Operador) error {
	if err := os.WriteFile(a.archivoEstado("actualizar-buscar"), []byte("1\n"), 0o600); err != nil {
		return err
	}
	escribirJSON(w, http.StatusAccepted, map[string]any{"ok": true})
	return nil
}

func (a *App) pedirActualizacion(w http.ResponseWriter, r *http.Request, op *Operador) error {
	var in struct {
		Commit string `json:"commit"`
	}
	if err := leerJSON(w, r, &in); err != nil {
		return err
	}
	if !reCommit.MatchString(in.Commit) {
		return malo("La versión indicada no es válida.")
	}
	var busqueda struct {
		Instalado string `json:"instalado"`
		Ultimo    string `json:"ultimo"`
	}
	if json.Unmarshal(leerCrudo(a.archivoEstado("actualizacion.json")), &busqueda) != nil || busqueda.Ultimo == "" {
		return conflicto("Todavía no se sabe qué versión hay disponible. Busca actualizaciones primero.")
	}
	if in.Commit != busqueda.Ultimo || in.Commit == busqueda.Instalado {
		return conflicto("Esa versión ya no es la última disponible. Busca actualizaciones de nuevo.")
	}
	var proceso struct {
		Estado string `json:"estado"`
	}
	_ = json.Unmarshal(leerCrudo(a.archivoEstado("actualizacion-proceso.json")), &proceso)
	if proceso.Estado == "en-curso" {
		return conflicto("Ya hay una actualización en curso.")
	}
	if _, err := os.Stat(a.archivoEstado("actualizar-pedido.json")); err == nil {
		return conflicto("Ya hay una actualización pedida.")
	}

	pedido, _ := json.Marshal(map[string]any{
		"commit": in.Commit, "operador": op.Usuario, "pedido": time.Now().UTC().Format(time.RFC3339),
	})
	tmp := a.archivoEstado("actualizar-pedido.json.tmp")
	if err := os.WriteFile(tmp, pedido, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, a.archivoEstado("actualizar-pedido.json")); err != nil {
		return err
	}
	a.auditar(r.Context(), op.Usuario, ipCliente(r), "sistema.actualizacion_pedida", "versión "+in.Commit[:7],
		map[string]any{"desde": busqueda.Instalado[:min(7, len(busqueda.Instalado))]})
	escribirJSON(w, http.StatusAccepted, map[string]any{"ok": true})
	return nil
}
