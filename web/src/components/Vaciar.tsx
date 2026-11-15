import { Trash2 } from "lucide-react";
import * as React from "react";
import { Button, Dialog, DialogContent, DialogFooter, Input, Label } from "@/components/ui";
import { api, type RegistroPurga } from "@/lib/api";
import { useApp } from "../contexto";

type Registro = "autenticaciones" | "actividad";

const textos: Record<Registro, { boton: string; titulo: string; que: string; aviso: string }> = {
  autenticaciones: {
    boton: "Vaciar autenticaciones",
    titulo: "Vaciar las autenticaciones",
    que: "los intentos de inicio de sesión de los usuarios en los routers",
    aviso: "No afecta a los usuarios, a los routers ni a la configuración: solo borra el historial.",
  },
  actividad: {
    boton: "Vaciar registro de actividad",
    titulo: "Vaciar el registro de actividad",
    que: "lo que se ha hecho en el panel: accesos, intentos fallidos y cambios",
    aviso: "Es el rastro de quién hizo qué. El propio vaciado queda anotado con tu usuario, y eso no se puede borrar desde aquí.",
  },
};

// Borrado expreso de un registro: todo, o lo anterior a unos días. Es distinto
// de la limpieza, que solo quita lo que supera el tiempo de conservación.
export function BotonVaciar({ registro, onHecho }: { registro: Registro; onHecho: () => void }) {
  const { operador, avisar, avisarError } = useApp();
  const [abierto, setAbierto] = React.useState(false);
  const [alcance, setAlcance] = React.useState<"todo" | "antiguos">("todo");
  const [dias, setDias] = React.useState(30);
  const [ocupado, setOcupado] = React.useState(false);
  const t = textos[registro];

  if (operador?.rol !== "administrador") return null;

  const abrir = () => {
    setAlcance("todo");
    setDias(30);
    setAbierto(true);
  };

  const borrar = async (e: React.FormEvent) => {
    e.preventDefault();
    setOcupado(true);
    try {
      const r = await api<{ purga: RegistroPurga }>("POST", "/purga/vaciar", { registro, dias: alcance === "todo" ? 0 : dias });
      const n = registro === "autenticaciones" ? r.purga.autenticaciones : r.purga.actividad;
      setAbierto(false);
      onHecho();
      avisar({
        titulo: n > 0 ? "Registro vaciado" : "No había nada que borrar",
        mensaje:
          n > 0
            ? `Se borraron ${n.toLocaleString("es-EC")} ${registro === "autenticaciones" ? "autenticaciones" : "eventos de actividad"}.`
            : "No había ningún registro en el periodo elegido.",
      });
    } catch (err) {
      avisarError(err);
    } finally {
      setOcupado(false);
    }
  };

  const opcion = "flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm has-[:checked]:border-primary has-[:checked]:bg-accent";

  return (
    <>
      <Button size="sm" variant="outline" onClick={abrir}>
        <Trash2 /> {t.boton}
      </Button>
      <Dialog open={abierto} onOpenChange={(a) => !a && setAbierto(false)}>
        <DialogContent titulo={t.titulo} descripcion={`Vas a borrar ${t.que}. No se puede deshacer.`}>
          <form onSubmit={borrar} className="space-y-4">
            <div className="space-y-2">
              <label className={opcion}>
                <input type="radio" name="alcance" className="mt-0.5 accent-[hsl(var(--primary))]" checked={alcance === "todo"} onChange={() => setAlcance("todo")} />
                <span>
                  <span className="font-medium">Borrar todo</span>
                  <span className="block text-xs text-muted-foreground">El registro queda vacío.</span>
                </span>
              </label>
              <label className={opcion}>
                <input type="radio" name="alcance" className="mt-0.5 accent-[hsl(var(--primary))]" checked={alcance === "antiguos"} onChange={() => setAlcance("antiguos")} />
                <span className="flex-1">
                  <span className="font-medium">Borrar solo lo más antiguo</span>
                  <span className="block text-xs text-muted-foreground">Se conserva lo de los últimos días que indiques.</span>
                </span>
              </label>
              {alcance === "antiguos" && (
                <div className="space-y-2 pl-1">
                  <Label htmlFor="vaciar-dias">Conservar los últimos … días</Label>
                  <Input
                    id="vaciar-dias"
                    type="number"
                    min={1}
                    max={3650}
                    required
                    value={dias}
                    onChange={(e) => setDias(Math.max(1, Math.min(3650, Number(e.target.value) || 1)))}
                  />
                </div>
              )}
            </div>
            <p className="rounded-md border border-warning/50 p-3 text-xs text-warning">{t.aviso}</p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setAbierto(false)}>
                Cancelar
              </Button>
              <Button type="submit" variant="destructive" disabled={ocupado}>
                {ocupado ? "Borrando…" : alcance === "todo" ? "Borrar todo" : "Borrar lo antiguo"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
