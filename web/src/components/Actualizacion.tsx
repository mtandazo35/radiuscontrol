import { Check, CircleDashed, Loader2, X } from "lucide-react";
import * as React from "react";
import { Button, Dialog, DialogContent, DialogFooter } from "@/components/ui";
import { api, type Actualizacion } from "@/lib/api";
import { cn, fecha } from "@/lib/utils";
import { useApp } from "../contexto";

interface Contexto {
  datos: Actualizacion | null;
  pendientes: number;
  enCurso: boolean;
  buscando: boolean;
  buscar: () => Promise<void>;
  abrir: () => void;
}

const Ctx = React.createContext<Contexto | null>(null);

export function useActualizacion() {
  const c = React.useContext(Ctx);
  if (!c) throw new Error("useActualizacion fuera de ProveedorActualizacion");
  return c;
}

const nombrePaso: Record<string, string> = {
  descargar: "Descargar la versión nueva",
  respaldo: "Hacer y verificar el respaldo",
  construir: "Construir la versión nueva",
  instalar: "Instalar y reiniciar los servicios",
  comprobar: "Comprobar que todo responde",
};

export function versionCorta(commit: string | undefined) {
  return commit ? commit.slice(0, 7) : "—";
}

export function ProveedorActualizacion({ children }: { children: React.ReactNode }) {
  const { operador, avisarError } = useApp();
  const admin = operador?.rol === "administrador";
  const [datos, setDatos] = React.useState<Actualizacion | null>(null);
  const [abierto, setAbierto] = React.useState(false);
  const [buscando, setBuscando] = React.useState(false);
  const [sinRespuesta, setSinRespuesta] = React.useState(false);
  // Se recuerda que esta ventana lanzó la actualización para seguir mostrando
  // el avance aunque el panel deje de responder mientras se reinicia.
  const [lanzada, setLanzada] = React.useState(false);

  const cargar = React.useCallback(async () => {
    try {
      setDatos(await api<Actualizacion>("GET", "/actualizacion", undefined, { auto: true }));
      setSinRespuesta(false);
    } catch {
      setSinRespuesta(true);
    }
  }, []);

  const enCurso = datos?.proceso?.estado === "en-curso";
  const siguiendo = enCurso || lanzada;

  React.useEffect(() => {
    if (!admin) return;
    cargar();
    const t = window.setInterval(cargar, siguiendo ? 2000 : 60000);
    return () => window.clearInterval(t);
  }, [admin, cargar, siguiendo]);

  // La actualización lanzada desde aquí ha terminado cuando el agente lo dice.
  React.useEffect(() => {
    if (lanzada && datos?.proceso && datos.proceso.estado !== "en-curso" && datos.proceso.fin) {
      const fin = new Date(datos.proceso.fin).getTime();
      if (Date.now() - fin < 600000) setLanzada(false);
    }
  }, [lanzada, datos]);

  const buscar = async () => {
    setBuscando(true);
    const antes = datos?.busqueda?.buscado;
    try {
      await api("POST", "/actualizacion/buscar", {});
      // El agente del servidor responde en unos segundos.
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => window.setTimeout(r, 1500));
        const d = await api<Actualizacion>("GET", "/actualizacion", undefined, { auto: true });
        setDatos(d);
        if (d.busqueda?.buscado && d.busqueda.buscado !== antes) break;
      }
    } catch (e) {
      avisarError(e);
    } finally {
      setBuscando(false);
    }
  };

  const actualizar = async () => {
    const ultimo = datos?.busqueda?.ultimo;
    if (!ultimo) return;
    try {
      await api("POST", "/actualizacion/aplicar", { commit: ultimo });
      setLanzada(true);
      await cargar();
    } catch (e) {
      avisarError(e);
    }
  };

  const b = datos?.busqueda;
  const p = datos?.proceso;
  const pendientes = b?.cambios.length ?? 0;
  const mostrarAvance = siguiendo || (p && p.estado !== "en-curso" && p.a === b?.instalado && pendientes === 0 && abierto && lanzada);
  const terminado = p && p.estado !== "en-curso" && !lanzada && p.fin && Date.now() - new Date(p.fin).getTime() < 600000;

  const valor = React.useMemo<Contexto>(
    () => ({ datos, pendientes, enCurso: Boolean(siguiendo), buscando, buscar, abrir: () => setAbierto(true) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [datos, pendientes, siguiendo, buscando],
  );

  const pasoActual = p ? p.pasos.indexOf(p.paso) : -1;

  return (
    <Ctx.Provider value={valor}>
      {children}
      <Dialog open={abierto} onOpenChange={(a) => !a && setAbierto(false)}>
        {mostrarAvance || (terminado && pendientes === 0) ? (
          <DialogContent
            titulo={siguiendo ? "Actualizando RadiusControl" : p?.estado === "ok" ? "Actualización terminada" : "La actualización no se completó"}
            descripcion={p ? `De la versión ${versionCorta(p.de)} a la ${versionCorta(p.a)}, pedida por ${p.quien}.` : undefined}
          >
            <ol className="space-y-2">
              {(p?.pasos ?? Object.keys(nombrePaso)).map((paso, i) => {
                const hecho = p ? (p.estado === "ok" ? true : i < pasoActual) : false;
                const actual = p ? i === pasoActual && p.estado === "en-curso" : i === 0;
                const fallo = p ? i === pasoActual && (p.estado === "fallida" || p.estado === "revertida") : false;
                return (
                  <li key={paso} className="flex items-center gap-3 text-sm">
                    {hecho ? (
                      <Check className="size-4 text-success" />
                    ) : fallo ? (
                      <X className="size-4 text-destructive" />
                    ) : actual ? (
                      <Loader2 className="size-4 animate-spin text-primary" />
                    ) : (
                      <CircleDashed className="size-4 text-muted-foreground" />
                    )}
                    <span className={cn(!hecho && !actual && !fallo && "text-muted-foreground", fallo && "text-destructive")}>
                      {nombrePaso[paso] ?? paso}
                    </span>
                  </li>
                );
              })}
            </ol>
            {siguiendo && sinRespuesta && (
              <p className="rounded-md border border-warning/50 p-3 text-sm text-warning" role="status">
                El panel se está reiniciando. Esta ventana seguirá el avance sola en cuanto vuelva a responder.
              </p>
            )}
            {siguiendo && !sinRespuesta && (
              <p className="text-sm text-muted-foreground">
                Tarda unos minutos. FreeRADIUS sigue autenticando mientras tanto, salvo un par de segundos al reiniciarse.
              </p>
            )}
            {!siguiendo && p?.mensaje && (
              <p className={cn("rounded-md border p-3 text-sm", p.estado === "ok" ? "border-success/40" : "border-destructive/50")}>{p.mensaje}</p>
            )}
            <DialogFooter>
              {!siguiendo && p?.estado === "ok" ? (
                <Button onClick={() => window.location.reload()}>Recargar el panel</Button>
              ) : (
                <Button variant="outline" onClick={() => setAbierto(false)}>
                  {siguiendo ? "Ocultar" : "Cerrar"}
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        ) : (
          <DialogContent
            titulo={pendientes > 0 ? "Actualización disponible" : "RadiusControl está al día"}
            descripcion={
              pendientes > 0
                ? `Hay ${pendientes} cambio(s) nuevo(s) desde la versión instalada (${versionCorta(b?.instalado)}).`
                : `Versión instalada: ${versionCorta(b?.instalado)}. Última búsqueda: ${fecha(b?.buscado)}.`
            }
          >
            {b?.error && <p className="rounded-md border border-destructive/50 p-3 text-sm text-destructive">{b.error}</p>}
            {pendientes > 0 && (
              <>
                <ul className="max-h-72 space-y-2 overflow-y-auto rounded-md border p-3">
                  {b!.cambios.map((c) => (
                    <li key={c.commit} className="text-sm">
                      <div>{c.asunto}</div>
                      <div className="text-xs text-muted-foreground">
                        {fecha(c.fecha)} · <span className="font-mono">{versionCorta(c.commit)}</span>
                      </div>
                    </li>
                  ))}
                </ul>
                <p className="text-sm text-muted-foreground">
                  Antes de cambiar nada se hace un respaldo de la base y de los secretos. Si la versión nueva no responde
                  bien, se vuelve sola a la anterior.
                </p>
              </>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setAbierto(false)}>
                Cerrar
              </Button>
              {pendientes > 0 ? (
                <Button onClick={actualizar}>Actualizar ahora</Button>
              ) : (
                <Button onClick={buscar} disabled={buscando}>
                  {buscando ? "Buscando…" : "Buscar actualizaciones"}
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </Ctx.Provider>
  );
}
