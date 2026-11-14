import { Plus } from "lucide-react";
import * as React from "react";
import { Badge, Button, Card, Dialog, DialogContent, DialogFooter, Input, Label, Table, Td, Th } from "@/components/ui";
import { api, type RespuestaUsuario, type Usuario } from "@/lib/api";
import { fecha } from "@/lib/utils";
import { useApp } from "../contexto";

interface Formulario {
  id: number | null;
  usuario: string;
  nombre: string;
  grupo: string;
  clave: string;
  activo: boolean;
}

const vacio: Formulario = { id: null, usuario: "", nombre: "", grupo: "full", clave: "", activo: true };

export default function Usuarios() {
  const { avisar, avisarError, confirmar, refrescarEstado } = useApp();
  const [lista, setLista] = React.useState<Usuario[] | null>(null);
  const [form, setForm] = React.useState<Formulario | null>(null);
  const [ocupado, setOcupado] = React.useState(false);

  const cargar = React.useCallback(async () => {
    try {
      setLista(await api<Usuario[]>("GET", "/usuarios"));
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

  const mostrarClave = (r: RespuestaUsuario, titulo: string) => {
    if (!r.clave_generada) return;
    avisar({
      titulo,
      mensaje: "Esta contraseña se muestra una sola vez. Entrégala a la persona y recuerda aplicar los cambios en el panel.",
      copiable: r.clave_generada,
    });
  };

  const guardar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setOcupado(true);
    try {
      let r: RespuestaUsuario;
      if (form.id === null) {
        r = await api<RespuestaUsuario>("POST", "/usuarios", {
          usuario: form.usuario,
          nombre_completo: form.nombre,
          grupo: form.grupo,
          activo: form.activo,
          ...(form.clave ? { clave: form.clave } : {}),
        });
      } else {
        r = await api<RespuestaUsuario>("PUT", `/usuarios/${form.id}`, {
          nombre_completo: form.nombre,
          grupo: form.grupo,
          activo: form.activo,
        });
      }
      setForm(null);
      await tras();
      mostrarClave(r, `Usuario «${r.usuario.usuario}» creado`);
    } catch (err) {
      avisarError(err);
    } finally {
      setOcupado(false);
    }
  };

  const alternar = async (u: Usuario) => {
    try {
      await api("PUT", `/usuarios/${u.id}`, { nombre_completo: u.nombre_completo, grupo: u.grupo, activo: !u.activo });
      await tras();
    } catch (e) {
      avisarError(e);
    }
  };

  const nuevaClave = async (u: Usuario) => {
    const ok = await confirmar(
      "Restablecer la contraseña",
      `Se generará una contraseña nueva para «${u.usuario}». La anterior dejará de servir cuando apliques los cambios.`,
      "Restablecer",
    );
    if (!ok) return;
    try {
      const r = await api<RespuestaUsuario>("POST", `/usuarios/${u.id}/clave`, {});
      await tras();
      mostrarClave(r, `Contraseña nueva de «${u.usuario}»`);
    } catch (e) {
      avisarError(e);
    }
  };

  const borrar = async (u: Usuario) => {
    const ok = await confirmar("Eliminar el usuario", `«${u.usuario}» dejará de entrar a los routers cuando apliques los cambios.`, "Eliminar", true);
    if (!ok) return;
    try {
      await api("DELETE", `/usuarios/${u.id}`);
      await tras();
    } catch (e) {
      avisarError(e);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Usuarios MikroTik</h1>
          <p className="text-sm text-muted-foreground">
            Personas que entran a los routers por WinBox, SSH o WebFig. El grupo debe existir en cada router.
          </p>
        </div>
        <Button onClick={() => setForm(vacio)}>
          <Plus /> Nuevo usuario
        </Button>
      </div>

      <Card>
        <Table>
          <thead>
            <tr>
              <Th>Usuario</Th>
              <Th>Grupo</Th>
              <Th>Estado</Th>
              <Th>Contraseña cambiada</Th>
              <Th className="text-right">Acciones</Th>
            </tr>
          </thead>
          <tbody>
            {lista?.length === 0 && (
              <tr>
                <Td colSpan={5} className="py-10 text-center text-muted-foreground">
                  Todavía no hay usuarios. Crea el primero con «Nuevo usuario».
                </Td>
              </tr>
            )}
            {lista?.map((u) => (
              <tr key={u.id}>
                <Td>
                  <div className="font-medium">{u.usuario}</div>
                  {u.nombre_completo && <div className="text-xs text-muted-foreground">{u.nombre_completo}</div>}
                </Td>
                <Td className="font-mono text-xs">{u.grupo}</Td>
                <Td>
                  <Badge variant={u.activo ? "success" : "muted"}>{u.activo ? "Activo" : "Suspendido"}</Badge>
                </Td>
                <Td className="whitespace-nowrap text-muted-foreground">{fecha(u.clave_cambiada)}</Td>
                <Td>
                  <div className="flex flex-wrap justify-end gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setForm({ id: u.id, usuario: u.usuario, nombre: u.nombre_completo, grupo: u.grupo, clave: "", activo: u.activo })}
                    >
                      Editar
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => nuevaClave(u)}>
                      Restablecer contraseña
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => alternar(u)}>
                      {u.activo ? "Suspender" : "Activar"}
                    </Button>
                    <Button size="sm" variant="ghost" className="text-destructive" onClick={() => borrar(u)}>
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
          <DialogContent titulo={form.id === null ? "Nuevo usuario" : `Editar «${form.usuario}»`}>
            <form onSubmit={guardar} className="space-y-4">
              {form.id === null && (
                <div className="space-y-2">
                  <Label htmlFor="usuario">Usuario</Label>
                  <Input id="usuario" required maxLength={64} autoComplete="off" value={form.usuario} onChange={(e) => setForm({ ...form, usuario: e.target.value })} />
                  <p className="text-xs text-muted-foreground">Una cuenta por persona. No se puede cambiar después.</p>
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="nombre">Nombre completo</Label>
                <Input id="nombre" maxLength={120} value={form.nombre} onChange={(e) => setForm({ ...form, nombre: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="grupo">Grupo en el router</Label>
                <Input id="grupo" required maxLength={32} list="grupos" value={form.grupo} onChange={(e) => setForm({ ...form, grupo: e.target.value })} />
                <datalist id="grupos">
                  <option value="full" />
                  <option value="write" />
                  <option value="read" />
                </datalist>
              </div>
              {form.id === null && (
                <div className="space-y-2">
                  <Label htmlFor="clave">Contraseña</Label>
                  <Input
                    id="clave"
                    type="password"
                    autoComplete="new-password"
                    placeholder="Vacío: se genera una aleatoria"
                    value={form.clave}
                    onChange={(e) => setForm({ ...form, clave: e.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">Mínimo 8 caracteres. Solo se guarda su hash, cifrado.</p>
                </div>
              )}
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
