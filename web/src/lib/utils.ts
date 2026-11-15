import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const formatoFecha = new Intl.DateTimeFormat("es-EC", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "America/Guayaquil",
});

// Las fechas se muestran siempre en hora de Ecuador.
export function fecha(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : formatoFecha.format(d);
}

export function huellaCorta(sha: string | undefined) {
  return sha ? sha.slice(0, 12) : "—";
}

// FreeRADIUS explica los rechazos en su propio idioma; los más habituales se
// traducen a algo que se entienda sin conocerlo.
export function motivoLegible(motivo: string) {
  if (!motivo) return "Usuario desconocido o sin permiso";
  if (motivo.includes("No NT-Password") || motivo.includes("No Auth-Type found")) {
    return "El usuario no existe en RadiusControl o está suspendido";
  }
  if (motivo.includes("MS-CHAP2-Response is incorrect") || motivo.includes("password is incorrect") || motivo.includes("does not match")) {
    return "Contraseña incorrecta";
  }
  return motivo;
}
