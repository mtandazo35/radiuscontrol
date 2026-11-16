# AGENTS.md — protocolo de trabajo para los constructores (Codex, Antigravity/Gemini)

Lo lees al empezar cada encargo. Es obligatorio y manda sobre tus costumbres. El encargo concreto (qué construir y en qué
archivos) te lo da el orquestador; esto es **cómo** trabajas siempre en este repositorio.

## 1. Qué es el proyecto

RadiusControl: FreeRADIUS para el login administrativo de routers MikroTik, con una API en Go (`api/`), un panel en React +
TypeScript + Tailwind (`web/`) y el despliegue con Docker Compose (`despliegue/`). La especificación está en
`docs/especificacion.md`.

## 2. Escribir archivos (Windows)

1. Escribe y edita archivos SOLO con tu herramienta de edición o de parches. Nunca con comandos de shell (`Set-Content`,
   `Out-File`, `>`, `echo`, `cat <<EOF`): PowerShell guarda con BOM, con CRLF o en ASCII, y en ASCII cada tilde y cada ñ se
   convierte en `?`.
2. Todo archivo va en UTF-8 sin BOM y con finales de línea LF. Los `.sh` con CRLF no arrancan en el servidor.
3. Antes de entregar, busca en lo que cambiaste tildes perdidas (`?` donde iba una letra acentuada) y dilo en el informe.

## 3. Estilo

- Todo texto visible, comentario y mensaje va en español. Mensajes concretos («La contraseña debe tener entre 8 y 128
  caracteres.»), nunca genéricos.
- **Go:** formato exacto de `gofmt` (tabulaciones). Los errores que ve el usuario salen de `malo(...)`, `conflicto(...)` o
  `&errHTTP{...}` (`api/http.go`); cualquier otro error se convierte en «Error interno del servidor» y su detalle va al log.
  Las consultas SQL son siempre parametrizadas (`$1`, `$2`): nunca se concatena un valor que venga de una petición.
- **TypeScript/React:** comillas dobles, punto y coma, sangría de 2 espacios, como el código vecino. El repo no usa prettier
  ni eslint: no los corras. Sin `any` ni `@ts-ignore`. Los componentes base están en `web/src/components/ui.tsx` (`Button`,
  `Input`, `Select`, `Card`, `Badge`, `Table`, `Th`, `ThOrden`, `Td`, `Copiable`, `Dialog`, `Paginacion`): reutilízalos antes
  de crear otro.
- **Colores:** solo los nombres de `web/src/index.css` y `web/tailwind.config.js` (`background`, `card`, `muted`, `border`,
  `primary`, `success`, `warning`, `destructive`, `consola`). Nada de colores sueltos en hexadecimal dentro de las vistas,
  salvo en `web/src/pages/Login.tsx`, que tiene su propia paleta fija.
- **Letras:** `font-sans` (Inter) para el texto y `font-mono` (JetBrains Mono) para datos técnicos: IP, redes, fechas,
  contadores, nombres de usuario de MikroTik.
- Imita el archivo modelo que te indique el encargo: misma estructura, mismos nombres de piezas, mismo nivel de comentarios.

## 4. Antes de escribir código

1. Lee el código real de lo que vas a usar (firmas, tipos, nombres de los campos JSON en `web/src/lib/api.ts`). Si el encargo
   dice algo distinto de lo que hay en el código, gana el código y lo dices en el informe.
2. Antes de crear un nombre (función, tipo, componente, archivo), búscalo en el paquete y en sus pruebas: los nombres
   repetidos rompen la compilación.
3. Un import o una variable que no se usa no compila, ni en Go ni en TypeScript (`noUnusedLocals`).

## 5. Lo que puedes y no puedes hacer

- Solo los archivos que el encargo te permite. Si necesitas tocar otro, no lo toques: escríbelo en el informe como
  **CAMBIO SOLICITADO** (motivo y cambio propuesto).
- Sin commits, sin `git push`, sin `git stash`, sin cambiar la configuración de git.
- Sin instalar dependencias (`npm install`, `go get`) ni añadir librerías.
- Sin Docker, sin SSH y sin tocar ningún servidor. En este proyecto **nada se compila ni se prueba en el PC**: la
  compilación y las pruebas las corre el orquestador en el servidor de pruebas y te devuelve la salida.
- Nunca nombres reales de clientes, empresas, personas ni direcciones IP reales. Ejemplos con nombres genéricos («Router
  principal», «Empresa de ejemplo») y direcciones de documentación (`192.0.2.x`, `198.51.100.x`, `203.0.113.x`).
- Nunca escribas una contraseña, un secreto ni una clave en el código ni en un ejemplo.

## 6. Reglas de la interfaz

- No se elimina ninguna funcionalidad existente y no se añaden pantallas, paneles ni botones que el encargo no pida.
- En un encargo visual no se toca la API (`api/`), ni las rutas, ni los permisos, ni las validaciones, ni la forma de los
  datos que el panel pide o envía.
- Los avisos al usuario son siempre ventanas modales (`avisar`, `avisarError`, `confirmar` de `web/src/contexto.tsx`),
  nunca franjas que empujan la página.
- Tema oscuro por defecto y tema claro disponible: todo cambio debe verse bien en los dos.
- Debe funcionar en un teléfono (390 px de ancho) sin desplazamiento horizontal de la página; las tablas se desplazan dentro
  de su tarjeta.
- Accesibilidad: foco visible con teclado, texto alternativo o `aria-label` en los botones que solo llevan icono, y el color
  nunca como única señal de un estado.

## 7. Trabajo completo en un turno

- Trabaja tú mismo y en este turno. No lances subagentes ni tareas en segundo plano, y no termines diciendo que «vas a
  esperar» un resultado: en modo no interactivo el turno se corta ahí y no queda nada hecho.
- Un encargo es un bloque completo. Si de verdad no puedes terminarlo, dilo en la primera línea del informe
  («INCOMPLETO: falta …») y explica el impedimento; nunca entregues a medias en silencio.

## 8. Informe final (como máximo 12 líneas, en español)

1. **Hecho** o **INCOMPLETO** en la primera línea.
2. Archivos creados y cambiados.
3. Decisiones tomadas y ambigüedades (y si el código contradecía el encargo).
4. Lo que no pudiste verificar y los CAMBIOS SOLICITADOS.
