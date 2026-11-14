import { LogOut, Moon, Router as IconoRouter, Settings2, ShieldCheck, Sun, Users } from "lucide-react";
import * as React from "react";
import { Navigate, NavLink, Route, Routes } from "react-router-dom";
import { Badge, Button } from "@/components/ui";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useApp } from "./contexto";
import Configuracion from "./pages/Configuracion";
import Login from "./pages/Login";
import Routers from "./pages/Routers";
import Usuarios from "./pages/Usuarios";

const secciones = [
  { ruta: "/routers", texto: "Routers", icono: IconoRouter },
  { ruta: "/usuarios", texto: "Usuarios MikroTik", icono: Users },
  { ruta: "/configuracion", texto: "Configuración", icono: Settings2 },
];

function IndicadorEstado() {
  const { estado } = useApp();
  if (!estado) return <Badge variant="muted">Sin datos</Badge>;
  if (estado.cambios_pendientes) return <Badge variant="warning">Cambios sin aplicar</Badge>;
  if (!estado.sincronizado) return <Badge variant="destructive">FreeRADIUS no sincronizado</Badge>;
  return <Badge variant="success">Aplicado y en marcha</Badge>;
}

function BotonAplicar() {
  const { estado, refrescarEstado, avisar, avisarError, confirmar } = useApp();
  const [ocupado, setOcupado] = React.useState(false);
  if (!estado?.cambios_pendientes) return null;
  const aplicar = async () => {
    const ok = await confirmar(
      "Aplicar la configuración",
      `Se generará la configuración de FreeRADIUS con ${estado.deseado.routers} router(es) y ${estado.deseado.usuarios} usuario(s) activos. FreeRADIUS la valida antes de activarla y se reinicia en un par de segundos.`,
      "Aplicar",
    );
    if (!ok) return;
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
      {ocupado ? "Aplicando…" : "Aplicar cambios"}
    </Button>
  );
}

function Marco({ children }: { children: React.ReactNode }) {
  const { operador, setOperador } = useApp();
  const [oscuro, setOscuro] = React.useState(document.documentElement.classList.contains("dark"));
  const cambiarTema = () => {
    const nuevo = !oscuro;
    document.documentElement.classList.toggle("dark", nuevo);
    localStorage.setItem("rc-tema", nuevo ? "oscuro" : "claro");
    setOscuro(nuevo);
  };
  const salir = async () => {
    try {
      await api("DELETE", "/sesion");
    } finally {
      setOperador(null);
    }
  };
  return (
    <div className="min-h-screen md:flex">
      <aside className="border-b bg-card md:min-h-screen md:w-60 md:shrink-0 md:border-b-0 md:border-r">
        <div className="flex items-center gap-2 px-4 py-4">
          <ShieldCheck className="size-5 text-primary" />
          <span className="font-semibold tracking-tight">RadiusControl</span>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:pb-0">
          {secciones.map(({ ruta, texto, icono: Icono }) => (
            <NavLink
              key={ruta}
              to={ruta}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium",
                  isActive ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )
              }
            >
              <Icono className="size-4" />
              {texto}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="flex flex-wrap items-center justify-end gap-2 border-b bg-card px-4 py-2.5">
          <div className="mr-auto flex flex-wrap items-center gap-2">
            <IndicadorEstado />
            <BotonAplicar />
          </div>
          <span className="text-sm text-muted-foreground">{operador?.usuario}</span>
          <Button variant="ghost" size="icon" onClick={cambiarTema} aria-label="Cambiar tema" title="Cambiar tema">
            {oscuro ? <Sun /> : <Moon />}
          </Button>
          <Button variant="ghost" size="icon" onClick={salir} aria-label="Cerrar sesión" title="Cerrar sesión">
            <LogOut />
          </Button>
        </header>
        <main className="mx-auto max-w-6xl p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}

export default function App() {
  const { operador } = useApp();
  if (!operador) return <Login />;
  return (
    <Marco>
      <Routes>
        <Route path="/routers" element={<Routers />} />
        <Route path="/usuarios" element={<Usuarios />} />
        <Route path="/configuracion" element={<Configuracion />} />
        <Route path="*" element={<Navigate to="/routers" replace />} />
      </Routes>
    </Marco>
  );
}
