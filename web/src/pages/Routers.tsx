import { Eye, EyeOff, Plus, Users } from "lucide-react";
import * as React from "react";
import { accesosDe, BloqueAccesos, CambiosMasivos, permisosDe, type Permisos } from "@/components/Accesos";
import { Badge, Button, Card, Copiable, Dialog, DialogContent, DialogFooter, EstadoVacio, Input, Label, MenuAcciones, Punto, Select, Table, Td, Textarea, Th, ThOrden, comparar, useOrden } from "@/components/ui";
import { api, type Empresa, type ModoAcceso, type RespuestaRouter, type Router, type Usuario } from "@/lib/api";
import { fecha } from "@/lib/utils";
import { useApp } from "../contexto";
import { useFiltro } from "../filtro";

interface Formulario {
  id: number | null;
  nombre: string;
  empresa: string;
  descripcion: string;
  redes: string;
  secreto: string;
  exigir: boolean;
  activo: boolean;
  acceso: ModoAcceso;
  // Modo con el que se abrió el formulario, para avisar si pasa a restringido.
  accesoInicial: ModoAcceso;
  // Usuarios marcados y su permiso en este router.
  permisos: Permisos;
}

const vacio: Formulario = {
  id: null,
  nombre: "",
  empresa: "",
  descripcion: "",
  redes: "",
  secreto: "",
  exigir: true,
  activo: true,
  acceso: "general",
  accesoInicial: "general",
  permisos: {},
};

function InsigniaAcceso({ r }: { r: Router }) {
  if (r.acceso !== "restringido") return <span className="text-sm text-muted-foreground">General</span>;
  const n = r.accesos?.length ?? 0;
  if (n === 0) return <Badge variant="warning">Restringido · nadie entra</Badge>;
  return (
    <Badge title={r.accesos.map((a) => `${a.usuario} (${a.grupo})`).join(", ")}>
      Restringido · {n === 1 ? "1 usuario" : `${n} usuarios`}
    </Badge>
  );
}

type Agrupacion = "" | "empresa" | "estado";
const CLAVE_AGRUPAR = "rc-tabla:routers:agrupar";

export default function Routers() {
  const { avisar, avisarError, confirmar, refrescarEstado } = useApp();
  const { routerId, recargarRouters } = useFiltro();
  const [lista, setLista] = React.useState<Router[] | null>(null);
  const [form, setForm] = React.useState<Formulario | null>(null);
  const [ocupado, setOcupado] = React.useState(false);
  const [empresas, setEmpresas] = React.useState<Empresa[]>([]);
  const [usuarios, setUsuarios] = React.useState<Usuario[] | null>(null);
  const [masivo, setMasivo] = React.useState(false);
  // Secreto en uso del router que se está editando: solo se pide al pulsar «Ver».
  const [secretoActual, setSecretoActual] = React.useState<string | null>(null);
  const [pidiendoSecreto, setPidiendoSecreto] = React.useState(false);
  const formId = form?.id ?? null;
  React.useEffect(() => {
    setSecretoActual(null);
  }, [formId]);

  const verSecreto = async () => {
    if (formId === null) return;
    setPidiendoSecreto(true);
    try {
      const r = await api<{ secreto: string }>("GET", `/routers/${formId}/secreto`);
      setSecretoActual(r.secreto);
    } catch (e) {
      avisarError(e);
    } finally {
      setPidiendoSecreto(false);
    }
  };

  const cargar = React.useCallback(async () => {
    try {
      setLista(await api<Router[]>("GET", "/routers"));
      recargarRouters();
      setEmpresas(await api<Empresa[]>("GET", "/empresas"));
      setUsuarios(await api<Usuario[]>("GET", "/usuarios"));
    } catch (e) {
      avisarError(e);
    }
  }, [avisarError, recargarRouters]);

  React.useEffect(() => {
    cargar();
  }, [cargar]);

  // El filtro de la barra superior deja a la vista un solo router.
  const [buscar, setBuscar] = React.useState("");
  const [fEmpresa, setFEmpresa] = React.useState("");
  const [fAcceso, setFAcceso] = React.useState("");
  const [fEstado, setFEstado] = React.useState("");
  const { orden, ordenarPor } = useOrden<"nombre" | "empresa" | "estado" | "acceso" | "secreto">("nombre", "routers-datos");
  const conFiltros = Boolean(buscar.trim() || fEmpresa || fAcceso || fEstado);
  const limpiarFiltros = () => {
    setBuscar("");
    setFEmpresa("");
    setFAcceso("");
    setFEstado("");
  };
  // Empresas que de verdad tienen routers, para el desplegable.
  const empresasEnUso = React.useMemo(() => [...new Set((lista ?? []).map((r) => r.empresa).filter(Boolean))].sort(comparar), [lista]);

  const visibles = React.useMemo(() => {
    if (!lista) return lista;
    const q = buscar.trim().toLowerCase();
    const valor = (r: Router) =>
      orden.campo === "nombre" ? r.nombre : orden.campo === "empresa" ? r.empresa : orden.campo === "estado" ? !r.activo : orden.campo === "acceso" ? r.acceso : r.secreto_rotado;
    return lista
      .filter((r) => routerId === null || r.id === routerId)
      .filter((r) => !q || [r.nombre, r.descripcion, r.empresa, ...r.redes].some((t) => t.toLowerCase().includes(q)))
      .filter((r) => !fEmpresa || (fEmpresa === "-" ? !r.empresa : r.empresa === fEmpresa))
      .filter((r) => !fAcceso || r.acceso === fAcceso)
      .filter((r) => !fEstado || r.activo === (fEstado === "activo"))
      .sort((x, y) => (comparar(valor(x), valor(y)) || comparar(x.nombre, y.nombre)) * (orden.asc ? 1 : -1));
  }, [lista, routerId, buscar, fEmpresa, fAcceso, fEstado, orden]);

  // Agrupar la tabla por empresa o por estado. Se recuerda durante la sesión,
  // como el orden de las columnas (y se olvida al salir del panel).
  const [agrupar, setAgrupar] = React.useState<Agrupacion>(() => {
    try {
      const v = sessionStorage.getItem(CLAVE_AGRUPAR);
      return v === "empresa" || v === "estado" ? v : "";
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
  const grupos = React.useMemo(() => {
    if (!visibles || visibles.length === 0) return [];
    if (agrupar === "") return [{ clave: "todos", titulo: null as string | null, routers: visibles }];
    const mapa = new Map<string, Router[]>();
    for (const r of visibles) {
      const k = agrupar === "empresa" ? r.empresa : r.activo ? "activo" : "suspendido";
      mapa.set(k, [...(mapa.get(k) ?? []), r]);
    }
    // Empresas por nombre, con «Sin empresa» al final; activos antes que suspendidos.
    const claves = [...mapa.keys()].sort((a, b) =>
      agrupar === "estado" ? (a === "activo" ? -1 : 1) : !a ? 1 : !b ? -1 : comparar(a, b),
    );
    return claves.map((k) => ({
      clave: k || "-",
      titulo: agrupar === "empresa" ? k || "Sin empresa" : k === "activo" ? "Activos" : "Suspendidos",
      routers: mapa.get(k) ?? [],
    }));
  }, [visibles, agrupar]);

  const tras = async () => {
    await cargar();
    await refrescarEstado();
  };

  const mostrarSecreto = (r: RespuestaRouter, titulo: string) => {
    if (!r.secreto_generado) return;
    avisar({
      titulo,
      mensaje:
        "Este secreto se muestra una sola vez. Pega estas líneas en el terminal del router, El panel aplica el cambio solo en unos segundos y abre el firewall del servidor únicamente para las redes de este router.",
      copiable: r.script_rsc,
    });
  };

  const guardar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form || ocupado) return;
    const restringido = form.acceso === "restringido";
    const accesos = accesosDe(form.permisos);
    if (form.id !== null && restringido && form.accesoInicial === "general") {
      const ok = await confirmar(
        "Pasar a acceso restringido",
        accesos.length === 0
          ? `No has marcado a ningún usuario: en unos segundos nadie podrá entrar a «${form.nombre}» por RADIUS.`
          : `En unos segundos solo ${accesos.length === 1 ? "podrá entrar a" : "podrán entrar a"} «${form.nombre}» ${
              accesos.length === 1 ? "el usuario marcado" : `los ${accesos.length} usuarios marcados`
            }, con el permiso elegido aquí. Los demás usuarios dejarán de entrar por RADIUS.`,
        "Restringir el acceso",
        true,
      );
      if (!ok) return;
    }
    setOcupado(true);
    // En modo general no se envía la lista: el servidor conserva la que había
    // por si el router vuelve a restringirse.
    const cuerpo = {
      nombre: form.nombre,
      empresa: form.empresa,
      descripcion: form.descripcion,
      redes: form.redes.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean),
      activo: form.activo,
      exigir_message_authenticator: form.exigir,
      acceso: form.acceso,
      ...(restringido ? { accesos } : {}),
      ...(form.id === null && form.secreto ? { secreto: form.secreto } : {}),
    };
    try {
      const r =
        form.id === null
          ? await api<RespuestaRouter>("POST", "/routers", cuerpo)
          : await api<RespuestaRouter>("PUT", `/routers/${form.id}`, cuerpo);
      // Al editar, un secreto escrito sustituye al que había.
      const cambiado = form.id !== null && form.secreto !== "";
      let lineas = "";
      if (cambiado) {
        await api<RespuestaRouter>("POST", `/routers/${form.id}/secreto`, { secreto: form.secreto });
        lineas = (await api<{ script_rsc: string }>("GET", `/routers/${form.id}/secreto`)).script_rsc;
      }
      setForm(null);
      await tras();
      if (cambiado) {
        avisar({
          titulo: `Secreto de «${r.router.nombre}» cambiado`,
          mensaje:
            "El secreto anterior deja de servir en unos segundos. Pega estas líneas en el terminal del router para que use el nuevo (si ya tenía una entrada de RadiusControl en /radius, cambia ahí el secreto en vez de añadir otra).",
          copiable: lineas,
        });
      } else {
        mostrarSecreto(r, `Router «${r.router.nombre}» creado`);
      }
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
        empresa: r.empresa,
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
      `Se generará un secreto nuevo para «${r.nombre}». El cambio se aplica en unos segundos y el secreto anterior deja de servir: ten a mano el router para actualizarlo enseguida.`,
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
    const ok = await confirmar("Eliminar el router", `«${r.nombre}» dejará de autenticar en unos segundos y su red se cerrará en el firewall.`, "Eliminar", true);
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
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1 basis-80">
          <p className="max-w-4xl text-sm text-muted-foreground">
            Cada router se identifica por la dirección de origen de sus paquetes y tiene su propio secreto. El firewall del servidor solo deja pasar al puerto RADIUS las redes de los routers activos.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setMasivo(true)}>
            <Users /> Cambios masivos
          </Button>
          <Button onClick={() => setForm(vacio)}>
            <Plus /> Nuevo router
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
        <Input
          className="col-span-2 w-full sm:w-64 sm:max-w-xs"
          placeholder="Buscar nombre, empresa o red"
          aria-label="Buscar routers"
          value={buscar}
          onChange={(e) => setBuscar(e.target.value)}
        />
        <Select className="col-span-1 w-full sm:w-auto" aria-label="Empresa" value={fEmpresa} onChange={(e) => setFEmpresa(e.target.value)}>
          <option value="">Todas las empresas</option>
          {empresasEnUso.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
          <option value="-">Sin empresa</option>
        </Select>
        <Select className="col-span-1 w-full sm:w-auto" aria-label="Acceso" value={fAcceso} onChange={(e) => setFAcceso(e.target.value)}>
          <option value="">Cualquier acceso</option>
          <option value="general">General</option>
          <option value="restringido">Restringido</option>
        </Select>
        <Select className="col-span-1 w-full sm:w-auto" aria-label="Estado" value={fEstado} onChange={(e) => setFEstado(e.target.value)}>
          <option value="">Cualquier estado</option>
          <option value="activo">Activos</option>
          <option value="suspendido">Suspendidos</option>
        </Select>
        <Select className="col-span-1 w-full sm:w-auto" aria-label="Agrupar" value={agrupar} onChange={(e) => cambiarAgrupar(e.target.value as Agrupacion)}>
          <option value="">Sin agrupar</option>
          <option value="empresa">Por empresa</option>
          <option value="estado">Por estado actual</option>
        </Select>
        {conFiltros && (
          <Button variant="ghost" size="sm" className="col-span-2 justify-center sm:col-span-1 sm:justify-start" onClick={limpiarFiltros}>
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
        <Table id="routers">
          <thead>
            <tr>
              <ThOrden campo="nombre" orden={orden} onOrden={ordenarPor}>
                Nombre
              </ThOrden>
              <ThOrden campo="empresa" orden={orden} onOrden={ordenarPor}>
                Empresa
              </ThOrden>
              <Th>Redes de origen</Th>
              <ThOrden campo="estado" orden={orden} onOrden={ordenarPor}>
                Estado
              </ThOrden>
              <ThOrden campo="acceso" orden={orden} onOrden={ordenarPor}>
                Acceso
              </ThOrden>
              <ThOrden campo="secreto" orden={orden} onOrden={ordenarPor}>
                Secreto rotado
              </ThOrden>
              <Th sinOrden className="text-center">Acciones</Th>
            </tr>
          </thead>
          {visibles?.length === 0 && (
            <tbody>
              <tr>
                <Td colSpan={7}>
                  <EstadoVacio titulo={lista?.length ? "Ningún router coincide con la búsqueda o los filtros." : "Todavía no hay routers. Crea el primero con «Nuevo router»."} />
                </Td>
              </tr>
            </tbody>
          )}
          {grupos.map((g) => (
            <tbody key={g.clave}>
              {g.titulo !== null && (
                <tr className="hover:!bg-transparent">
                  <Td colSpan={7} className="bg-muted/40 py-2">
                    <span className="font-semibold">{g.titulo}</span>
                    <span className="ml-2 font-mono text-xs text-muted-foreground">
                      {g.routers.length} {g.routers.length === 1 ? "router" : "routers"}
                    </span>
                  </Td>
                </tr>
              )}
              {g.routers.map((r) => (
              <tr key={r.id}>
                <Td>
                  <div className="whitespace-nowrap font-medium">{r.nombre}</div>
                  {r.descripcion && <div className="text-xs text-muted-foreground">{r.descripcion}</div>}
                </Td>
                <Td className="whitespace-nowrap">{r.empresa || <Badge variant="warning">Sin empresa</Badge>}</Td>
                <Td className="font-mono text-xs" valor={r.redes[0] ?? ""}>
                  {r.redes.length > 0 && <Copiable texto={r.redes[0]} />}
                  {r.redes.length > 1 && (
                    <span className="ml-1.5 rounded bg-muted px-1.5 py-0.5 font-sans text-[11px] text-muted-foreground" title={r.redes.slice(1).join("\n")}>
                      +{r.redes.length - 1}
                    </span>
                  )}
                </Td>
                <Td>
                  <div className="flex flex-col gap-0.5">
                    <Punto tono={r.activo ? "success" : "muted"}>{r.activo ? "Activo" : "Suspendido"}</Punto>
                    {!r.exigir_message_authenticator && <Punto tono="warning" className="text-xs text-muted-foreground">Sin Message-Authenticator</Punto>}
                  </div>
                </Td>
                <Td>
                  <InsigniaAcceso r={r} />
                </Td>
                <Td className="whitespace-nowrap text-muted-foreground" valor={r.secreto_rotado ?? ""}>{fecha(r.secreto_rotado)}</Td>
                <Td>
                  <div className="flex flex-nowrap items-center justify-center gap-1 whitespace-nowrap">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setForm({
                          id: r.id,
                          nombre: r.nombre,
                          empresa: r.empresa,
                          descripcion: r.descripcion,
                          redes: r.redes.join("\n"),
                          secreto: "",
                          exigir: r.exigir_message_authenticator,
                          activo: r.activo,
                          acceso: r.acceso === "restringido" ? "restringido" : "general",
                          accesoInicial: r.acceso === "restringido" ? "restringido" : "general",
                          permisos: permisosDe(r.accesos),
                        })
                      }
                    >
                      Editar
                    </Button>
                    <MenuAcciones
                      etiqueta={`Más acciones de ${r.nombre}`}
                      acciones={[
                        { texto: "Rotar secreto", onSelect: () => rotar(r) },
                        { texto: r.activo ? "Suspender" : "Activar", onSelect: () => alternar(r) },
                        { texto: "Eliminar", onSelect: () => borrar(r), peligro: true, separadoAntes: true },
                      ]}
                    />
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
          <DialogContent tamano="lg" titulo={form.id === null ? "Nuevo router" : "Editar router"}>
            <form onSubmit={guardar} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="nombre">Nombre</Label>
                  <Input id="nombre" required maxLength={63} value={form.nombre} onChange={(e) => setForm({ ...form, nombre: e.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="empresa">Empresa</Label>
                  <Input id="empresa" required maxLength={63} list="empresas" autoComplete="off" value={form.empresa} onChange={(e) => setForm({ ...form, empresa: e.target.value })} />
                  <datalist id="empresas">
                    {empresas.map((e) => (
                      <option key={e.nombre} value={e.nombre} />
                    ))}
                  </datalist>
                  <p className="text-xs text-muted-foreground">A quién pertenece el router. Escribe una nueva o elige una existente.</p>
                </div>
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
              {form.id === null ? (
                <div className="space-y-2">
                  <Label htmlFor="secreto">Secreto RADIUS</Label>
                  <Input
                    id="secreto"
                    className="font-mono"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Vacío: se genera uno aleatorio"
                    value={form.secreto}
                    onChange={(e) => setForm({ ...form, secreto: e.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">Escríbelo solo si el router ya tiene uno que quieras conservar.</p>
                </div>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Secreto RADIUS en uso</Label>
                    <div className="flex h-9 items-center justify-between gap-2 rounded-md border border-input bg-muted/40 px-3">
                      {secretoActual === null ? (
                        <span className="font-mono text-sm tracking-widest text-muted-foreground" aria-hidden="true">
                          ••••••••••••
                        </span>
                      ) : (
                        <Copiable texto={secretoActual} className="min-w-0 text-sm" />
                      )}
                      <button
                        type="button"
                        onClick={() => (secretoActual === null ? void verSecreto() : setSecretoActual(null))}
                        disabled={pidiendoSecreto}
                        aria-label={secretoActual === null ? "Ver el secreto en uso" : "Ocultar el secreto"}
                        title={secretoActual === null ? "Ver el secreto en uso" : "Ocultar el secreto"}
                        className="-mr-2 flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                      >
                        {secretoActual === null ? <Eye className="size-4" aria-hidden="true" /> : <EyeOff className="size-4" aria-hidden="true" />}
                      </button>
                    </div>
                    <p className="text-xs text-muted-foreground">Verlo queda anotado en el registro de actividad.</p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="secreto">Secreto nuevo</Label>
                    <Input
                      id="secreto"
                      className="font-mono"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="Vacío: se conserva el actual"
                      value={form.secreto}
                      onChange={(e) => setForm({ ...form, secreto: e.target.value })}
                    />
                    <p className="text-xs text-muted-foreground">
                      Si escribes uno, sustituye al actual al guardar y el router debe usar el nuevo.
                    </p>
                  </div>
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
              <BloqueAccesos
                modo={form.acceso}
                onModo={(acceso) => setForm({ ...form, acceso })}
                usuarios={usuarios}
                permisos={form.permisos}
                onPermisos={(permisos) => setForm({ ...form, permisos })}
              />
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

      <CambiosMasivos
        abierto={masivo}
        onCerrar={() => setMasivo(false)}
        routers={lista ?? []}
        empresas={empresas}
        usuarios={usuarios}
        onHecho={tras}
      />
    </div>
  );
}
