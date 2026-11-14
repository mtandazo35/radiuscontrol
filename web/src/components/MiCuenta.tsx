import QRCode from "qrcode";
import * as React from "react";
import { Badge, Button, Dialog, DialogContent, DialogFooter, Input, Label } from "@/components/ui";
import { api } from "@/lib/api";
import { useApp } from "../contexto";

export const nombreRol: Record<string, string> = { administrador: "Administrador", lectura: "Solo lectura" };

// Ventana con lo que cada persona gestiona de su propia cuenta: la contraseña
// y la verificación en dos pasos.
export function ModalMiCuenta({
  abierto,
  onCerrar,
  onCambio,
  soloClave,
}: {
  abierto: boolean;
  onCerrar: () => void;
  onCambio?: () => void;
  // Muestra solo el cambio de contraseña.
  soloClave?: boolean;
}) {
  const { operador, refrescarOperador, avisar, avisarError } = useApp();
  const [vista, setVista] = React.useState<"inicio" | "alta" | "baja">("inicio");
  const [actual, setActual] = React.useState("");
  const [nueva, setNueva] = React.useState("");
  const [repetida, setRepetida] = React.useState("");
  const [alta, setAlta] = React.useState<{ secreto: string; qr: string } | null>(null);
  const [codigo, setCodigo] = React.useState("");
  const [claveBaja, setClaveBaja] = React.useState("");

  React.useEffect(() => {
    if (abierto) {
      setVista("inicio");
      setActual("");
      setNueva("");
      setRepetida("");
      setAlta(null);
      setCodigo("");
      setClaveBaja("");
    }
  }, [abierto]);

  const cambiarClave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (nueva !== repetida) {
      avisar({ titulo: "Las contraseñas no coinciden", mensaje: "Escribe la contraseña nueva dos veces, igual." });
      return;
    }
    try {
      await api("POST", "/cuenta/clave", { actual, nueva });
      onCerrar();
      onCambio?.();
      avisar({ titulo: "Contraseña cambiada", mensaje: "Tus otras sesiones abiertas se han cerrado." });
    } catch (err) {
      avisarError(err);
    }
  };

  const empezarAlta = async () => {
    try {
      const r = await api<{ secreto: string; uri: string }>("POST", "/cuenta/totp");
      setCodigo("");
      setAlta({ secreto: r.secreto, qr: await QRCode.toDataURL(r.uri, { margin: 1, width: 220 }) });
      setVista("alta");
    } catch (err) {
      avisarError(err);
    }
  };

  const confirmarAlta = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api("POST", "/cuenta/totp/confirmar", { codigo });
      await refrescarOperador();
      onCerrar();
      onCambio?.();
      avisar({ titulo: "Verificación en dos pasos activada", mensaje: "A partir de ahora el panel te pedirá el código al entrar." });
    } catch (err) {
      avisarError(err);
    }
  };

  const confirmarBaja = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api("POST", "/cuenta/totp/desactivar", { clave: claveBaja });
      await refrescarOperador();
      onCerrar();
      onCambio?.();
    } catch (err) {
      avisarError(err);
    }
  };

  const titulos = {
    inicio: soloClave ? "Cambiar contraseña" : "Mi cuenta",
    alta: "Activar la verificación en dos pasos",
    baja: "Desactivar la verificación en dos pasos",
  };
  const descripciones = {
    inicio: `Has entrado como ${operador?.usuario} (${nombreRol[operador?.rol ?? ""] ?? operador?.rol}).`,
    alta: "Escanea el código con tu aplicación y escribe las 6 cifras que te muestre.",
    baja: "Tu cuenta quedará protegida solo por la contraseña. Confírmalo escribiéndola.",
  };

  return (
    <Dialog open={abierto} onOpenChange={(a) => !a && onCerrar()}>
      <DialogContent titulo={titulos[vista]} descripcion={descripciones[vista]}>
        {vista === "inicio" && (
          <div className="space-y-6">
            <div className={soloClave ? "hidden" : "space-y-3 rounded-md border p-4"}>
              <h3 className="text-sm font-semibold">Verificación en dos pasos</h3>
              <p className="text-sm text-muted-foreground">
                Además de la contraseña, el panel pide un código de 6 cifras que genera una aplicación en tu teléfono
                (Google Authenticator, Aegis, Microsoft Authenticator u otra compatible).
              </p>
              {operador?.totp ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="success">Activada</Badge>
                  <Button variant="outline" size="sm" onClick={() => setVista("baja")}>
                    Desactivar
                  </Button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="warning">Sin activar</Badge>
                  <Button size="sm" onClick={empezarAlta}>
                    Activar
                  </Button>
                </div>
              )}
            </div>

            <form onSubmit={cambiarClave} className="space-y-3 rounded-md border p-4">
              <h3 className="text-sm font-semibold">Cambiar contraseña</h3>
              <div className="space-y-2">
                <Label htmlFor="actual">Contraseña actual</Label>
                <Input id="actual" type="password" autoComplete="current-password" required value={actual} onChange={(e) => setActual(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="nueva">Contraseña nueva</Label>
                <Input id="nueva" type="password" autoComplete="new-password" required minLength={12} value={nueva} onChange={(e) => setNueva(e.target.value)} />
                <p className="text-xs text-muted-foreground">Mínimo 12 caracteres.</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="repetida">Repite la contraseña nueva</Label>
                <Input id="repetida" type="password" autoComplete="new-password" required minLength={12} value={repetida} onChange={(e) => setRepetida(e.target.value)} />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={onCerrar}>
                  Cerrar
                </Button>
                <Button type="submit">Cambiar contraseña</Button>
              </DialogFooter>
            </form>
          </div>
        )}

        {vista === "alta" && alta && (
          <form onSubmit={confirmarAlta} className="space-y-4">
            <div className="flex justify-center">
              <img src={alta.qr} alt="Código QR para la aplicación de autenticación" className="rounded-md border bg-white p-2" width={220} height={220} />
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Si no puedes escanearlo, escribe esta clave en la aplicación:</p>
              <pre className="overflow-x-auto rounded-md border bg-muted p-2 text-center font-mono text-xs">{alta.secreto}</pre>
            </div>
            <div className="space-y-2">
              <Label htmlFor="codigo-alta">Código de 6 cifras</Label>
              <Input id="codigo-alta" inputMode="numeric" autoComplete="one-time-code" required maxLength={7} autoFocus value={codigo} onChange={(e) => setCodigo(e.target.value)} />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setVista("inicio")}>
                Volver
              </Button>
              <Button type="submit">Activar</Button>
            </DialogFooter>
          </form>
        )}

        {vista === "baja" && (
          <form onSubmit={confirmarBaja} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="clave-baja">Contraseña</Label>
              <Input id="clave-baja" type="password" autoComplete="current-password" required autoFocus value={claveBaja} onChange={(e) => setClaveBaja(e.target.value)} />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setVista("inicio")}>
                Volver
              </Button>
              <Button type="submit" variant="destructive">
                Desactivar
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
