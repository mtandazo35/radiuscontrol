import * as React from "react";
import { Button, Input, Label } from "@/components/ui";
import { api, ErrorApi, type Operador } from "@/lib/api";
import { cn } from "@/lib/utils";
import { VERSION } from "@/version";
import { useApp } from "../contexto";

// Iniciar sesión es lo mismo que hace un router contra RADIUS: pedir acceso y
// recibir una respuesta. La pantalla lo dibuja con los nombres del protocolo.
type Fase = "reposo" | "enviando" | "codigo" | "aceptado" | "rechazado";

const fases: Record<Fase, { termino: string; texto: string }> = {
  reposo: { termino: "", texto: "Escribe tus datos para pedir acceso." },
  enviando: { termino: "Access-Request", texto: "Comprobando tus datos…" },
  codigo: { termino: "Access-Challenge", texto: "Falta el código de verificación." },
  aceptado: { termino: "Access-Accept", texto: "Acceso aceptado." },
  rechazado: { termino: "Access-Reject", texto: "Acceso rechazado." },
};

// Colores del panel del diagrama: fijos, no dependen del tema claro u oscuro.
// Todos son colores planos: sin degradados ni transparencias.
const tinta = {
  fondo: "#0D2B3E",
  trazo: "#3E7D97",
  anillos: ["#235069", "#1A4259", "#14374C"],
  linea: "#7FD3EE",
  texto: "#E6F4FA",
  tenue: "#9CC3D4",
  aceptado: "#5FD39A",
  rechazado: "#FF8A80",
};

function Diagrama({ fase }: { fase: Fase }) {
  // Dónde está la petición sobre el trazo: sale del navegador, llega al
  // servidor y vuelve con la respuesta; un desafío la deja a medio camino.
  const posicion = fase === "enviando" ? 100 : fase === "codigo" ? 50 : 0;
  const color = fase === "aceptado" ? tinta.aceptado : fase === "rechazado" ? tinta.rechazado : tinta.linea;
  const f = fases[fase];

  return (
    <div className="w-full max-w-xl">
      {/* Un solo dibujo a escala: los rótulos van fuera de los anillos y nada
          se sale del panel, tampoco en un teléfono. */}
      <svg viewBox="0 0 480 270" className="block w-full" role="img" aria-label="Tu navegador pide acceso a RadiusControl">
        {/* Los discos son el «radio»: el alcance del servidor. */}
        {[104, 72, 40].map((r, i) => (
          <circle key={r} cx={352} cy={116} r={r} fill={tinta.anillos[2 - i]} />
        ))}
        <line x1={28} y1={116} x2={352} y2={116} stroke={tinta.trazo} strokeWidth={2} />

        <circle cx={28} cy={116} r={11} fill={tinta.fondo} stroke={tinta.linea} strokeWidth={2} />
        <circle
          cx={352}
          cy={116}
          r={11}
          fill={color}
          className="transition-[fill] duration-700 motion-reduce:transition-none"
        />
        {/* La petición: en reposo descansa dentro del nodo del navegador. */}
        <circle
          cx={28}
          cy={116}
          r={6}
          fill={color}
          className="transition-[transform,fill] duration-700 ease-out motion-reduce:transition-none"
          style={{ transform: `translateX(${(posicion / 100) * 324}px)` }}
        />

        <text x={12} y={152} fontSize={15} fill={tinta.tenue} className="font-titulo">
          Tu navegador
        </text>
        <text x={352} y={250} fontSize={15} fill={tinta.tenue} textAnchor="middle" className="font-titulo">
          RadiusControl
        </text>
      </svg>

      <p className="mt-8 min-h-[4.5rem] font-titulo" aria-live="polite">
        <span className="block text-2xl font-semibold sm:text-3xl leading-tight" style={{ color: fase === "reposo" ? tinta.texto : color }}>
          {f.texto}
        </span>
        {f.termino && (
          <span className="mt-1 block text-sm" style={{ color: tinta.tenue }}>
            En RADIUS esto se llama {f.termino}.
          </span>
        )}
      </p>
    </div>
  );
}

export default function Login() {
  const { setOperador, motivoSalida } = useApp();
  const [usuario, setUsuario] = React.useState("");
  const [clave, setClave] = React.useState("");
  const [codigo, setCodigo] = React.useState("");
  const [pideCodigo, setPideCodigo] = React.useState(false);
  const [error, setError] = React.useState("");
  const [fase, setFase] = React.useState<Fase>("reposo");
  const ocupado = fase === "enviando" || fase === "aceptado";

  const entrar = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setFase("enviando");
    try {
      const operador = await api<Operador>("POST", "/sesion", { usuario, clave, codigo: pideCodigo ? codigo : "" });
      setFase("aceptado");
      // Un instante para que se vea la respuesta antes de entrar; sin espera si
      // el sistema pide menos animación.
      const sinMovimiento = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (!sinMovimiento) await new Promise((r) => window.setTimeout(r, 550));
      setOperador(operador);
    } catch (err) {
      if (err instanceof ErrorApi && err.datos?.requiere_codigo) {
        // La contraseña es correcta; falta el segundo factor.
        setError(pideCodigo ? err.message : "");
        setPideCodigo(true);
        setCodigo("");
        setFase("codigo");
      } else {
        setError(err instanceof Error ? err.message : "Error inesperado.");
        setFase("rechazado");
      }
    }
  };

  // Al volver a escribir tras un rechazo, el diagrama vuelve al reposo.
  const alEscribir = (cambiar: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    cambiar(e.target.value);
    if (fase === "rechazado") setFase("reposo");
  };

  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <section
        className="flex flex-col justify-between gap-8 px-6 py-8 sm:px-10 lg:px-14 lg:py-12"
        style={{ backgroundColor: tinta.fondo, color: tinta.texto }}
      >
        <p className="font-titulo text-xl font-semibold tracking-tight">RadiusControl</p>

        <div className="flex flex-1 items-center py-6 lg:py-0">
          <Diagrama fase={fase} />
        </div>

        <p className="hidden max-w-sm text-sm leading-relaxed lg:block" style={{ color: tinta.tenue }}>
          Decide quién entra a cada router MikroTik, con qué permiso y desde dónde.
        </p>
      </section>

      <main className="flex flex-col items-center justify-between gap-8 px-6 py-8 sm:px-10 lg:px-16 lg:py-12">
        <div className="hidden lg:block" />

        <div className="w-full max-w-sm">
          <h1 className="font-titulo text-4xl font-semibold tracking-tight">Entrar al panel</h1>
          <p className="mt-2 text-sm text-muted-foreground">Con tu cuenta de operador.</p>

          {motivoSalida && (
            <p role="status" className="mt-6 rounded-md border border-warning/50 p-3 text-sm text-warning">
              {motivoSalida}
            </p>
          )}

          <form onSubmit={entrar} className="mt-8 space-y-5">
            <div className="space-y-2">
              <Label htmlFor="usuario">Usuario</Label>
              <Input id="usuario" className="h-11" autoComplete="username" autoFocus required value={usuario} onChange={alEscribir(setUsuario)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="clave">Contraseña</Label>
              <Input id="clave" className="h-11" type="password" autoComplete="current-password" required value={clave} onChange={alEscribir(setClave)} />
            </div>
            {pideCodigo && (
              <div className="space-y-2">
                <Label htmlFor="codigo">Código de verificación</Label>
                <Input
                  id="codigo"
                  className="h-11 tracking-[0.3em]"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  required
                  maxLength={7}
                  value={codigo}
                  onChange={alEscribir(setCodigo)}
                />
                <p className="text-xs text-muted-foreground">Las 6 cifras que muestra tu aplicación de autenticación.</p>
              </div>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" className={cn("h-11 w-full text-base", fase === "aceptado" && "bg-success hover:bg-success")} disabled={ocupado}>
              {fase === "enviando" ? "Comprobando…" : fase === "aceptado" ? "Entrando…" : "Entrar"}
            </Button>
          </form>
        </div>

        <p className="w-full max-w-sm text-xs text-muted-foreground">Versión {VERSION}. Desarrollado por MAAT.</p>
      </main>
    </div>
  );
}
