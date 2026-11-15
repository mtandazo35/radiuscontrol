import { Ban, KeyRound, Router as IconoRouter, ShieldAlert, Users } from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";
import { Badge, Card, Table, Td, Th } from "@/components/ui";
import { api } from "@/lib/api";
import { cn, fecha } from "@/lib/utils";
import { useFiltro } from "../filtro";

interface Tramo {
  inicio: string;
  aceptados: number;
  rechazados: number;
}

interface Resumen {
  ahora: string;
  aceptados_24h: number;
  rechazados_24h: number;
  aceptados_hora: number;
  rechazados_hora: number;
  routers_total: number;
  routers_activos: number;
  routers_con_actividad: number;
  usuarios_total: number;
  usuarios_activos: number;
  // null si quien mira no es administrador.
  bloqueos_ip: number | null;
  minutos_tramo: number;
  horas_serie: number;
  serie: Tramo[];
  routers: {
    id: number;
    nombre: string;
    empresa: string;
    activo: boolean;
    redes: number;
    aceptados: number;
    rechazados: number;
    ultimo: string | null;
  }[];
  rechazados: { usuario: string; rechazados: number; ultimo: string }[];
}

const miles = new Intl.NumberFormat("es-EC");
const hora = new Intl.DateTimeFormat("es-EC", { timeZone: "America/Guayaquil", hour: "2-digit", minute: "2-digit", hour12: false });

function Indicador({
  titulo,
  icono: Icono,
  tono = "primario",
  valor,
  aparte,
  pie,
  children,
}: {
  titulo: string;
  icono: React.ComponentType<{ className?: string }>;
  tono?: "primario" | "ok" | "fallo" | "aviso";
  valor: React.ReactNode;
  aparte?: React.ReactNode;
  pie: [string, React.ReactNode][];
  children?: React.ReactNode;
}) {
  const fondo = {
    primario: "bg-primary/10 text-primary",
    ok: "bg-success/10 text-success",
    fallo: "bg-destructive/10 text-destructive",
    aviso: "bg-warning/10 text-warning",
  }[tono];
  return (
    <Card className="flex flex-col justify-between p-4 shadow-none">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{titulo}</span>
        <span className={cn("rounded p-1.5", fondo)}>
          <Icono className="size-4" />
        </span>
      </div>
      <div className="my-2 flex items-baseline justify-between gap-2">
        <span className="font-mono text-2xl font-semibold">{valor}</span>
        {aparte && <span className="font-mono text-xs">{aparte}</span>}
      </div>
      {children}
      <div className="flex items-center justify-between gap-2 border-t pt-2 text-[11px] text-muted-foreground">
        {pie.map(([etiqueta, dato]) => (
          <span key={etiqueta}>
            {etiqueta}: <strong className="font-mono font-semibold text-foreground">{dato}</strong>
          </span>
        ))}
      </div>
    </Card>
  );
}

function Barra({ parte, total, tono }: { parte: number; total: number; tono: string }) {
  const pct = total > 0 ? Math.round((parte / total) * 100) : 0;
  return (
    <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-muted" role="img" aria-label={`${pct} %`}>
      <div className={cn("h-full rounded-full", tono)} style={{ width: `${pct}%` }} />
    </div>
  );
}

// Barras apiladas de aceptados y rechazados por tramo. Un pico de rojo delata
// un equipo o una persona reintentando con la contraseña equivocada.
function Grafico({ datos }: { datos: Resumen }) {
  const paso = datos.minutos_tramo * 60000;
  const n = (datos.horas_serie * 60) / datos.minutos_tramo;
  const fin = Math.floor(new Date(datos.ahora).getTime() / paso) * paso;
  const porInicio = new Map(datos.serie.map((t) => [new Date(t.inicio).getTime(), t]));
  const tramos = Array.from({ length: n }, (_, i) => {
    const inicio = fin - (n - 1 - i) * paso;
    const t = porInicio.get(inicio);
    return { inicio, aceptados: t?.aceptados ?? 0, rechazados: t?.rechazados ?? 0 };
  });
  const maximo = Math.max(1, ...tramos.map((t) => t.aceptados + t.rechazados));
  const vacio = tramos.every((t) => t.aceptados + t.rechazados === 0);

  const ancho = 720;
  const alto = 180;
  const hueco = ancho / n;
  const marcas = [0, 0.5, 1];

  return (
    <div>
      <div className="relative">
        <svg viewBox={`0 0 ${ancho} ${alto}`} className="block h-48 w-full" preserveAspectRatio="none" role="img" aria-label="Autenticaciones aceptadas y rechazadas por tramo">
          {marcas.map((m) => (
            <line key={m} x1={0} x2={ancho} y1={alto - m * (alto - 8)} y2={alto - m * (alto - 8)} className="stroke-border" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          ))}
          {tramos.map((t, i) => {
            const escala = (alto - 8) / maximo;
            const hA = t.aceptados * escala;
            const hR = t.rechazados * escala;
            const x = i * hueco + hueco * 0.15;
            const w = hueco * 0.7;
            const titulo = `${hora.format(t.inicio)}: ${t.aceptados} aceptados, ${t.rechazados} rechazados`;
            return (
              <g key={t.inicio}>
                <title>{titulo}</title>
                {/* Zona completa para que la ayuda salga también sobre un tramo vacío. */}
                <rect x={i * hueco} y={0} width={hueco} height={alto} fill="transparent" />
                {hA > 0 && <rect x={x} y={alto - hA} width={w} height={hA} rx={1} className="fill-success" />}
                {hR > 0 && <rect x={x} y={alto - hA - hR} width={w} height={hR} rx={1} className="fill-destructive" />}
              </g>
            );
          })}
        </svg>
        <span className="absolute right-0 top-0 font-mono text-[11px] text-muted-foreground">{maximo}</span>
        {vacio && (
          <p className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
            Sin autenticaciones en las últimas {datos.horas_serie} horas.
          </p>
        )}
      </div>
      <div className="mt-1 flex justify-between font-mono text-[11px] text-muted-foreground">
        {[0, Math.floor(n / 4), Math.floor(n / 2), Math.floor((3 * n) / 4), n - 1].map((i) => (
          <span key={i}>{hora.format(tramos[i].inicio)}</span>
        ))}
      </div>
    </div>
  );
}

function Leyenda() {
  return (
    <div className="flex items-center gap-4 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span className="size-2 rounded-sm bg-success" /> Access-Accept
      </span>
      <span className="flex items-center gap-1.5">
        <span className="size-2 rounded-sm bg-destructive" /> Access-Reject
      </span>
    </div>
  );
}

export default function Inicio() {
  const { routerId } = useFiltro();
  const [datos, setDatos] = React.useState<Resumen | null>(null);
  const [fallo, setFallo] = React.useState(false);

  React.useEffect(() => {
    let vivo = true;
    const cargar = async () => {
      try {
        const r = await api<Resumen>("GET", `/resumen${routerId !== null ? `?router=${routerId}` : ""}`, undefined, { auto: true });
        if (vivo) {
          setDatos(r);
          setFallo(false);
        }
      } catch {
        if (vivo) setFallo(true);
      }
    };
    cargar();
    const t = window.setInterval(cargar, 10000);
    return () => {
      vivo = false;
      window.clearInterval(t);
    };
  }, [routerId]);

  if (!datos) {
    return <p className="text-sm text-muted-foreground">{fallo ? "No se pudo cargar el resumen. Se reintenta solo en unos segundos." : "Cargando…"}</p>;
  }

  const total24 = datos.aceptados_24h + datos.rechazados_24h;
  const exito = total24 > 0 ? `${((datos.aceptados_24h / total24) * 100).toFixed(1)} %` : "—";

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Indicador
          titulo="Autenticaciones (24 h)"
          icono={KeyRound}
          valor={miles.format(total24)}
          aparte={<span className={datos.rechazados_24h > 0 && total24 > 0 && datos.aceptados_24h / total24 < 0.9 ? "text-warning" : "text-success"}>{exito}</span>}
          pie={[
            ["Aceptadas", miles.format(datos.aceptados_24h)],
            ["Última hora", miles.format(datos.aceptados_hora + datos.rechazados_hora)],
          ]}
        />
        <Indicador
          titulo="Rechazos (24 h)"
          icono={ShieldAlert}
          tono={datos.rechazados_24h > 0 ? "fallo" : "ok"}
          valor={<span className={datos.rechazados_24h > 0 ? "text-destructive" : undefined}>{miles.format(datos.rechazados_24h)}</span>}
          pie={[
            ["Última hora", miles.format(datos.rechazados_hora)],
            ["Usuarios distintos", datos.rechazados.length >= 6 ? "6+" : datos.rechazados.length],
          ]}
        />
        <Indicador
          titulo="Routers activos"
          icono={IconoRouter}
          tono="ok"
          valor={
            <>
              {datos.routers_activos} <span className="text-base text-muted-foreground">/ {datos.routers_total}</span>
            </>
          }
          pie={[
            ["Con logins en 24 h", datos.routers_con_actividad],
            ["Suspendidos", datos.routers_total - datos.routers_activos],
          ]}
        >
          <Barra parte={datos.routers_activos} total={datos.routers_total} tono="bg-success" />
        </Indicador>
        <Indicador
          titulo="Usuarios MikroTik activos"
          icono={Users}
          valor={
            <>
              {datos.usuarios_activos} <span className="text-base text-muted-foreground">/ {datos.usuarios_total}</span>
            </>
          }
          pie={
            datos.bloqueos_ip === null
              ? [["Suspendidos", datos.usuarios_total - datos.usuarios_activos]]
              : [
                  ["Suspendidos", datos.usuarios_total - datos.usuarios_activos],
                  ["IP bloqueadas en el panel", datos.bloqueos_ip],
                ]
          }
        >
          <Barra parte={datos.usuarios_activos} total={datos.usuarios_total} tono="bg-primary" />
        </Indicador>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="p-4 shadow-none xl:col-span-2">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-semibold">
              Salud de autenticación{" "}
              <span className="text-xs font-normal text-muted-foreground">
                últimas {datos.horas_serie} horas, cada {datos.minutos_tramo} minutos
              </span>
            </h2>
            <Leyenda />
          </div>
          <Grafico datos={datos} />
        </Card>

        <Card className="p-4 shadow-none">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-base font-semibold">Más rechazados (24 h)</h2>
            <Ban className="size-4 text-muted-foreground" aria-hidden="true" />
          </div>
          {datos.rechazados.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nadie fue rechazado en las últimas 24 horas.</p>
          ) : (
            <ul className="divide-y">
              {datos.rechazados.map((x) => (
                <li key={x.usuario} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-sm">{x.usuario || "(sin usuario)"}</p>
                    <p className="text-[11px] text-muted-foreground">Último: {fecha(x.ultimo)}</p>
                  </div>
                  <span className="font-mono text-sm font-semibold text-destructive">{miles.format(x.rechazados)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card className="shadow-none">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
          <h2 className="text-base font-semibold">Routers</h2>
          <Link to="/routers" className="text-sm font-medium text-primary hover:underline">
            Administrar routers
          </Link>
        </div>
        <Table>
          <thead>
            <tr>
              <Th>Router</Th>
              <Th>Estado</Th>
              <Th className="text-right">Redes</Th>
              <Th className="text-right">Aceptados 24 h</Th>
              <Th className="text-right">Rechazados 24 h</Th>
              <Th>Último login aceptado</Th>
            </tr>
          </thead>
          <tbody>
            {datos.routers.length === 0 && (
              <tr>
                <Td colSpan={6} className="text-center text-muted-foreground">
                  Todavía no hay routers. Añade el primero en «Routers».
                </Td>
              </tr>
            )}
            {datos.routers.map((r) => (
              <tr key={r.id} className="hover:bg-muted/50">
                <Td>
                  <div className="font-medium">{r.nombre}</div>
                  {r.empresa && <div className="text-xs text-muted-foreground">{r.empresa}</div>}
                </Td>
                <Td>{r.activo ? <Badge variant="success">Activo</Badge> : <Badge variant="muted">Suspendido</Badge>}</Td>
                <Td className="text-right font-mono">{r.redes}</Td>
                <Td className="text-right font-mono">{miles.format(r.aceptados)}</Td>
                <Td className={cn("text-right font-mono", r.rechazados > 0 && "font-semibold text-destructive")}>{miles.format(r.rechazados)}</Td>
                <Td className="font-mono text-xs">{r.ultimo ? fecha(r.ultimo) : "Nunca"}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}
