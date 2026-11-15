import { Plus } from "lucide-react";
import * as React from "react";
import { Badge, Button, Card, Dialog, DialogContent, DialogFooter, Input, Label, Select, Table, Td, Th, ThOrden, comparar, useOrden } from "@/components/ui";
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
const gruposBase = ["full", "write", "read"];

export default function Usuarios() {
  const { avisar, avisarError, confirmar, refrescarEstado } = useApp();
  const [lista, setLista] = React.useState<Usuario[] | null>(null);
  const [form, setForm] = React.useState<Formulario | null>(null);
  const [ocupado, setOcupado] = React.useState(false);
  const [otroGrupo, setOtroGrupo] = React.useState(false);

  const [buscar, setBuscar] = React.useState("");
  const [fGrupo, setFGrupo] = React.useState("");
  const [fEstado, setFEstado] = React.useState("");
  const { orden, ordenarPor } = useOrden<"usuario" | "grupo" | "estado" | "clave">("usuario");
  const conFiltros = Boolean(buscar.trim() || fGrupo || fEstado);
  const gruposEnUso = React.useMemo(() => [...new Set((lista ?? []).map((u) => u.grupo))].sort(comparar), [lista]);
  const visibles = React.useMemo(() => {
    if (!lista) return lista;
    const q = buscar.trim().toLowerCase();
    const valor = (u: Usuario) => (orden.campo === "usuario" ? u.usuario : orden.campo === "grupo" ? u.grupo : orden.campo === "estado" ? !u.activo : u.clave_cambiada);
    return lista
      .filter((u) => !q || u.usuario.toLowerCase().includes(q) || u.nombre_completo.toLowerCase().includes(q))
      .filter((u) => !fGrupo || u.grupo === fGrupo)
      .filter((u) => !fEstado || u.activo === (fEstado === "activo"))
      .sort((x, y) => (comparar(valor(x), valor(y)) || comparar(x.usuario, y.usuario)) * (orden.asc ? 1 : -1));
  }, [lista, buscar, fGrupo, fEstado, orden]);

  const abrir = (f: Formulario) => {
    setOtroGrupo(!gruposBase.includes(f.grupo));
    setForm(f);
  };

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
      mensaje: "Esta contraseña se muestra una sola vez. Entrégala a la persona; el cambio se aplica solo en unos segundos.",
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
      `Se generará una contraseña nueva para «${u.usuario}». La anterior dejará de servir en unos segundos.`,
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
    const ok = await confirmar("Eliminar el usuario", `«${u.usuario}» dejará de entrar a los routers en unos segundos.`, "Eliminar", true);
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
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1 basis-80">
          <p className="max-w-4xl text-sm text-muted-foreground">
            Personas que entran a los routers por WinBox, SSH o WebFig. El grupo debe existir en cada router.
          </p>
        </div>
        <Button onClick={() => abrir(vacio)}>
          <Plus /> Nuevo usuario
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="max-w-xs"
          placeholder="Buscar usuario o nombre"
          aria-label="Buscar usuarios"
          value={buscar}
          onChange={(e) => setBuscar(e.target.value)}
        />
        <Select aria-label="Grupo" value={fGrupo} onChange={(e) => setFGrupo(e.target.value)}>
          <option value="">Todos los grupos</option>
          {gruposEnUso.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </Select>
        <Select aria-label="Estado" value={fEstado} onChange={(e) => setFEstado(e.target.value)}>
          <option value="">Cualquier estado</option>
          <option value="activo">Activos</option>
          <option value="suspendido">Suspendidos</option>
        </Select>
        {conFiltros && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setBuscar("");
              setFGrupo("");
              setFEstado("");
            }}
          >
            Limpiar filtros
          </Button>
        )}
        {lista && visibles && (
          <span className="ml-auto font-mono text-xs text-muted-foreground">
            {visibles.length} de {lista.length}
          </span>
        )}
      </div>

      <Card>
        <Table>
          <thead>
            <tr>
              <ThOrden campo="usuario" orden={orden} onOrden={ordenarPor}>
                Usuario
              </ThOrden>
              <ThOrden campo="grupo" orden={orden} onOrden={ordenarPor}>
                Grupo
              </ThOrden>
              <ThOrden campo="estado" orden={orden} onOrden={ordenarPor}>
                Estado
              </ThOrden>
              <ThOrden campo="clave" orden={orden} onOrden={ordenarPor}>
                Contraseña cambiada
              </ThOrden>
              <Th className="text-right">Acciones</Th>
            </tr>
          </thead>
          <tbody>
            {visibles?.length === 0 && (
              <tr>
                <Td colSpan={5} className="py-10 text-center text-muted-foreground">
                  {lista?.length ? "Ningún usuario coincide con la búsqueda o los filtros." : "Todavía no hay usuarios. Crea el primero con «Nuevo usuario»."}
                </Td>
              </tr>
            )}
            {visibles?.map((u) => (
              <tr key={u.id}>
                <Td>
                  <div className="whitespace-nowrap font-medium">{u.usuario}</div>
                  {u.nombre_completo && <div className="text-xs text-muted-foreground">{u.nombre_completo}</div>}
                </Td>
                <Td className="font-mono text-xs">{u.grupo}</Td>
                <Td>
                  <Badge variant={u.activo ? "success" : "muted"}>{u.activo ? "Activo" : "Suspendido"}</Badge>
                </Td>
                <Td className="whitespace-nowrap text-muted-foreground">{fecha(u.clave_cambiada)}</Td>
                <Td>
                  <div className="flex flex-nowrap items-center justify-end gap-1 whitespace-nowrap">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => abrir({ id: u.id, usuario: u.usuario, nombre: u.nombre_completo, grupo: u.grupo, clave: "", activo: u.activo })}
                    >
                      Editar
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => nuevaClave(u)}>
                      Restablecer contraseña
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => alternar(u)}>
                      {u.activo ? "Suspender" : "Activar"}
                    </Button>
                    <Button size="sm" variant="outline" className="text-destructive" onClick={() => borrar(u)}>
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
                <select
                  id="grupo"
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={otroGrupo ? "__otro" : form.grupo}
                  onChange={(e) => {
                    const otro = e.target.value === "__otro";
                    setOtroGrupo(otro);
                    setForm({ ...form, grupo: otro ? "" : e.target.value });
                  }}
                >
                  <option value="full">full: control total</option>
                  <option value="write">write: puede cambiar la configuración</option>
                  <option value="read">read: solo lectura</option>
                  <option value="__otro">Otro grupo…</option>
                </select>
                {otroGrupo && (
                  <Input
                    aria-label="Nombre del grupo"
                    required
                    maxLength={32}
                    placeholder="Nombre exacto del grupo en el router"
                    value={form.grupo}
                    onChange={(e) => setForm({ ...form, grupo: e.target.value })}
                  />
                )}
                <p className="text-xs text-muted-foreground">
                  full, write y read vienen de fábrica en RouterOS. Un grupo propio debe existir en cada router.
                </p>
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
