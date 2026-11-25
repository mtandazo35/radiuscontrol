import { Plus } from "lucide-react";
import * as React from "react";
import { Button, Card, Copiable, Dialog, DialogContent, DialogFooter, EstadoVacio, Input, Label, Table, Td, Th } from "@/components/ui";
import { api, type Origen } from "@/lib/api";
import { fecha } from "@/lib/utils";
import { useApp } from "../contexto";

// Orígenes con nombre: una descripción para la dirección o la red desde la que
// entra un sistema o una persona a los routers. Solo sirve para leer mejor las
// autenticaciones; no cambia quién puede entrar.

export interface BorradorOrigen {
  red: string;
  nombre: string;
  // true cuando la dirección viene dada (desde Autenticaciones) y no se edita.
  fija?: boolean;
}

// Ventana para dar nombre a una dirección o red. Guardar sobre una que ya
// tenía nombre lo cambia.
export function ModalOrigen({ borrador, onCerrar, onGuardado }: { borrador: BorradorOrigen | null; onCerrar: () => void; onGuardado: () => void }) {
  const { avisarError } = useApp();
  const [form, setForm] = React.useState<BorradorOrigen>({ red: "", nombre: "" });
  const [ocupado, setOcupado] = React.useState(false);

  React.useEffect(() => {
    if (borrador) setForm(borrador);
  }, [borrador]);

  const guardar = async (e: React.FormEvent) => {
    e.preventDefault();
    setOcupado(true);
    try {
      await api("POST", "/origenes", { red: form.red, nombre: form.nombre });
      onGuardado();
      onCerrar();
    } catch (err) {
      avisarError(err);
    } finally {
      setOcupado(false);
    }
  };

  return (
    <Dialog open={borrador !== null} onOpenChange={(abierto) => !abierto && onCerrar()}>
      {borrador && (
        <DialogContent tamano="sm" titulo="Nombre de un origen" descripcion="La descripción aparece bajo la dirección en Autenticaciones y en Inicio.">
          <form onSubmit={guardar} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="origen-red">Dirección o red</Label>
              <Input
                id="origen-red"
                className="font-mono"
                required
                autoComplete="off"
                spellCheck={false}
                readOnly={form.fija}
                placeholder="192.0.2.10 o 192.0.2.0/24"
                value={form.red}
                onChange={(e) => setForm({ ...form, red: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">Una dirección suelta o una red entera. Si una dirección cae en varias redes, gana la más pequeña.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="origen-nombre">Descripción</Label>
              <Input
                id="origen-nombre"
                required
                maxLength={60}
                autoFocus
                placeholder="Servidor de respaldos"
                value={form.nombre}
                onChange={(e) => setForm({ ...form, nombre: e.target.value })}
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={onCerrar}>
                Cancelar
              </Button>
              <Button type="submit" disabled={ocupado}>
                {ocupado ? "Guardando…" : "Guardar"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      )}
    </Dialog>
  );
}

// Apartado de Configuración: la lista de orígenes con nombre.
export function Origenes() {
  const { avisarError, confirmar } = useApp();
  const [lista, setLista] = React.useState<Origen[] | null>(null);
  const [borrador, setBorrador] = React.useState<BorradorOrigen | null>(null);

  const cargar = React.useCallback(async () => {
    try {
      setLista(await api<Origen[]>("GET", "/origenes"));
    } catch (e) {
      avisarError(e);
    }
  }, [avisarError]);

  React.useEffect(() => {
    cargar();
  }, [cargar]);

  const quitar = async (o: Origen) => {
    const ok = await confirmar("Quitar el nombre", `«${o.red}» volverá a mostrarse solo con su dirección.`, "Quitar", true);
    if (!ok) return;
    try {
      await api("DELETE", `/origenes/${o.id}`);
      await cargar();
    } catch (e) {
      avisarError(e);
    }
  };

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3 p-4">
        <div>
          <h3 className="text-sm font-semibold">Orígenes con nombre</h3>
          <p className="text-sm text-muted-foreground">
            Ponle una descripción a la dirección o la red de cada sistema que entra a los routers, para reconocerlo en Autenticaciones y en Inicio.
          </p>
        </div>
        <Button size="sm" onClick={() => setBorrador({ red: "", nombre: "" })}>
          <Plus /> Nuevo origen
        </Button>
      </div>
      <Table id="origenes">
        <thead>
          <tr>
            <Th>Dirección o red</Th>
            <Th>Descripción</Th>
            <Th>Puesto por</Th>
            <Th>Fecha</Th>
            <Th sinOrden className="text-center">
              Acciones
            </Th>
          </tr>
        </thead>
        <tbody>
          {lista?.length === 0 && (
            <tr>
              <Td colSpan={5}>
                <EstadoVacio titulo="Todavía no hay ningún origen con nombre." />
              </Td>
            </tr>
          )}
          {lista?.map((o) => (
            <tr key={o.id}>
              <Td className="text-xs">
                <Copiable texto={o.red} />
              </Td>
              <Td className="font-medium">{o.nombre}</Td>
              <Td>{o.operador || "—"}</Td>
              <Td className="whitespace-nowrap text-muted-foreground" valor={o.creado}>
                {fecha(o.creado)}
              </Td>
              <Td>
                <div className="flex items-center justify-center gap-1 whitespace-nowrap">
                  <Button size="sm" variant="outline" onClick={() => setBorrador({ red: o.red, nombre: o.nombre, fija: true })}>
                    Editar
                  </Button>
                  <Button size="sm" variant="ghost" className="text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => quitar(o)}>
                    Quitar
                  </Button>
                </div>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
      <ModalOrigen borrador={borrador} onCerrar={() => setBorrador(null)} onGuardado={cargar} />
    </Card>
  );
}
