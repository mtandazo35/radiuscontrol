import * as React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { ProveedorApp } from "./contexto";
import "./index.css";

const guardado = localStorage.getItem("rc-tema");
const oscuro = guardado ? guardado === "oscuro" : window.matchMedia("(prefers-color-scheme: dark)").matches;
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
