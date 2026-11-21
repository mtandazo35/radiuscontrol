import { Plus, UserCog } from "lucide-react";
import * as React from "react";
import { Badge, Button, Card, Copiable, Dialog, DialogContent, DialogFooter, EstadoVacio, Input, Label, Paginacion, Table, Td, Th, ThOrden, useOrden } from "@/components/ui";
import { api, type Bloqueos as DatosBloqueos, type OperadorDetalle, type PaginaEventos, type Sesion } from "@/lib/api";
import { ModalMiCuenta, nombreRol } from "@/components/MiCuenta";
import { BotonVaciar } from "@/components/Vaciar";
import { fecha } from "@/lib/utils";
import { useApp } from "../contexto";

const selector =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";


const nombreAccion: Record<string, string> = {
  "sesion.iniciada": "Inicio de sesión",
  "sesion.fallida": "Intento de acceso fallido",
  "sesion.cerrada": "Cierre de sesión",
  "sesion.revocada": "Sesión cerrada por un operador",
  "sesion.cerrada_por_inactividad": "Sesión cerrada por inactividad",
  "cuenta.clave_cambiada": "Cambio de contraseña propia",
  "cuenta.clave_rechazada": "Cambio de contraseña rechazado",
  "cuenta.doble_factor_activado": "Doble factor activado",
  "cuenta.doble_factor_desactivado": "Doble factor desactivado",
  "operador.creado": "Operador creado",
  "operador.editado": "Operador editado",
  "operador.eliminado": "Operador eliminado",
  "operador.clave_restablecida": "Contraseña de operador restablecida",
  "operador.desbloqueado": "Operador desbloqueado",
  "operador.doble_factor_retirado": "Doble factor retirado a un operador",
  "operador.acceso_de_emergencia": "Acceso de emergencia desde el servidor",
  "sistema.actualizacion_pedida": "Actualización pedida",
  "sistema.actualizada": "Actualización instalada",
  "sistema.actualizacion_fallida": "Actualización fallida",
  "sistema.actualizacion_revertida": "Actualización revertida",
  "sistema.purga": "Limpieza de registros",
  "sistema.purga_ajustada": "Ajustes de limpieza cambiados",
  "sistema.registros_vaciados": "Registros vaciados a mano",
  "servidor.acceso_añadido": "Acceso al servidor añadido",
  "servidor.acceso_quitado": "Acceso al servidor quitado",
  "ip.bloqueada": "Dirección IP bloqueada por intentos fallidos",
  "ip.desbloqueada": "Dirección IP desbloqueada",
  "router.creado": "Router creado",
  "router.editado": "Router editado",
  "router.eliminado": "Router eliminado",
  "router.secreto_rotado": "Secreto de router rotado",
  "router.secreto_visto": "Secreto de router consultado",
  "usuario.creado": "Usuario MikroTik creado",
  "usuario.editado": "Usuario MikroTik editado",
  "usuario.eliminado": "Usuario MikroTik eliminado",
  "usuario.clave_cambiada": "Contraseña de usuario MikroTik cambiada",
  "usuario.clave_vista": "Contraseña de usuario MikroTik consultada",
  "origen.guardado": "Nombre de un origen guardado",
  "origen.borrado": "Nombre de un origen quitado",
  "accesos.cambio_masivo": "Cambio masivo de accesos",
  "config.aplicada": "Configuración aplicada",
  "config.rechazada": "Configuración rechazada por FreeRADIUS",
};

function Seccion({ titulo, descripcion, children, accion }: { titulo: string; descripcion: string; children: React.ReactNode; accion?: React.ReactNode }) {
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-2 p-4">
        <div>
          <h2 className="text-base font-semibold">{titulo}</h2>
          <p className="text-sm text-muted-foreground">{descripcion}</p>
        </div>
        {accion}
      </div>
      {children}
    </Card>
  );
}

// Para las cuentas que no ven la lista de operadores.
function TarjetaMiCuenta() {
  const { operador } = useApp();
  const [abierto, setAbierto] = React.useState(false);
  return (
    <Seccion
      titulo="Mi cuenta"
      descripcion={`Has entrado como ${operador?.usuario} (${nombreRol[operador?.rol ?? ""] ?? operador?.rol}).`}
      accion={
        <Button size="sm" onClick={() => setAbierto(true)}>
          <UserCog /> Mi cuenta
        </Button>
      }
    >
      <ModalMiCuenta abierto={abierto} onCerrar={() => setAbierto(false)} />
    </Seccion>
  );
}

function Operadores() {
  const { operador, avisar, avisarError, confirmar } = useApp();
  const [lista, setLista] = React.useState<OperadorDetalle[] | null>(null);
  const [alta, setAlta] = React.useState<{ usuario: string; rol: string } | null>(null);
  const [miCuenta, setMiCuenta] = React.useState(false);

  const cargar = React.useCallback(async () => {
    try {
      setLista(await api<OperadorDetalle[]>("GET", "/operadores"));
    } catch (e) {
      avisarError(e);
    }
  }, [avisarError]);

  React.useEffect(() => {
    cargar();
  }, [cargar]);

  const hacer = async (accion: () => Promise<unknown>) => {
    try {
      await accion();
      await cargar();
    } catch (e) {
      avisarError(e);
    }
  };

  const crear = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!alta) return;
    try {
      const r = await api<{ operador: OperadorDetalle; clave_generada: string }>("POST", "/operadores", alta);
      setAlta(null);
      await cargar();
      avisar({
        titulo: `Operador «${r.operador.usuario}» creado`,
        mensaje: "Esta contraseña se muestra una sola vez. Entrégasela y pídele que la cambie al entrar.",
        copiable: r.clave_generada,
      });
    } catch (err) {
      avisarError(err);
    }
  };

  const restablecer = async (o: OperadorDetalle) => {
    if (!(await confirmar("Restablecer la contraseña", `Se generará una contraseña nueva para «${o.usuario}», se cerrarán sus sesiones y se quitará el bloqueo si lo tiene.`, "Restablecer"))) return;
    try {
      const r = await api<{ clave_generada: string }>("POST", `/operadores/${o.id}/clave`, {});
      await cargar();
      avisar({ titulo: `Contraseña nueva de «${o.usuario}»`, mensaje: "Se muestra una sola vez.", copiable: r.clave_generada });
    } catch (e) {
      avisarError(e);
    }
  };

  const quitarTotp = async (o: OperadorDetalle) => {
    if (!(await confirmar("Retirar el doble factor", `«${o.usuario}» volverá a entrar solo con su contraseña hasta que lo active de nuevo. Úsalo si perdió el teléfono.`, "Retirar", true))) return;
    hacer(() => api("DELETE", `/operadores/${o.id}/totp`));
  };

  const borrar = async (o: OperadorDetalle) => {
    if (!(await confirmar("Eliminar el operador", `«${o.usuario}» dejará de poder entrar al panel.`, "Eliminar", true))) return;
    hacer(() => api("DELETE", `/operadores/${o.id}`));
  };

  return (
    <Seccion
      titulo="Operadores del panel"
      descripcion="Quién puede entrar a RadiusControl. Los administradores cambian todo; las cuentas de solo lectura únicamente consultan."
      accion={
        <Button size="sm" onClick={() => setAlta({ usuario: "", rol: "lectura" })}>
          <Plus /> Nuevo operador
        </Button>
      }
    >
      <Table id="operadores">
        <thead>
          <tr>
            <Th>Usuario</Th>
            <Th>Rol</Th>
            <Th>Estado</Th>
            <Th>Último acceso</Th>
            <Th sinOrden className="text-center">Acciones</Th>
          </tr>
        </thead>
        <tbody>
          {lista?.map((o) => {
            const yo = o.usuario === operador?.usuario;
            return (
              <tr key={o.id}>
                <Td className="font-medium">
                  {o.usuario} {yo && <span className="text-xs font-normal text-muted-foreground">(tú)</span>}
                </Td>
                <Td valor={o.rol}>
                  <select
                    aria-label={`Rol de ${o.usuario}`}
                    className={selector + " w-[10.5rem]"}
                    value={o.rol}
                    disabled={yo}
                    onChange={(e) => hacer(() => api("PUT", `/operadores/${o.id}`, { rol: e.target.value, activo: o.activo }))}
                  >
                    <option value="administrador">Administrador</option>
                    <option value="lectura">Solo lectura</option>
                  </select>
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    <Badge variant={o.activo ? "success" : "muted"}>{o.activo ? "Activo" : "Suspendido"}</Badge>
                    <Badge variant={o.totp ? "success" : "warning"}>{o.totp ? "Doble factor" : "Sin doble factor"}</Badge>
                    {o.bloqueado && <Badge variant="destructive">Bloqueado</Badge>}
                  </div>
                </Td>
                <Td className="whitespace-nowrap text-muted-foreground" valor={o.ultimo_acceso ?? ""}>
                  {o.ultimo_acceso ? fecha(o.ultimo_acceso) : "Nunca"}
                  <div className="text-xs">{o.sesiones} sesión(es) abierta(s)</div>
                </Td>
                <Td>
                  {/* Cada acción tiene su hueco, exista o no en esa fila: así todas
                      quedan en la misma vertical. Primero las que hay siempre. */}
                  <div className="mx-auto grid w-max grid-cols-[10.25rem_5.75rem_4.75rem_9.25rem_6.5rem] items-center gap-1 whitespace-nowrap">
                    {yo ? (
                      <Button size="sm" className="justify-self-start" onClick={() => setMiCuenta(true)}>
                        <UserCog /> Mi cuenta
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => restablecer(o)}>
                        Restablecer contraseña
                      </Button>
                    )}
                    {yo ? (
                      <span />
                    ) : (
                      <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-foreground" onClick={() => hacer(() => api("PUT", `/operadores/${o.id}`, { rol: o.rol, activo: !o.activo }))}>
                        {o.activo ? "Suspender" : "Activar"}
                      </Button>
                    )}
                    {yo ? (
                      <span />
                    ) : (
                      <Button size="sm" variant="ghost" className="text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => borrar(o)}>
                        Eliminar
                      </Button>
                    )}
                    {o.totp && !yo ? (
                      <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-foreground" onClick={() => quitarTotp(o)}>
                        Retirar doble factor
                      </Button>
                    ) : (
                      <span />
                    )}
                    {o.bloqueado ? (
                      <Button size="sm" variant="outline" onClick={() => hacer(() => api("POST", `/operadores/${o.id}/desbloquear`, {}))}>
                        Desbloquear
                      </Button>
                    ) : (
                      <span />
                    )}
                  </div>
                </Td>
              </tr>
            );
          })}
        </tbody>
      </Table>

      <ModalMiCuenta abierto={miCuenta} onCerrar={() => setMiCuenta(false)} onCambio={cargar} />

      <Dialog open={alta !== null} onOpenChange={(abierto) => !abierto && setAlta(null)}>
        {alta && (
          <DialogContent titulo="Nuevo operador" descripcion="El panel genera una contraseña inicial y te la muestra una sola vez.">
            <form onSubmit={crear} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="op-usuario">Usuario</Label>
                <Input id="op-usuario" required maxLength={64} autoComplete="off" autoFocus value={alta.usuario} onChange={(e) => setAlta({ ...alta, usuario: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="op-rol">Rol</Label>
                <select id="op-rol" className={selector} value={alta.rol} onChange={(e) => setAlta({ ...alta, rol: e.target.value })}>
                  <option value="lectura">Solo lectura: consulta, no cambia nada</option>
                  <option value="administrador">Administrador: control total del panel</option>
                </select>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setAlta(null)}>
                  Cancelar
                </Button>
                <Button type="submit">Crear</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        )}
      </Dialog>
    </Seccion>
  );
}

function Sesiones() {
  const { operador, setOperador, avisar, avisarError, confirmar } = useApp();
  const [lista, setLista] = React.useState<Sesion[] | null>(null);

  const cargar = React.useCallback(
    async (auto = false) => {
      try {
        setLista(await api<Sesion[]>("GET", "/sesiones", undefined, { auto }));
      } catch (e) {
        if (!auto) avisarError(e);
      }
    },
    [avisarError],
  );

  React.useEffect(() => {
    cargar();
    const t = window.setInterval(() => cargar(true), 15000);
    return () => window.clearInterval(t);
  }, [cargar]);

  const cerrar = async (s: Sesion) => {
    try {
      await api("DELETE", `/sesiones/${s.id}`);
      await cargar();
    } catch (e) {
      avisarError(e);
    }
  };

  const cerrarLaMia = async () => {
    if (!(await confirmar("Cerrar esta sesión", "Saldrás del panel y tendrás que volver a entrar.", "Cerrar sesión"))) return;
    try {
      await api("DELETE", "/sesion");
    } finally {
      setOperador(null);
    }
  };

  const cerrarLasDemas = async () => {
    const admin = operador?.rol === "administrador";
    const ok = await confirmar(
      "Cerrar las demás sesiones",
      admin
        ? "Se cerrarán todas las sesiones de todos los operadores, menos esta. Quien esté usando el panel tendrá que volver a entrar."
        : "Se cerrarán todas tus sesiones en otros equipos o navegadores, menos esta.",
      "Cerrar las demás",
      true,
    );
    if (!ok) return;
    try {
      const r = await api<{ cerradas: number }>("DELETE", "/sesiones");
      await cargar();
      avisar({ titulo: "Sesiones cerradas", mensaje: `Se cerraron ${r.cerradas} sesión(es).` });
    } catch (e) {
      avisarError(e);
    }
  };

  const otras = (lista ?? []).filter((s) => !s.actual).length;

  return (
    <Seccion
      titulo="Sesiones abiertas"
      descripcion={operador?.rol === "administrador" ? "Quién tiene el panel abierto ahora mismo y desde dónde. Una sesión se cierra sola tras 30 minutos sin actividad y dura como máximo 12 horas." : "Tus sesiones abiertas. Una sesión se cierra sola tras 30 minutos sin actividad y dura como máximo 12 horas."}
      accion={
        <Button size="sm" variant="outline" disabled={otras === 0} onClick={cerrarLasDemas}>
          Cerrar las demás sesiones
        </Button>
      }
    >
      <Table id="sesiones">
        <thead>
          <tr>
            <Th>Operador</Th>
            <Th>Dirección IP</Th>
            <Th>Abierta</Th>
            <Th>Última actividad</Th>
            <Th>Caduca como máximo</Th>
            <Th sinOrden className="text-center">Acciones</Th>
          </tr>
        </thead>
        <tbody>
          {lista?.map((s) => (
            <tr key={s.id}>
              <Td className="font-medium">{s.operador}</Td>
              <Td className="text-xs">
                <Copiable texto={s.ip} />
              </Td>
              <Td className="whitespace-nowrap text-muted-foreground" valor={s.creada ?? ""}>{fecha(s.creada)}</Td>
              <Td className="whitespace-nowrap text-muted-foreground" valor={s.ultima_actividad ?? ""}>{fecha(s.ultima_actividad)}</Td>
              <Td className="whitespace-nowrap text-muted-foreground" valor={s.expira ?? ""}>{fecha(s.expira)}</Td>
              <Td>
                {/* El hueco de la píldora existe en todas las filas: así el botón
                    queda en el mismo sitio tenga o no «Esta sesión» al lado. */}
                <div className="grid grid-cols-[6.5rem_auto] items-center justify-center gap-2">
                  <span className="flex justify-end">{s.actual && <Badge>Esta sesión</Badge>}</span>
                  <Button size="sm" variant="outline" onClick={() => (s.actual ? cerrarLaMia() : cerrar(s))}>
                    Cerrar sesión
                  </Button>
                </div>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Seccion>
  );
}

// Bloqueos por intentos fallidos, tanto de direcciones IP como de cuentas, con
// su desbloqueo para los falsos positivos.
function Bloqueos({ onCambio }: { onCambio: number }) {
  const { avisarError } = useApp();
  const [datos, setDatos] = React.useState<DatosBloqueos | null>(null);

  const cargar = React.useCallback(
    async (auto = false) => {
      try {
        setDatos(await api<DatosBloqueos>("GET", "/bloqueos", undefined, { auto }));
      } catch (e) {
        if (!auto) avisarError(e);
      }
    },
    [avisarError],
  );

  React.useEffect(() => {
    cargar();
    const t = window.setInterval(() => cargar(true), 15000);
    return () => window.clearInterval(t);
  }, [cargar, onCambio]);

  const desbloquear = async (accion: () => Promise<unknown>) => {
    try {
      await accion();
      await cargar();
    } catch (e) {
      avisarError(e);
    }
  };

  const regla = datos?.regla;
  const vacio = datos && datos.bloqueos.length === 0 && datos.cuentas.length === 0;
  return (
    <Seccion
      titulo="Bloqueos por intentos fallidos"
      descripcion={
        regla
          ? `Una dirección IP que falla el inicio de sesión ${regla.intentos} veces en ${regla.ventana_minutos} minutos queda bloqueada ${regla.bloqueo_minutos} minutos, sea cual sea la cuenta. Una cuenta con ${regla.intentos_cuenta} fallos seguidos queda bloqueada ${regla.bloqueo_cuenta_m} minutos, venga de donde venga. Si es un falso positivo, desbloquéalo aquí. Las sesiones ya abiertas no se ven afectadas.`
          : "Direcciones IP y cuentas con el inicio de sesión bloqueado por intentos fallidos."
      }
    >
      <Table id="bloqueos">
        <thead>
          <tr>
            <Th>Tipo</Th>
            <Th>Bloqueado</Th>
            <Th>Intentos fallidos</Th>
            <Th>Hasta</Th>
            <Th sinOrden className="text-center">Acciones</Th>
          </tr>
        </thead>
        <tbody>
          {vacio && (
            <tr>
              <Td colSpan={5}>
                <EstadoVacio titulo="No hay ninguna dirección ni cuenta bloqueada." />
              </Td>
            </tr>
          )}
          {datos?.bloqueos.map((b) => (
            <tr key={"ip-" + b.ip}>
              <Td>
                <Badge variant="destructive">Dirección IP</Badge>
              </Td>
              <Td className="text-xs">
                <Copiable texto={b.ip} />
              </Td>
              <Td valor={b.intentos}>{b.intentos}</Td>
              <Td className="whitespace-nowrap text-muted-foreground" valor={b.hasta ?? ""}>{fecha(b.hasta)}</Td>
              <Td className="text-center">
                <Button size="sm" variant="outline" onClick={() => desbloquear(() => api("POST", "/bloqueos/desbloquear", { ip: b.ip }))}>
                  Desbloquear
                </Button>
              </Td>
            </tr>
          ))}
          {datos?.cuentas.map((c) => (
            <tr key={"cuenta-" + c.id}>
              <Td>
                <Badge variant="destructive">Cuenta</Badge>
              </Td>
              <Td className="font-medium">{c.usuario}</Td>
              <Td>{c.intentos}</Td>
              <Td className="whitespace-nowrap text-muted-foreground" valor={c.hasta ?? ""}>{fecha(c.hasta)}</Td>
              <Td className="text-center">
                <Button size="sm" variant="outline" onClick={() => desbloquear(() => api("POST", `/operadores/${c.id}/desbloquear`, {}))}>
                  Desbloquear
                </Button>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Seccion>
  );
}

function Actividad() {
  const { avisarError } = useApp();
  const [datos, setDatos] = React.useState<PaginaEventos | null>(null);
  const [buscar, setBuscar] = React.useState("");
  // El registro está paginado: lo ordena el servidor. Por omisión, lo más reciente primero.
  const { orden, ordenarPor } = useOrden<"fecha" | "operador" | "accion" | "objeto" | "ip">("fecha", "actividad-datos", false);
  const ordenar = (campo: "fecha" | "operador" | "accion" | "objeto" | "ip") => {
    ordenarPor(campo);
    setPagina(1);
  };
  const [pagina, setPagina] = React.useState(1);
  const [tamano, setTamano] = React.useState(25);
  const [recarga, setRecarga] = React.useState(0);

  React.useEffect(() => {
    const t = window.setTimeout(async () => {
      try {
        const q = new URLSearchParams({ pagina: String(pagina), tamano: String(tamano) });
        if (buscar.trim()) q.set("buscar", buscar.trim());
        q.set("orden", orden.campo);
        q.set("dir", orden.asc ? "asc" : "desc");
        const r = await api<PaginaEventos>("GET", `/auditoria?${q}`);
        setDatos(r);
        // El servidor corrige una página que ya no existe.
        if (r.pagina !== pagina) setPagina(r.pagina);
      } catch (e) {
        avisarError(e);
      }
    }, 250);
    return () => window.clearTimeout(t);
  }, [buscar, pagina, tamano, recarga, avisarError]);

  return (
    <Seccion
      titulo="Registro de actividad"
      descripcion="Accesos al panel, intentos fallidos y cada cambio hecho, con quién lo hizo y desde qué dirección. Nunca guarda contraseñas ni secretos."
      accion={
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="w-56"
            placeholder="Buscar operador, acción o IP"
            aria-label="Buscar en la actividad"
            value={buscar}
            onChange={(e) => {
              setBuscar(e.target.value);
              setPagina(1);
            }}
          />
          <BotonVaciar
            registro="actividad"
            onHecho={() => {
              setPagina(1);
              setRecarga((n) => n + 1);
            }}
          />
        </div>
      }
    >
      <Table id="actividad" ordenLocal={false}>
        <thead>
          <tr>
            <ThOrden campo="fecha" orden={orden} onOrden={ordenar}>
              Fecha
            </ThOrden>
            <ThOrden campo="operador" orden={orden} onOrden={ordenar}>
              Operador
            </ThOrden>
            <ThOrden campo="accion" orden={orden} onOrden={ordenar}>
              Qué pasó
            </ThOrden>
            <ThOrden campo="objeto" orden={orden} onOrden={ordenar}>
              Sobre
            </ThOrden>
            <ThOrden campo="ip" orden={orden} onOrden={ordenar}>
              Dirección IP
            </ThOrden>
          </tr>
        </thead>
        <tbody>
          {datos?.eventos.length === 0 && (
            <tr>
              <Td colSpan={5}>
                <EstadoVacio titulo="No hay actividad que coincida." />
              </Td>
            </tr>
          )}
          {datos?.eventos.map((e) => (
            <tr key={e.id}>
              <Td className="whitespace-nowrap text-muted-foreground" valor={e.fecha ?? ""}>{fecha(e.fecha)}</Td>
              <Td className="font-medium">{e.operador}</Td>
              <Td>
                {e.accion === "sesion.fallida" || e.accion === "config.rechazada" || e.accion === "ip.bloqueada" ? (
                  <span className="text-destructive">{nombreAccion[e.accion]}</span>
                ) : (
                  (nombreAccion[e.accion] ?? e.accion)
                )}
                {e.detalle !== "{}" && <div className="max-w-[22rem] truncate font-mono text-xs text-muted-foreground" title={e.detalle}>{e.detalle}</div>}
              </Td>
              <Td>{e.objeto}</Td>
              <Td className="text-xs">
                <Copiable texto={e.ip} />
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>

      <Paginacion
        pagina={datos?.pagina ?? 1}
        paginas={datos?.paginas ?? 1}
        total={datos?.total ?? 0}
        tamano={tamano}
        onPagina={setPagina}
        onTamano={(t) => {
          setTamano(t);
          setPagina(1);
        }}
      />
    </Seccion>
  );
}

export default function Seguridad() {
  const { operador } = useApp();
  const admin = operador?.rol === "administrador";
  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm text-muted-foreground">
          Acceso a la plataforma: quién puede entrar, las sesiones abiertas y el registro de lo que se hace. Tu contraseña y tu verificación en dos pasos están en el botón «Mi cuenta».
        </p>
      </div>
      {admin ? <Operadores /> : <TarjetaMiCuenta />}
      <Sesiones />
      {admin && <Bloqueos onCambio={0} />}
      {admin && <Actividad />}
    </div>
  );
}
