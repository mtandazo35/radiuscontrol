import { LayoutDashboard, ListChecks, Lock, Moon, RefreshCw, Router as IconoRouter, Settings2, ShieldCheck, Sun, Users } from "lucide-react";
import * as React from "react";
import { Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { ProveedorActualizacion, useActualizacion, versionCorta } from "@/components/Actualizacion";
import { MenuUsuario } from "@/components/MenuUsuario";
import { Button } from "@/components/ui";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useApp } from "./contexto";
import { ProveedorFiltro, useFiltro } from "./filtro";
import Autenticaciones from "./pages/Autenticaciones";
import Configuracion from "./pages/Configuracion";
import Inicio from "./pages/Inicio";
import Login from "./pages/Login";
import Routers from "./pages/Routers";
import Seguridad from "./pages/Seguridad";
import Usuarios from "./pages/Usuarios";
import { VERSION } from "./version";

// Menú agrupado: lo que se mira a diario, lo que se administra y el propio sistema.
const grupos = [
  {
    titulo: "Operación",
    secciones: [
      { ruta: "/inicio", texto: "Inicio", icono: LayoutDashboard },
      { ruta: "/autenticaciones", texto: "Autenticaciones", icono: ListChecks },
    ],
  },
  {
    titulo: "Gestión AAA",
    secciones: [
      { ruta: "/routers", texto: "Routers", icono: IconoRouter },
      { ruta: "/usuarios", texto: "Usuarios MikroTik", icono: Users },
    ],
  },
  {
    titulo: "Sistema",
    secciones: [
      { ruta: "/seguridad", texto: "Seguridad", icono: Lock },
      { ruta: "/configuracion", texto: "Configuración", icono: Settings2 },
    ],
  },
];

// Estado del motor en una sola lectura: color y texto.
function useResumenEstado(): { tono: "ok" | "aviso" | "fallo" | "nada"; texto: string } {
  const { estado } = useApp();
  if (!estado) return { tono: "nada", texto: "Sin datos" };
  if (estado.cambios_pendientes && estado.ultimo_fallo) return { tono: "fallo", texto: "No se pudo aplicar" };
  if (estado.cambios_pendientes) return { tono: "aviso", texto: "Aplicando cambios…" };
  if (!estado.sincronizado) return { tono: "aviso", texto: "FreeRADIUS cargando…" };
  if (!estado.firewall_al_dia) return { tono: "aviso", texto: "Firewall actualizándose…" };
  return { tono: "ok", texto: "En vivo" };
}

const colorTono = { ok: "bg-success", aviso: "bg-warning", fallo: "bg-destructive", nada: "bg-muted-foreground" };
const textoTono = { ok: "text-success", aviso: "text-warning", fallo: "text-destructive", nada: "text-muted-foreground" };

function Punto({ tono, late }: { tono: keyof typeof colorTono; late?: boolean }) {
  return (
    <span className="relative flex size-2 shrink-0">
      {late && <span className={cn("absolute inline-flex size-full rounded-full opacity-60 motion-safe:animate-ping", colorTono[tono])} />}
      <span className={cn("relative inline-flex size-2 rounded-full", colorTono[tono])} />
    </span>
  );
}

// Indicador de la barra superior: late en verde mientras todo está aplicado.
function IndicadorEstado() {
  const { tono, texto } = useResumenEstado();
  return (
    <span role="status" className={cn("flex items-center gap-2 text-xs font-medium", textoTono[tono])}>
      <Punto tono={tono} late={tono === "ok"} />
      {texto}
    </span>
  );
}

// Los cambios se aplican solos a los pocos segundos de guardarlos. Este botón
// solo aparece si algo quedó sin aplicar, para reintentarlo y ver el motivo.
function BotonAplicar() {
  const { estado, refrescarEstado, avisar, avisarError } = useApp();
  const [ocupado, setOcupado] = React.useState(false);
  const [desde, setDesde] = React.useState<number | null>(null);
  const pendiente = estado?.cambios_pendientes ?? false;

  React.useEffect(() => {
    setDesde(pendiente ? Date.now() : null);
  }, [pendiente]);

  const [, refrescar] = React.useState(0);
  React.useEffect(() => {
    if (!pendiente) return;
    const t = window.setInterval(() => refrescar((n) => n + 1), 2000);
    return () => window.clearInterval(t);
  }, [pendiente]);

  // Se le da margen a la aplicación automática antes de ofrecer el botón.
  const atascado = pendiente && (Boolean(estado?.ultimo_fallo) || (desde !== null && Date.now() - desde > 15000));
  if (!atascado) return null;

  const aplicar = async () => {
    setOcupado(true);
    try {
      const r = await api<{ version: number }>("POST", "/aplicar");
      await refrescarEstado();
      avisar({ titulo: "Configuración aplicada", mensaje: `Versión ${r.version} activada. FreeRADIUS la carga en unos segundos.` });
    } catch (e) {
      avisarError(e);
    } finally {
      setOcupado(false);
    }
  };
  return (
    <Button size="sm" onClick={aplicar} disabled={ocupado}>
      {ocupado ? "Aplicando…" : "Reintentar aplicar"}
    </Button>
  );
}

// Estado del servicio, al fondo del menú: FreeRADIUS, su puerto y el firewall.
function EstadoServicio() {
  const { estado } = useApp();
  const fr = !estado?.freeradius ? "nada" : estado.sincronizado ? "ok" : "aviso";
  const fw = !estado?.firewall ? "nada" : !estado.firewall.ufw_activo ? "fallo" : estado.firewall_al_dia ? "ok" : "aviso";
  const redes = estado?.firewall?.redes.length ?? 0;
  const fila = "flex items-center justify-between gap-2";
  return (
    <div className="mx-3 hidden rounded-md border bg-background p-3 text-xs md:block">
      <div className={fila}>
        <span className="flex items-center gap-2 font-medium">
          <Punto tono={fr} />
          FreeRADIUS
        </span>
        <span className={textoTono[fr]}>{fr === "ok" ? "En marcha" : fr === "aviso" ? "Cargando" : "Sin datos"}</span>
      </div>
      <div className={cn(fila, "mt-2 text-muted-foreground")}>
        <span>Autenticación</span>
        <span className="font-mono">UDP :1812</span>
      </div>
      <div className={cn(fila, "mt-2 border-t pt-2")}>
        <span className="flex items-center gap-2 font-medium">
          <Punto tono={fw} />
          Firewall
        </span>
        <span className="text-muted-foreground">
          {fw === "nada" ? "Sin datos" : fw === "fallo" ? "UFW inactivo" : <span className="font-mono">{redes} {redes === 1 ? "red" : "redes"}</span>}
        </span>
      </div>
    </div>
  );
}

// Pie del menú lateral, al fondo y para todos los roles. El identificador de
// la versión instalada solo lo conocen los administradores: va como ayuda
// emergente de la línea de versión.
function PieMenu() {
  const act = useActualizacion();
  const instalado = act.datos?.busqueda?.instalado;
  return (
    <div className="hidden space-y-0.5 px-4 py-3 text-xs text-muted-foreground md:block">
      <p title={instalado ? `Instalada: ${versionCorta(instalado)}` : undefined}>Versión {VERSION}</p>
      <p>Desarrollado por MAAT</p>
    </div>
  );
}

function SelectorRouter() {
  const { routers, routerId, setRouterId, recargarRouters } = useFiltro();
  return (
    <select
      aria-label="Filtrar por router"
      title="Filtra Inicio, Routers y Autenticaciones"
      className="h-9 max-w-[11rem] rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:max-w-[16rem]"
      value={routerId ?? ""}
      onFocus={recargarRouters}
      onChange={(e) => setRouterId(e.target.value ? Number(e.target.value) : null)}
    >
      <option value="">Todos los routers</option>
      {routers.map((r) => (
        <option key={r.id} value={r.id}>
          {r.empresa ? `${r.nombre} (${r.empresa})` : r.nombre}
        </option>
      ))}
    </select>
  );
}

function Marco({ children }: { children: React.ReactNode }) {
  const [oscuro, setOscuro] = React.useState(document.documentElement.classList.contains("dark"));
  const { marca, sincronizando, sincronizar } = useFiltro();
  const { pathname } = useLocation();
  const titulo = grupos.flatMap((g) => g.secciones).find((s) => pathname.startsWith(s.ruta))?.texto ?? "RadiusControl";
  const cambiarTema = () => {
    const nuevo = !oscuro;
    document.documentElement.classList.toggle("dark", nuevo);
    localStorage.setItem("rc-tema", nuevo ? "oscuro" : "claro");
    setOscuro(nuevo);
  };
  return (
    <div className="min-h-screen md:flex">
      {/* En escritorio el menú queda fijo a la altura de la ventana, con el
          estado del servicio y el pie al fondo. */}
      <aside className="border-b bg-card md:sticky md:top-0 md:flex md:h-screen md:w-[240px] md:shrink-0 md:flex-col md:self-start md:overflow-y-auto md:border-b-0 md:border-r">
        <div className="flex items-center gap-2.5 px-4 md:h-[56px] md:border-b max-md:py-3">
          <ShieldCheck className="size-5 shrink-0 text-primary" aria-hidden="true" />
          <div className="leading-tight">
            <p className="font-semibold tracking-tight">RadiusControl</p>
            <p className="text-[11px] text-muted-foreground">FreeRADIUS • AAA</p>
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:gap-0 md:overflow-visible md:px-3 md:py-3">
          {grupos.map((g) => (
            <div key={g.titulo} className="flex gap-1 md:mb-4 md:flex-col md:gap-0.5">
              <p className="hidden px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground md:block">{g.titulo}</p>
              {g.secciones.map(({ ruta, texto, icono: Icono }) => (
                <NavLink
                  key={ruta}
                  to={ruta}
                  className={({ isActive }) =>
                    cn(
                      "flex items-center gap-2.5 whitespace-nowrap rounded-md px-2.5 py-2 text-sm font-medium transition-colors",
                      isActive ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )
                  }
                >
                  <Icono className="size-4 shrink-0" aria-hidden="true" />
                  {texto}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="mt-auto">
          <EstadoServicio />
          <PieMenu />
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-20 flex min-h-[56px] flex-wrap items-center gap-x-3 gap-y-2 border-b bg-card px-4 py-2 md:px-6">
          <h1 className="text-base font-semibold tracking-tight">{titulo}</h1>
          <IndicadorEstado />
          <BotonAplicar />
          <div className="ml-auto flex items-center gap-2">
            <SelectorRouter />
            <Button variant="outline" size="icon" onClick={sincronizar} disabled={sincronizando} aria-label="Sincronizar ahora" title="Sincronizar ahora">
              <RefreshCw className={cn(sincronizando && "motion-safe:animate-spin")} />
            </Button>
            <Button variant="ghost" size="icon" onClick={cambiarTema} aria-label="Cambiar tema" title="Cambiar tema">
              {oscuro ? <Sun /> : <Moon />}
            </Button>
            <MenuUsuario />
          </div>
        </header>
        {/* El contenido usa todo el ancho disponible: las tablas con varias
            acciones no caben en una columna estrecha. El tope solo evita que
            las líneas se hagan ilegibles en pantallas muy anchas. */}
        <main key={marca} className="mx-auto w-full max-w-[1800px] p-4 md:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}

export default function App() {
  const { operador } = useApp();
  if (!operador) return <Login />;
  return (
    <ProveedorActualizacion>
      <ProveedorFiltro>
      <Marco>
        <Routes>
          <Route path="/inicio" element={<Inicio />} />
          <Route path="/routers" element={<Routers />} />
          <Route path="/usuarios" element={<Usuarios />} />
          <Route path="/autenticaciones" element={<Autenticaciones />} />
          <Route path="/configuracion" element={<Configuracion />} />
          <Route path="/seguridad" element={<Seguridad />} />
          <Route path="*" element={<Navigate to="/inicio" replace />} />
        </Routes>
      </Marco>
      </ProveedorFiltro>
    </ProveedorActualizacion>
  );
}
