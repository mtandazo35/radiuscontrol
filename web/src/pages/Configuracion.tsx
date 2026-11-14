import * as React from "react";
import { Badge, Button, Card, Table, Td, Th } from "@/components/ui";
import { api, type Version } from "@/lib/api";
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
  const { estado, refrescarEstado, avisar, avisarError, confirmar } = useApp();
  const [versiones, setVersiones] = React.useState<Version[] | null>(null);

  const cargar = React.useCallback(async () => {
    try {
      setVersiones(await api<Version[]>("GET", "/versiones"));
    } catch (e) {
      avisarError(e);
    }
  }, [avisarError]);

  React.useEffect(() => {
    cargar();
  }, [cargar, estado?.activa?.id]);

  const volver = async (v: Version) => {
    const ok = await confirmar(
      `Volver a la versión ${v.id}`,
      "FreeRADIUS volverá a usar esa configuración tal como se aplicó. Los datos del panel no cambian, así que quedará marcado como «cambios sin aplicar».",
      "Volver a esta versión",
    );
    if (!ok) return;
    try {
      await api("POST", `/versiones/${v.id}/activar`);
      await refrescarEstado();
      await cargar();
      avisar({ titulo: "Versión reactivada", mensaje: `FreeRADIUS carga la versión ${v.id} en unos segundos.` });
    } catch (e) {
      avisarError(e);
    }
  };

  const fr = estado?.freeradius;
  const fw = estado?.firewall;
  const activa = estado?.activa;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Configuración</h1>
        <p className="text-sm text-muted-foreground">
          Lo que el panel tiene guardado, lo que se aplicó, lo que FreeRADIUS declara tener cargado y lo que el firewall deja pasar.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card className="p-4">
          <h2 className="mb-3 text-sm font-semibold">Deseado (panel)</h2>
          <dl className="space-y-3">
            <Dato titulo="Routers y usuarios activos">
              {estado ? `${estado.deseado.routers} routers, ${estado.deseado.usuarios} usuarios` : "—"}
            </Dato>
            <Dato titulo="Huella">
              <span className="font-mono text-xs">
                {huellaCorta(estado?.deseado.sha_clients)} · {huellaCorta(estado?.deseado.sha_authorize)}
              </span>
            </Dato>
            <Dato titulo="Situación">
              {estado?.cambios_pendientes ? <Badge variant="warning">Cambios sin aplicar</Badge> : <Badge variant="success">Igual a lo aplicado</Badge>}
            </Dato>
          </dl>
        </Card>

        <Card className="p-4">
          <h2 className="mb-3 text-sm font-semibold">Aplicado</h2>
          <dl className="space-y-3">
            <Dato titulo="Versión activa">{activa ? `Versión ${activa.id}, ${fecha(activa.creada)}` : "Ninguna todavía"}</Dato>
            <Dato titulo="Huella">
              <span className="font-mono text-xs">
                {huellaCorta(activa?.sha_clients)} · {huellaCorta(activa?.sha_authorize)}
              </span>
            </Dato>
            <Dato titulo="Aplicada por">{activa?.operador ?? "—"}</Dato>
          </dl>
        </Card>

        <Card className="p-4">
          <h2 className="mb-3 text-sm font-semibold">FreeRADIUS</h2>
          <dl className="space-y-3">
            <Dato titulo="Estado">{fr ? (textoFreeradius[fr.estado] ?? fr.estado) : "Sin datos"}</Dato>
            <Dato titulo="Huella cargada">
              <span className="font-mono text-xs">
                {huellaCorta(fr?.sha_clients)} · {huellaCorta(fr?.sha_authorize)}
              </span>
            </Dato>
            <Dato titulo="Situación">
              {estado?.sincronizado ? (
                <Badge variant="success">Coincide con lo aplicado</Badge>
              ) : (
                <Badge variant="destructive">No coincide con lo aplicado</Badge>
              )}
            </Dato>
          </dl>
        </Card>

        <Card className="p-4">
          <h2 className="mb-3 text-sm font-semibold">Firewall del servidor</h2>
          <dl className="space-y-3">
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
            <Dato titulo="Situación">
              {estado?.firewall_al_dia ? (
                <Badge variant="success">Coincide con lo aplicado</Badge>
              ) : (
                <Badge variant="destructive">No coincide con lo aplicado</Badge>
              )}
            </Dato>
          </dl>
        </Card>
      </div>

      <Card>
        <h2 className="px-4 pt-4 text-sm font-semibold">Historial de versiones</h2>
        <Table className="mt-2">
          <thead>
            <tr>
              <Th>Versión</Th>
              <Th>Fecha</Th>
              <Th>Operador</Th>
              <Th>Contenido</Th>
              <Th>Resultado</Th>
              <Th className="text-right">Acciones</Th>
            </tr>
          </thead>
          <tbody>
            {versiones?.length === 0 && (
              <tr>
                <Td colSpan={6} className="py-10 text-center text-muted-foreground">
                  Todavía no se ha aplicado ninguna configuración.
                </Td>
              </tr>
            )}
            {versiones?.map((v) => (
              <tr key={v.id}>
                <Td className="font-medium">{v.id}</Td>
                <Td className="whitespace-nowrap text-muted-foreground">{fecha(v.creada)}</Td>
                <Td>{v.operador}</Td>
                <Td className="whitespace-nowrap text-muted-foreground">
                  {v.routers} routers, {v.usuarios} usuarios
                </Td>
                <Td>
                  {v.activa ? (
                    <Badge variant="success">Activa</Badge>
                  ) : v.estado === "aplicada" ? (
                    <Badge variant="muted">Aplicada</Badge>
                  ) : (
                    <Badge variant="destructive">Rechazada</Badge>
                  )}
                </Td>
                <Td className="text-right">
                  {!v.activa && v.estado === "aplicada" && (
                    <Button size="sm" variant="outline" onClick={() => volver(v)}>
                      Volver a esta versión
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}
