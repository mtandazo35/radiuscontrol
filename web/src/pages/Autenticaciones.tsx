import { Pencil } from "lucide-react";
import * as React from "react";
import { Badge, Card, Copiable, EstadoVacio, Input, Paginacion, Select, Table, Td, ThOrden, useOrden } from "@/components/ui";
import { ModalOrigen, type BorradorOrigen } from "@/components/Origenes";
import { BotonVaciar } from "@/components/Vaciar";
import { api, type Autenticacion, type PaginaAutenticaciones } from "@/lib/api";
import { cn, fecha, motivoLegible } from "@/lib/utils";
import { useApp } from "../contexto";
import { useFiltro } from "../filtro";

const filtros = [
  { valor: "", texto: "Todos", punto: "" },
  { valor: "aceptado", texto: "Access-Accept", punto: "bg-success" },
  { valor: "rechazado", texto: "Access-Reject", punto: "bg-destructive" },
  { valor: "sondeo", texto: "Sondeos", punto: "bg-muted-foreground" },
];

type Agrupacion = "" | "router" | "empresa" | "usuario" | "resultado";
const CLAVE_AGRUPAR = "rc-tabla:autenticaciones:agrupar";

// Valor del campo por el que se agrupa y cómo se titula su bloque.
function claveGrupo(a: Autenticacion, agrupar: Agrupacion) {
  return agrupar === "router" ? a.router : agrupar === "empresa" ? a.empresa : agrupar === "usuario" ? a.usuario : a.resultado;
}
const nombreResultado: Record<string, string> = { aceptado: "Access-Accept", rechazado: "Access-Reject", sondeo: "Sondeos sin clave" };
function tituloGrupo(valor: string, agrupar: Agrupacion) {
  if (agrupar === "resultado") return nombreResultado[valor] ?? valor;
  if (valor) return valor;
  return agrupar === "router" ? "Router desconocido" : agrupar === "empresa" ? "Sin empresa" : "Sin usuario";
}

export default function Autenticaciones() {
  const { avisarError, operador } = useApp();
  const admin = operador?.rol === "administrador";
  const [borrador, setBorrador] = React.useState<BorradorOrigen | null>(null);
  const { routerId } = useFiltro();
  const [datos, setDatos] = React.useState<PaginaAutenticaciones | null>(null);
  const [resultado, setResultado] = React.useState("");
  const [buscar, setBuscar] = React.useState("");
  const [pagina, setPagina] = React.useState(1);
  const [tamano, setTamano] = React.useState(25);
  const lista = datos?.autenticaciones;
  // La tabla está paginada: la ordena el servidor. Por omisión, lo más reciente primero.
  type Campo = "fecha" | "resultado" | "usuario" | "router" | "empresa" | "origen" | "metodo" | "detalle";
  const { orden, ordenarPor } = useOrden<Campo>("fecha", "autenticaciones-datos", false);
  const ordenar = (campo: Campo) => {
    ordenarPor(campo);
    setPagina(1);
  };

  // Agrupar: lo ordena el servidor por el grupo, así cada bloque sale entero
  // y seguido. Se recuerda durante la sesión, como el resto de la tabla.
  const [agrupar, setAgrupar] = React.useState<Agrupacion>(() => {
    try {
      const v = sessionStorage.getItem(CLAVE_AGRUPAR);
      return v === "router" || v === "empresa" || v === "usuario" || v === "resultado" ? v : "";
    } catch {
      return "";
    }
  });
  const cambiarAgrupar = (v: Agrupacion) => {
    setAgrupar(v);
    setPagina(1);
    try {
      sessionStorage.setItem(CLAVE_AGRUPAR, v);
    } catch {
      // Sin almacenamiento: vale hasta recargar.
    }
  };
  // Bloques consecutivos de la página a la vista, con el total de cada grupo.
  const bloques = React.useMemo(() => {
    if (!lista || lista.length === 0) return [];
    if (agrupar === "") return [{ clave: "todos", titulo: null as string | null, total: 0, filas: lista }];
    const totales = new Map((datos?.grupos ?? []).map((g) => [g.valor, g.total]));
    const salida: { clave: string; titulo: string | null; total: number; filas: Autenticacion[] }[] = [];
    for (const a of lista) {
      const valor = claveGrupo(a, agrupar);
      const ultimo = salida[salida.length - 1];
      if (ultimo && ultimo.clave === valor) ultimo.filas.push(a);
      else salida.push({ clave: valor, titulo: tituloGrupo(valor, agrupar), total: totales.get(valor) ?? 0, filas: [a] });
    }
    return salida;
  }, [lista, agrupar, datos]);

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
        q.set("orden", orden.campo);
        q.set("dir", orden.asc ? "asc" : "desc");
        if (agrupar) q.set("agrupar", agrupar);
        const r = await api<PaginaAutenticaciones>("GET", `/autenticaciones?${q}`, undefined, { auto: !avisar });
        setDatos(r);
        // El servidor corrige una página que ya no existe.
        if (r.pagina !== pagina) setPagina(r.pagina);
      } catch (e) {
        if (avisar) avisarError(e);
      }
    },
    [resultado, buscar, routerId, pagina, tamano, orden, agrupar, avisarError],
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
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <p className="min-w-0 max-w-4xl flex-1 basis-80 text-sm text-muted-foreground">
          Cada intento de login que FreeRADIUS aceptó o rechazó, en hora de Ecuador. La primera página se actualiza sola. Los paquetes de
          orígenes no autorizados o con secreto incorrecto no aparecen aquí: FreeRADIUS los descarta sin responder.
        </p>
        <BotonVaciar
          registro="autenticaciones"
          onHecho={() => {
            setPagina(1);
            cargar(true);
          }}
        />
      </div>

      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        <Input
          className="col-span-2 w-full sm:max-w-xs"
          placeholder="Buscar usuario, router, empresa o IP"
          aria-label="Buscar"
          value={buscar}
          onChange={(e) => {
            setBuscar(e.target.value);
            setPagina(1);
          }}
        />
        <div className="col-span-2 flex w-full flex-wrap rounded-md border bg-card p-0.5 sm:w-auto" role="group" aria-label="Resultado">
          {filtros.map((f) => (
            <button
              key={f.valor}
              type="button"
              aria-pressed={resultado === f.valor}
              onClick={() => {
                setResultado(f.valor);
                setPagina(1);
              }}
              className={cn(
                "flex items-center gap-1.5 rounded px-3 py-1 font-mono text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                resultado === f.valor ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {f.punto && <span className={cn("size-1.5 rounded-full", resultado === f.valor ? "bg-current" : f.punto)} />}
              {f.texto}
            </button>
          ))}
        </div>
        <Select className="col-span-2 w-full sm:w-auto" aria-label="Agrupar" value={agrupar} onChange={(e) => cambiarAgrupar(e.target.value as Agrupacion)}>
          <option value="">Sin agrupar</option>
          <option value="router">Por router</option>
          <option value="empresa">Por empresa</option>
          <option value="usuario">Por usuario</option>
          <option value="resultado">Por resultado</option>
        </Select>
      </div>

      {/* Visor de registros: fondo de consola, letra monoespaciada y los
          rechazos señalados en rojo para que salten a la vista. */}
      <Card className="overflow-hidden bg-consola">
        <Table id="autenticaciones" ordenLocal={false} className="font-mono text-xs">
          <thead>
            <tr>
              <ThOrden campo="fecha" orden={orden} onOrden={ordenar}>
                Fecha
              </ThOrden>
              <ThOrden campo="resultado" orden={orden} onOrden={ordenar}>
                Resultado
              </ThOrden>
              <ThOrden campo="usuario" orden={orden} onOrden={ordenar}>
                Usuario
              </ThOrden>
              <ThOrden campo="router" orden={orden} onOrden={ordenar}>
                Router
              </ThOrden>
              <ThOrden campo="empresa" orden={orden} onOrden={ordenar}>
                Empresa
              </ThOrden>
              <ThOrden campo="origen" orden={orden} onOrden={ordenar}>
                Entró desde
              </ThOrden>
              <ThOrden campo="metodo" orden={orden} onOrden={ordenar}>
                Método
              </ThOrden>
              <ThOrden campo="detalle" orden={orden} onOrden={ordenar}>
                Grupo o motivo
              </ThOrden>
            </tr>
          </thead>
          {lista?.length === 0 && (
            <tbody>
              <tr>
                <Td colSpan={8} className="font-sans text-sm">
                  <EstadoVacio titulo="No hay autenticaciones que coincidan." />
                </Td>
              </tr>
            </tbody>
          )}
          {bloques.map((b, i) => (
            <tbody key={`${i}-${b.clave}`}>
              {b.titulo !== null && (
                <tr className="hover:!bg-transparent">
                  <Td colSpan={8} className="bg-muted/40 py-2 font-sans">
                    <span className="text-sm font-semibold">{b.titulo}</span>
                    <span className="ml-2 font-mono text-xs text-muted-foreground">
                      {b.total} en total{b.total > b.filas.length ? `, ${b.filas.length} en esta página` : ""}
                    </span>
                  </Td>
                </tr>
              )}
              {b.filas.map((a) => {
              const rechazado = a.resultado === "rechazado";
              const sondeo = a.resultado === "sondeo";
              return (
                <tr key={a.id} className={cn(rechazado && "shadow-[inset_2px_0_0_hsl(var(--destructive))]")}>
                  <Td className="whitespace-nowrap py-2 text-muted-foreground">{fecha(a.fecha)}</Td>
                  <Td className="py-2">
                    {sondeo ? (
                      <Badge variant="muted" title="Petición con la contraseña vacía: el cliente SSH la envía al abrir la conexión, antes del login">
                        Sondeo sin clave
                      </Badge>
                    ) : (
                      <Badge variant={rechazado ? "destructive" : "success"}>{rechazado ? "Access-Reject" : "Access-Accept"}</Badge>
                    )}
                  </Td>
                  <Td className="max-w-[14rem] truncate py-2 font-semibold" title={a.usuario}>
                    {a.usuario || "—"}
                  </Td>
                  <Td className="py-2">
                    <div className="font-sans text-sm">{a.router || a.nas_identifier || "—"}</div>
                    <Copiable texto={a.ip_origen} className="text-muted-foreground" />
                  </Td>
                  <Td className="py-2 font-sans text-sm">{a.empresa || "—"}</Td>
                  <Td className="py-2">
                    <div className="flex items-center gap-1">
                      <Copiable texto={a.origen} />
                      {admin && a.origen && (
                        <button
                          type="button"
                          onClick={() => setBorrador({ red: a.origen, nombre: a.origen_nombre, fija: true })}
                          aria-label={a.origen_nombre ? `Cambiar la descripción de ${a.origen}` : `Poner una descripción a ${a.origen}`}
                          title={a.origen_nombre ? "Cambiar la descripción" : "Poner una descripción a esta dirección"}
                          className="rounded p-0.5 text-muted-foreground opacity-60 transition-opacity hover:text-foreground hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <Pencil className="size-3.5" aria-hidden="true" />
                        </button>
                      )}
                    </div>
                    {a.origen_nombre && <div className="font-sans text-xs text-muted-foreground">{a.origen_nombre}</div>}
                  </Td>
                  <Td className="whitespace-nowrap py-2">{a.metodo || "—"}</Td>
                  <Td className="max-w-[20rem] py-2">
                    {sondeo ? (
                      <span className="font-sans text-muted-foreground">Contraseña vacía al abrir la conexión. No es un intento fallido.</span>
                    ) : rechazado ? (
                      <span className="font-semibold text-destructive" title={a.motivo}>
                        {motivoLegible(a.motivo)}
                      </span>
                    ) : (
                      <span>{a.grupo || "—"}</span>
                    )}
                  </Td>
                </tr>
              );
              })}
            </tbody>
          ))}
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
      <ModalOrigen borrador={borrador} onCerrar={() => setBorrador(null)} onGuardado={() => cargar(true)} />
    </div>
  );
}
