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

### Inicio

- Autenticaciones y rechazos de las últimas 24 horas, routers activos y usuarios activos.
- Gráfico de logins aceptados y rechazados de la última hora, de las últimas 12 o de las
  últimas 24: un pico de rechazos delata a alguien o algo reintentando.
- Los últimos intentos, quién entra más, a quién se rechaza más, desde qué dirección y por
  qué motivo.
- Una tabla por router con sus redes, sus logins del día y el último login aceptado.

### Routers

- Alta, edición, suspensión y baja. Cada router se identifica por la dirección de origen
  de sus paquetes y pertenece a una empresa. Dos routers no pueden compartir dirección.
- Un secreto RADIUS por router, generado por el panel o introducido si ya existía. Se
  muestra una sola vez, junto con las líneas para pegar en el MikroTik. Se puede rotar.
- **Acceso por router**:
  - *Manejo general*: entran todos los usuarios activos, cada uno con su grupo.
  - *Restringido*: solo entran los usuarios que elijas, cada uno con el permiso que le
    des en ese router (`full`, `write`, `read` u otro grupo).
- **Cambios masivos**: dar o quitar acceso a varios usuarios, o cambiar el modo, en todos
  los routers, en los de una empresa o en una selección.
- Buscador por nombre, empresa o red; filtros por empresa, tipo de acceso y estado; y orden
  por cualquier columna.

### Usuarios MikroTik

- Las personas que entran a los routers. Cada una tiene su grupo general.
- Alta, suspensión, baja y restablecimiento de contraseña.
- La contraseña la escribes tú o la genera el sistema. Al guardar se muestra una sola vez
  para copiarla; después no se puede consultar, porque solo se guarda su hash.
- Buscador por usuario o nombre, filtros por grupo y estado, y orden por cualquier columna.

### Autenticaciones

- Cada intento de login que FreeRADIUS aceptó o rechazó: fecha, usuario, router, empresa,
  dirección desde la que entró, método y grupo o motivo del rechazo.
- Buscador, filtro rápido por resultado (todos, aceptados, rechazados) y paginación. Los
  rechazos van marcados en rojo con su motivo.
- Las direcciones se copian con un clic.

### Configuración

- **Versión**: versión instalada, búsqueda de actualizaciones e instalación desde el panel.
- **Accesos al servidor**: quién puede llegar a la web del panel (443) y al SSH, gestionado
  de forma gráfica. Las reglas cargadas a mano en el servidor se muestran y no se tocan.
- **Estado**: lo guardado en el panel, lo aplicado, lo que FreeRADIUS tiene cargado y lo
  que el firewall deja pasar, con sus huellas para comprobar que coinciden.
- **Limpieza de registros**: conservación configurable, limpieza programada, limpieza de
  emergencia por disco lleno y vaciado a petición.

### Seguridad

- Operadores del panel con dos roles: administrador y solo lectura.
- Verificación en dos pasos (TOTP) con código QR.
- Bloqueo del inicio de sesión tras 4 intentos fallidos, por dirección IP y por cuenta,
  con desbloqueo desde el panel. A quien no logra entrar se le responde siempre lo mismo
  («Usuario o contraseña incorrectos»): no se le dice si hay un bloqueo ni cuánto falta.
  El motivo real queda en el registro de actividad.
- Con la sesión abierta, repetir mal la contraseña cinco veces (al cambiarla o al quitar la
  verificación en dos pasos) bloquea esas operaciones 15 minutos.
- Sesiones abiertas a la vista, con cierre individual o de todas las demás. Una sesión se
  cierra sola tras 30 minutos sin actividad.
- Registro de actividad: accesos, intentos fallidos y cada cambio, con quién y desde dónde.

## Cómo se guardan las credenciales

| Credencial | Cómo se guarda |
|---|---|
| Contraseñas del panel | Hash Argon2id |
| Contraseñas de usuarios MikroTik | Solo el hash NT, cifrado con AES-256-GCM |
| Secretos RADIUS de los routers | Cifrados con AES-256-GCM |
| Secreto de la verificación en dos pasos | Cifrado con AES-256-GCM |

La clave de cifrado vive fuera de la base de datos, en `despliegue/secrets/`. Un volcado
de la base sin esa clave no contiene nada utilizable. Los secretos RADIUS no se pueden
guardar como hash porque el protocolo necesita su valor original.

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
hay, el panel lo avisa en el menú de usuario. Nunca se instalan solas: las lanza un
administrador con «Actualizar ahora». El proceso:

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

`despliegue/probar.sh` ejecuta más de 220 pruebas de extremo a extremo en el propio
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
