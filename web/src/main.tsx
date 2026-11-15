import * as React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { ProveedorApp } from "./contexto";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./index.css";

const guardado = localStorage.getItem("rc-tema");
// Oscuro por defecto; el claro queda a elección de cada persona.
const oscuro = guardado ? guardado === "oscuro" : true;
document.documentElement.classList.toggle("dark", oscuro);

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <ProveedorApp>
        <App />
      </ProveedorApp>
    </BrowserRouter>
  </React.StrictMode>,
);
