import * as React from "react";
import { AccesoServidor } from "@/components/AccesoServidor";
import { useActualizacion, versionCorta } from "@/components/Actualizacion";
import { Limpieza } from "@/components/Limpieza";
import { Badge, Button, Card } from "@/components/ui";
import { fecha, huellaCorta } from "@/lib/utils";
import { useApp } from "../contexto";

function Dato({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{titulo}</dt>
      <dd className="mt-0.5 text-sm">{children}</dd>
    </div>
  );
}

const textoFreeradius: Record<string, string> = {
  "en-marcha": "En marcha",
  "sin-configuracion": "Esperando la primera configuración",
  error: "Detenido por un error",
};

const textoFirewall: Record<string, string> = {
  sincronizado: "Al día",
  "sin-configuracion": "Esperando la primera configuración",
  error: "No pudo aplicar alguna regla",
};

export default function Configuracion() {
  const { estado, operador } = useApp();
  const act = useActualizacion();
  const b = act.datos?.busqueda;
  const p = act.datos?.proceso;
  const fr = estado?.freeradius;
  const fw = estado?.firewall;
  const activa = estado?.activa;

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted-foreground">
          Lo que el panel tiene guardado, lo que se aplicó, lo que FreeRADIUS declara tener cargado y lo que el firewall
          deja pasar. Los cambios se aplican solos a los pocos segundos de guardarlos.
        </p>
      </div>

      {estado?.cambios_pendientes && estado.ultimo_fallo && (
        <Card className="border-destructive/50 p-4">
          <h2 className="text-sm font-semibold text-destructive">El último cambio no se pudo aplicar</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            FreeRADIUS sigue funcionando con la configuración anterior. Este es el motivo:
          </p>
          <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap rounded-md border bg-muted p-3 font-mono text-xs">
            {estado.ultimo_fallo}
          </pre>
        </Card>
      )}

      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Estado del motor y del firewall</h2>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card className="flex flex-col justify-between p-4">
          <div className="mb-3 flex items-center justify-between gap-2 border-b pb-2.5">
            <h3 className="text-sm font-semibold">Guardado en el panel</h3>
            {estado?.cambios_pendientes ? (
              <Badge variant="warning">Distinto de lo aplicado</Badge>
            ) : (
              <Badge variant="success">Igual a lo aplicado</Badge>
            )}
          </div>
          <dl className="space-y-2.5">
            <Dato titulo="Routers y usuarios activos">
              {estado ? `${estado.deseado.routers} routers, ${estado.deseado.usuarios} usuarios` : "—"}
            </Dato>
            <Dato titulo="Huella">
              <span className="font-mono text-xs">
                {huellaCorta(estado?.deseado.sha_clients)} · {huellaCorta(estado?.deseado.sha_authorize)}
              </span>
            </Dato>
          </dl>
        </Card>

        <Card className="flex flex-col justify-between p-4">
          <div className="mb-3 flex items-center justify-between gap-2 border-b pb-2.5">
            <h3 className="text-sm font-semibold">Aplicado</h3>
          </div>
          <dl className="space-y-2.5">
            <Dato titulo="Última aplicación">{activa ? fecha(activa.creada) : "Ninguna todavía"}</Dato>
            <Dato titulo="Huella">
              <span className="font-mono text-xs">
                {huellaCorta(activa?.sha_clients)} · {huellaCorta(activa?.sha_authorize)}
              </span>
            </Dato>
            <Dato titulo="Aplicada por">{activa?.operador ?? "—"}</Dato>
          </dl>
        </Card>

        <Card className="flex flex-col justify-between p-4">
          <div className="mb-3 flex items-center justify-between gap-2 border-b pb-2.5">
            <h3 className="text-sm font-semibold">FreeRADIUS</h3>
            {estado?.sincronizado ? (
              <Badge variant="success">Coincide con lo aplicado</Badge>
            ) : (
              <Badge variant="destructive">No coincide con lo aplicado</Badge>
            )}
          </div>
          <dl className="space-y-2.5">
            <Dato titulo="Estado">{fr ? (textoFreeradius[fr.estado] ?? fr.estado) : "Sin datos"}</Dato>
            <Dato titulo="Huella cargada">
              <span className="font-mono text-xs">
                {huellaCorta(fr?.sha_clients)} · {huellaCorta(fr?.sha_authorize)}
              </span>
            </Dato>
          </dl>
        </Card>

        <Card className="flex flex-col justify-between p-4">
          <div className="mb-3 flex items-center justify-between gap-2 border-b pb-2.5">
            <h3 className="text-sm font-semibold">Firewall del servidor</h3>
            {estado?.firewall_al_dia ? (
              <Badge variant="success">Coincide con lo aplicado</Badge>
            ) : (
              <Badge variant="destructive">No coincide con lo aplicado</Badge>
            )}
          </div>
          <dl className="space-y-2.5">
            <Dato titulo="Estado">
              {!fw ? "Sin datos del agente" : !fw.ufw_activo ? "UFW está desactivado" : (textoFirewall[fw.estado] ?? fw.estado)}
            </Dato>
            <Dato titulo="Redes con acceso a 1812/udp">
              {fw && fw.redes.length > 0 ? (
                <span className="font-mono text-xs">
                  {fw.redes.map((red) => (
                    <span key={red} className="block">
                      {red}
                    </span>
                  ))}
                </span>
              ) : (
                "Ninguna"
              )}
            </Dato>
          </dl>
        </Card>
        </div>
      </section>

      {operador?.rol === "administrador" && (
        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Sistema y accesos</h2>
          <Card className="p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">Versión</h3>
              <p className="text-sm text-muted-foreground">
                Las mejoras se publican en el repositorio y se instalan desde aquí. Nunca se instalan solas.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={act.buscar} disabled={act.buscando || act.enCurso}>
                {act.buscando ? "Buscando…" : "Buscar actualizaciones"}
              </Button>
              {(act.pendientes > 0 || act.enCurso) && (
                <Button size="sm" onClick={act.abrir}>
                  {act.enCurso ? "Ver el avance" : "Ver novedades y actualizar"}
                </Button>
              )}
            </div>
          </div>
          <dl className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Dato titulo="Versión instalada">
              <span className="font-mono text-xs">{versionCorta(b?.instalado)}</span>
              {b?.instalado_fecha && <span className="text-muted-foreground"> · {fecha(b.instalado_fecha)}</span>}
            </Dato>
            <Dato titulo="Situación">
              {!b ? (
                <Badge variant="muted">Sin datos del agente</Badge>
              ) : b.error ? (
                <Badge variant="destructive">No se pudo consultar</Badge>
              ) : act.pendientes > 0 ? (
                <Badge variant="warning">{act.pendientes} cambio(s) nuevo(s)</Badge>
              ) : (
                <Badge variant="success">Al día</Badge>
              )}
            </Dato>
            <Dato titulo="Última búsqueda">{fecha(b?.buscado)}</Dato>
            <Dato titulo="Última actualización">
              {p ? (
                <>
                  {p.estado === "ok" ? "Correcta" : p.estado === "en-curso" ? "En curso" : p.estado === "revertida" ? "Revertida" : "Fallida"}
                  <span className="text-muted-foreground">
                    {" "}
                    · {versionCorta(p.de)} → {versionCorta(p.a)} · {p.quien} · {fecha(p.fin || p.inicio)}
                  </span>
                </>
              ) : (
                "Ninguna todavía"
              )}
            </Dato>
          </dl>
          {b?.error && <p className="mt-3 text-sm text-destructive">{b.error}</p>}
          {p && p.estado !== "ok" && p.estado !== "en-curso" && p.mensaje && <p className="mt-3 text-sm text-destructive">{p.mensaje}</p>}
          </Card>
          <AccesoServidor />
        </section>
      )}

      {operador?.rol === "administrador" && (
        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Mantenimiento y retención</h2>
          <Limpieza />
        </section>
      )}
    </div>
  );
}
