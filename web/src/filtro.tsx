import * as React from "react";
import { api, type Router } from "@/lib/api";
import { useApp } from "./contexto";

// Filtro global por router y sincronización manual, compartidos por la barra
// superior y las vistas.
interface Filtro {
  routers: Router[];
  // null = todos los routers.
  routerId: number | null;
  setRouterId: (id: number | null) => void;
  recargarRouters: () => Promise<void>;
  // Cambia en cada sincronización manual: las vistas se vuelven a montar y
  // piden sus datos de nuevo.
  marca: number;
  sincronizando: boolean;
  sincronizar: () => Promise<void>;
}

const Ctx = React.createContext<Filtro | null>(null);

export function useFiltro() {
  const c = React.useContext(Ctx);
  if (!c) throw new Error("useFiltro fuera de ProveedorFiltro");
  return c;
}

export function ProveedorFiltro({ children }: { children: React.ReactNode }) {
  const { refrescarEstado } = useApp();
  const [routers, setRouters] = React.useState<Router[]>([]);
  const [routerId, setRouterId] = React.useState<number | null>(null);
  const [marca, setMarca] = React.useState(0);
  const [sincronizando, setSincronizando] = React.useState(false);

  const recargarRouters = React.useCallback(async () => {
    try {
      const lista = await api<Router[]>("GET", "/routers", undefined, { auto: true });
      setRouters(lista);
      // Si el router elegido ya no existe, el filtro vuelve a «todos».
      setRouterId((actual) => (actual !== null && !lista.some((r) => r.id === actual) ? null : actual));
    } catch {
      // El selector se queda con la lista que tenía.
    }
  }, []);

  React.useEffect(() => {
    recargarRouters();
  }, [recargarRouters]);

  const sincronizar = React.useCallback(async () => {
    setSincronizando(true);
    // Un mínimo visible: si no, el icono ni llega a girar.
    const minimo = new Promise((r) => window.setTimeout(r, 600));
    await Promise.all([refrescarEstado(), recargarRouters(), minimo]);
    setMarca((n) => n + 1);
    setSincronizando(false);
  }, [refrescarEstado, recargarRouters]);

  const valor = React.useMemo(
    () => ({ routers, routerId, setRouterId, recargarRouters, marca, sincronizando, sincronizar }),
    [routers, routerId, recargarRouters, marca, sincronizando, sincronizar],
  );
  return <Ctx.Provider value={valor}>{children}</Ctx.Provider>;
}
