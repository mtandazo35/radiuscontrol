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
