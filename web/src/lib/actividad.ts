// Conversión del campo de detalle técnico del registro de actividad a frases legibles en español.
import { fecha } from "@/lib/utils";

function formatearBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) {
    const kb = (n / 1024).toLocaleString("es-EC", { maximumFractionDigits: 1 });
    return `${kb} KB`;
  }
  const mb = (n / 1048576).toLocaleString("es-EC", { maximumFractionDigits: 1 });
  return `${mb} MB`;
}

function plural(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

export function detalleLegible(detalle: string): string {
  if (!detalle || detalle.trim() === "" || detalle.trim() === "{}") {
    return "";
  }

  let obj: Record<string, unknown>;
  try {
    const parseado = JSON.parse(detalle);
    if (!parseado || typeof parseado !== "object" || Array.isArray(parseado)) {
      return detalle;
    }
    obj = parseado as Record<string, unknown>;
  } catch {
    return detalle;
  }

  const claves = Object.keys(obj);
  if (claves.length === 0) {
    return "";
  }

  const frases: string[] = [];
  const procesadas = new Set<string>();

  for (const k of claves) {
    if (procesadas.has(k)) continue;

    if (k === "de" || k === "a") {
      if ("de" in obj && "a" in obj) {
        procesadas.add("de");
        procesadas.add("a");
        if ("desde" in obj) procesadas.add("desde");
        const deVal = String(obj.de ?? "").slice(0, 7);
        const aVal = String(obj.a ?? "").slice(0, 7);
        frases.push(`De ${deVal} a ${aVal}`);
        continue;
      }
    }

    if (k === "desde") {
      procesadas.add("desde");
      if ("de" in obj) {
        continue;
      }
      const desdeVal = String(obj.desde ?? "").slice(0, 7);
      frases.push(`Desde la versión ${desdeVal}`);
      continue;
    }

    if (k === "disco_antes" || k === "disco_despues") {
      if ("disco_antes" in obj && "disco_despues" in obj) {
        procesadas.add("disco_antes");
        procesadas.add("disco_despues");
        frases.push(`Disco ${String(obj.disco_antes)} % → ${String(obj.disco_despues)} %`);
        continue;
      }
    }

    procesadas.add(k);
    const v = obj[k];

    switch (k) {
      case "doble_factor":
        frases.push(v ? "Con doble factor" : "Sin doble factor");
        break;
      case "motivo": {
        const s = String(v ?? "");
        frases.push(s ? s.charAt(0).toUpperCase() + s.slice(1) : "");
        break;
      }
      case "secreto_generado":
        frases.push(v ? "Secreto generado" : "Secreto escrito a mano");
        break;
      case "clave_generada":
        frases.push(v ? "Contraseña generada" : "Contraseña escrita a mano");
        break;
      case "activo":
        frases.push(v ? "Activo" : "Suspendido");
        break;
      case "acceso":
        frases.push(`Acceso ${String(v ?? "")}`);
        break;
      case "redes": {
        const n = Number(v) || 0;
        frases.push(plural(n, "red", "redes"));
        break;
      }
      case "asignaciones": {
        const n = Number(v) || 0;
        if (n > 0) {
          frases.push(plural(n, "asignación", "asignaciones"));
        }
        break;
      }
      case "routers": {
        const n = Number(v) || 0;
        frases.push(plural(n, "router", "routers"));
        break;
      }
      case "usuarios": {
        const n = Number(v) || 0;
        frases.push(plural(n, "usuario", "usuarios"));
        break;
      }
      case "operadores": {
        const n = Number(v) || 0;
        frases.push(plural(n, "operador", "operadores"));
        break;
      }
      case "empresa":
        frases.push(`Empresa ${String(v ?? "")}`);
        break;
      case "grupo":
        frases.push(`Grupo ${String(v ?? "")}`);
        break;
      case "descripcion":
        frases.push(`«${String(v ?? "")}»`);
        break;
      case "autenticaciones": {
        const n = Number(v) || 0;
        frases.push(`${n} autenticaciones borradas`);
        break;
      }
      case "actividad": {
        const n = Number(v) || 0;
        frases.push(`${n} eventos borrados`);
        break;
      }
      case "dias": {
        const n = Number(v) || 0;
        frases.push(n === 0 ? "Todo" : `Lo anterior a ${n} días`);
        break;
      }
      case "dias_autenticaciones":
        frases.push(`Autenticaciones: ${String(v ?? "")} días`);
        break;
      case "dias_actividad":
        frases.push(`Actividad: ${String(v ?? "")} días`);
        break;
      case "ultima_actividad":
        frases.push(`Última actividad ${fecha(v as string | null | undefined)}`);
        break;
      case "bytes": {
        const n = Number(v) || 0;
        frases.push(formatearBytes(n));
        break;
      }
      default: {
        const nombreClave = k.replace(/_/g, " ");
        let valorTexto: string;
        if (typeof v === "boolean") {
          valorTexto = v ? "sí" : "no";
        } else {
          valorTexto = String(v ?? "");
        }
        frases.push(`${nombreClave}: ${valorTexto}`);
        break;
      }
    }
  }

  return frases.filter((f) => f.length > 0).join(" · ");
}
