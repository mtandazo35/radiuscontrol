import { KeyRound, Router as IconoRouter, ShieldAlert, ShieldCheck, Users } from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";
import { Card, EstadoVacio, Punto, Table, Td, Th } from "@/components/ui";
import { api } from "@/lib/api";
import { cn, fecha, motivoLegible } from "@/lib/utils";
import { AvisoDescartes } from "@/components/AvisoDescartes";
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
  activos: Cuenta[];
  motivos: Cuenta[];
  origenes: Cuenta[];
  recientes: {
    fecha: string;
    resultado: "aceptado" | "rechazado";
    usuario: string;
    router: string;
    origen: string;
    origen_nombre: string;
    metodo: string;
    motivo: string;
  }[];
}

interface Cuenta {
  nombre: string;
  total: number;
  ultimo: string;
  // Solo en los orígenes: la descripción puesta a esa dirección.
  descripcion?: string;
}

const periodos = [
  { horas: 1, texto: "1 h" },
  { horas: 12, texto: "12 h" },
  { horas: 24, texto: "24 h" },
];

// «hace 3 min»: en un panel que se mira de reojo dice más que la hora exacta.
function hace(iso: string, ahora: string) {
  const s = Math.max(0, Math.round((new Date(ahora).getTime() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "hace un momento";
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  return `hace ${Math.floor(s / 86400)} d`;
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
  const brillo = {
    primario: "bg-primary",
    ok: "bg-success",
    fallo: "bg-destructive",
    aviso: "bg-warning",
  }[tono];
  return (
    <Card className="relative flex flex-col justify-between overflow-hidden p-4">
      <span aria-hidden="true" className={cn("pointer-events-none absolute -right-8 -top-10 size-28 rounded-full opacity-[0.12] blur-2xl", brillo)} />
      <div className="relative flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{titulo}</span>
        <span className={cn("rounded-lg p-2", fondo)}>
          <Icono className="size-5" />
        </span>
      </div>
      <div className="relative my-2 flex items-baseline justify-between gap-2">
        <span className="font-mono text-3xl font-semibold tabular-nums">{valor}</span>
        {aparte && <span className="font-mono text-xs">{aparte}</span>}
      </div>
      {children}
      <div className="relative flex items-center justify-between gap-2 border-t pt-2 text-[11px] text-muted-foreground">
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
  const alto = 200;
  const util = alto - 10;
  const hueco = ancho / n;
  const grosor = Math.min(hueco * 0.7, 14);
  const marcas = [1, 0.5, 0];

  return (
    <div className="flex gap-2">
      {/* Eje: fuera del dibujo para que ninguna barra tape las cifras. */}
      <div className="flex h-[21rem] flex-col justify-between pt-[10px] text-right font-mono text-[11px] leading-none text-muted-foreground">
        {marcas.map((m) => (
          <span key={m}>{Number.isInteger(maximo * m) ? maximo * m : ""}</span>
        ))}
      </div>
      <div className="min-w-0 flex-1">
        <div className="relative">
          <svg viewBox={`0 0 ${ancho} ${alto}`} className="block h-[21rem] w-full" preserveAspectRatio="none" role="img" aria-label="Autenticaciones aceptadas y rechazadas por tramo">
            {marcas.map((m) => (
              <line key={m} x1={0} x2={ancho} y1={alto - m * util} y2={alto - m * util} className="stroke-border" strokeWidth={1} strokeDasharray={m === 0 ? undefined : "3 4"} vectorEffect="non-scaling-stroke" />
            ))}
            {tramos.map((t, i) => {
              const escala = util / maximo;
              const hA = t.aceptados * escala;
              const hR = t.rechazados * escala;
              const x = i * hueco + (hueco - grosor) / 2;
              const titulo = `${hora.format(t.inicio)}: ${t.aceptados} aceptados, ${t.rechazados} rechazados`;
              return (
                <g key={t.inicio} className="group">
                  <title>{titulo}</title>
                  {/* Zona completa: resalta la columna y da la ayuda también sobre un tramo vacío. */}
                  <rect x={i * hueco} y={0} width={hueco} height={alto} className="fill-transparent group-hover:fill-muted" />
                  {hA > 0 && <rect x={x} y={alto - hA} width={grosor} height={hA} className="fill-success/80 group-hover:fill-success" />}
                  {hR > 0 && <rect x={x} y={alto - hA - hR} width={grosor} height={hR} className="fill-destructive/85 group-hover:fill-destructive" />}
                </g>
              );
            })}
          </svg>
          {vacio && (
            <p className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
              Sin autenticaciones en {datos.horas_serie === 1 ? "la última hora" : `las últimas ${datos.horas_serie} horas`}.
            </p>
          )}
        </div>
        <div className="mt-1.5 flex justify-between font-mono text-[11px] text-muted-foreground">
          {[0, Math.floor(n / 4), Math.floor(n / 2), Math.floor((3 * n) / 4), n - 1].map((i) => (
            <span key={i}>{hora.format(tramos[i].inicio)}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

// Lista ordenada con una barra de fondo proporcional a la primera entrada.
function Lista({
  titulo,
  ayuda,
  filas,
  vacio,
  tono,
  mono = true,
}: {
  titulo: string;
  ayuda: string;
  filas: { nombre: string; total: number; detalle?: string }[];
  vacio: string;
  tono: "ok" | "fallo";
  mono?: boolean;
}) {
  const maximo = Math.max(1, ...filas.map((f) => f.total));
  return (
    <Card className="min-h-[165px] p-4">
      <h2 className="text-sm font-semibold">{titulo}</h2>
      <p className="mb-3 text-[11px] text-muted-foreground">{ayuda}</p>
      {filas.length === 0 ? (
        <div className="flex h-20 items-center justify-center rounded border border-dashed border-border/70 p-3 text-center text-xs text-muted-foreground">
          {vacio}
        </div>
      ) : (
        <ul className="space-y-1.5">
          {filas.map((f) => (
            <li key={f.nombre} className="relative overflow-hidden rounded">
              <span
                aria-hidden="true"
                className={cn("absolute inset-y-0 left-0 rounded", tono === "ok" ? "bg-success/15" : "bg-destructive/15")}
                style={{ width: `${Math.max(4, (f.total / maximo) * 100)}%` }}
              />
              <div className="relative flex items-center justify-between gap-3 px-2 py-1.5">
                <div className="min-w-0">
                  <p className={cn("truncate text-sm", mono && "font-mono")} title={f.nombre}>
                    {f.nombre}
                  </p>
                  {f.detalle && <p className="text-[11px] text-muted-foreground">{f.detalle}</p>}
                </div>
                <span className={cn("font-mono text-sm font-semibold", tono === "ok" ? "text-success" : "text-destructive")}>{miles.format(f.total)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
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
  const [horas, setHoras] = React.useState(12);

  React.useEffect(() => {
    let vivo = true;
    const cargar = async () => {
      try {
        const r = await api<Resumen>("GET", `/resumen?horas=${horas}${routerId !== null ? `&router=${routerId}` : ""}`, undefined, { auto: true });
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
  }, [routerId, horas]);

  if (!datos) {
    return <p className="text-sm text-muted-foreground">{fallo ? "No se pudo cargar el resumen. Se reintenta solo en unos segundos." : "Cargando…"}</p>;
  }

  const total24 = datos.aceptados_24h + datos.rechazados_24h;
  // Varios textos de FreeRADIUS significan lo mismo para quien lee: se suman.
  const porMotivo = new Map<string, number>();
  for (const m of datos.motivos) porMotivo.set(motivoLegible(m.nombre), (porMotivo.get(motivoLegible(m.nombre)) ?? 0) + m.total);
  const motivos = [...porMotivo].map(([nombre, total]) => ({ nombre, total })).sort((a, b) => b.total - a.total);
  const exito = total24 > 0 ? `${((datos.aceptados_24h / total24) * 100).toFixed(1)} %` : "—";

  return (
    <div className="space-y-4">
      <AvisoDescartes />
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
        <Card className="p-4 xl:col-span-2">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div>
              <h2 className="text-base font-semibold">Salud de autenticación</h2>
              <p className="text-[11px] text-muted-foreground">
                Una barra cada {datos.minutos_tramo === 1 ? "minuto" : `${datos.minutos_tramo} minutos`}. Un pico rojo es alguien o algo reintentando.
              </p>
            </div>
            <div className="flex items-center gap-4">
              <Leyenda />
              <div className="flex rounded-md border p-0.5" role="group" aria-label="Periodo del gráfico">
                {periodos.map((p) => (
                  <button
                    key={p.horas}
                    type="button"
                    onClick={() => setHoras(p.horas)}
                    aria-pressed={horas === p.horas}
                    className={cn(
                      "rounded px-2.5 py-1 font-mono text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      horas === p.horas ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {p.texto}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <Grafico datos={datos} />
        </Card>

        <Card className="flex flex-col">
          <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-4">
            <h2 className="text-base font-semibold">Últimos intentos</h2>
            <Link to="/autenticaciones" className="text-sm font-medium text-primary hover:underline">
              Ver todos
            </Link>
          </div>
          {datos.recientes.length === 0 ? (
            <p className="px-4 pb-4 text-sm text-muted-foreground">Todavía no hay ningún intento registrado.</p>
          ) : (
            <ul className="divide-y">
              {datos.recientes.map((x, i) => (
                <li key={`${x.fecha}-${i}`} className="flex items-center gap-3 px-4 py-2">
                  <span className={cn("size-2 shrink-0 rounded-full", x.resultado === "aceptado" ? "bg-success" : "bg-destructive")} aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">
                      <span className="font-mono font-medium">{x.usuario || "(sin usuario)"}</span>
                      <span className="text-muted-foreground">
                        {" "}
                        en {x.router || "router desconocido"}
                        {x.origen_nombre && ` desde ${x.origen_nombre}`}
                      </span>
                    </p>
                    <p className={cn("truncate text-[11px]", x.resultado === "aceptado" ? "text-success" : "text-destructive")}>
                      {x.resultado === "aceptado" ? `Aceptado por ${x.metodo || "RADIUS"}` : motivoLegible(x.motivo)}
                    </p>
                  </div>
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground" title={fecha(x.fecha)}>
                    {hace(x.fecha, datos.ahora)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Lista
          titulo="Quién entra más"
          ayuda="Logins aceptados por usuario, 24 h"
          tono="ok"
          vacio="Nadie entró en las últimas 24 horas."
          filas={datos.activos.map((x) => ({ nombre: x.nombre || "(sin usuario)", total: x.total, detalle: `Último: ${hace(x.ultimo, datos.ahora)}` }))}
        />
        {datos.rechazados.length === 0 && datos.origenes.length === 0 && motivos.length === 0 ? (
          <Card className="relative flex min-h-[165px] items-center gap-4 overflow-hidden p-5 xl:col-span-3">
            <span aria-hidden="true" className="pointer-events-none absolute -left-10 -top-10 size-40 rounded-full bg-success opacity-[0.08] blur-3xl" />
            <span className="relative rounded-xl bg-success/10 p-3 text-success"><ShieldCheck className="size-7" /></span>
            <div className="relative">
              <h2 className="text-base font-semibold">Sin rechazos en las últimas 24 horas</h2>
              <p className="text-sm text-muted-foreground">Todos los intentos de login a los routers se aceptaron. Si aparece alguno, aquí verás a quién, desde dónde y por qué.</p>
            </div>
          </Card>
        ) : (
          <>
            <Lista
              titulo="A quién se rechaza más"
              ayuda="Rechazos por usuario, 24 h"
              tono="fallo"
              vacio="Nadie fue rechazado en las últimas 24 horas."
              filas={datos.rechazados.map((x) => ({ nombre: x.usuario || "(sin usuario)", total: x.rechazados, detalle: `Último: ${hace(x.ultimo, datos.ahora)}` }))}
            />
            <Lista
              titulo="Desde dónde se rechaza"
              ayuda="Rechazos por dirección de quien intenta, 24 h"
              tono="fallo"
              vacio="Sin rechazos en las últimas 24 horas."
              filas={datos.origenes.map((x) => ({
                nombre: x.nombre || "Sin dirección de origen",
                total: x.total,
                detalle: `${x.descripcion ? `${x.descripcion}. ` : ""}Último: ${hace(x.ultimo, datos.ahora)}`,
              }))}
            />
            <Lista
              titulo="Por qué se rechaza"
              ayuda="Motivo que da FreeRADIUS, 24 h"
              tono="fallo"
              mono={false}
              vacio="Sin rechazos en las últimas 24 horas."
              filas={motivos}
            />
          </>
        )}
      </div>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
          <h2 className="text-base font-semibold">Routers</h2>
          <Link to="/routers" className="text-sm font-medium text-primary hover:underline">
            Administrar routers
          </Link>
        </div>
        <Table id="inicio-routers">
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
                <Td colSpan={6}>
                  <EstadoVacio titulo="Todavía no hay routers. Añade el primero en «Routers»." />
                </Td>
              </tr>
            )}
            {datos.routers.map((r) => (
              <tr key={r.id}>
                <Td>
                  <div className="font-medium">{r.nombre}</div>
                  {r.empresa && <div className="text-xs text-muted-foreground">{r.empresa}</div>}
                </Td>
                <Td><Punto tono={r.activo ? "success" : "muted"}>{r.activo ? "Activo" : "Suspendido"}</Punto></Td>
                <Td className="text-right font-mono" valor={r.redes}>{r.redes}</Td>
                <Td className="text-right font-mono" valor={r.aceptados}>{miles.format(r.aceptados)}</Td>
                <Td className={cn("text-right font-mono", r.rechazados > 0 && "font-semibold text-destructive")} valor={r.rechazados}>{miles.format(r.rechazados)}</Td>
                <Td className="font-mono text-xs" valor={r.ultimo ?? ""}>{r.ultimo ? fecha(r.ultimo) : "Nunca"}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}
