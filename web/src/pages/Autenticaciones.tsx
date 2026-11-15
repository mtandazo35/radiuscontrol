import * as React from "react";
import { Badge, Card, Input, Paginacion, Table, Td, Th } from "@/components/ui";
import { BotonVaciar } from "@/components/Vaciar";
import { api, type PaginaAutenticaciones } from "@/lib/api";
import { fecha, motivoLegible } from "@/lib/utils";
import { useApp } from "../contexto";
import { useFiltro } from "../filtro";

export default function Autenticaciones() {
  const { avisarError } = useApp();
  const { routerId } = useFiltro();
  const [datos, setDatos] = React.useState<PaginaAutenticaciones | null>(null);
  const [resultado, setResultado] = React.useState("");
  const [buscar, setBuscar] = React.useState("");
  const [pagina, setPagina] = React.useState(1);
  const [tamano, setTamano] = React.useState(25);
  const lista = datos?.autenticaciones;

  // Al cambiar de router se vuelve a la primera página.
  React.useEffect(() => {
    setPagina(1);
  }, [routerId]);

  const cargar = React.useCallback(
    async (avisar: boolean) => {
      try {
        const q = new URLSearchParams({ pagina: String(pagina), tamano: String(tamano) });
        if (resultado) q.set("resultado", resultado);
        if (buscar.trim()) q.set("buscar", buscar.trim());
        if (routerId !== null) q.set("router", String(routerId));
        const r = await api<PaginaAutenticaciones>("GET", `/autenticaciones?${q}`, undefined, { auto: !avisar });
        setDatos(r);
        // El servidor corrige una página que ya no existe.
        if (r.pagina !== pagina) setPagina(r.pagina);
      } catch (e) {
        if (avisar) avisarError(e);
      }
    },
    [resultado, buscar, routerId, pagina, tamano, avisarError],
  );

  React.useEffect(() => {
    const espera = window.setTimeout(() => cargar(true), 250);
    // Solo la primera página se refresca sola: en las demás, las filas se
    // moverían bajo el cursor mientras se leen.
    const t = pagina === 1 ? window.setInterval(() => cargar(false), 5000) : undefined;
    return () => {
      window.clearTimeout(espera);
      if (t !== undefined) window.clearInterval(t);
    };
  }, [cargar, pagina]);

  return (
    <div className="space-y-4">
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <BotonVaciar
            registro="autenticaciones"
            onHecho={() => {
              setPagina(1);
              cargar(true);
            }}
          />
        </div>
        <p className="text-sm text-muted-foreground">
          Cada intento de login que FreeRADIUS aceptó o rechazó, en hora de Ecuador. La primera página se actualiza sola. Los paquetes de
          orígenes no autorizados o con secreto incorrecto no aparecen aquí: FreeRADIUS los descarta sin responder.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Input
          className="max-w-xs"
          placeholder="Buscar usuario, router, empresa o IP"
          aria-label="Buscar"
          value={buscar}
          onChange={(e) => {
            setBuscar(e.target.value);
            setPagina(1);
          }}
        />
        <select
          aria-label="Resultado"
          className="h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={resultado}
          onChange={(e) => {
            setResultado(e.target.value);
            setPagina(1);
          }}
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
                    <span className="text-muted-foreground" title={a.motivo}>
                      {motivoLegible(a.motivo)}
                    </span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
        <Paginacion
          pagina={datos?.pagina ?? 1}
          paginas={datos?.paginas ?? 1}
          total={datos?.total ?? 0}
          tamano={tamano}
          onPagina={setPagina}
          onTamano={(t) => {
            setTamano(t);
            setPagina(1);
          }}
        />
      </Card>
    </div>
  );
}
