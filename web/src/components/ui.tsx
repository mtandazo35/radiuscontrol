// Componentes base al estilo de shadcn/ui (Radix + Tailwind + variantes).
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cva, type VariantProps } from "class-variance-authority";
import { ArrowDown, ArrowUp, Check, ChevronsUpDown, Copy, Inbox, X } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline: "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = "button", ...props }, ref) => (
    <button ref={ref} type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  ),
);
Button.displayName = "Button";

const campo =
  "flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => <input ref={ref} className={cn(campo, "h-9", className)} {...props} />,
);
Input.displayName = "Input";

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn(campo, "min-h-[84px] font-mono", className)} {...props} />
));
Textarea.displayName = "Textarea";

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("text-sm font-medium leading-none", className)} {...props} />;
}

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-lg border bg-card text-card-foreground shadow-sm dark:shadow-none", className)} {...props} />;
}

// Píldora translúcida con un punto del color del estado.
const badgeVariants = cva(
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold before:size-1.5 before:shrink-0 before:rounded-full before:bg-current before:content-['']",
  {
  variants: {
    variant: {
      default: "border-primary/20 bg-primary/10 text-primary",
      success: "border-success/20 bg-success/10 text-success",
      warning: "border-warning/30 bg-warning/15 text-warning font-semibold",
      destructive: "border-destructive/20 bg-destructive/10 text-destructive",
      muted: "border-border/80 bg-muted/80 text-foreground/80 font-medium",
    },
  },
  defaultVariants: { variant: "default" },
  },
);

export function Badge({
  className,
  variant,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

// ---------------------------------------------------------------- tablas
//
// Una tabla con `id` deja arrastrar sus columnas para cambiarlas de sitio y
// ordenar las filas pulsando un encabezado. Las dos cosas se recuerdan mientras
// dure la sesión del navegador (sessionStorage) y se olvidan al salir del panel.

const PREFIJO_TABLA = "rc-tabla:";

function leerSesion<T>(clave: string): T | null {
  try {
    const v = sessionStorage.getItem(PREFIJO_TABLA + clave);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}

function guardarSesion(clave: string, valor: unknown) {
  try {
    if (valor === null) sessionStorage.removeItem(PREFIJO_TABLA + clave);
    else sessionStorage.setItem(PREFIJO_TABLA + clave, JSON.stringify(valor));
  } catch {
    // Sin almacenamiento disponible: el orden vale solo hasta recargar.
  }
}

// Al cerrar la sesión del panel se olvida cómo quedó cada tabla.
export function olvidarTablas() {
  try {
    for (const k of Object.keys(sessionStorage)) {
      if (k.startsWith(PREFIJO_TABLA)) sessionStorage.removeItem(k);
    }
  } catch {
    // Nada que olvidar.
  }
}

function esPermutacion(o: unknown, n: number): o is number[] {
  return Array.isArray(o) && o.length === n && [...o].sort((a, b) => a - b).every((v, k) => v === k);
}

type Elemento = React.ReactElement<{ children?: React.ReactNode; className?: string; valor?: Valor; texto?: unknown; sinOrden?: boolean; title?: string }>;
type Valor = string | number | boolean | null | undefined;

const esElemento = (n: React.ReactNode): n is Elemento => React.isValidElement(n);
const esFila = (n: React.ReactNode): n is Elemento => esElemento(n) && n.type === "tr";

// Texto de una celda, para ordenar cuando no trae un valor explícito.
function textoDe(nodo: React.ReactNode): string {
  if (nodo === null || nodo === undefined || typeof nodo === "boolean") return "";
  if (typeof nodo === "string" || typeof nodo === "number") return String(nodo);
  if (Array.isArray(nodo)) return nodo.map(textoDe).join(" ");
  if (esElemento(nodo)) return typeof nodo.props.texto === "string" ? nodo.props.texto : textoDe(nodo.props.children);
  return "";
}

function valorDe(celda: React.ReactNode): string | number {
  if (!esElemento(celda)) return "";
  const v = celda.props.valor;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") return v;
  return textoDe(celda.props.children).trim();
}

function compararValores(a: string | number, b: string | number) {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return comparar(String(a), String(b));
}

// Control de ordenación de un encabezado. Es un <span> con papel de botón y no
// un <button> para que arrastrar el encabezado funcione en todos los navegadores.
function BotonOrden({ activo, asc, onPulsar, children }: { activo: boolean; asc: boolean; onPulsar: () => void; children: React.ReactNode }) {
  const Icono = !activo ? ChevronsUpDown : asc ? ArrowUp : ArrowDown;
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={onPulsar}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onPulsar();
        }
      }}
      title="Pulsa para ordenar; arrastra para mover la columna (o Alt + flechas)"
      className={cn(
        "-mx-1 inline-flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 uppercase tracking-wider transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        activo && "text-foreground",
      )}
    >
      {children}
      <Icono className={cn("size-3", !activo && "opacity-50")} aria-hidden="true" />
    </span>
  );
}

interface PropsTabla extends React.TableHTMLAttributes<HTMLTableElement> {
  // Nombre de la tabla: activa mover columnas, ordenar y recordarlo en la sesión.
  id?: string;
  // false cuando las filas las ordena el servidor (tablas paginadas).
  ordenLocal?: boolean;
}

export function Table({ id, ordenLocal = true, className, children, ...props }: PropsTabla) {
  const [columnas, setColumnas] = React.useState<number[] | null>(() => (id ? leerSesion<number[]>(`${id}:columnas`) : null));
  const [orden, setOrden] = React.useState<{ col: number; asc: boolean } | null>(() =>
    id && ordenLocal ? leerSesion<{ col: number; asc: boolean }>(`${id}:orden`) : null,
  );
  // Posiciones visibles de la columna que se arrastra y de la que está debajo.
  const [arrastrada, setArrastrada] = React.useState<number | null>(null);
  const [sobre, setSobre] = React.useState<number | null>(null);

  let contenido: React.ReactNode = children;
  let movidas = false;

  if (id) {
    const partes = React.Children.toArray(children);
    const cabeza = partes.find((x) => esElemento(x) && x.type === "thead") as Elemento | undefined;
    const filaCabeza = cabeza ? React.Children.toArray(cabeza.props.children).find(esFila) : undefined;
    const n = filaCabeza ? React.Children.toArray(filaCabeza.props.children).length : 0;
    const vista = esPermutacion(columnas, n) ? columnas : Array.from({ length: n }, (_, k) => k);
    movidas = vista.some((v, k) => v !== k);

    const mover = (de: number, a: number) => {
      if (de === a || a < 0 || a >= n) return;
      const nueva = [...vista];
      const [quitada] = nueva.splice(de, 1);
      nueva.splice(a, 0, quitada);
      setColumnas(nueva);
      guardarSesion(`${id}:columnas`, nueva);
    };
    const soltar = () => {
      setArrastrada(null);
      setSobre(null);
    };
    const ordenarPor = (col: number) => {
      // Ascendente, descendente y, a la tercera, como venía.
      const nuevo = orden?.col !== col ? { col, asc: true } : orden.asc ? { col, asc: false } : null;
      setOrden(nuevo);
      guardarSesion(`${id}:orden`, nuevo);
    };

    const encabezado = (celda: React.ReactNode, original: number, pos: number) => {
      if (!esElemento(celda)) return celda;
      const ordenable = ordenLocal && celda.type === Th && !celda.props.sinOrden;
      const activo = orden?.col === original;
      const extra = {
        draggable: true,
        onDragStart: (e: React.DragEvent) => {
          setArrastrada(pos);
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", String(pos));
        },
        onDragOver: (e: React.DragEvent) => {
          if (arrastrada === null) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          if (sobre !== pos) setSobre(pos);
        },
        onDrop: (e: React.DragEvent) => {
          e.preventDefault();
          if (arrastrada !== null) mover(arrastrada, pos);
          soltar();
        },
        onDragEnd: soltar,
        onKeyDown: (e: React.KeyboardEvent) => {
          if (!e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
          e.preventDefault();
          mover(pos, pos + (e.key === "ArrowLeft" ? -1 : 1));
        },
        title: celda.props.title ?? "Arrastra para mover la columna",
        className: cn(
          celda.props.className,
          "cursor-grab select-none active:cursor-grabbing",
          arrastrada === pos && "opacity-50",
          sobre === pos && arrastrada !== null && arrastrada !== pos && "bg-primary/15 shadow-[inset_2px_0_0_hsl(var(--primary))]",
        ),
        ...(ordenable ? { "aria-sort": activo ? (orden.asc ? "ascending" : "descending") : "none" } : {}),
      };
      return React.cloneElement(
        celda as React.ReactElement<Record<string, unknown>>,
        extra,
        ordenable ? (
          <BotonOrden activo={activo} asc={activo ? orden.asc : true} onPulsar={() => ordenarPor(original)}>
            {celda.props.children}
          </BotonOrden>
        ) : (
          celda.props.children
        ),
      );
    };

    contenido = partes.map((parte) => {
      if (!esElemento(parte)) return parte;
      if (parte.type === "thead") {
        const filas = React.Children.toArray(parte.props.children).map((fila) => {
          if (!esFila(fila)) return fila;
          const celdas = React.Children.toArray(fila.props.children);
          if (celdas.length !== n) return fila;
          return React.cloneElement(fila, undefined, vista.map((original, pos) => encabezado(celdas[original], original, pos)));
        });
        return React.cloneElement(parte, undefined, filas);
      }
      if (parte.type === "tbody") {
        const otras: React.ReactNode[] = [];
        const datos: { fila: Elemento; celdas: React.ReactNode[] }[] = [];
        for (const fila of React.Children.toArray(parte.props.children)) {
          const celdas = esFila(fila) ? React.Children.toArray(fila.props.children) : [];
          if (esFila(fila) && celdas.length === n) datos.push({ fila, celdas });
          else otras.push(fila);
        }
        if (orden && orden.col < n) {
          const sentido = orden.asc ? 1 : -1;
          datos.sort((x, y) => compararValores(valorDe(x.celdas[orden.col]), valorDe(y.celdas[orden.col])) * sentido);
        }
        return React.cloneElement(parte, undefined, [
          ...otras,
          ...datos.map(({ fila, celdas }) => React.cloneElement(fila, undefined, vista.map((original) => celdas[original]))),
        ]);
      }
      return parte;
    });
  }

  const restablecer = () => {
    if (!id) return;
    setColumnas(null);
    setOrden(null);
    guardarSesion(`${id}:columnas`, null);
    guardarSesion(`${id}:orden`, null);
  };

  return (
    <>
      <div className="w-full overflow-x-auto">
        <table className={cn("w-full caption-bottom text-sm [&_tbody_tr:hover]:bg-muted/50 [&_tbody_tr]:transition-colors", className)} {...props}>
          {contenido}
        </table>
      </div>
      {id && (movidas || orden !== null) && (
        <div className="flex justify-end border-t px-4 py-1.5">
          <button
            type="button"
            onClick={restablecer}
            className="rounded font-sans text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Restablecer columnas y orden
          </button>
        </div>
      )}
    </>
  );
}

// sinOrden: la columna no se puede ordenar (por ejemplo, la de acciones).
export function Th({ className, sinOrden: _sinOrden, ...props }: React.ThHTMLAttributes<HTMLTableCellElement> & { sinOrden?: boolean }) {
  return (
    <th
      className={cn("h-9 whitespace-nowrap bg-muted/40 px-4 text-left align-middle text-[11px] font-semibold uppercase tracking-wider text-muted-foreground first:rounded-tl-lg last:rounded-tr-lg", className)}
      {...props}
    />
  );
}

// valor: por lo que se ordena la celda cuando su texto no sirve (una fecha
// escrita «21/11/26» se ordena por su fecha real, un número por su número).
export function Td({ className, valor: _valor, ...props }: React.TdHTMLAttributes<HTMLTableCellElement> & { valor?: Valor }) {
  return <td className={cn("border-t px-4 py-2.5 align-middle", className)} {...props} />;
}

// Dato técnico (IP, red) con un botón para copiarlo que aparece al pasar el
// ratón o al llegar con el teclado; en pantallas táctiles está siempre.
export function Copiable({ texto, className }: { texto: string | null | undefined; className?: string }) {
  const [hecho, setHecho] = React.useState(false);
  if (!texto) return <span className={className}>—</span>;
  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(texto);
      setHecho(true);
      window.setTimeout(() => setHecho(false), 1500);
    } catch {
      // Sin permiso para el portapapeles: el texto sigue ahí para seleccionarlo.
    }
  };
  return (
    <span className={cn("group/copia inline-flex items-center gap-1 font-mono", className)}>
      <span className="break-all">{texto}</span>
      <button
        type="button"
        onClick={copiar}
        aria-label={hecho ? "Copiado" : `Copiar ${texto}`}
        title={hecho ? "Copiado" : "Copiar"}
        className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/copia:opacity-100 [@media(hover:none)]:opacity-100"
      >
        {hecho ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
      </button>
    </span>
  );
}

// Lo que se ve en una tabla sin filas: icono, motivo y, si hace falta, qué hacer.
export function EstadoVacio({
  titulo,
  descripcion,
  icono: Icono = Inbox,
}: {
  titulo: string;
  descripcion?: string;
  icono?: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-10 text-center">
      <div className="mb-3 flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground" aria-hidden="true">
        <Icono className="size-5" />
      </div>
      <p className="text-sm font-medium text-foreground">{titulo}</p>
      {descripcion && <p className="mt-1 max-w-sm text-xs text-muted-foreground">{descripcion}</p>}
    </div>
  );
}

export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "h-9 rounded-md border border-input bg-background px-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      {...props}
    />
  );
}

// Orden de una tabla: qué columna y en qué sentido. Pulsar la misma columna
// invierte el sentido; pulsar otra empieza en ascendente.
export interface Orden<C extends string> {
  campo: C;
  asc: boolean;
}

// clave: nombre con el que el orden se recuerda durante la sesión.
export function useOrden<C extends string>(inicial: C, clave?: string, ascendente = true) {
  const [orden, setOrden] = React.useState<Orden<C>>(() => (clave ? leerSesion<Orden<C>>(`${clave}:orden`) : null) ?? { campo: inicial, asc: ascendente });
  const ordenarPor = React.useCallback(
    (campo: C) =>
      setOrden((o) => {
        const nuevo = { campo, asc: o.campo === campo ? !o.asc : true };
        if (clave) guardarSesion(`${clave}:orden`, nuevo);
        return nuevo;
      }),
    [clave],
  );
  return { orden, ordenarPor };
}

// Compara textos como se leen en español (sin distinguir mayúsculas ni tildes
// y con los números en su orden natural).
const comparador = new Intl.Collator("es", { sensitivity: "base", numeric: true });
export function comparar(a: string | number | boolean, b: string | number | boolean) {
  if (typeof a === "string" && typeof b === "string") return comparador.compare(a, b);
  return Number(a) - Number(b);
}

export function ThOrden<C extends string>({
  campo,
  orden,
  onOrden,
  children,
  ...resto
}: {
  campo: C;
  orden: Orden<C>;
  onOrden: (campo: C) => void;
  children: React.ReactNode;
} & Omit<React.ThHTMLAttributes<HTMLTableCellElement>, "children">) {
  const activo = orden.campo === campo;
  return (
    <Th {...resto} aria-sort={activo ? (orden.asc ? "ascending" : "descending") : "none"}>
      <BotonOrden activo={activo} asc={orden.asc} onPulsar={() => onOrden(campo)}>
        {children}
      </BotonOrden>
    </Th>
  );
}

export const Dialog = DialogPrimitive.Root;

// Ancho de una ventana según lo que lleva: «sm» avisos, confirmaciones y formularios de uno o dos campos;
// «md» (por defecto) formularios normales; «lg» formularios a dos columnas.
const anchoDialogo = {
  sm: "max-w-[24rem]",
  md: "max-w-[28rem]",
  lg: "max-w-[36rem]",
} as const;

export function DialogContent({
  className,
  children,
  titulo,
  descripcion,
  tamano = "md",
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { titulo: string; descripcion?: string; tamano?: keyof typeof anchoDialogo }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60" />
      <DialogPrimitive.Content
        className={cn(
          "fixed left-1/2 top-1/2 z-50 grid max-h-[90vh] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 gap-3 overflow-y-auto rounded-lg border bg-card p-5 shadow-lg",
          anchoDialogo[tamano],
          className,
        )}
        {...props}
      >
        <div className="space-y-1.5 pr-6">
          <DialogPrimitive.Title className="text-lg font-semibold leading-tight">{titulo}</DialogPrimitive.Title>
          {descripcion ? (
            <DialogPrimitive.Description className="text-sm text-muted-foreground">
              {descripcion}
            </DialogPrimitive.Description>
          ) : (
            <DialogPrimitive.Description className="sr-only">{titulo}</DialogPrimitive.Description>
          )}
        </div>
        {children}
        <DialogPrimitive.Close
          className="absolute right-4 top-4 rounded-sm opacity-70 hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring"
          aria-label="Cerrar"
        >
          <X className="size-4" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props} />;
}

export function Paginacion({
  pagina,
  paginas,
  total,
  tamano,
  onPagina,
  onTamano,
}: {
  pagina: number;
  paginas: number;
  total: number;
  tamano: number;
  onPagina: (p: number) => void;
  onTamano: (t: number) => void;
}) {
  const desde = total > 0 ? (pagina - 1) * tamano + 1 : 0;
  const hasta = Math.min(pagina * tamano, total);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-sm">
      <span className="text-muted-foreground" aria-live="polite">
        {total > 0 ? `${desde}–${hasta} de ${total}` : "Sin resultados"}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-muted-foreground">
          Por página
          <select
            className="h-9 w-20 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={tamano}
            onChange={(e) => onTamano(Number(e.target.value))}
          >
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>
        </label>
        <Button size="sm" variant="outline" disabled={pagina <= 1} onClick={() => onPagina(1)}>
          Primera
        </Button>
        <Button size="sm" variant="outline" disabled={pagina <= 1} onClick={() => onPagina(pagina - 1)}>
          Anterior
        </Button>
        <span className="whitespace-nowrap px-1">
          Página {pagina} de {paginas}
        </span>
        <Button size="sm" variant="outline" disabled={pagina >= paginas} onClick={() => onPagina(pagina + 1)}>
          Siguiente
        </Button>
        <Button size="sm" variant="outline" disabled={pagina >= paginas} onClick={() => onPagina(paginas)}>
          Última
        </Button>
      </div>
    </div>
  );
}
