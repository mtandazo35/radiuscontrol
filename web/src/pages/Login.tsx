import { ShieldCheck } from "lucide-react";
import * as React from "react";
import { Button, Card, Input, Label } from "@/components/ui";
import { api, ErrorApi, type Operador } from "@/lib/api";
import { useApp } from "../contexto";

export default function Login() {
  const { setOperador } = useApp();
  const [usuario, setUsuario] = React.useState("");
  const [clave, setClave] = React.useState("");
  const [codigo, setCodigo] = React.useState("");
  const [pideCodigo, setPideCodigo] = React.useState(false);
  const [error, setError] = React.useState("");
  const [ocupado, setOcupado] = React.useState(false);

  const entrar = async (e: React.FormEvent) => {
    e.preventDefault();
    setOcupado(true);
    setError("");
    try {
      setOperador(await api<Operador>("POST", "/sesion", { usuario, clave, codigo: pideCodigo ? codigo : "" }));
    } catch (err) {
      if (err instanceof ErrorApi && err.datos?.requiere_codigo) {
        // La contraseña es correcta; falta el segundo factor.
        setError(pideCodigo ? err.message : "");
        setPideCodigo(true);
        setCodigo("");
      } else {
        setError(err instanceof Error ? err.message : "Error inesperado.");
      }
    } finally {
      setOcupado(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm p-6">
        <div className="mb-6 flex items-center gap-2">
          <ShieldCheck className="size-6 text-primary" />
          <h1 className="text-xl font-semibold tracking-tight">RadiusControl</h1>
        </div>
        <form onSubmit={entrar} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="usuario">Usuario</Label>
            <Input id="usuario" autoComplete="username" autoFocus required value={usuario} onChange={(e) => setUsuario(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="clave">Contraseña</Label>
            <Input id="clave" type="password" autoComplete="current-password" required value={clave} onChange={(e) => setClave(e.target.value)} />
          </div>
          {pideCodigo && (
            <div className="space-y-2">
              <Label htmlFor="codigo">Código de verificación</Label>
              <Input
                id="codigo"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                required
                maxLength={7}
                placeholder="6 cifras de tu aplicación"
                value={codigo}
                onChange={(e) => setCodigo(e.target.value)}
              />
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={ocupado}>
            {ocupado ? "Entrando…" : "Entrar"}
          </Button>
        </form>
      </Card>
    </div>
  );
}
