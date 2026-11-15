import * as React from "react";
import { Button, Dialog, DialogContent, DialogFooter } from "@/components/ui";
import { api, ErrorApi, type Estado, type Operador } from "@/lib/api";

interface Aviso {
  titulo: string;
  mensaje?: string;
  detalle?: string;
  copiable?: string;
  confirmar?: { texto: string; peligro?: boolean; resolver: (ok: boolean) => void };
}

interface Contexto {
  operador: Operador | null;
  setOperador: (o: Operador | null) => void;
  motivoSalida: string;
  estado: Estado | null;
  refrescarEstado: () => Promise<void>;
  refrescarOperador: () => Promise<void>;
  // Todos los avisos son modales: nada de franjas que mueven la página.
  avisar: (a: Omit<Aviso, "confirmar">) => void;
  avisarError: (e: unknown) => void;
  confirmar: (titulo: string, mensaje: string, texto: string, peligro?: boolean) => Promise<boolean>;
}

const Ctx = React.createContext<Contexto | null>(null);

export function useApp() {
  const c = React.useContext(Ctx);
  if (!c) throw new Error("useApp fuera de ProveedorApp");
  return c;
}

export function ProveedorApp({ children }: { children: React.ReactNode }) {
  const [operador, setOperador] = React.useState<Operador | null>(null);
  const [cargando, setCargando] = React.useState(true);
  const [motivoSalida, setMotivoSalida] = React.useState("");
  const [estado, setEstado] = React.useState<Estado | null>(null);
  const [aviso, setAviso] = React.useState<Aviso | null>(null);
  const [copiado, setCopiado] = React.useState(false);

  React.useEffect(() => {
    api<Operador>("GET", "/sesion")
      .then(setOperador)
      .catch(() => setOperador(null))
      .finally(() => setCargando(false));
    const caducada = (e: Event) => {
      setMotivoSalida((e as CustomEvent<string>).detail || "");
      setOperador(null);
    };
    window.addEventListener("rc:sesion-caducada", caducada);
    return () => window.removeEventListener("rc:sesion-caducada", caducada);
  }, []);

  const refrescarEstado = React.useCallback(async () => {
    try {
      setEstado(await api<Estado>("GET", "/estado", undefined, { auto: true }));
    } catch {
      // El indicador simplemente no se actualiza.
    }
  }, []);

  // Mientras la persona usa el panel (ratón, teclado, pantalla táctil), se
  // avisa al servidor como mucho una vez por minuto para que la sesión no se
  // cierre por inactividad en mitad del trabajo.
  React.useEffect(() => {
    if (!operador) return;
    let ultimo = Date.now();
    const actividad = () => {
      if (Date.now() - ultimo < 60000) return;
      ultimo = Date.now();
      api("GET", "/sesion").catch(() => undefined);
    };
    const eventos = ["mousemove", "keydown", "click", "scroll", "touchstart"];
    eventos.forEach((e) => window.addEventListener(e, actividad, { passive: true }));
    return () => eventos.forEach((e) => window.removeEventListener(e, actividad));
  }, [operador]);

  React.useEffect(() => {
    if (!operador) {
      setEstado(null);
      return;
    }
    setMotivoSalida("");
    refrescarEstado();
    const t = window.setInterval(refrescarEstado, 2000);
    return () => window.clearInterval(t);
  }, [operador, refrescarEstado]);

  const refrescarOperador = React.useCallback(async () => {
    try {
      setOperador(await api<Operador>("GET", "/sesion"));
    } catch {
      // Si la sesión caducó, el aviso global ya la cierra.
    }
  }, []);

  const valor = React.useMemo<Contexto>(
    () => ({
      operador,
      setOperador,
      motivoSalida,
      estado,
      refrescarEstado,
      refrescarOperador,
      avisar: (a) => {
        setCopiado(false);
        setAviso(a);
      },
      avisarError: (e) => {
        if (e instanceof ErrorApi && e.estado === 401) return;
        setAviso({
          titulo: "No se pudo completar",
          mensaje: e instanceof Error ? e.message : "Error inesperado.",
          detalle: e instanceof ErrorApi ? e.detalle : undefined,
        });
      },
      confirmar: (titulo, mensaje, texto, peligro) =>
        new Promise<boolean>((resolver) => setAviso({ titulo, mensaje, confirmar: { texto, peligro, resolver } })),
    }),
    [operador, estado, motivoSalida, refrescarEstado, refrescarOperador],
  );

  const cerrar = (ok: boolean) => {
    aviso?.confirmar?.resolver(ok);
    setAviso(null);
  };

  // Al terminar la sesión (por inactividad, revocación o cierre) no puede quedar
  // a la vista ninguna ventana: podría estar mostrando una contraseña o un
  // secreto recién generado. Una confirmación pendiente se da por rechazada.
  React.useEffect(() => {
    if (operador !== null) return;
    setAviso((actual) => {
      actual?.confirmar?.resolver(false);
      return null;
    });
    setCopiado(false);
  }, [operador]);

  return (
    <Ctx.Provider value={valor}>
      {cargando ? null : children}
      <Dialog open={aviso !== null} onOpenChange={(abierto) => !abierto && cerrar(false)}>
        {aviso && (
          <DialogContent titulo={aviso.titulo} descripcion={aviso.mensaje}>
            {aviso.copiable && (
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted p-3 font-mono text-xs">
                {aviso.copiable}
              </pre>
            )}
            {aviso.detalle && (
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border bg-muted p-3 font-mono text-xs">
                {aviso.detalle}
              </pre>
            )}
            <DialogFooter>
              {aviso.copiable && (
                <Button
                  variant="outline"
                  onClick={() => navigator.clipboard.writeText(aviso.copiable!).then(() => setCopiado(true))}
                >
                  {copiado ? "Copiado" : "Copiar"}
                </Button>
              )}
              {aviso.confirmar ? (
                <>
                  <Button variant="outline" onClick={() => cerrar(false)}>
                    Cancelar
                  </Button>
                  <Button variant={aviso.confirmar.peligro ? "destructive" : "default"} onClick={() => cerrar(true)}>
                    {aviso.confirmar.texto}
                  </Button>
                </>
              ) : (
                <Button onClick={() => cerrar(true)}>Entendido</Button>
              )}
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </Ctx.Provider>
  );
}
