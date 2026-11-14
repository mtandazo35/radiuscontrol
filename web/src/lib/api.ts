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

export async function api<T>(metodo: string, ruta: string, cuerpo?: unknown): Promise<T> {
  let respuesta: Response;
  try {
    respuesta = await fetch(`/api${ruta}`, {
      method: metodo,
      credentials: "same-origin",
      headers: { "X-RC": "1", ...(cuerpo !== undefined ? { "Content-Type": "application/json" } : {}) },
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
      window.dispatchEvent(new Event("rc:sesion-caducada"));
    }
    throw new ErrorApi(respuesta.status, datos?.error ?? `Error ${respuesta.status}`, datos?.detalle, datos);
  }
  return datos as T;
}

export interface Operador {
  usuario: string;
  rol: string;
  totp: boolean;
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
}

export interface RespuestaRouter {
  router: Router;
  secreto_generado?: string;
  script_rsc?: string;
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

export interface Empresa {
  nombre: string;
  routers: number;
}

export interface Autenticacion {
  id: number;
  fecha: string;
  resultado: "aceptado" | "rechazado";
  usuario: string;
  ip_origen: string;
  router_id: number | null;
  router: string;
  empresa: string;
  nas_identifier: string;
  nas_ip: string;
  origen: string;
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
