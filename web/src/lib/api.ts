export class ErrorApi extends Error {
  constructor(
    public estado: number,
    mensaje: string,
    public detalle?: string,
    public datos?: any,
  ) {
    super(mensaje);
  }
}

let ultimaActividad = Date.now();

export function momentoUltimaActividad() {
  return ultimaActividad;
}

// auto: la petición la lanza el panel por su cuenta (un refresco periódico) y
// no debe contar como actividad de la persona.
export async function api<T>(metodo: string, ruta: string, cuerpo?: unknown, opciones?: { auto?: boolean }): Promise<T> {
  if (!opciones?.auto) ultimaActividad = Date.now();
  let respuesta: Response;
  try {
    respuesta = await fetch(`/api${ruta}`, {
      method: metodo,
      credentials: "same-origin",
      headers: {
        "X-RC": "1",
        ...(opciones?.auto ? { "X-RC-Auto": "1" } : {}),
        ...(cuerpo !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined,
    });
  } catch {
    throw new ErrorApi(0, "No se pudo contactar con el servidor.");
  }
  let datos: any = null;
  try {
    datos = await respuesta.json();
  } catch {
    // Respuesta sin cuerpo JSON.
  }
  if (!respuesta.ok) {
    if (respuesta.status === 401 && ruta !== "/sesion") {
      window.dispatchEvent(new CustomEvent("rc:sesion-caducada", { detail: datos?.motivo === "inactividad" ? datos.error : "" }));
    }
    throw new ErrorApi(respuesta.status, datos?.error ?? `Error ${respuesta.status}`, datos?.detalle, datos);
  }
  return datos as T;
}

export interface Operador {
  usuario: string;
  rol: string;
  totp: boolean;
  expira: string;
  minutos_inactividad: number;
}

export interface OperadorDetalle {
  id: number;
  usuario: string;
  rol: string;
  activo: boolean;
  totp: boolean;
  bloqueado: boolean;
  ultimo_acceso: string | null;
  clave_cambiada: string;
  creado: string;
  sesiones: number;
  intentos_fallidos: number;
}

export interface Sesion {
  id: number;
  operador: string;
  ip: string;
  creada: string;
  expira: string;
  ultima_actividad: string;
  actual: boolean;
}

export interface Evento {
  id: number;
  fecha: string;
  operador: string;
  ip: string;
  accion: string;
  objeto: string;
  detalle: string;
}

export interface Router {
  id: number;
  nombre: string;
  empresa: string;
  descripcion: string;
  activo: boolean;
  redes: string[];
  secreto_rotado: string;
  exigir_message_authenticator: boolean;
  creado: string;
  // general: entran todos los usuarios activos con su grupo general.
  // restringido: solo los de «accesos», con el grupo que tengan ahí.
  acceso: ModoAcceso;
  accesos: AccesoRouter[];
}

export type ModoAcceso = "general" | "restringido";

export interface AccesoRouter {
  usuario_id: number;
  usuario: string;
  grupo: string;
}

export interface CambioMasivoAccesos {
  routers: { todos: boolean; empresa: string; ids: number[] };
  usuarios: number[];
  accion: "asignar" | "quitar" | "modo";
  grupo: string;
  modo: "" | ModoAcceso;
}

export interface ResultadoCambioMasivo {
  routers: number;
  asignaciones: number;
}

export interface RespuestaRouter {
  router: Router;
  secreto_generado?: string;
  script_rsc?: string;
}

// Descripción puesta a una dirección o red desde la que se entra a los routers.
export interface Origen {
  id: number;
  red: string;
  nombre: string;
  operador: string;
  creado: string;
}

export interface Usuario {
  id: number;
  usuario: string;
  nombre_completo: string;
  grupo: string;
  activo: boolean;
  clave_cambiada: string;
  creado: string;
}

export interface RespuestaUsuario {
  usuario: Usuario;
  clave_generada?: string;
}

export interface Actualizacion {
  busqueda: {
    instalado: string;
    instalado_fecha: string;
    instalado_asunto: string;
    ultimo: string;
    cambios: { commit: string; asunto: string; fecha: string }[];
    buscado: string;
    error: string;
  } | null;
  pedido: boolean;
  proceso: {
    estado: "en-curso" | "ok" | "revertida" | "fallida";
    paso: string;
    pasos: string[];
    mensaje: string;
    de: string;
    a: string;
    quien: string;
    inicio: string;
    fin: string;
  } | null;
}

export interface Bloqueos {
  bloqueos: { ip: string; desde: string; hasta: string; intentos: number }[];
  cuentas: { id: number; usuario: string; hasta: string; intentos: number }[];
  regla: { intentos: number; ventana_minutos: number; bloqueo_minutos: number; intentos_cuenta: number; bloqueo_cuenta_m: number };
}

// Limpieza de registros: cuánto se conserva, cada cuánto se limpia y a partir
// de qué uso de disco se limpia de emergencia.
export interface AjustesPurga {
  dias_autenticaciones: number;
  dias_actividad: number;
  cada_horas: number;
  porcentaje_disco: number;
}

export interface RegistroPurga {
  id: number;
  fecha: string;
  motivo: "programada" | "manual" | "disco";
  operador: string;
  autenticaciones: number;
  actividad: number;
  disco_antes: number;
  disco_despues: number;
}

export interface Purga {
  ajustes: AjustesPurga;
  disco: { porcentaje: number; total_bytes: number; libre_bytes: number };
  // Lo que ocupan los registros y si borrarlos liberaría algo apreciable.
  registros_bytes: number;
  registros_pesan: boolean;
  filas: { autenticaciones: number; actividad: number };
  mas_antiguo: { autenticaciones: string | null; actividad: string | null };
  ultimas: RegistroPurga[];
}

// Accesos al servidor: qué direcciones llegan a la web del panel (443/tcp) y
// al SSH. «red» es un prefijo o la palabra «cualquiera».
export type ServicioAcceso = "panel" | "ssh";

export interface AccesoGestionado {
  id: number;
  servicio: ServicioAcceso;
  red: string;
  descripcion: string;
  operador: string;
  creado: string;
  // El firewall ya tiene puesta la regla.
  aplicada: boolean;
}

// Regla del firewall para esos puertos que no gestiona el panel.
export interface AccesoAjeno {
  servicio: ServicioAcceso;
  red: string;
  comentario: string;
}

export interface AccesosServidor {
  puerto_ssh: number;
  tu_ip: string;
  gestionadas: AccesoGestionado[];
  ajenas: AccesoAjeno[];
  firewall: {
    estado: "sincronizado" | "error" | "sin-configuracion" | "sin-datos";
    ufw_activo: boolean;
    desde: string;
  } | null;
}

export interface PaginaAutenticaciones {
  autenticaciones: Autenticacion[];
  total: number;
  pagina: number;
  paginas: number;
  tamano: number;
}

export interface PaginaEventos {
  eventos: Evento[];
  total: number;
  pagina: number;
  paginas: number;
  tamano: number;
}

export interface Empresa {
  nombre: string;
  routers: number;
}

export interface Autenticacion {
  id: number;
  fecha: string;
  resultado: "aceptado" | "rechazado" | "sondeo";
  usuario: string;
  ip_origen: string;
  router_id: number | null;
  router: string;
  empresa: string;
  nas_identifier: string;
  nas_ip: string;
  origen: string;
  // Descripción de esa dirección, si se le puso una; si no, vacío.
  origen_nombre: string;
  metodo: string;
  grupo: string;
  motivo: string;
}

export interface Version {
  id: number;
  creada: string;
  operador: string;
  estado: string;
  mensaje: string;
  activa: boolean;
  routers: number;
  usuarios: number;
  sha_clients: string;
  sha_authorize: string;
}

export interface Estado {
  cambios_pendientes: boolean;
  sincronizado: boolean;
  deseado: { routers: number; usuarios: number; sha_clients: string; sha_authorize: string };
  activa: Version | null;
  freeradius: {
    estado: string;
    version: string;
    sha_clients: string;
    sha_authorize: string;
    desde: string;
  } | null;
  firewall: {
    estado: string;
    version: string;
    ufw_activo: boolean;
    redes: string[];
    desde: string;
  } | null;
  firewall_al_dia: boolean;
  ultimo_fallo: string;
}
