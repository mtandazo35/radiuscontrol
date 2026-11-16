import { Plus } from "lucide-react";
import * as React from "react";
import { Badge, Button, Card, Dialog, DialogContent, DialogFooter, Input, Label } from "@/components/ui";
import { api, type AccesoAjeno, type AccesoGestionado, type AccesosServidor, type ServicioAcceso } from "@/lib/api";
import { cn, fecha } from "@/lib/utils";
import { useApp } from "../contexto";

// Formas de escribir «abierto a todo el mundo»: se tratan igual que el botón
// «Abrir a cualquier dirección», con su confirmación.
const TODO_EL_MUNDO = ["cualquiera", "0.0.0.0/0", "::/0"];

function esCualquiera(red: string) {
  return TODO_EL_MUNDO.includes(red.trim().toLowerCase());
}

const nombreServicio: Record<ServicioAcceso, string> = {
  panel: "la web del panel",
  ssh: "el SSH del servidor",
};

const riesgoAbrir: Record<ServicioAcceso, string> = {
  panel:
    "Cualquier dirección de internet podrá llegar a la pantalla de acceso del panel. Quedará protegido solo por las contraseñas, el doble factor y el bloqueo por intentos fallidos.",
  ssh:
    "Cualquier dirección de internet podrá intentar entrar por SSH al servidor. Es el acceso más delicado: hay programas que prueban contraseñas sin parar en todo SSH abierto. Hazlo solo si de verdad lo necesitas y el servidor acepta únicamente claves.",
};

function Red({ red }: { red: string }) {
  if (esCualquiera(red)) {
    return (
      <span className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Cualquier dirección</span>
        <Badge variant="warning">Abierto a todos</Badge>
      </span>
    );
  }
  return <span className="break-all font-mono text-sm">{red}</span>;
}

interface PropsSeccion {
  servicio: ServicioAcceso;
  titulo: string;
  tuIp: string;
  gestionadas: AccesoGestionado[];
  ajenas: AccesoAjeno[];
  ocupado: boolean;
  // Devuelve true si el servidor aceptó el alta.
  onAlta: (servicio: ServicioAcceso, red: string, descripcion: string) => Promise<boolean>;
  onQuitar: (regla: AccesoGestionado) => void;
}

function Seccion({ servicio, titulo, tuIp, gestionadas, ajenas, ocupado, onAlta, onQuitar }: PropsSeccion) {
  const { avisar, confirmar } = useApp();
  const [abierto, setAbierto] = React.useState(false);
  const [red, setRed] = React.useState("");
  const [descripcion, setDescripcion] = React.useState("");

  const abrir = () => {
    setRed("");
    setDescripcion("");
    setAbierto(true);
  };

  const abrirATodos = async () => {
    const ok = await confirmar("Abrir a cualquier dirección", riesgoAbrir[servicio], "Abrir a cualquier dirección", true);
    if (!ok) return;
    if (await onAlta(servicio, "cualquiera", descripcion.trim())) setAbierto(false);
  };

  const enviar = async (e: React.FormEvent) => {
    e.preventDefault();
    const valor = red.trim();
    if (valor === "") {
      avisar({
        titulo: "Falta la dirección",
        mensaje: "Escribe una dirección IP o una red, por ejemplo 192.0.2.10 o 198.51.100.0/24.",
      });
      return;
    }
    if (esCualquiera(valor)) {
      await abrirATodos();
      return;
    }
    if (await onAlta(servicio, valor, descripcion.trim())) setAbierto(false);
  };

  const yaAbierto = gestionadas.some((g) => esCualquiera(g.red));
  const vacio = gestionadas.length === 0 && ajenas.length === 0;
  // Todas las filas comparten la misma rejilla: el texto a la izquierda y la
  // acción a la derecha, con el mismo ancho, para que queden alineadas.
  const fila = "grid min-h-[4.5rem] grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5";

  return (
    <section className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{titulo}</h3>
        <Button size="sm" disabled={ocupado} onClick={abrir}>
          <Plus /> Agregar acceso
        </Button>
      </div>

      {vacio ? (
        <p className="rounded-md border border-warning/50 p-3 text-xs text-warning" role="status">
          No hay ninguna regla: nadie puede llegar a {nombreServicio[servicio]} mientras el firewall esté activo.
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {gestionadas.map((g) => (
            <li key={`g-${g.id}`} className={fila}>
              <div className="min-w-0 space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Red red={g.red} />
                  {g.aplicada ? <Badge variant="success">Aplicada</Badge> : <Badge variant="warning">Aplicando…</Badge>}
                </div>
                <p className="truncate text-xs text-muted-foreground" title={g.descripcion}>
                  {g.descripcion ? `${g.descripcion} · ` : ""}
                  {g.operador || "—"} · {fecha(g.creado)}
                </p>
              </div>
              <Button size="sm" variant="ghost" className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive px-3" disabled={ocupado} onClick={() => onQuitar(g)}>
                Quitar
              </Button>
            </li>
          ))}
          {ajenas.map((a, i) => (
            <li key={`a-${a.red}-${i}`} className={cn(fila, "bg-muted/40")}>
              <div className="min-w-0 space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Red red={a.red} />
                  <Badge variant="muted">Cargada a mano</Badge>
                </div>
                <p className="truncate text-xs text-muted-foreground" title={a.comentario ?? ""}>
                  {a.comentario || "Sin comentario"}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0 text-xs"
                disabled={ocupado}
                title="El panel pasa a gestionar esta regla, sin cortar el acceso."
                onClick={() => void onAlta(servicio, a.red, a.comentario ?? "")}
              >
                Gestionar desde el panel
              </Button>
            </li>
          ))}
        </ul>
      )}

      {ajenas.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Las reglas «Cargada a mano» se pusieron directamente en el servidor: el panel las muestra pero no las quita. Con
          «Gestionar desde el panel» pasan a poder quitarse desde aquí, sin cortar el acceso.
        </p>
      )}

      <Dialog open={abierto} onOpenChange={(a) => !a && setAbierto(false)}>
        <DialogContent titulo={`Agregar acceso a ${nombreServicio[servicio]}`} descripcion="El firewall del servidor lo aplica en unos segundos.">
          <form onSubmit={enviar} noValidate className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor={`acceso-${servicio}-red`}>Dirección o red</Label>
              <div className="flex gap-2">
                <Input
                  id={`acceso-${servicio}-red`}
                  className="font-mono"
                  placeholder="192.0.2.10 o 198.51.100.0/24"
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus
                  maxLength={64}
                  value={red}
                  onChange={(e) => setRed(e.target.value)}
                />
                <Button variant="outline" className="shrink-0" disabled={!tuIp} onClick={() => setRed(tuIp)}>
                  Usar mi dirección
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Una dirección suelta o una red completa, IPv4 o IPv6.{tuIp ? ` Estás conectado desde ${tuIp}.` : ""}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`acceso-${servicio}-descripcion`}>Descripción (opcional)</Label>
              <Input
                id={`acceso-${servicio}-descripcion`}
                placeholder="Oficina, casa del técnico…"
                autoComplete="off"
                maxLength={120}
                value={descripcion}
                onChange={(e) => setDescripcion(e.target.value)}
              />
            </div>
            {!yaAbierto && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/40 p-3">
                <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                  Sin limitar por dirección: cualquiera en internet podrá llegar a {nombreServicio[servicio]}.
                </p>
                <Button size="sm" variant="outline" className="text-destructive" disabled={ocupado} onClick={abrirATodos}>
                  Abrir a cualquier dirección
                </Button>
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setAbierto(false)}>
                Cancelar
              </Button>
              <Button type="submit" disabled={ocupado}>
                {ocupado ? "Guardando…" : "Dar acceso"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}

export function AccesoServidor() {
  const { avisarError, confirmar } = useApp();
  const [datos, setDatos] = React.useState<AccesosServidor | null>(null);
  const [fallo, setFallo] = React.useState(false);
  const [ocupado, setOcupado] = React.useState(false);
  // Descarta la respuesta de una carga que empezó antes de la última petición.
  const serie = React.useRef(0);

  const aplicar = React.useCallback((d: AccesosServidor) => {
    setDatos(d);
    setFallo(false);
  }, []);

  const cargar = React.useCallback(
    async (auto = false) => {
      const n = ++serie.current;
      try {
        const d = await api<AccesosServidor>("GET", "/servidor/accesos", undefined, { auto });
        if (n === serie.current) aplicar(d);
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
  }, [cargar]);

  // El servidor puede mandar las listas vacías como null.
  const gestionadas = datos?.gestionadas ?? [];
  const ajenas = datos?.ajenas ?? [];
  const pendiente = gestionadas.some((g) => !g.aplicada);

  // Mientras el firewall no haya puesto alguna regla se mira cada 3 s. Si UFW
  // está apagado nunca las pondrá, así que no tiene sentido insistir.
  const esperando = pendiente && datos?.firewall?.ufw_activo === true;
  React.useEffect(() => {
    const t = window.setInterval(() => cargar(true), esperando ? 3000 : 60000);
    return () => window.clearInterval(t);
  }, [cargar, esperando]);

  const alta = async (servicio: ServicioAcceso, red: string, descripcion: string): Promise<boolean> => {
    if (ocupado) return false;
    setOcupado(true);
    serie.current++;
    try {
      aplicar(await api<AccesosServidor>("POST", "/servidor/accesos", { servicio, red, descripcion }));
      return true;
    } catch (e) {
      avisarError(e);
      return false;
    } finally {
      setOcupado(false);
    }
  };

  const quitar = async (g: AccesoGestionado) => {
    if (ocupado) return;
    const quien = esCualquiera(g.red) ? "Dejará de estar abierto a cualquier dirección" : `«${g.red}» dejará de tener acceso`;
    const ok = await confirmar(
      "Quitar el acceso",
      `${quien} a ${nombreServicio[g.servicio]} en unos segundos, salvo que otra regla lo permita. Si es la dirección desde la que te conectas, puedes quedarte fuera.`,
      "Quitar",
      true,
    );
    if (!ok) return;
    setOcupado(true);
    serie.current++;
    try {
      aplicar(await api<AccesosServidor>("DELETE", `/servidor/accesos/${g.id}`));
    } catch (e) {
      avisarError(e);
    } finally {
      setOcupado(false);
    }
  };

  const fw = datos?.firewall ?? null;
  const estadoFw = fw?.estado ?? "sin-datos";
  const sinDatos = estadoFw === "sin-datos";
  const ufwApagado = !sinDatos && fw?.ufw_activo !== true;

  let insignia: React.ReactNode = null;
  if (datos) {
    if (sinDatos) insignia = <Badge variant="muted">Sin datos del agente</Badge>;
    else if (ufwApagado) insignia = <Badge variant="destructive">UFW desactivado</Badge>;
    else if (estadoFw === "error") insignia = <Badge variant="destructive">No pudo aplicar alguna regla</Badge>;
    else if (pendiente || estadoFw !== "sincronizado") insignia = <Badge variant="warning">Aplicando…</Badge>;
    else insignia = <Badge variant="success">Al día</Badge>;
  }

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3 p-4">
        <div>
          <h2 className="text-sm font-semibold">Accesos al servidor</h2>
          <p className="text-sm text-muted-foreground">
            Desde qué direcciones se puede llegar a la web del panel y al SSH del servidor. Son reglas del firewall: lo que
            cambies aquí se aplica en unos segundos.
          </p>
        </div>
        {insignia}
      </div>

      {!datos ? (
        <div className="flex flex-wrap items-center gap-3 border-t p-4 text-sm text-muted-foreground">
          {fallo ? "No se pudieron cargar los accesos al servidor." : "Cargando…"}
          {fallo && (
            <Button size="sm" variant="outline" onClick={() => cargar()}>
              Reintentar
            </Button>
          )}
        </div>
      ) : (
        <>
          <div className="space-y-3 border-t p-4">
            {(sinDatos || ufwApagado) && (
              <p className="rounded-md border border-warning/50 p-3 text-xs text-warning" role="status">
                {sinDatos
                  ? "El agente del firewall todavía no ha informado. Las reglas de esta lista no tienen efecto hasta que el firewall (UFW) esté activo y el agente las aplique."
                  : "El firewall (UFW) está desactivado en el servidor. Las reglas de esta lista no tienen efecto hasta que esté activo: ahora mismo no se limita ningún acceso."}
              </p>
            )}
            <p className="rounded-md border bg-muted/40 p-3 text-sm">
              Estás conectado desde <span className="break-all font-mono font-semibold">{datos.tu_ip || "—"}</span>
              <span className="text-muted-foreground"> · No dejes esta dirección fuera de la web del panel.</span>
            </p>
          </div>

          <div className="grid divide-y border-t lg:grid-cols-2 lg:divide-x lg:divide-y-0">
            <Seccion
              servicio="panel"
              titulo="Web del panel (puerto 443)"
              tuIp={datos.tu_ip}
              gestionadas={gestionadas.filter((g) => g.servicio === "panel")}
              ajenas={ajenas.filter((a) => a.servicio === "panel")}
              ocupado={ocupado}
              onAlta={alta}
              onQuitar={quitar}
            />
            <Seccion
              servicio="ssh"
              titulo={`SSH del servidor (puerto ${datos.puerto_ssh})`}
              tuIp={datos.tu_ip}
              gestionadas={gestionadas.filter((g) => g.servicio === "ssh")}
              ajenas={ajenas.filter((a) => a.servicio === "ssh")}
              ocupado={ocupado}
              onAlta={alta}
              onQuitar={quitar}
            />
          </div>
        </>
      )}
    </Card>
  );
}
