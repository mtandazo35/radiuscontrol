import { Download } from "lucide-react";
import * as React from "react";
import { Button, Card, Dialog, DialogContent, DialogFooter, Input, Label } from "@/components/ui";
import { ErrorApi } from "@/lib/api";
import { useApp } from "../contexto";

const FRASE_MINIMA = 12;

// Descarga de la base para llevarla a otro servidor. El archivo lleva también
// la clave maestra (sin ella los secretos no se pueden descifrar allí), así que
// va cifrado con una frase que se escribe aquí y se pide al restaurar.
export function Migracion() {
  const { avisar, avisarError } = useApp();
  const [abierto, setAbierto] = React.useState(false);
  const [clave, setClave] = React.useState("");
  const [frase, setFrase] = React.useState("");
  const [repetida, setRepetida] = React.useState("");
  const [ocupado, setOcupado] = React.useState(false);

  const abrir = () => {
    setClave("");
    setFrase("");
    setRepetida("");
    setAbierto(true);
  };

  const fraseCorta = frase.length > 0 && [...frase].length < FRASE_MINIMA;
  const distintas = repetida.length > 0 && frase !== repetida;
  const listo = clave.length > 0 && [...frase].length >= FRASE_MINIMA && frase === repetida;

  const descargar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!listo || ocupado) return;
    setOcupado(true);
    try {
      let r: Response;
      try {
        r = await fetch("/api/migracion/exportar", {
          method: "POST",
          credentials: "same-origin",
          headers: { "X-RC": "1", "Content-Type": "application/json" },
          body: JSON.stringify({ clave, frase }),
        });
      } catch {
        throw new ErrorApi(0, "No se pudo contactar con el servidor.");
      }
      if (!r.ok) {
        let datos: any = null;
        try {
          datos = await r.json();
        } catch {
          // Sin cuerpo JSON.
        }
        if (r.status === 401) window.dispatchEvent(new CustomEvent("rc:sesion-caducada", { detail: "" }));
        throw new ErrorApi(r.status, datos?.error ?? `Error ${r.status}`, datos?.detalle, datos);
      }
      const nombre = /filename="([^"]+)"/.exec(r.headers.get("Content-Disposition") ?? "")?.[1] ?? "radiuscontrol-migracion.rcm";
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = nombre;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10000);
      setAbierto(false);
      avisar({
        titulo: "Archivo de migración descargado",
        mensaje: `Se guardó como ${nombre}. Para instalarlo en el servidor nuevo, súbelo a /root y ejecuta el instalador con RESTAURAR=/root/${nombre}. Te pedirá la frase.`,
      });
    } catch (err) {
      avisarError(err);
    } finally {
      setOcupado(false);
      setClave("");
    }
  };

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3 p-4">
        <div className="max-w-prose">
          <h2 className="text-sm font-semibold">Migrar a otro servidor</h2>
          <p className="text-sm text-muted-foreground">
            Descarga toda la base (routers, usuarios, empresas, operadores, ajustes e historial) en un archivo cifrado,
            para instalar RadiusControl en otro servidor con los mismos datos.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={abrir}>
          <Download /> Descargar base de datos
        </Button>
      </div>

      <Dialog open={abierto} onOpenChange={(a) => !a && !ocupado && setAbierto(false)}>
        <DialogContent
          titulo="Descargar base de datos"
          descripcion="El archivo lleva los secretos de los routers y las contraseñas de los usuarios. Se cifra con la frase que escribas aquí."
        >
          <form onSubmit={descargar} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="migracion-clave">Tu contraseña</Label>
              <Input
                id="migracion-clave"
                type="password"
                autoComplete="current-password"
                required
                value={clave}
                onChange={(e) => setClave(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="migracion-frase">Frase para cifrar el archivo</Label>
              <Input
                id="migracion-frase"
                type="password"
                autoComplete="new-password"
                required
                value={frase}
                onChange={(e) => setFrase(e.target.value)}
                aria-describedby="migracion-frase-ayuda"
              />
              <p id="migracion-frase-ayuda" className={`text-xs ${fraseCorta ? "text-destructive" : "text-muted-foreground"}`}>
                Al menos {FRASE_MINIMA} caracteres.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="migracion-repetida">Repite la frase</Label>
              <Input
                id="migracion-repetida"
                type="password"
                autoComplete="new-password"
                required
                value={repetida}
                onChange={(e) => setRepetida(e.target.value)}
              />
              {distintas && <p className="text-xs text-destructive">Las frases no coinciden.</p>}
            </div>
            <p className="rounded-md border border-warning/50 p-3 text-xs text-warning">
              Guarda la frase en un lugar seguro: sin ella el archivo no se puede abrir, y nadie puede recuperarla. Guarda
              también el archivo con cuidado y bórralo cuando termines la migración.
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setAbierto(false)} disabled={ocupado}>
                Cancelar
              </Button>
              <Button type="submit" disabled={!listo || ocupado}>
                {ocupado ? "Preparando…" : "Descargar"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
