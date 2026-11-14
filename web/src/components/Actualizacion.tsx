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

const PASOS = ["descargar", "respaldo", "construir", "instalar", "comprobar"];

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

// Una actualización lanzada desde esta ventana. «inicioPrevio» es el inicio del
// proceso que había antes de pedirla: mientras el agente no publique uno
// distinto, lo que se lee es el resultado de una actualización anterior.
interface Lanzada {
  commit: string;
  inicioPrevio: string;
}

export function ProveedorActualizacion({ children }: { children: React.ReactNode }) {
  const { operador, avisarError } = useApp();
  const admin = operador?.rol === "administrador";
  const [datos, setDatos] = React.useState<Actualizacion | null>(null);
  const [abierto, setAbierto] = React.useState(false);
  const [buscando, setBuscando] = React.useState(false);
  const [pidiendo, setPidiendo] = React.useState(false);
  const [sinRespuesta, setSinRespuesta] = React.useState(false);
  const [lanzada, setLanzada] = React.useState<Lanzada | null>(null);

  const cargar = React.useCallback(async () => {
    try {
      setDatos(await api<Actualizacion>("GET", "/actualizacion", undefined, { auto: true }));
      setSinRespuesta(false);
    } catch {
      setSinRespuesta(true);
    }
  }, []);

  const b = datos?.busqueda;
  const p = datos?.proceso;
  // El proceso que se lee, ¿es ya el de la actualización lanzada desde aquí?
  const procesoPropio = lanzada !== null && p != null && p.inicio !== lanzada.inicioPrevio && p.a === lanzada.commit;
  const terminada = procesoPropio && p!.estado !== "en-curso";
  // En marcha: lo dice el agente, hay un pedido esperando, o se lanzó desde
  // aquí y todavía no ha terminado.
  const enMarcha = p?.estado === "en-curso" || datos?.pedido === true || (lanzada !== null && !terminada);

  React.useEffect(() => {
    if (!admin) return;
    cargar();
    const t = window.setInterval(cargar, enMarcha ? 2000 : 60000);
    return () => window.clearInterval(t);
  }, [admin, cargar, enMarcha]);

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
    const ultimo = b?.ultimo;
    if (!ultimo || pidiendo) return;
    setPidiendo(true);
    try {
      await api("POST", "/actualizacion/aplicar", { commit: ultimo });
      setLanzada({ commit: ultimo, inicioPrevio: p?.inicio ?? "" });
    } catch (e) {
      avisarError(e);
      await cargar();
    } finally {
      setPidiendo(false);
    }
  };

  const cerrar = () => {
    setAbierto(false);
    // Visto el resultado, la ventana vuelve a su estado normal.
    if (terminada) setLanzada(null);
  };

  const pendientes = enMarcha || terminada ? 0 : (b?.cambios.length ?? 0);

  const valor = React.useMemo<Contexto>(
    () => ({ datos, pendientes, enCurso: enMarcha, buscando, buscar, abrir: () => setAbierto(true) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [datos, pendientes, enMarcha, buscando],
  );

  // Qué proceso se pinta en la vista de avance: el propio si ya existe, el del
  // agente si hay una actualización en curso lanzada desde otro sitio, o
  // ninguno todavía (todo pendiente).
  const pv = procesoPropio || (lanzada === null && p?.estado === "en-curso") ? p! : null;
  const pasoActual = pv ? PASOS.indexOf(pv.paso) : -1;
  const vistaAvance = enMarcha || terminada;

  return (
    <Ctx.Provider value={valor}>
      {children}
      <Dialog open={abierto} onOpenChange={(a) => !a && cerrar()}>
        {vistaAvance ? (
          <DialogContent
            titulo={!terminada ? "Actualizando RadiusControl" : pv?.estado === "ok" ? "Actualización terminada" : "La actualización no se completó"}
            descripcion={
              pv
                ? `De la versión ${versionCorta(pv.de)} a la ${versionCorta(pv.a)}, pedida por ${pv.quien}.`
                : "El servidor está empezando la actualización."
            }
          >
            <ol className="space-y-2">
              {PASOS.map((paso, i) => {
                const hecho = pv ? pv.estado === "ok" || i < pasoActual : false;
                const actual = pv ? i === pasoActual && pv.estado === "en-curso" : false;
                const fallo = pv ? i === pasoActual && (pv.estado === "fallida" || pv.estado === "revertida") : false;
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
                      {nombrePaso[paso]}
                    </span>
                  </li>
                );
              })}
            </ol>
            {!terminada && sinRespuesta && (
              <p className="rounded-md border border-warning/50 p-3 text-sm text-warning" role="status">
                El panel se está reiniciando. Esta ventana seguirá el avance sola en cuanto vuelva a responder.
              </p>
            )}
            {!terminada && !sinRespuesta && (
              <p className="text-sm text-muted-foreground">
                Puede tardar unos minutos. FreeRADIUS sigue autenticando mientras tanto, salvo un par de segundos si
                tiene que reiniciarse.
              </p>
            )}
            {terminada && pv?.mensaje && (
              <p className={cn("rounded-md border p-3 text-sm", pv.estado === "ok" ? "border-success/40" : "border-destructive/50")}>{pv.mensaje}</p>
            )}
            <DialogFooter>
              {terminada && pv?.estado === "ok" ? (
                <Button onClick={() => window.location.reload()}>Recargar el panel</Button>
              ) : (
                <Button variant="outline" onClick={cerrar}>
                  {terminada ? "Cerrar" : "Ocultar"}
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
              <Button variant="outline" onClick={cerrar}>
                Cerrar
              </Button>
              {pendientes > 0 ? (
                <Button onClick={actualizar} disabled={pidiendo}>
                  {pidiendo ? "Pidiendo…" : "Actualizar ahora"}
                </Button>
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
