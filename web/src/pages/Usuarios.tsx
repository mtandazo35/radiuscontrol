import { Eye, EyeOff, Plus } from "lucide-react";
import * as React from "react";
import { Badge, Button, Card, Copiable, Dialog, DialogContent, DialogFooter, EstadoVacio, Input, Label, Select, Table, Td, Th, ThOrden, comparar, useOrden } from "@/components/ui";
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

// Campo de contraseña con un botón para verla mientras se escribe.
function CampoClave({
  id,
  valor,
  onValor,
  enfocar,
  vacio = "Vacío: se genera una aleatoria",
}: {
  id: string;
  valor: string;
  onValor: (v: string) => void;
  enfocar?: boolean;
  vacio?: string;
}) {
  const [ver, setVer] = React.useState(false);
  return (
    <div className="relative">
      <Input
        id={id}
        className="pr-10 font-mono"
        type={ver ? "text" : "password"}
        autoComplete="new-password"
        autoFocus={enfocar}
        placeholder={vacio}
        value={valor}
        onChange={(e) => onValor(e.target.value)}
      />
      <button
        type="button"
        onClick={() => setVer((v) => !v)}
        aria-label={ver ? "Ocultar la contraseña" : "Mostrar la contraseña"}
        aria-pressed={ver}
        className="absolute right-0 top-0 flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {ver ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
      </button>
    </div>
  );
}

type Agrupacion = "" | "grupo" | "estado";
const CLAVE_AGRUPAR = "rc-tabla:usuarios:agrupar";

export default function Usuarios() {
  const { avisar, avisarError, confirmar, refrescarEstado } = useApp();
  const [lista, setLista] = React.useState<Usuario[] | null>(null);
  const [form, setForm] = React.useState<Formulario | null>(null);
  const [ocupado, setOcupado] = React.useState(false);
  const [otroGrupo, setOtroGrupo] = React.useState(false);
  const [cambio, setCambio] = React.useState<{ usuario: Usuario; clave: string } | null>(null);
  // Contraseña en uso del usuario que se está editando: solo se pide al pulsar «Ver».
  // null = oculta; "" = el usuario es anterior a que se guardara y no se puede recuperar.
  const [claveActual, setClaveActual] = React.useState<string | null>(null);
  const [pidiendoClave, setPidiendoClave] = React.useState(false);
  const formId = form?.id ?? null;
  React.useEffect(() => {
    setClaveActual(null);
  }, [formId]);

  const verClave = async () => {
    if (formId === null) return;
    setPidiendoClave(true);
    try {
      const r = await api<{ disponible: boolean; clave: string }>("GET", `/usuarios/${formId}/clave`);
      setClaveActual(r.disponible ? r.clave : "");
    } catch (e) {
      avisarError(e);
    } finally {
      setPidiendoClave(false);
    }
  };

  const [buscar, setBuscar] = React.useState("");
  const [fGrupo, setFGrupo] = React.useState("");
  const [fEstado, setFEstado] = React.useState("");
  const { orden, ordenarPor } = useOrden<"usuario" | "grupo" | "estado" | "clave">("usuario", "usuarios-datos");
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

  // Agrupar la tabla por grupo de RouterOS o por estado. Se recuerda durante la
  // sesión, como el orden de las columnas (y se olvida al salir del panel).
  const [agrupar, setAgrupar] = React.useState<Agrupacion>(() => {
    try {
      const v = sessionStorage.getItem(CLAVE_AGRUPAR);
      return v === "grupo" || v === "estado" ? v : "";
    } catch {
      return "";
    }
  });
  const cambiarAgrupar = (v: Agrupacion) => {
    setAgrupar(v);
    try {
      sessionStorage.setItem(CLAVE_AGRUPAR, v);
    } catch {
      // Sin almacenamiento: vale hasta recargar.
    }
  };
  const bloques = React.useMemo(() => {
    if (!visibles || visibles.length === 0) return [];
    if (agrupar === "") return [{ clave: "todos", titulo: null as string | null, usuarios: visibles }];
    const mapa = new Map<string, Usuario[]>();
    for (const u of visibles) {
      const k = agrupar === "grupo" ? u.grupo : u.activo ? "activo" : "suspendido";
      mapa.set(k, [...(mapa.get(k) ?? []), u]);
    }
    // Los grupos de fábrica primero (full, write, read) y luego los propios por
    // nombre; activos antes que suspendidos.
    const fabrica = ["full", "write", "read"];
    const peso = (g: string) => (fabrica.includes(g) ? fabrica.indexOf(g) : fabrica.length);
    const claves = [...mapa.keys()].sort((a, b) =>
      agrupar === "estado" ? (a === "activo" ? -1 : 1) : peso(a) - peso(b) || comparar(a, b),
    );
    return claves.map((k) => ({
      clave: k,
      titulo: agrupar === "grupo" ? `Grupo ${k}` : k === "activo" ? "Activos" : "Suspendidos",
      usuarios: mapa.get(k) ?? [],
    }));
  }, [visibles, agrupar]);

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

  // La contraseña se enseña al terminar, tanto si la generó el sistema como si
  // la escribió el operador. Después se puede consultar al editar el usuario.
  const mostrarClave = (r: RespuestaUsuario, titulo: string, escrita: string) => {
    const clave = r.clave_generada || escrita;
    if (!clave) return;
    avisar({
      titulo,
      mensaje: r.clave_generada
        ? "Contraseña generada por el sistema. Cópiala y entrégala a la persona. El cambio se aplica solo en unos segundos."
        : "Esta es la contraseña que escribiste. El cambio se aplica solo en unos segundos.",
      copiable: clave,
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
        // Al editar, una contraseña escrita sustituye a la que había.
        if (form.clave) await api<RespuestaUsuario>("POST", `/usuarios/${form.id}/clave`, { clave: form.clave });
      }
      const escrita = form.clave;
      setForm(null);
      await tras();
      mostrarClave(r, form.id === null ? `Usuario «${r.usuario.usuario}» creado` : `Contraseña nueva de «${r.usuario.usuario}»`, escrita);
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

  const nuevaClave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cambio) return;
    const { usuario: u, clave } = cambio;
    setOcupado(true);
    try {
      const r = await api<RespuestaUsuario>("POST", `/usuarios/${u.id}/clave`, clave ? { clave } : {});
      setCambio(null);
      await tras();
      mostrarClave(r, `Contraseña nueva de «${u.usuario}»`, clave);
    } catch (err) {
      avisarError(err);
    } finally {
      setOcupado(false);
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

      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
        <Input
          className="col-span-2 w-full sm:w-64 sm:max-w-xs"
          placeholder="Buscar usuario o nombre"
          aria-label="Buscar usuarios"
          value={buscar}
          onChange={(e) => setBuscar(e.target.value)}
        />
        <Select className="col-span-1 w-full sm:w-auto" aria-label="Grupo" value={fGrupo} onChange={(e) => setFGrupo(e.target.value)}>
          <option value="">Todos los grupos</option>
          {gruposEnUso.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </Select>
        <Select className="col-span-1 w-full sm:w-auto" aria-label="Estado" value={fEstado} onChange={(e) => setFEstado(e.target.value)}>
          <option value="">Cualquier estado</option>
          <option value="activo">Activos</option>
          <option value="suspendido">Suspendidos</option>
        </Select>
        <Select className="col-span-1 w-full sm:w-auto" aria-label="Agrupar" value={agrupar} onChange={(e) => cambiarAgrupar(e.target.value as Agrupacion)}>
          <option value="">Sin agrupar</option>
          <option value="grupo">Por grupo</option>
          <option value="estado">Por estado actual</option>
        </Select>
        {conFiltros && (
          <Button
            variant="ghost"
            size="sm"
            className="col-span-2 justify-center sm:col-span-1 sm:justify-start"
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
          <span className="col-span-2 text-right font-mono text-xs text-muted-foreground sm:ml-auto">
            {visibles.length} de {lista.length}
          </span>
        )}
      </div>

      <Card>
        <Table id="usuarios">
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
              <Th sinOrden className="text-center">Acciones</Th>
            </tr>
          </thead>
          {visibles?.length === 0 && (
            <tbody>
              <tr>
                <Td colSpan={5}>
                  <EstadoVacio titulo={lista?.length ? "Ningún usuario coincide con la búsqueda o los filtros." : "Todavía no hay usuarios. Crea el primero con «Nuevo usuario»."} />
                </Td>
              </tr>
            </tbody>
          )}
          {bloques.map((b) => (
            <tbody key={b.clave}>
              {b.titulo !== null && (
                <tr className="hover:!bg-transparent">
                  <Td colSpan={5} className="bg-muted/40 py-2">
                    <span className="font-semibold">{b.titulo}</span>
                    <span className="ml-2 font-mono text-xs text-muted-foreground">
                      {b.usuarios.length} {b.usuarios.length === 1 ? "usuario" : "usuarios"}
                    </span>
                  </Td>
                </tr>
              )}
              {b.usuarios.map((u) => (
              <tr key={u.id}>
                <Td>
                  <div className="whitespace-nowrap font-medium">{u.usuario}</div>
                  {u.nombre_completo && <div className="text-xs text-muted-foreground">{u.nombre_completo}</div>}
                </Td>
                <Td className="font-mono text-xs">{u.grupo}</Td>
                <Td>
                  <Badge variant={u.activo ? "success" : "muted"}>{u.activo ? "Activo" : "Suspendido"}</Badge>
                </Td>
                <Td className="whitespace-nowrap text-muted-foreground" valor={u.clave_cambiada ?? ""}>{fecha(u.clave_cambiada)}</Td>
                <Td>
                  <div className="flex flex-nowrap items-center justify-center gap-1 whitespace-nowrap">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => abrir({ id: u.id, usuario: u.usuario, nombre: u.nombre_completo, grupo: u.grupo, clave: "", activo: u.activo })}
                    >
                      Editar
                    </Button>
                    <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-foreground" onClick={() => setCambio({ usuario: u, clave: "" })}>
                      Restablecer contraseña
                    </Button>
                    <Button size="sm" variant="ghost" className="w-[5.75rem] text-muted-foreground hover:text-foreground" onClick={() => alternar(u)}>
                      {u.activo ? "Suspender" : "Activar"}
                    </Button>
                    <Button size="sm" variant="ghost" className="text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => borrar(u)}>
                      Eliminar
                    </Button>
                  </div>
                </Td>
              </tr>
              ))}
            </tbody>
          ))}
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
              {form.id === null ? (
                <div className="space-y-2">
                  <Label htmlFor="clave">Contraseña</Label>
                  <CampoClave id="clave" valor={form.clave} onValor={(v) => setForm({ ...form, clave: v })} />
                  <p className="text-xs text-muted-foreground">Mínimo 8 caracteres. Después se puede consultar y cambiar al editar el usuario.</p>
                </div>
              ) : (
                <>
                  <div className="space-y-2">
                    <Label>Contraseña en uso</Label>
                    <div className="flex h-9 items-center justify-between gap-2 rounded-md border border-input bg-muted/40 px-3">
                      {claveActual === null ? (
                        <span className="font-mono text-sm tracking-widest text-muted-foreground" aria-hidden="true">
                          ••••••••••••
                        </span>
                      ) : claveActual === "" ? (
                        <span className="text-sm text-muted-foreground">No se puede recuperar</span>
                      ) : (
                        <Copiable texto={claveActual} className="min-w-0 text-sm" />
                      )}
                      <button
                        type="button"
                        onClick={() => (claveActual === null ? void verClave() : setClaveActual(null))}
                        disabled={pidiendoClave}
                        aria-label={claveActual === null ? "Ver la contraseña en uso" : "Ocultar la contraseña"}
                        title={claveActual === null ? "Ver la contraseña en uso" : "Ocultar la contraseña"}
                        className="-mr-2 flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                      >
                        {claveActual === null ? <Eye className="size-4" aria-hidden="true" /> : <EyeOff className="size-4" aria-hidden="true" />}
                      </button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {claveActual === ""
                        ? "Esta contraseña se puso antes de que el panel las guardara para consultarlas. Escribe una nueva abajo y a partir de ahí se podrá ver."
                        : "Verla queda anotado en el registro de actividad."}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="clave">Contraseña nueva</Label>
                    <CampoClave id="clave" vacio="Vacío: se conserva la actual" valor={form.clave} onValor={(v) => setForm({ ...form, clave: v })} />
                    <p className="text-xs text-muted-foreground">Mínimo 8 caracteres. Si escribes una, sustituye a la actual al guardar.</p>
                  </div>
                </>
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

      <Dialog open={cambio !== null} onOpenChange={(abierto) => !abierto && setCambio(null)}>
        {cambio && (
          <DialogContent titulo={`Restablecer la contraseña de «${cambio.usuario.usuario}»`}>
            <form onSubmit={nuevaClave} className="space-y-4">
              <p className="text-sm text-muted-foreground">La contraseña anterior dejará de servir en unos segundos.</p>
              <div className="space-y-2">
                <Label htmlFor="clave-nueva">Contraseña nueva</Label>
                <CampoClave id="clave-nueva" enfocar valor={cambio.clave} onValor={(v) => setCambio({ ...cambio, clave: v })} />
                <p className="text-xs text-muted-foreground">
                  Mínimo 8 caracteres, o déjala vacía para que el sistema genere una. Al guardar se te muestra una vez para que la copies.
                </p>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setCambio(null)}>
                  Cancelar
                </Button>
                <Button type="submit" disabled={ocupado}>
                  {ocupado ? "Guardando…" : "Restablecer"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
