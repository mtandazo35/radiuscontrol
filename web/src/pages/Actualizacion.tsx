import { Download, RefreshCw } from "lucide-react";
import { useActualizacion, versionCorta } from "@/components/Actualizacion";
import { Badge, Button, Card, EstadoVacio } from "@/components/ui";
import { cn, fecha } from "@/lib/utils";
import { useApp } from "../contexto";

// Apartado de actualización: qué versión hay instalada, qué cambios nuevos hay
// publicados en el repositorio y el botón para instalarlos. La instalación la
// hace el agente del servidor; aquí se pide y se sigue su avance.

const nombrePaso: Record<string, string> = {
  descargar: "Descargar la versión nueva",
  respaldo: "Respaldar la base, los secretos y el entorno",
  construir: "Construir la versión nueva",
  instalar: "Instalarla",
  comprobar: "Comprobar que todo responde",
};

const nombreEstado = { ok: "Correcta", "en-curso": "En curso", revertida: "Revertida", fallida: "Fallida" } as const;
const tonoEstado = { ok: "success", "en-curso": "default", revertida: "warning", fallida: "destructive" } as const;

function Dato({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{titulo}</dt>
      <dd className="mt-0.5 text-sm">{children}</dd>
    </div>
  );
}

export default function Actualizacion() {
  const { operador } = useApp();
  const act = useActualizacion();
  const b = act.datos?.busqueda;
  const p = act.datos?.proceso;

  if (operador?.rol !== "administrador") {
    return <p className="text-sm text-muted-foreground">Solo un administrador puede ver e instalar actualizaciones.</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <p className="min-w-0 max-w-4xl flex-1 basis-80 text-sm text-muted-foreground">
          Las mejoras se publican en el repositorio. El servidor mira cada 30 minutos si hay cambios nuevos, pero nunca los instala solo: los
          instalas tú desde aquí.
        </p>
        <Button variant="outline" onClick={act.buscar} disabled={act.buscando || act.enCurso}>
          <RefreshCw className={cn(act.buscando && "motion-safe:animate-spin")} />
          {act.buscando ? "Buscando…" : "Buscar actualizaciones"}
        </Button>
      </div>

      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b pb-2.5">
          <h2 className="text-sm font-semibold">Versión instalada</h2>
          {!b ? (
            <Badge variant="muted">Sin datos del agente</Badge>
          ) : b.error ? (
            <Badge variant="destructive">No se pudo consultar</Badge>
          ) : act.enCurso ? (
            <Badge>Actualizando…</Badge>
          ) : act.pendientes > 0 ? (
            <Badge variant="warning">{act.pendientes} cambio(s) nuevo(s)</Badge>
          ) : (
            <Badge variant="success">Al día</Badge>
          )}
        </div>
        <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Dato titulo="Versión">
            <span className="font-mono">{versionCorta(b?.instalado)}</span>
          </Dato>
          <Dato titulo="Publicada el">{fecha(b?.instalado_fecha)}</Dato>
          <Dato titulo="Último cambio que trae">{b?.instalado_asunto || "—"}</Dato>
          <Dato titulo="Última búsqueda">{fecha(b?.buscado)}</Dato>
        </dl>
        {b?.error && <p className="mt-3 rounded-md border border-destructive/50 p-3 text-sm text-destructive">{b.error}</p>}
      </Card>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div>
            <h2 className="text-sm font-semibold">Cambios disponibles</h2>
            <p className="text-sm text-muted-foreground">
              {act.pendientes > 0
                ? "Lo que se publicó después de la versión instalada, de lo más reciente a lo más antiguo."
                : "Lo publicado en el repositorio después de la versión instalada."}
            </p>
          </div>
          {(act.pendientes > 0 || act.enCurso) && (
            <Button onClick={act.abrir}>
              <Download /> {act.enCurso ? "Ver el avance" : "Actualizar ahora"}
            </Button>
          )}
        </div>
        {act.pendientes > 0 ? (
          <ul className="divide-y border-t">
            {b!.cambios.map((c) => (
              <li key={c.commit} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-2.5">
                <span className="min-w-0 text-sm">{c.asunto}</span>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  {versionCorta(c.commit)} · {fecha(c.fecha)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="border-t">
            <EstadoVacio
              titulo={act.enCurso ? "Hay una actualización en curso." : "RadiusControl está al día."}
              descripcion={act.enCurso ? undefined : "Pulsa «Buscar actualizaciones» para comprobarlo ahora mismo sin esperar a la búsqueda automática."}
            />
          </div>
        )}
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b pb-2.5">
            <h2 className="text-sm font-semibold">Última actualización</h2>
            {p && <Badge variant={tonoEstado[p.estado]}>{nombreEstado[p.estado]}</Badge>}
          </div>
          {p ? (
            <>
              <dl className="grid gap-4 sm:grid-cols-2">
                <Dato titulo="De la versión">
                  <span className="font-mono">{versionCorta(p.de)}</span>
                </Dato>
                <Dato titulo="A la versión">
                  <span className="font-mono">{versionCorta(p.a)}</span>
                </Dato>
                <Dato titulo="La pidió">{p.quien || "—"}</Dato>
                <Dato titulo="Cuándo">{fecha(p.fin || p.inicio)}</Dato>
              </dl>
              {p.mensaje && (
                <p className={cn("mt-3 text-sm", p.estado === "ok" || p.estado === "en-curso" ? "text-muted-foreground" : "text-destructive")}>{p.mensaje}</p>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Todavía no se ha instalado ninguna actualización desde el panel.</p>
          )}
        </Card>

        <Card className="p-4">
          <h2 className="mb-3 border-b pb-2.5 text-sm font-semibold">Qué pasa al actualizar</h2>
          <ol className="space-y-2 text-sm">
            {["descargar", "respaldo", "construir", "instalar", "comprobar"].map((paso, i) => (
              <li key={paso} className="flex gap-2.5">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted font-mono text-[11px] text-muted-foreground">{i + 1}</span>
                <span>{nombrePaso[paso]}</span>
              </li>
            ))}
          </ol>
          <p className="mt-3 text-sm text-muted-foreground">
            Si la versión nueva no construye o no responde bien, el servidor vuelve solo a la anterior. Se conservan los cinco últimos respaldos en
            el servidor.
          </p>
        </Card>
      </div>
    </div>
  );
}
