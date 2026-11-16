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

export function Table({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn("w-full caption-bottom text-sm [&_tbody_tr:hover]:bg-muted/50 [&_tbody_tr]:transition-colors", className)} {...props} />
    </div>
  );
}
export function Th({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn("h-9 whitespace-nowrap bg-muted/40 px-4 text-left align-middle text-[11px] font-semibold uppercase tracking-wider text-muted-foreground first:rounded-tl-lg last:rounded-tr-lg", className)}
      {...props}
    />
  );
}
export function Td({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
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

export function useOrden<C extends string>(inicial: C) {
  const [orden, setOrden] = React.useState<Orden<C>>({ campo: inicial, asc: true });
  const ordenarPor = React.useCallback((campo: C) => setOrden((o) => ({ campo, asc: o.campo === campo ? !o.asc : true })), []);
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
  className,
  children,
}: {
  campo: C;
  orden: Orden<C>;
  onOrden: (campo: C) => void;
  className?: string;
  children: React.ReactNode;
}) {
  const activo = orden.campo === campo;
  const Icono = !activo ? ChevronsUpDown : orden.asc ? ArrowUp : ArrowDown;
  return (
    <Th className={className} aria-sort={activo ? (orden.asc ? "ascending" : "descending") : "none"}>
      <button
        type="button"
        onClick={() => onOrden(campo)}
        title="Ordenar por esta columna"
        className={cn(
          "-mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 uppercase tracking-wider transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          activo && "text-foreground",
        )}
      >
        {children}
        <Icono className={cn("size-3", !activo && "opacity-50")} aria-hidden="true" />
      </button>
    </Th>
  );
}

export const Dialog = DialogPrimitive.Root;

export function DialogContent({
  className,
  children,
  titulo,
  descripcion,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { titulo: string; descripcion?: string }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60" />
      <DialogPrimitive.Content
        className={cn(
          "fixed left-1/2 top-1/2 z-50 grid max-h-[90vh] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-lg border bg-card p-6 shadow-lg",
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
