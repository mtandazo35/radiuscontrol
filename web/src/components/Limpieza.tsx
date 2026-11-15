import * as React from "react";
import { Button, Card, Input, Label, Table, Td, Th } from "@/components/ui";
import { api, type AjustesPurga, type Purga, type RegistroPurga } from "@/lib/api";
import { cn, fecha } from "@/lib/utils";
import { useApp } from "../contexto";

// Los campos se editan como texto para que se puedan vaciar mientras se escribe.
type Formulario = Record<keyof AjustesPurga, string>;

interface Campo {
  clave: keyof AjustesPurga;
  antes: string;
  despues: string;
  nombre: string;
  min: number;
  max: number;
  ayuda: string;
}

// Tamaño en la unidad que mejor se lee: los registros suelen ocupar muy poco.
function tamanoLegible(bytes: number) {
  const unidades = ["bytes", "KB", "MB", "GB"];
  let valor = bytes;
  let i = 0;
  while (valor >= 1024 && i < unidades.length - 1) {
    valor /= 1024;
    i++;
  }
  return `${valor.toLocaleString("es-EC", { maximumFractionDigits: i === 0 ? 0 : 1 })} ${unidades[i]}`;
}

const CAMPOS: Campo[] = [
  {
    clave: "dias_autenticaciones",
    antes: "Conservar las autenticaciones durante",
    despues: "días",
    nombre: "Días de conservación de las autenticaciones",
    min: 7,
    max: 3650,
    ayuda: "Los inicios de sesión de los usuarios en los routers más antiguos que esto se borran en cada limpieza.",
  },
  {
    clave: "dias_actividad",
    antes: "Conservar el registro de actividad durante",
    despues: "días",
    nombre: "Días de conservación del registro de actividad",
    min: 30,
    max: 3650,
    ayuda: "Lo que se ha hecho en el panel (accesos, cambios) más antiguo que esto se borra en cada limpieza.",
  },
  {
    clave: "cada_horas",
    antes: "Limpiar cada",
    despues: "horas",
    nombre: "Horas entre limpiezas",
    min: 1,
    max: 720,
    ayuda: "Cada cuánto se hace sola la limpieza programada.",
  },
  {
    clave: "porcentaje_disco",
    antes: "Limpieza de emergencia si el disco supera el",
    despues: "%",
    nombre: "Porcentaje de disco para la limpieza de emergencia",
    min: 20,
    max: 95,
    ayuda:
      "Cuando el disco pasa de ese porcentaje se borran primero los registros más antiguos, acortando la conservación por pasos, sin bajar nunca de 7 días de autenticaciones ni de 30 de actividad.",
  },
];

const nombreMotivo: Record<RegistroPurga["motivo"], string> = {
  programada: "Programada",
  manual: "Manual",
  disco: "Por disco lleno",
};

const formatoNumero = new Intl.NumberFormat("es-EC");
const formatoGB = new Intl.NumberFormat("es-EC", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function numero(n: number) {
  return formatoNumero.format(n);
}

function enGB(bytes: number) {
  return `${formatoGB.format(bytes / 1073741824)} GB`;
}

function aTexto(a: AjustesPurga): Formulario {
  return {
    dias_autenticaciones: String(a.dias_autenticaciones),
    dias_actividad: String(a.dias_actividad),
    cada_horas: String(a.cada_horas),
    porcentaje_disco: String(a.porcentaje_disco),
  };
}

function iguales(a: Formulario, b: Formulario) {
  return CAMPOS.every((c) => a[c.clave].trim() === b[c.clave].trim());
}

function Apartado({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <section className="border-t p-4">
      <h3 className="mb-3 text-sm font-semibold">{titulo}</h3>
      {children}
    </section>
  );
}

export function Limpieza() {
  const { avisar, avisarError, confirmar } = useApp();
  const [datos, setDatos] = React.useState<Purga | null>(null);
  // «base» son los ajustes del servidor sobre los que se empezó a editar.
  const [edicion, setEdicion] = React.useState<{ base: AjustesPurga; valores: Formulario } | null>(null);
  const [fallo, setFallo] = React.useState(false);
  const [guardando, setGuardando] = React.useState(false);
  const [limpiando, setLimpiando] = React.useState(false);
  // Descarta la respuesta de una carga que empezó antes de la última petición.
  const serie = React.useRef(0);

  // forzar: el formulario se rellena con lo recibido aunque tenga cambios sin
  // guardar. Sin forzar (un refresco), lo que la persona está escribiendo se respeta.
  const aplicar = React.useCallback((d: Purga, forzar: boolean) => {
    setDatos(d);
    setFallo(false);
    setEdicion((prev) =>
      forzar || prev === null || iguales(prev.valores, aTexto(prev.base)) ? { base: d.ajustes, valores: aTexto(d.ajustes) } : prev,
    );
  }, []);

  const cargar = React.useCallback(
    async (auto = false) => {
      const n = ++serie.current;
      try {
        const d = await api<Purga>("GET", "/purga", undefined, { auto });
        if (n === serie.current) aplicar(d, false);
      } catch (e) {
        if (!auto) {
          setFallo(true);
          avisarError(e);
        }
      }
    },
    [aplicar, avisarError],
  );

  React.useEffect(() => {
    cargar();
    const t = window.setInterval(() => cargar(true), 60000);
    return () => window.clearInterval(t);
  }, [cargar]);

  const guardados = datos?.ajustes;
  const sucio = datos !== null && edicion !== null && !iguales(edicion.valores, aTexto(datos.ajustes));

  const guardar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!datos || !edicion || !sucio || guardando) return;

    const nuevos: AjustesPurga = { ...datos.ajustes };
    for (const c of CAMPOS) {
      const texto = edicion.valores[c.clave].trim();
      const v = Number(texto);
      if (texto === "" || !Number.isInteger(v) || v < c.min || v > c.max) {
        avisar({ titulo: "Revisa los ajustes", mensaje: `${c.nombre}: escribe un número entero entre ${c.min} y ${c.max}.` });
        return;
      }
      nuevos[c.clave] = v;
    }

    const reducidos: string[] = [];
    if (nuevos.dias_autenticaciones < datos.ajustes.dias_autenticaciones) {
      reducidos.push(`las autenticaciones pasan de ${datos.ajustes.dias_autenticaciones} a ${nuevos.dias_autenticaciones} días`);
    }
    if (nuevos.dias_actividad < datos.ajustes.dias_actividad) {
      reducidos.push(`el registro de actividad pasa de ${datos.ajustes.dias_actividad} a ${nuevos.dias_actividad} días`);
    }
    if (reducidos.length > 0) {
      const ok = await confirmar(
        "Conservar menos tiempo",
        `Vas a acortar la conservación: ${reducidos.join(" y ")}. Los registros más antiguos que el nuevo periodo se borrarán en la siguiente limpieza y no se pueden recuperar.`,
        "Guardar y acortar",
        true,
      );
      if (!ok) return;
    }

    setGuardando(true);
    serie.current++;
    try {
      aplicar(await api<Purga>("PUT", "/purga", nuevos), true);
      avisar({ titulo: "Ajustes guardados", mensaje: "Se aplican desde la siguiente limpieza." });
    } catch (err) {
      avisarError(err);
    } finally {
      setGuardando(false);
    }
  };

  const limpiarAhora = async () => {
    if (!guardados || limpiando) return;
    const ok = await confirmar(
      "Limpiar ahora",
      `Se borrarán las autenticaciones de más de ${guardados.dias_autenticaciones} días y el registro de actividad de más de ${guardados.dias_actividad} días, según los ajustes guardados${sucio ? " (los cambios que tienes sin guardar no cuentan)" : ""}. Lo borrado no se puede recuperar.`,
      "Limpiar ahora",
      true,
    );
    if (!ok) return;
    setLimpiando(true);
    try {
      const r = await api<{ purga: RegistroPurga }>("POST", "/purga/ejecutar", {});
      await cargar();
      avisar({
        titulo: "Limpieza terminada",
        mensaje: `Se borraron ${numero(r.purga.autenticaciones)} autenticaciones y ${numero(r.purga.actividad)} eventos de actividad. Uso del disco: ${r.purga.disco_antes} % antes, ${r.purga.disco_despues} % después.`,
      });
    } catch (e) {
      avisarError(e);
    } finally {
      setLimpiando(false);
    }
  };

  const usado = datos ? Math.min(100, Math.max(0, datos.disco.porcentaje)) : 0;
  const umbral = guardados ? Math.min(100, Math.max(0, guardados.porcentaje_disco)) : 0;
  const enAviso = datos !== null && datos.disco.porcentaje >= umbral;

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3 p-4">
        <div>
          <h2 className="text-sm font-semibold">Limpieza de registros</h2>
          <p className="text-sm text-muted-foreground">
            Las autenticaciones y el registro de actividad antiguos se borran solos cada cierto tiempo, y antes si el disco
            se llena, para que el servidor no se quede sin espacio.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={limpiarAhora} disabled={!datos || limpiando}>
          {limpiando ? "Limpiando…" : "Limpiar ahora"}
        </Button>
      </div>

      {!datos || !edicion ? (
        <div className="flex flex-wrap items-center gap-3 border-t p-4 text-sm text-muted-foreground">
          {fallo ? "No se pudieron cargar los datos de la limpieza." : "Cargando…"}
          {fallo && (
            <Button size="sm" variant="outline" onClick={() => cargar()}>
              Reintentar
            </Button>
          )}
        </div>
      ) : (
        <>
          <Apartado titulo="Uso del disco">
            <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
              <span className={cn("font-medium", enAviso && "text-warning")}>{datos.disco.porcentaje} % usado</span>
              <span className="text-muted-foreground">
                {datos.disco.total_bytes > 0
                  ? `${enGB(datos.disco.libre_bytes)} libres de ${enGB(datos.disco.total_bytes)}`
                  : "Sin datos del tamaño del disco"}
              </span>
            </div>
            <div className="relative mt-2">
              <div
                className="h-3 overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-label="Uso del disco"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={usado}
              >
                <div className={cn("h-full rounded-full transition-all", enAviso ? "bg-warning" : "bg-primary")} style={{ width: `${usado}%` }} />
              </div>
              {/* Marca del umbral de la limpieza de emergencia. */}
              <div className="absolute -bottom-1 -top-1 w-0.5 -translate-x-1/2 bg-foreground" style={{ left: `${umbral}%` }} aria-hidden="true" />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              La marca señala el {umbral} %: a partir de ahí se hace la limpieza de emergencia.
              {enAviso && " El disco ya está en ese nivel o por encima."}
            </p>
            {enAviso && !datos.registros_pesan && (
              <p className="mt-2 rounded-md border border-warning/50 p-3 text-xs text-warning" role="status">
                Los registros solo ocupan {tamanoLegible(datos.registros_bytes)}, así que no son lo que llena el disco y no
                se borra nada: lo ocupa otra cosa del servidor, como imágenes y caché de Docker o respaldos.
              </p>
            )}
          </Apartado>

          <Apartado titulo="Qué hay guardado">
            <dl className="grid gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">Autenticaciones</dt>
                <dd className="mt-0.5 text-sm">
                  {numero(datos.filas.autenticaciones)}
                  <span className="text-muted-foreground">
                    {" "}
                    · {datos.mas_antiguo.autenticaciones ? `desde ${fecha(datos.mas_antiguo.autenticaciones)}` : "sin datos"}
                  </span>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Eventos de actividad</dt>
                <dd className="mt-0.5 text-sm">
                  {numero(datos.filas.actividad)}
                  <span className="text-muted-foreground">
                    {" "}
                    · {datos.mas_antiguo.actividad ? `desde ${fecha(datos.mas_antiguo.actividad)}` : "sin datos"}
                  </span>
                </dd>
              </div>
            </dl>
          </Apartado>

          <Apartado titulo="Ajustes">
            <form onSubmit={guardar} noValidate className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                {CAMPOS.map((c) => (
                  <div key={c.clave} className="space-y-2">
                    <Label htmlFor={`purga-${c.clave}`}>{c.antes}</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        id={`purga-${c.clave}`}
                        type="number"
                        inputMode="numeric"
                        className="w-28"
                        min={c.min}
                        max={c.max}
                        step={1}
                        required
                        aria-describedby={`purga-${c.clave}-ayuda`}
                        value={edicion.valores[c.clave]}
                        onChange={(e) => {
                          const valor = e.target.value;
                          setEdicion((prev) => (prev ? { ...prev, valores: { ...prev.valores, [c.clave]: valor } } : prev));
                        }}
                      />
                      <span className="text-sm text-muted-foreground">{c.despues}</span>
                    </div>
                    <p id={`purga-${c.clave}-ayuda`} className="text-xs text-muted-foreground">
                      {c.ayuda} Entre {c.min} y {c.max}.
                    </p>
                  </div>
                ))}
              </div>
              <div className="flex justify-end">
                <Button type="submit" disabled={!sucio || guardando}>
                  {guardando ? "Guardando…" : "Guardar"}
                </Button>
              </div>
            </form>
          </Apartado>

          <div className="border-t">
            <h3 className="p-4 pb-2 text-sm font-semibold">Últimas limpiezas</h3>
            {datos.ultimas.length === 0 ? (
              <p className="px-4 pb-4 text-sm text-muted-foreground">Todavía no se ha hecho ninguna limpieza.</p>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Fecha</Th>
                    <Th>Motivo</Th>
                    <Th>Quién</Th>
                    <Th className="text-right">Autenticaciones borradas</Th>
                    <Th className="text-right">Eventos borrados</Th>
                    <Th>Disco</Th>
                  </tr>
                </thead>
                <tbody>
                  {datos.ultimas.map((u) => (
                    <tr key={u.id}>
                      <Td className="whitespace-nowrap py-2 text-muted-foreground">{fecha(u.fecha)}</Td>
                      <Td className="whitespace-nowrap py-2">{nombreMotivo[u.motivo] ?? u.motivo}</Td>
                      <Td className="py-2">{u.operador}</Td>
                      <Td className="py-2 text-right">{numero(u.autenticaciones)}</Td>
                      <Td className="py-2 text-right">{numero(u.actividad)}</Td>
                      <Td className="whitespace-nowrap py-2">
                        {u.disco_antes} % → {u.disco_despues} %
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
