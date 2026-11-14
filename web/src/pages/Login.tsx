import { ShieldCheck } from "lucide-react";
import * as React from "react";
import { Button, Card, Input, Label } from "@/components/ui";
import { api, type Operador } from "@/lib/api";
import { useApp } from "../contexto";

export default function Login() {
  const { setOperador } = useApp();
  const [usuario, setUsuario] = React.useState("");
  const [clave, setClave] = React.useState("");
  const [error, setError] = React.useState("");
  const [ocupado, setOcupado] = React.useState(false);

  const entrar = async (e: React.FormEvent) => {
    e.preventDefault();
    setOcupado(true);
    setError("");
    try {
      setOperador(await api<Operador>("POST", "/sesion", { usuario, clave }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error inesperado.");
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
