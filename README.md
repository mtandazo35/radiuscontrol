# RadiusControl

Plataforma para sustituir MikroTik User Manager por FreeRADIUS en la autenticación
administrativa de routers MikroTik (WinBox, SSH y WebFig). Incluye un panel web para
administrar los routers, sus secretos RADIUS, los usuarios y quién puede entrar a cada
router.

Versión 1.2. Desarrollado por MAAT.

## Cómo funciona

FreeRADIUS es quien autentica. El panel guarda lo que quieres (routers, usuarios, accesos)
y genera con ello la configuración de FreeRADIUS:

1. Guardas un cambio en el panel.
2. A los dos segundos la API genera la configuración, y el propio FreeRADIUS la valida.
3. Si es válida, se activa y FreeRADIUS la carga. Si no, sigue la anterior y el panel
   muestra el motivo.
4. El firewall del servidor abre o cierra el puerto RADIUS según los routers activos.

FreeRADIUS no consulta la API ni la base de datos para autenticar: si ambas caen, sigue
funcionando con la última configuración cargada.

## Qué se puede hacer desde el panel

El panel tiene tema oscuro por omisión y tema claro, y se puede usar desde el teléfono. En
la barra superior hay un filtro por router, que afecta a Inicio, Routers y
Autenticaciones, y un botón para volver a pedir los datos.

En todas las tablas:

- **Mover columnas**: arrastra un encabezado y suéltalo donde quieras la columna (con el
  teclado, Alt + flecha izquierda o derecha sobre el encabezado).
- **Ordenar**: pulsa un encabezado para ordenar por esa columna; otra pulsación invierte
  el sentido. En Autenticaciones y en el registro de actividad, que están paginados,
  ordena el servidor sobre todos los registros, no solo sobre la página a la vista.
- **Agrupar** (en Routers y en Usuarios MikroTik): el selector «Agrupar», junto a los
  filtros, reparte las filas en bloques con un encabezado y su número de elementos. El
  orden por columna se aplica dentro de cada bloque.
- El orden de las columnas, el de las filas y la agrupación se recuerdan mientras dure la
  sesión y se olvidan al salir del panel. «Restablecer columnas y orden», bajo la tabla,
  devuelve columnas y orden a como venían.

### Inicio

- Autenticaciones y rechazos de las últimas 24 horas, routers activos y usuarios activos.
  Los sondeos sin clave (ver Autenticaciones) no cuentan en ninguna estadística.
- Gráfico de logins aceptados y rechazados de la última hora, de las últimas 12 o de las
  últimas 24: un pico de rechazos delata a alguien o algo reintentando.
- Los últimos intentos, quién entra más, a quién se rechaza más, desde qué dirección y por
  qué motivo. Si la dirección tiene una descripción puesta, se muestra junto a ella.
- Una tabla por router con sus redes, sus logins del día y el último login aceptado.

### Routers

- Alta, edición, suspensión y baja. Cada router se identifica por la dirección de origen
  de sus paquetes y pertenece a una empresa. Dos routers no pueden compartir dirección.
- Un secreto RADIUS por router, generado por el panel o introducido si ya existía. Al
  crearlo se muestra junto con las líneas para pegar en el MikroTik.
- Al editar un router, un administrador puede ver el secreto en uso y escribir uno nuevo
  que lo sustituya. Cada consulta del secreto queda en el registro de actividad. También
  se puede rotar por uno aleatorio con un clic.
- **Acceso por router**:
  - *Manejo general*: entran todos los usuarios activos, cada uno con su grupo.
  - *Restringido*: solo entran los usuarios que elijas, cada uno con el permiso que le
    des en ese router (`full`, `write`, `read` u otro grupo).
- **Cambios masivos**: dar o quitar acceso a varios usuarios, o cambiar el modo, en todos
  los routers, en los de una empresa o en una selección.
- **Exigir Message-Authenticator** (marcado por omisión): FreeRADIUS solo acepta las
  peticiones de ese router si vienen firmadas con su secreto. Un router que lo tiene
  desmarcado se señala en la tabla con «Sin Message-Authenticator».
- Buscador por nombre, empresa o red; filtros por empresa, tipo de acceso y estado; y orden
  por cualquier columna.
- **Agrupar** por empresa o por estado actual: cada grupo lleva un encabezado con su número
  de routers, y el orden de las columnas se aplica dentro de cada grupo. La elección se
  recuerda durante la sesión.

### Usuarios MikroTik

- Las personas que entran a los routers. Cada una tiene su grupo general.
- Alta, edición, suspensión y baja.
- La contraseña la escribes tú o la genera el sistema, tanto al crear el usuario como al
  restablecerla. Al guardar se muestra para copiarla.
- Al editar un usuario, un administrador puede ver la contraseña en uso y escribir una
  nueva que la sustituya. Cada consulta queda en el registro de actividad.
- Buscador por usuario o nombre, filtros por grupo y estado, y orden por cualquier columna.
- **Agrupar** por grupo de RouterOS (primero `full`, `write` y `read`, luego los propios) o
  por estado actual, igual que en Routers.

### Autenticaciones

- Cada intento de login que FreeRADIUS aceptó o rechazó: fecha, usuario, router, empresa,
  dirección desde la que entró, método y grupo o motivo del rechazo.
- Buscador, filtro rápido por resultado (todos, aceptados, rechazados) y paginación. Los
  rechazos van marcados en rojo con su motivo.
- Las direcciones se copian con un clic.
- **Sondeos sin clave**: al abrir una conexión SSH, antes de pedir la contraseña, RouterOS
  manda a RADIUS una petición con la contraseña vacía. Se rechaza como siempre, pero se
  registra aparte como «Sondeo sin clave»: no sale en «Todos», no cuenta como rechazo en
  Inicio y se ve con el filtro «Sondeos». Una contraseña equivocada que no está vacía sigue
  siendo un rechazo normal.
- **Orígenes con nombre**: a la dirección desde la que entra un sistema (un servidor de
  respaldos, la oficina, el monitoreo) se le puede poner una descripción, que aparece bajo
  la dirección. Se pone con el lápiz que hay junto a cada dirección, o por redes enteras
  en Configuración.

### Configuración

- **Accesos al servidor**: quién puede llegar a la web del panel (443) y al SSH, gestionado
  de forma gráfica. Las reglas cargadas a mano en el servidor se muestran y no se tocan.
- **Orígenes con nombre**: la lista de direcciones y redes con su descripción. Si una
  dirección cae en varias redes, vale la descripción de la más pequeña.
- **Estado**: lo guardado en el panel, lo aplicado, lo que FreeRADIUS tiene cargado y lo
  que el firewall deja pasar, con sus huellas para comprobar que coinciden.
- **Limpieza de registros**: conservación configurable, limpieza programada, limpieza de
  emergencia por disco lleno y vaciado a petición.

### Actualización

- Apartado propio en el menú, solo para administradores. Muestra la versión instalada, los
  cambios publicados en el repositorio que todavía no están instalados y el resultado de
  la última actualización.
- «Buscar actualizaciones» comprueba en el momento si hay cambios nuevos; «Actualizar
  ahora» los instala y muestra el avance paso a paso.
- Cuando hay cambios por instalar, el menú lo avisa con su número junto a «Actualización».

### Seguridad

- Operadores del panel con dos roles: administrador y solo lectura.
- Verificación en dos pasos (TOTP) con código QR.
- Bloqueo del inicio de sesión tras 4 intentos fallidos, por dirección IP y por cuenta,
  con desbloqueo desde el panel. A quien no logra entrar se le responde siempre lo mismo
  («Usuario o contraseña incorrectos»): no se le dice si hay un bloqueo ni cuánto falta.
  El motivo real queda en el registro de actividad.
- Con la sesión abierta, repetir mal la contraseña cinco veces (al cambiarla o al quitar la
  verificación en dos pasos) bloquea esas operaciones 15 minutos.
- La contraseña de un usuario MikroTik y el secreto de un router solo los puede ver un
  administrador, y cada consulta queda anotada con quién la hizo y desde dónde.
- Sesiones abiertas a la vista, con cierre individual o de todas las demás. Una sesión se
  cierra sola tras 30 minutos sin actividad.
- Registro de actividad: accesos, intentos fallidos y cada cambio, con quién y desde dónde.

## Cómo se guardan las credenciales

| Credencial | Cómo se guarda |
|---|---|
| Contraseñas del panel | Hash Argon2id |
| Contraseñas de usuarios MikroTik | El hash NT (lo que usa FreeRADIUS) y la propia contraseña (para consultarla desde el panel), ambos cifrados con AES-256-GCM |
| Secretos RADIUS de los routers | Cifrados con AES-256-GCM |
| Secreto de la verificación en dos pasos | Cifrado con AES-256-GCM |

La clave de cifrado vive fuera de la base de datos, en `despliegue/secrets/`. Un volcado
de la base sin esa clave no contiene nada utilizable. Los secretos RADIUS no se pueden
guardar como hash porque el protocolo necesita su valor original.

Las contraseñas de los usuarios MikroTik son recuperables por decisión de diseño, para
poder consultarlas desde el panel: quien tenga a la vez la base y la clave de cifrado
puede leerlas. Las contraseñas de los operadores del panel no: de esas solo existe su hash.

En el repositorio no hay ninguna contraseña ni clave: los secretos se generan al instalar,
en `despliegue/secrets/`, que queda fuera de git. El archivo `despliegue/.env` solo lleva
la dirección del panel y la del servidor; hay un ejemplo en `despliegue/.env.example`.

## ⚡ Instalación rápida (one-liner)

En un servidor Debian o Ubuntu, como root:

```
curl -fsSL https://raw.githubusercontent.com/mtandazo35/radiuscontrol/main/install.sh -o /root/install-radiuscontrol.sh && bash /root/install-radiuscontrol.sh
```

Descarga el repositorio en `/root/radiuscontrol`, instala Docker si falta, genera los
secretos, levanta los servicios y deja activos los agentes de firewall y de actualización.
Al terminar muestra la dirección del panel y la contraseña inicial de `admin`, una sola
vez; después la borra del disco.

Ejecutar la misma línea en un servidor que ya tiene RadiusControl lo pone al día sin
regenerar secretos ni credenciales.

### Firewall: lo mínimo, el resto lo decides tú

El instalador no impone la seguridad del servidor. Solo hace lo imprescindible:

- Instala y activa UFW, porque el puerto RADIUS (1812/udp) se abre y se cierra solo,
  únicamente para las redes de los routers que des de alta en el panel.
- Antes de activarlo, abre el SSH solo para la conexión desde la que estás instalando,
  para no dejarte fuera.
- Si UFW ya estaba activo, no toca ninguna regla existente.

El panel (443) no se abre a nadie por omisión. Ábrelo con tu propia regla:

```
ufw allow from 192.0.2.0/24 to any port 443 proto tcp
```

O indica la red al instalar, y el instalador la abre por ti:

```
curl -fsSL https://raw.githubusercontent.com/mtandazo35/radiuscontrol/main/install.sh -o /root/install-radiuscontrol.sh && RED_GESTION=192.0.2.0/24 bash /root/install-radiuscontrol.sh
```

Una vez dentro del panel, los accesos al 443 y al SSH se gestionan desde
Configuración → Accesos al servidor.

### Instalación paso a paso

```
git clone https://github.com/mtandazo35/radiuscontrol.git /root/radiuscontrol
cd /root/radiuscontrol/despliegue
RED_GESTION=192.0.2.0/24 ./instalar.sh
```

## Conectar un router MikroTik

1. En el panel, crea el router con su dirección o red de origen y su empresa.
2. El panel muestra una sola vez las líneas para pegar en el terminal del router:

   ```
   /radius add service=login address=<IP del servidor> secret="<secreto>" comment="RadiusControl"
   /user aaa set use-radius=yes
   ```

3. Crea el usuario en Usuarios MikroTik. El grupo que le des (`full`, `write`, `read` u
   otro) debe existir en el router.
4. Entra al router por WinBox o SSH con ese usuario. El intento aparece en Autenticaciones.

Deja siempre una cuenta local en el router: si el servidor RADIUS no responde, es la única
forma de entrar.

### Sondeos al abrir SSH

Todo cliente SSH (PuTTY, Oxidized, un script) abre la conexión preguntando al router qué
formas de entrar admite. RouterOS convierte esa pregunta en una petición RADIUS con la
contraseña vacía, antes de que el usuario escriba la suya. Por eso cada login por SSH
genera dos peticiones casi a la vez: el sondeo y el login de verdad.

FreeRADIUS rechaza el sondeo como cualquier contraseña incorrecta, pero RadiusControl lo
reconoce (comprueba si la respuesta se calculó con la contraseña vacía) y lo registra
aparte. Un sondeo nunca da acceso; solo cambia cómo se anota y se cuenta.

### Message-Authenticator

Es la firma que un router añade a cada petición RADIUS, calculada con el secreto
compartido. Exigirla impide que alguien situado entre el router y el servidor falsifique o
altere un login (la vulnerabilidad conocida como BlastRADIUS, de 2024). Las versiones
actuales de RouterOS la envían.

Si un router tiene el secreto correcto y aun así nadie puede entrar, y sus intentos ni
siquiera aparecen en Autenticaciones, es probable que su RouterOS no envíe la firma. Lo
correcto es actualizar el router. Desmarcar «Exigir Message-Authenticator» en ese router
lo deja funcionar sin la firma, pero también sin esa protección: úsalo solo como último
recurso.

## Qué se instala

| Pieza | Qué hace | Dónde corre |
|---|---|---|
| FreeRADIUS 3.2.x | Autentica los logins de los routers (1812/udp) | Contenedor, red del servidor |
| API | Guarda los datos y genera la configuración | Contenedor, solo accesible en local |
| PostgreSQL 16 | Base de datos | Contenedor, sin puerto publicado |
| Web | Panel (443) con certificado interno | Contenedor, red del servidor |
| Agente de firewall | Mantiene las reglas de UFW que gestiona el panel | Servicio del servidor |
| Agente de actualización | Busca e instala versiones nuevas a petición | Servicio del servidor |

El certificado del panel es autofirmado: el navegador avisa la primera vez. El panel solo
atiende por HTTPS; el puerto 80 no escucha.

## Actualizaciones

El servidor busca cada 30 minutos si hay cambios nuevos en este repositorio. Cuando los
hay, el panel lo avisa en el menú, junto a «Actualización», y en el menú de usuario. Nunca
se instalan solas: las lanza un administrador desde el apartado Actualización con
«Actualizar ahora». El proceso:

1. Comprueba que la versión es la última publicada y posterior a la instalada.
2. Guarda y verifica un respaldo de la base, los secretos y el entorno en `/root/backups/`.
3. Construye la versión nueva. Si no construye, sigue la anterior.
4. Instala y comprueba que la API, FreeRADIUS y la web responden.
5. Si algo no responde, vuelve sola a la versión anterior.

Se conservan los cinco últimos respaldos.

## Operación

| Necesidad | Orden en el servidor |
|---|---|
| Recuperar el acceso de administrador | `docker exec radiuscontrol-api radiuscontrol operador-emergencia admin` |
| Desbloquear una dirección IP, o todas | `docker exec radiuscontrol-api radiuscontrol desbloquear-ip todas` |
| Ver el estado de los servicios | `cd /root/radiuscontrol/despliegue && docker compose ps` |
| Ver el agente de firewall | `journalctl -u radiuscontrol-firewall` |
| Ver el agente de actualización | `journalctl -u radiuscontrol-actualizar` |
| Ejecutar las pruebas | `cd /root/radiuscontrol/despliegue && ./probar.sh` |

Las reglas de UFW con los comentarios `radiuscontrol`, `radiuscontrol-panel` y
`radiuscontrol-ssh` las gestiona el panel: no las añadas ni las borres a mano, porque el
agente las repone o las quita en un minuto como mucho.

## Pruebas

`despliegue/probar.sh` ejecuta 250 pruebas de extremo a extremo en el propio
servidor: usa la API como lo haría el panel y verifica el resultado con logins RADIUS
reales contra FreeRADIUS y con las reglas reales de UFW. Crea sus propios datos, con su
propia cuenta, y los borra al terminar. La evidencia queda en `despliegue/evidencias/`.

## Límites conocidos

- Hay una sola instancia de FreeRADIUS. Una segunda, en otra máquina, está pendiente.
- El importador desde User Manager está pendiente: los routers y usuarios se dan de alta
  en el panel.
- La instalación en un servidor recién creado y el camino del instalador con UFW
  desactivado no se han probado todavía en una máquina limpia.
- Un SSH abierto con un perfil de aplicación de UFW (`ufw allow OpenSSH`) no se reconoce
  como regla de SSH en Accesos al servidor.
- Mover columnas arrastrando no funciona en pantallas táctiles; ordenar pulsando el
  encabezado sí.
- El buscador de Autenticaciones busca por la dirección de origen, no por la descripción
  que se le haya puesto.
- La contraseña de un usuario MikroTik creado antes de la versión que permite consultarla
  no se puede recuperar: hay que ponerle una nueva para poder verla después.
- El panel solo registra autenticaciones. No lleva contabilidad RADIUS (sesiones, tráfico
  ni tiempo de conexión) y no sondea los routers: «activo» significa dado de alta y sin
  suspender, no que el router esté encendido.
- La API se conecta a PostgreSQL con el usuario administrador de la base. La base no
  publica ningún puerto; pasar a un usuario con menos privilegios está pendiente.
- Las dependencias de la web tienen avisos conocidos en vite y react-router que no afectan
  al panel instalado (servidor de desarrollo y renderizado en servidor, que no se usan);
  corregirlos exige un salto de versión mayor, pendiente.

## Estructura del repositorio

| Carpeta | Contenido |
|---|---|
| `api/` | API en Go y sus migraciones de base de datos |
| `web/` | Panel en React y TypeScript |
| `despliegue/` | Docker Compose, instalador, pruebas y los dos agentes del servidor |
| `docs/` | [Especificación original](docs/especificacion.md), con el orden de entregas |
| `install.sh` | Instalación rápida |
| `AGENTS.md` | Reglas de trabajo para los asistentes de programación que tocan el código |

Tecnologías: FreeRADIUS 3.2.x, Go 1.26, React + TypeScript + Tailwind, PostgreSQL 16 y
Docker Compose.
