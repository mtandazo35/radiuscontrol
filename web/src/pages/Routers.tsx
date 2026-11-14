import { Plus } from "lucide-react";
import * as React from "react";
import { Badge, Button, Card, Dialog, DialogContent, DialogFooter, Input, Label, Table, Td, Textarea, Th } from "@/components/ui";
import { api, type RespuestaRouter, type Router } from "@/lib/api";
import { fecha } from "@/lib/utils";
import { useApp } from "../contexto";

interface Formulario {
  id: number | null;
  nombre: string;
  descripcion: string;
  redes: string;
  secreto: string;
  exigir: boolean;
  activo: boolean;
}

const vacio: Formulario = { id: null, nombre: "", descripcion: "", redes: "", secreto: "", exigir: true, activo: true };

export default function Routers() {
  const { avisar, avisarError, confirmar, refrescarEstado } = useApp();
  const [lista, setLista] = React.useState<Router[] | null>(null);
  const [form, setForm] = React.useState<Formulario | null>(null);
  const [ocupado, setOcupado] = React.useState(false);

  const cargar = React.useCallback(async () => {
    try {
      setLista(await api<Router[]>("GET", "/routers"));
    } catch (e) {
      avisarError(e);
    }
  }, [avisarError]);

  React.useEffect(() => {
    cargar();
  }, [cargar]);

  const tras = async () => {
    await cargar();
    await refrescarEstado();
  };

  const mostrarSecreto = (r: RespuestaRouter, titulo: string) => {
    if (!r.secreto_generado) return;
    avisar({
      titulo,
      mensaje:
        "Este secreto se muestra una sola vez. Pega estas líneas en el terminal del router y recuerda aplicar los cambios en el panel.",
      copiable: r.script_rsc,
    });
  };

  const guardar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setOcupado(true);
    const cuerpo = {
      nombre: form.nombre,
      descripcion: form.descripcion,
      redes: form.redes.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean),
      activo: form.activo,
      exigir_message_authenticator: form.exigir,
      ...(form.id === null && form.secreto ? { secreto: form.secreto } : {}),
    };
    try {
      const r =
        form.id === null
          ? await api<RespuestaRouter>("POST", "/routers", cuerpo)
          : await api<RespuestaRouter>("PUT", `/routers/${form.id}`, cuerpo);
      setForm(null);
      await tras();
      mostrarSecreto(r, `Router «${r.router.nombre}» creado`);
    } catch (err) {
      avisarError(err);
    } finally {
      setOcupado(false);
    }
  };

  const alternar = async (r: Router) => {
    try {
      await api("PUT", `/routers/${r.id}`, {
        nombre: r.nombre,
        descripcion: r.descripcion,
        redes: r.redes,
        activo: !r.activo,
        exigir_message_authenticator: r.exigir_message_authenticator,
      });
      await tras();
    } catch (e) {
      avisarError(e);
    }
  };

  const rotar = async (r: Router) => {
    const ok = await confirmar(
      "Rotar el secreto",
      `Se generará un secreto nuevo para «${r.nombre}». Al aplicar los cambios el secreto anterior dejará de servir, así que el router debe actualizarse a la vez.`,
      "Rotar secreto",
    );
    if (!ok) return;
    try {
      const resp = await api<RespuestaRouter>("POST", `/routers/${r.id}/secreto`, {});
      await tras();
      mostrarSecreto(resp, `Secreto nuevo de «${r.nombre}»`);
    } catch (e) {
      avisarError(e);
    }
  };

  const borrar = async (r: Router) => {
    const ok = await confirmar("Eliminar el router", `«${r.nombre}» dejará de autenticar cuando apliques los cambios.`, "Eliminar", true);
    if (!ok) return;
    try {
      await api("DELETE", `/routers/${r.id}`);
      await tras();
    } catch (e) {
      avisarError(e);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Routers</h1>
          <p className="text-sm text-muted-foreground">
            Cada router se identifica por la dirección de origen de sus paquetes y tiene su propio secreto.
          </p>
        </div>
        <Button onClick={() => setForm(vacio)}>
          <Plus /> Nuevo router
        </Button>
      </div>

      <Card>
        <Table>
          <thead>
            <tr>
              <Th>Nombre</Th>
              <Th>Redes de origen</Th>
              <Th>Estado</Th>
              <Th>Secreto rotado</Th>
              <Th className="text-right">Acciones</Th>
            </tr>
          </thead>
          <tbody>
            {lista?.length === 0 && (
              <tr>
                <Td colSpan={5} className="py-10 text-center text-muted-foreground">
                  Todavía no hay routers. Crea el primero con «Nuevo router».
                </Td>
              </tr>
            )}
            {lista?.map((r) => (
              <tr key={r.id}>
                <Td>
                  <div className="font-medium">{r.nombre}</div>
                  {r.descripcion && <div className="text-xs text-muted-foreground">{r.descripcion}</div>}
                </Td>
                <Td className="font-mono text-xs">
                  {r.redes.map((red) => (
                    <div key={red}>{red}</div>
                  ))}
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    <Badge variant={r.activo ? "success" : "muted"}>{r.activo ? "Activo" : "Suspendido"}</Badge>
                    {!r.exigir_message_authenticator && <Badge variant="warning">Sin Message-Authenticator</Badge>}
                  </div>
                </Td>
                <Td className="whitespace-nowrap text-muted-foreground">{fecha(r.secreto_rotado)}</Td>
                <Td>
                  <div className="flex flex-wrap justify-end gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setForm({
                          id: r.id,
                          nombre: r.nombre,
                          descripcion: r.descripcion,
                          redes: r.redes.join("\n"),
                          secreto: "",
                          exigir: r.exigir_message_authenticator,
                          activo: r.activo,
                        })
                      }
                    >
                      Editar
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => rotar(r)}>
                      Rotar secreto
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => alternar(r)}>
                      {r.activo ? "Suspender" : "Activar"}
                    </Button>
                    <Button size="sm" variant="ghost" className="text-destructive" onClick={() => borrar(r)}>
                      Eliminar
                    </Button>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>

      <Dialog open={form !== null} onOpenChange={(abierto) => !abierto && setForm(null)}>
        {form && (
          <DialogContent titulo={form.id === null ? "Nuevo router" : "Editar router"}>
            <form onSubmit={guardar} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="nombre">Nombre</Label>
                <Input id="nombre" required maxLength={63} value={form.nombre} onChange={(e) => setForm({ ...form, nombre: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="descripcion">Descripción</Label>
                <Input id="descripcion" maxLength={200} value={form.descripcion} onChange={(e) => setForm({ ...form, descripcion: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="redes">Direcciones o redes de origen</Label>
                <Textarea
                  id="redes"
                  required
                  placeholder={"192.0.2.10\n198.51.100.8/29\n2001:db8::1"}
                  value={form.redes}
                  onChange={(e) => setForm({ ...form, redes: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">Una por línea, IPv4 o IPv6. No pueden coincidir con las de otro router.</p>
              </div>
              {form.id === null && (
                <div className="space-y-2">
                  <Label htmlFor="secreto">Secreto RADIUS</Label>
                  <Input
                    id="secreto"
                    type="password"
                    autoComplete="new-password"
                    placeholder="Vacío: se genera uno aleatorio"
                    value={form.secreto}
                    onChange={(e) => setForm({ ...form, secreto: e.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">Escríbelo solo si el router ya tiene uno que quieras conservar.</p>
                </div>
              )}
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-0.5 size-4 accent-[hsl(var(--primary))]" checked={form.exigir} onChange={(e) => setForm({ ...form, exigir: e.target.checked })} />
                <span>
                  Exigir Message-Authenticator
                  <span className="block text-xs text-muted-foreground">
                    Desmárcalo solo para routers con una versión de RouterOS que no lo envía.
                  </span>
                </span>
              </label>
              <DialogFooter>
                <Button variant="outline" onClick={() => setForm(null)}>
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
    </div>
  );
}
