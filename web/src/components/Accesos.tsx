// Accesos por router: quién puede entrar a cada uno y con qué permiso.
// Aquí viven el bloque «Quién puede entrar» del formulario de un router y la
// ventana de cambios masivos.
import * as React from "react";
import { Badge, Button, Dialog, DialogContent, DialogFooter, Input } from "@/components/ui";
import {
  api,
  type AccesoRouter,
  type CambioMasivoAccesos,
  type Empresa,
  type ModoAcceso,
  type ResultadoCambioMasivo,
  type Router,
  type Usuario,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { useApp } from "../contexto";

const gruposBase = ["full", "write", "read"];

const selector =
  "flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const casilla = "mt-0.5 size-4 shrink-0 accent-[hsl(var(--primary))]";

// Un permiso elegido en pantalla. «otro» indica que el grupo se escribe a mano
// porque no es uno de los que trae RouterOS de fábrica.
export interface Permiso {
  grupo: string;
  otro: boolean;
}

// Permisos por router, indexados por el id del usuario MikroTik.
export type Permisos = Record<number, Permiso>;

export function permisoDe(grupo: string): Permiso {
  return { grupo, otro: !gruposBase.includes(grupo) };
}

export function permisosDe(accesos: AccesoRouter[] | undefined): Permisos {
  const p: Permisos = {};
  for (const a of accesos ?? []) p[a.usuario_id] = permisoDe(a.grupo);
  return p;
}

// La lista que espera la API: solo los usuarios marcados.
export function accesosDe(permisos: Permisos): { usuario_id: number; grupo: string }[] {
  return Object.entries(permisos).map(([id, p]) => ({ usuario_id: Number(id), grupo: p.grupo.trim() }));
}

export function SelectorGrupo({
  valor,
  onCambio,
  etiqueta,
  className,
}: {
  valor: Permiso;
  onCambio: (p: Permiso) => void;
  etiqueta: string;
  className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      <select
        aria-label={etiqueta}
        className={selector}
        value={valor.otro ? "__otro" : valor.grupo}
        onChange={(e) => {
          const otro = e.target.value === "__otro";
          onCambio({ grupo: otro ? "" : e.target.value, otro });
        }}
      >
        <option value="full">full: control total</option>
        <option value="write">write: puede cambiar la configuración</option>
        <option value="read">read: solo lectura</option>
        <option value="__otro">Otro grupo…</option>
      </select>
      {valor.otro && (
        <Input
          aria-label={`${etiqueta}: nombre del grupo`}
          required
          maxLength={32}
          placeholder="Nombre exacto del grupo en el router"
          value={valor.grupo}
          onChange={(e) => onCambio({ grupo: e.target.value, otro: true })}
        />
      )}
    </div>
  );
}

function Opcion({
  nombre,
  marcado,
  onMarcar,
  tarjeta = false,
  children,
}: {
  nombre: string;
  marcado: boolean;
  onMarcar: () => void;
  tarjeta?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label
      className={cn(
        "flex items-start gap-2 text-sm",
        tarjeta &&
          cn(
            "w-full cursor-pointer gap-2.5 rounded-md border p-3 text-xs transition-colors",
            marcado
              ? "border-primary/50 bg-primary/10 text-foreground"
              : "border-border bg-card text-muted-foreground hover:bg-muted/40",
          ),
      )}
    >
      <input type="radio" name={nombre} className={casilla} checked={marcado} onChange={onMarcar} />
      <span>{children}</span>
    </label>
  );
}

function Grupo({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <fieldset className="min-w-0 space-y-3 rounded-lg border bg-muted/30 p-4">
      <legend className="px-1 text-sm font-medium">{titulo}</legend>
      {children}
    </fieldset>
  );
}

function Advertencia({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs text-warning" role="status">
      {children}
    </p>
  );
}

// Bloque «Quién puede entrar» del formulario de alta y edición de un router.
export function BloqueAccesos({
  modo,
  onModo,
  usuarios,
  permisos,
  onPermisos,
}: {
  modo: ModoAcceso;
  onModo: (m: ModoAcceso) => void;
  usuarios: Usuario[] | null;
  permisos: Permisos;
  onPermisos: (p: Permisos) => void;
}) {
  const marcar = (u: Usuario, incluido: boolean) => {
    const copia: Permisos = { ...permisos };
    if (incluido) copia[u.id] = permisoDe(u.grupo);
    else delete copia[u.id];
    onPermisos(copia);
  };
  const marcados = Object.keys(permisos).length;

  return (
    <Grupo titulo="Quién puede entrar">
      <div className="grid gap-2 sm:grid-cols-2">
        <Opcion tarjeta nombre="modo-acceso" marcado={modo === "general"} onMarcar={() => onModo("general")}>
          Manejo general: entran todos los usuarios activos, cada uno con su grupo
        </Opcion>
        <Opcion tarjeta nombre="modo-acceso" marcado={modo === "restringido"} onMarcar={() => onModo("restringido")}>
          Restringido: solo los usuarios que elijas, con el permiso que les des aquí
        </Opcion>
      </div>

      {modo === "restringido" && (
        <>
          {usuarios === null && <p className="text-sm text-muted-foreground">No se pudo cargar la lista de usuarios.</p>}
          {usuarios?.length === 0 && (
            <p className="text-sm text-muted-foreground">Todavía no hay usuarios MikroTik. Créalos en «Usuarios MikroTik».</p>
          )}
          {usuarios && usuarios.length > 0 && (
            <ul className="max-h-72 divide-y overflow-y-auto rounded-md border">
              {usuarios.map((u) => {
                const p: Permiso | undefined = permisos[u.id];
                return (
                  <li key={u.id} className="flex flex-wrap items-start gap-x-3 gap-y-2 px-3 py-2">
                    <label className="flex min-w-0 flex-1 basis-48 items-start gap-2 text-sm">
                      <input type="checkbox" className={casilla} checked={p !== undefined} onChange={(e) => marcar(u, e.target.checked)} />
                      <span className="min-w-0">
                        <span className="font-medium">{u.usuario}</span>
                        {!u.activo && (
                          <Badge variant="muted" className="ml-2">
                            Suspendido
                          </Badge>
                        )}
                        <span className="block text-xs text-muted-foreground">
                          {u.nombre_completo ? `${u.nombre_completo} · ` : ""}grupo general: <span className="font-mono">{u.grupo}</span>
                        </span>
                      </span>
                    </label>
                    {p !== undefined && (
                      <SelectorGrupo
                        className="w-full sm:w-64"
                        etiqueta={`Permiso de ${u.usuario} en este router`}
                        valor={p}
                        onCambio={(nuevo) => onPermisos({ ...permisos, [u.id]: nuevo })}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {marcados === 0 ? (
            <Advertencia>No hay ningún usuario marcado: nadie podrá entrar a este router por RADIUS.</Advertencia>
          ) : (
            <p className="text-xs text-muted-foreground">
              {marcados} usuario(s) con acceso. Un usuario suspendido no entra aunque esté marcado. Un grupo propio debe existir en el router.
            </p>
          )}
        </>
      )}
    </Grupo>
  );
}

interface Elemento {
  id: number;
  texto: string;
  detalle?: string;
}

function ListaCasillas({
  elementos,
  marcados,
  onCambio,
  vacio,
}: {
  elementos: Elemento[];
  marcados: number[];
  onCambio: (ids: number[]) => void;
  vacio: string;
}) {
  if (elementos.length === 0) return <p className="text-sm text-muted-foreground">{vacio}</p>;
  return (
    <div className="space-y-1">
      <div className="flex gap-1">
        <Button size="sm" variant="ghost" onClick={() => onCambio(elementos.map((x) => x.id))}>
          Marcar todos
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onCambio([])}>
          Ninguno
        </Button>
      </div>
      <ul className="max-h-48 divide-y overflow-y-auto rounded-md border">
        {elementos.map((x) => (
          <li key={x.id}>
            <label className="flex items-start gap-2 px-3 py-2 text-sm">
              <input
                type="checkbox"
                className={casilla}
                checked={marcados.includes(x.id)}
                onChange={(e) => onCambio(e.target.checked ? [...marcados, x.id] : marcados.filter((id) => id !== x.id))}
              />
              <span className="min-w-0">
                <span className="font-medium">{x.texto}</span>
                {x.detalle && <span className="block text-xs text-muted-foreground">{x.detalle}</span>}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

type Criterio = "todos" | "empresa" | "ids";
type Accion = CambioMasivoAccesos["accion"];

interface PropsMasivo {
  routers: Router[];
  empresas: Empresa[];
  usuarios: Usuario[] | null;
  onCerrar: () => void;
  // Se llama tras aplicar el cambio, para recargar la lista de routers.
  onHecho: () => Promise<void>;
}

function cuantos(n: number, uno: string, varios: string) {
  return n === 1 ? `1 ${uno}` : `${n} ${varios}`;
}

function FormularioMasivo({ routers, empresas, usuarios, onCerrar, onHecho }: PropsMasivo) {
  const { avisar, avisarError, confirmar } = useApp();
  const [criterio, setCriterio] = React.useState<Criterio>("todos");
  const [empresa, setEmpresa] = React.useState("");
  const [ids, setIds] = React.useState<number[]>([]);
  const [accion, setAccion] = React.useState<Accion>("asignar");
  const [elegidos, setElegidos] = React.useState<number[]>([]);
  const [permiso, setPermiso] = React.useState<Permiso>({ grupo: "read", otro: false });
  const [modo, setModo] = React.useState<ModoAcceso>("restringido");
  const [restringir, setRestringir] = React.useState(false);
  const [ocupado, setOcupado] = React.useState(false);

  const conEmpresa = empresas.filter((e) => e.nombre !== "");
  const listaUsuarios = usuarios ?? [];

  // Cuántos routers alcanza el criterio elegido, según la lista ya cargada.
  const alcance =
    criterio === "todos" ? routers.length : criterio === "empresa" ? routers.filter((r) => r.empresa === empresa).length : ids.length;

  const faltaRouters =
    criterio === "empresa" && empresa === ""
      ? "Elige una empresa."
      : criterio === "ids" && ids.length === 0
        ? "Marca al menos un router."
        : alcance === 0
          ? "No hay ningún router que cumpla esa condición."
          : "";
  const faltaUsuarios = accion !== "modo" && elegidos.length === 0 ? "Marca al menos un usuario." : "";
  const faltaGrupo = accion === "asignar" && permiso.grupo.trim() === "" ? "Escribe el nombre del grupo." : "";
  const incompleto = faltaRouters !== "" || faltaUsuarios !== "" || faltaGrupo !== "";

  const resumen = () => {
    const cuales =
      criterio === "todos"
        ? `todos los routers (${alcance})`
        : criterio === "empresa"
          ? `${cuantos(alcance, "router", "routers")} de la empresa «${empresa}»`
          : `${cuantos(alcance, "router elegido", "routers elegidos")}`;
    const nombres = listaUsuarios.filter((u) => elegidos.includes(u.id)).map((u) => u.usuario);
    const quienes = nombres.length <= 6 ? nombres.join(", ") : `${nombres.length} usuarios`;
    const ademas = restringir ? " Además, esos routers quedarán en modo restringido: solo entrarán los usuarios que tengan asignados." : "";
    if (accion === "asignar") {
      return `Se dará acceso a ${quienes} con el permiso «${permiso.grupo.trim()}» en ${cuales}.${ademas}${
        restringir ? "" : " Solo tendrá efecto en los routers que estén en modo restringido."
      }`;
    }
    if (accion === "quitar") {
      return `Se quitará el acceso de ${quienes} en ${cuales}.${ademas}${
        restringir ? "" : " En los routers en modo general seguirán entrando con su grupo general."
      }`;
    }
    return modo === "general"
      ? `Se pasará a manejo general ${cuales}: entrarán todos los usuarios activos, cada uno con su grupo general.`
      : `Se pasará a modo restringido ${cuales}: solo entrarán los usuarios asignados a cada router. En un router sin usuarios asignados no podrá entrar nadie por RADIUS.`;
  };

  const enviar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (incompleto || ocupado) return;
    const peligro = accion === "quitar" || restringir || (accion === "modo" && modo === "restringido");
    const ok = await confirmar("Confirmar el cambio masivo", `${resumen()} El cambio se aplica solo en unos segundos.`, "Aplicar el cambio", peligro);
    if (!ok) return;
    const cuerpo: CambioMasivoAccesos = {
      routers: {
        todos: criterio === "todos",
        empresa: criterio === "empresa" ? empresa : "",
        ids: criterio === "ids" ? ids : [],
      },
      usuarios: accion === "modo" ? [] : elegidos,
      accion,
      grupo: accion === "asignar" ? permiso.grupo.trim() : "",
      modo: accion === "modo" ? modo : restringir ? "restringido" : "",
    };
    setOcupado(true);
    try {
      const r = await api<ResultadoCambioMasivo>("POST", "/accesos/masivo", cuerpo);
      onCerrar();
      await onHecho();
      avisar({
        titulo: "Cambio masivo aplicado",
        mensaje:
          accion === "modo"
            ? `Routers cambiados: ${r.routers}.`
            : `Routers afectados: ${r.routers}. Asignaciones ${accion === "asignar" ? "guardadas" : "quitadas"}: ${r.asignaciones}.`,
      });
    } catch (err) {
      avisarError(err);
    } finally {
      setOcupado(false);
    }
  };

  const selectorUsuarios = (
    <>
      <ListaCasillas
        elementos={listaUsuarios.map((u) => ({
          id: u.id,
          texto: u.usuario,
          detalle: `${u.nombre_completo ? `${u.nombre_completo} · ` : ""}grupo general: ${u.grupo}${u.activo ? "" : " · suspendido"}`,
        }))}
        marcados={elegidos}
        onCambio={setElegidos}
        vacio={usuarios === null ? "No se pudo cargar la lista de usuarios." : "Todavía no hay usuarios MikroTik."}
      />
      {faltaUsuarios && <Advertencia>{faltaUsuarios}</Advertencia>}
    </>
  );

  return (
    <form onSubmit={enviar} className="space-y-4">
      <Grupo titulo="1. Qué routers">
        <div className="space-y-2">
          <Opcion nombre="masivo-routers" marcado={criterio === "todos"} onMarcar={() => setCriterio("todos")}>
            Todos los routers
          </Opcion>
          <Opcion nombre="masivo-routers" marcado={criterio === "empresa"} onMarcar={() => setCriterio("empresa")}>
            Los de una empresa
          </Opcion>
          <Opcion nombre="masivo-routers" marcado={criterio === "ids"} onMarcar={() => setCriterio("ids")}>
            Los que elija
          </Opcion>
        </div>
        {criterio === "empresa" && (
          <select aria-label="Empresa" className={selector} value={empresa} onChange={(e) => setEmpresa(e.target.value)}>
            <option value="">Elige una empresa…</option>
            {conEmpresa.map((e) => (
              <option key={e.nombre} value={e.nombre}>
                {e.nombre} ({e.routers})
              </option>
            ))}
          </select>
        )}
        {criterio === "ids" && (
          <ListaCasillas
            elementos={routers.map((r) => ({ id: r.id, texto: r.nombre, detalle: r.empresa || "Sin empresa" }))}
            marcados={ids}
            onCambio={setIds}
            vacio="Todavía no hay routers."
          />
        )}
        {faltaRouters ? (
          <Advertencia>{faltaRouters}</Advertencia>
        ) : (
          <p className="text-xs text-muted-foreground">El cambio alcanza a {cuantos(alcance, "router", "routers")}.</p>
        )}
      </Grupo>

      <Grupo titulo="2. Qué hacer">
        <div className="space-y-2">
          <Opcion nombre="masivo-accion" marcado={accion === "asignar"} onMarcar={() => setAccion("asignar")}>
            Dar acceso a usuarios
          </Opcion>
          <Opcion nombre="masivo-accion" marcado={accion === "quitar"} onMarcar={() => setAccion("quitar")}>
            Quitar acceso a usuarios
          </Opcion>
          <Opcion nombre="masivo-accion" marcado={accion === "modo"} onMarcar={() => setAccion("modo")}>
            Cambiar el modo de acceso
          </Opcion>
        </div>

        {accion === "asignar" && (
          <>
            {selectorUsuarios}
            <div className="space-y-2">
              <p className="text-sm font-medium">Permiso en esos routers</p>
              <SelectorGrupo etiqueta="Permiso en esos routers" valor={permiso} onCambio={setPermiso} />
              {faltaGrupo && <Advertencia>{faltaGrupo}</Advertencia>}
            </div>
          </>
        )}
        {accion === "quitar" && selectorUsuarios}
        {accion === "modo" && (
          <div className="space-y-2 rounded-md border p-3">
            <Opcion nombre="masivo-modo" marcado={modo === "general"} onMarcar={() => setModo("general")}>
              Manejo general: entran todos los usuarios activos, cada uno con su grupo
            </Opcion>
            <Opcion nombre="masivo-modo" marcado={modo === "restringido"} onMarcar={() => setModo("restringido")}>
              Restringido: solo los usuarios asignados a cada router
            </Opcion>
            {modo === "restringido" && (
              <Advertencia>En un router restringido sin usuarios asignados no podrá entrar nadie por RADIUS.</Advertencia>
            )}
          </div>
        )}
      </Grupo>

      {accion !== "modo" && (
        <Grupo titulo="3. Modo de esos routers">
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className={casilla} checked={restringir} onChange={(e) => setRestringir(e.target.checked)} />
            <span>
              Dejar además esos routers en modo restringido
              <span className="block text-xs text-muted-foreground">
                Una asignación solo tiene efecto en los routers restringidos; en los de manejo general entran todos los usuarios activos.
              </span>
            </span>
          </label>
        </Grupo>
      )}

      <DialogFooter>
        <Button variant="outline" onClick={onCerrar}>
          Cancelar
        </Button>
        <Button type="submit" disabled={incompleto || ocupado}>
          {ocupado ? "Aplicando…" : "Revisar y aplicar"}
        </Button>
      </DialogFooter>
    </form>
  );
}

// Ventana de cambios masivos. El formulario se monta al abrirla, así empieza
// siempre en blanco.
export function CambiosMasivos({ abierto, ...props }: PropsMasivo & { abierto: boolean }) {
  return (
    <Dialog open={abierto} onOpenChange={(a) => !a && props.onCerrar()}>
      {abierto && (
        <DialogContent
          className="max-w-2xl"
          titulo="Cambios masivos de acceso"
          descripcion="Cambia de una vez quién entra a varios routers. Antes de aplicar se muestra un resumen para confirmar."
        >
          <FormularioMasivo {...props} />
        </DialogContent>
      )}
    </Dialog>
  );
}
