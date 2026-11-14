import * as React from "react";
import { Badge, Card, Input, Table, Td, Th } from "@/components/ui";
import { api, type Autenticacion } from "@/lib/api";
import { fecha } from "@/lib/utils";
import { useApp } from "../contexto";

export default function Autenticaciones() {
  const { avisarError } = useApp();
  const [lista, setLista] = React.useState<Autenticacion[] | null>(null);
  const [resultado, setResultado] = React.useState("");
  const [buscar, setBuscar] = React.useState("");

  const cargar = React.useCallback(
    async (avisar: boolean) => {
      try {
        const q = new URLSearchParams({ limite: "200" });
        if (resultado) q.set("resultado", resultado);
        if (buscar.trim()) q.set("buscar", buscar.trim());
        setLista(await api<Autenticacion[]>("GET", `/autenticaciones?${q}`));
      } catch (e) {
        if (avisar) avisarError(e);
      }
    },
    [resultado, buscar, avisarError],
  );

  React.useEffect(() => {
    const espera = window.setTimeout(() => cargar(true), 250);
    const t = window.setInterval(() => cargar(false), 5000);
    return () => {
      window.clearTimeout(espera);
      window.clearInterval(t);
    };
  }, [cargar]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Autenticaciones</h1>
        <p className="text-sm text-muted-foreground">
          Cada intento de login que FreeRADIUS aceptó o rechazó, en hora de Ecuador. Se actualiza solo. Los paquetes de
          orígenes no autorizados o con secreto incorrecto no aparecen aquí: FreeRADIUS los descarta sin responder.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Input
          className="max-w-xs"
          placeholder="Buscar usuario, router, empresa o IP"
          aria-label="Buscar"
          value={buscar}
          onChange={(e) => setBuscar(e.target.value)}
        />
        <select
          aria-label="Resultado"
          className="h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={resultado}
          onChange={(e) => setResultado(e.target.value)}
        >
          <option value="">Todos los resultados</option>
          <option value="aceptado">Aceptados</option>
          <option value="rechazado">Rechazados</option>
        </select>
      </div>

      <Card>
        <Table>
          <thead>
            <tr>
              <Th>Fecha</Th>
              <Th>Resultado</Th>
              <Th>Usuario</Th>
              <Th>Router</Th>
              <Th>Empresa</Th>
              <Th>Entró desde</Th>
              <Th>Método</Th>
              <Th>Grupo o motivo</Th>
            </tr>
          </thead>
          <tbody>
            {lista?.length === 0 && (
              <tr>
                <Td colSpan={8} className="py-10 text-center text-muted-foreground">
                  No hay autenticaciones que coincidan.
                </Td>
              </tr>
            )}
            {lista?.map((a) => (
              <tr key={a.id}>
                <Td className="whitespace-nowrap text-muted-foreground">{fecha(a.fecha)}</Td>
                <Td>
                  <Badge variant={a.resultado === "aceptado" ? "success" : "destructive"}>
                    {a.resultado === "aceptado" ? "Aceptado" : "Rechazado"}
                  </Badge>
                </Td>
                <Td className="max-w-[14rem] truncate font-medium" title={a.usuario}>
                  {a.usuario || "—"}
                </Td>
                <Td>
                  <div>{a.router || a.nas_identifier || "—"}</div>
                  <div className="font-mono text-xs text-muted-foreground">{a.ip_origen}</div>
                </Td>
                <Td>{a.empresa || "—"}</Td>
                <Td className="font-mono text-xs">{a.origen || "—"}</Td>
                <Td className="whitespace-nowrap">{a.metodo || "—"}</Td>
                <Td className="max-w-[18rem] text-sm">
                  {a.resultado === "aceptado" ? (
                    <span className="font-mono text-xs">{a.grupo || "—"}</span>
                  ) : (
                    <span className="text-muted-foreground">{a.motivo || "Usuario desconocido o sin permiso"}</span>
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
