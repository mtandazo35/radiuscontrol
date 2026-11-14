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
  const [estado, setEstado] = React.useState<Estado | null>(null);
  const [aviso, setAviso] = React.useState<Aviso | null>(null);
  const [copiado, setCopiado] = React.useState(false);

  React.useEffect(() => {
    api<Operador>("GET", "/sesion")
      .then(setOperador)
      .catch(() => setOperador(null))
      .finally(() => setCargando(false));
    const caducada = () => setOperador(null);
    window.addEventListener("rc:sesion-caducada", caducada);
    return () => window.removeEventListener("rc:sesion-caducada", caducada);
  }, []);

  const refrescarEstado = React.useCallback(async () => {
    try {
      setEstado(await api<Estado>("GET", "/estado"));
    } catch {
      // El indicador simplemente no se actualiza.
    }
  }, []);

  React.useEffect(() => {
    if (!operador) {
      setEstado(null);
      return;
    }
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
    [operador, estado, refrescarEstado, refrescarOperador],
  );

  const cerrar = (ok: boolean) => {
    aviso?.confirmar?.resolver(ok);
    setAviso(null);
  };

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
