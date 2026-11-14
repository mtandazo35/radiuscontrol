import { ArrowDownToLine, KeyRound, Loader2, Power, User } from "lucide-react";
import * as React from "react";
import { api, momentoUltimaActividad } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useApp } from "../contexto";
import { useActualizacion } from "./Actualizacion";
import { ModalMiCuenta, nombreRol } from "./MiCuenta";

function iniciales(usuario: string) {
  const partes = usuario.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const letras = partes.length > 1 ? partes[0][0] + partes[1][0] : usuario.slice(0, 2);
  return letras.toUpperCase();
}

function reloj(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const dos = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${dos(m)}:${dos(s % 60)}` : `${dos(m)}:${dos(s % 60)}`;
}

// Tiempo que queda hasta que la sesión se cierre sola: por inactividad o por
// llegar a su duración máxima, lo que ocurra antes.
function useCuentaAtras() {
  const { operador } = useApp();
  const [, tic] = React.useState(0);
  React.useEffect(() => {
    const t = window.setInterval(() => tic((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, []);
  if (!operador) return { resta: 0, porInactividad: true };
  const porInactividad = momentoUltimaActividad() + operador.minutos_inactividad * 60000 - Date.now();
  const porMaximo = new Date(operador.expira).getTime() - Date.now();
  return porInactividad <= porMaximo ? { resta: porInactividad, porInactividad: true } : { resta: porMaximo, porInactividad: false };
}

export function MenuUsuario() {
  const { operador, setOperador } = useApp();
  const [abierto, setAbierto] = React.useState(false);
  const [cuenta, setCuenta] = React.useState<"cuenta" | "clave" | null>(null);
  const caja = React.useRef<HTMLDivElement>(null);
  const { resta, porInactividad } = useCuentaAtras();
  const act = useActualizacion();
  const avisar = operador?.rol === "administrador" && (act.pendientes > 0 || act.enCurso);

  React.useEffect(() => {
    if (!abierto) return;
    const fuera = (e: MouseEvent) => {
      if (caja.current && !caja.current.contains(e.target as Node)) setAbierto(false);
    };
    const tecla = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAbierto(false);
    };
    document.addEventListener("mousedown", fuera);
    document.addEventListener("keydown", tecla);
    return () => {
      document.removeEventListener("mousedown", fuera);
      document.removeEventListener("keydown", tecla);
    };
  }, [abierto]);

  if (!operador) return null;

  const salir = async () => {
    try {
      await api("DELETE", "/sesion");
    } finally {
      setOperador(null);
    }
  };

  const opcion = "flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:outline-none";
  const avatar = "flex shrink-0 items-center justify-center rounded-full bg-primary font-semibold text-primary-foreground";

  return (
    <div className="relative" ref={caja}>
      <button
        type="button"
        className={cn(avatar, "relative size-9 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background")}
        aria-haspopup="menu"
        aria-expanded={abierto}
        aria-label={`Menú de ${operador.usuario}`}
        onClick={() => setAbierto(!abierto)}
      >
        {iniciales(operador.usuario)}
        {avisar && (
          <span className="absolute -right-0.5 -top-0.5 flex size-3">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-warning opacity-75" />
            <span className="relative inline-flex size-3 rounded-full border-2 border-card bg-warning" />
          </span>
        )}
      </button>

      {abierto && (
        <div role="menu" className="absolute right-0 z-40 mt-2 w-72 overflow-hidden rounded-lg border bg-card text-card-foreground shadow-lg">
          <div className="flex items-center gap-3 border-b px-4 py-3">
            <span className={cn(avatar, "size-10 text-sm")}>{iniciales(operador.usuario)}</span>
            <div className="min-w-0">
              <div className="truncate font-semibold">{operador.usuario}</div>
              <div className="truncate text-xs text-muted-foreground">
                Usuario: {operador.usuario} · {nombreRol[operador.rol] ?? operador.rol}
              </div>
            </div>
          </div>
          {avisar && (
            <div className="border-b p-2">
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-3 rounded-md border border-warning/50 bg-warning/10 px-3 py-2.5 text-left hover:bg-warning/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => {
                  setAbierto(false);
                  act.abrir();
                }}
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-warning text-background">
                  {act.enCurso ? <Loader2 className="size-4 animate-spin" /> : <ArrowDownToLine className="size-4" />}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold">{act.enCurso ? "Actualizando el panel…" : "Actualización disponible"}</span>
                  <span className="block text-xs text-muted-foreground">
                    {act.enCurso ? "Pulsa para ver el avance." : `${act.pendientes} cambio(s) nuevo(s): pulsa para ver las mejoras.`}
                  </span>
                </span>
              </button>
            </div>
          )}
          <div className="py-1">
            <button
              type="button"
              role="menuitem"
              className={opcion}
              onClick={() => {
                setAbierto(false);
                setCuenta("cuenta");
              }}
            >
              <User className="size-4" /> Mi cuenta
            </button>
            <button
              type="button"
              role="menuitem"
              className={opcion}
              onClick={() => {
                setAbierto(false);
                setCuenta("clave");
              }}
            >
              <KeyRound className="size-4" /> Cambiar contraseña
            </button>
            <button type="button" role="menuitem" className={cn(opcion, "font-semibold")} onClick={salir}>
              <Power className="size-4" /> Cerrar sesión
            </button>
          </div>
          <div className="border-t px-4 py-2.5 text-xs text-muted-foreground">
            {porInactividad ? "Se cierra por inactividad en " : "La sesión termina en "}
            <span className="font-mono font-semibold text-foreground">{reloj(resta)}</span>
          </div>
        </div>
      )}

      <ModalMiCuenta abierto={cuenta !== null} soloClave={cuenta === "clave"} onCerrar={() => setCuenta(null)} />
    </div>
  );
}
