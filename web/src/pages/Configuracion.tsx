import * as React from "react";
import { AccesoServidor } from "@/components/AccesoServidor";
import { Limpieza } from "@/components/Limpieza";
import { Migracion } from "@/components/Migracion";
import { Ayuda, Badge, Card, ListaPestanas, PanelPestana, Pestana, Pestanas } from "@/components/ui";
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

  const [pestana, setPestana] = React.useState<string>(() => {
    try {
      return sessionStorage.getItem("rc-configuracion:pestana") ?? "estado";
    } catch {
      return "estado";
    }
  });
  const cambiarPestana = (v: string) => {
    setPestana(v);
    try {
      sessionStorage.setItem("rc-configuracion:pestana", v);
    } catch {
      // Sin almacenamiento: vale hasta recargar.
    }
  };
  const admin = operador?.rol === "administrador";
  const actual = !admin && pestana !== "estado" ? "estado" : pestana;

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted-foreground">
          Estado del motor, accesos y mantenimiento del servidor.{" "}
          <Ayuda>
            Lo que el panel tiene guardado, lo que se aplicó, lo que FreeRADIUS declara tener cargado y lo que el firewall
            deja pasar. Los cambios se aplican solos a los pocos segundos de guardarlos.
          </Ayuda>
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

      <Pestanas value={actual} onValueChange={cambiarPestana}>
        <ListaPestanas>
          <Pestana value="estado">Estado</Pestana>
          {admin && <Pestana value="accesos">Accesos</Pestana>}
          {admin && <Pestana value="mantenimiento">Mantenimiento</Pestana>}
          {admin && <Pestana value="migracion">Migración</Pestana>}
        </ListaPestanas>
        <PanelPestana value="estado">
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
                    <details>
                      <summary className="cursor-pointer text-sm hover:text-primary">{fw.redes.length === 1 ? "1 red" : `${fw.redes.length} redes`}</summary>
                      <span className="mt-1.5 block font-mono text-xs">
                        {fw.redes.map((red) => (
                          <span key={red} className="block">
                            {red}
                          </span>
                        ))}
                      </span>
                    </details>
                  ) : (
                    "Ninguna"
                  )}
                </Dato>
              </dl>
            </Card>
          </div>
        </PanelPestana>
        {admin && (
          <PanelPestana value="accesos">
            <AccesoServidor />
            <Origenes />
          </PanelPestana>
        )}
        {admin && (
          <PanelPestana value="mantenimiento">
            <Limpieza />
          </PanelPestana>
        )}
        {admin && (
          <PanelPestana value="migracion">
            <Migracion />
          </PanelPestana>
        )}
      </Pestanas>
    </div>
  );
}
