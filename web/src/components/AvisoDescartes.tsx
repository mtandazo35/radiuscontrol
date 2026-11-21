import { TriangleAlert } from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";
import { Card } from "@/components/ui";
import { api } from "@/lib/api";
import { fecha } from "@/lib/utils";
import { useFiltro } from "../filtro";

// Aviso de peticiones descartadas: las que FreeRADIUS tira sin responder aunque
// vengan de un router dado de alta. No sale nada si no hay ninguna.

interface GrupoDescartes {
  router_id: number;
  router: string;
  empresa: string;
  motivo: "secreto" | "message_authenticator" | "otro";
  ip: string;
  total: number;
  primero: string;
  ultimo: string;
  detalle: string;
}

const explicacion: Record<GrupoDescartes["motivo"], { que: string; arreglo: string }> = {
  secreto: {
    que: "El secreto RADIUS del router no coincide con el del panel.",
    arreglo:
      "En Routers, Editar, copia el «Secreto RADIUS en uso» y ponlo en el router, o escribe el que tiene el router como «Secreto nuevo».",
  },
  message_authenticator: {
    que: "El router no envía Message-Authenticator y este router lo tiene exigido.",
    arreglo: "Actualiza RouterOS en el router o, como último recurso, desmarca «Exigir Message-Authenticator» en Routers, Editar.",
  },
  otro: {
    que: "FreeRADIUS descartó la petición.",
    arreglo: "Revisa la configuración RADIUS del router; el detalle técnico está debajo.",
  },
};

function hace(iso: string, ahora: string) {
  const s = Math.max(0, Math.round((new Date(ahora).getTime() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "hace un momento";
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  return `hace ${Math.floor(s / 3600)} h`;
}

export function AvisoDescartes() {
  const { routerId } = useFiltro();
  const [datos, setDatos] = React.useState<{ ahora: string; descartes: GrupoDescartes[] } | null>(null);

  React.useEffect(() => {
    let vivo = true;
    const cargar = async () => {
      try {
        const r = await api<{ ahora: string; descartes: GrupoDescartes[] }>(
          "GET",
          `/descartes${routerId !== null ? `?router=${routerId}` : ""}`,
          undefined,
          { auto: true },
        );
        if (vivo) setDatos(r);
      } catch {
        // Sin datos, sin aviso: no es motivo para molestar.
      }
    };
    cargar();
    const t = window.setInterval(cargar, 15000);
    return () => {
      vivo = false;
      window.clearInterval(t);
    };
  }, [routerId]);

  if (!datos || datos.descartes.length === 0) return null;

  return (
    <Card className="border-warning/60 p-4" role="status">
      <div className="flex items-start gap-3">
        <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">Peticiones descartadas</h2>
          <p className="text-sm text-muted-foreground">
            FreeRADIUS las tiró sin responder, aunque vienen de routers dados de alta. Mientras siga así, nadie puede entrar a esos routers por
            RADIUS. Últimas 24 horas.
          </p>
          <ul className="mt-3 divide-y rounded-md border">
            {datos.descartes.map((d) => (
              <li key={`${d.router_id}-${d.motivo}-${d.ip}`} className="space-y-1 p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <p className="text-sm">
                    <span className="font-semibold">{d.router || `Router ${d.router_id}`}</span>
                    {d.empresa && <span className="text-muted-foreground"> ({d.empresa})</span>}
                    <span>: {explicacion[d.motivo].que}</span>
                  </p>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground" title={`Primera: ${fecha(d.primero)}. Última: ${fecha(d.ultimo)}.`}>
                    {d.total} {d.total === 1 ? "petición" : "peticiones"} desde {d.ip}, la última {hace(d.ultimo, datos.ahora)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {explicacion[d.motivo].arreglo}{" "}
                  <Link to="/routers" className="font-medium text-primary hover:underline">
                    Ir a Routers
                  </Link>
                </p>
                {d.motivo === "otro" && d.detalle && <p className="break-all font-mono text-[11px] text-muted-foreground">{d.detalle}</p>}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  );
}
