import * as React from "react";
import { AccesoServidor } from "@/components/AccesoServidor";
import { Limpieza } from "@/components/Limpieza";
import { Badge, Card } from "@/components/ui";
import { fecha, huellaCorta } from "@/lib/utils";
import { Origenes } from "@/components/Origenes";
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
        <Card className="p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 border-b pb-2.5">
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

        <Card className="p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 border-b pb-2.5">
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

        <Card className="p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 border-b pb-2.5">
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

        <Card className="p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 border-b pb-2.5">
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
          <AccesoServidor />
          <Origenes />
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
