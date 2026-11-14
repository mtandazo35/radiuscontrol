# RadiusControl: especificación v3

Estado: borrador para aprobación. Sustituye a la especificación v2.

## 0. Objetivo

Dejar de depender de MikroTik User Manager para el acceso administrativo a los routers
(WinBox, SSH y WebFig) sin que ningún administrador pierda el acceso en ningún momento,
y cerrar tres debilidades de la instalación actual:

1. Casi todos los routers comparten un mismo secreto RADIUS.
2. Hay cuentas administrativas compartidas entre varias personas.
3. Hay un único servidor RADIUS.

**Criterio final.** RadiusControl está terminado cuando se cumplen las cuatro condiciones:

- Todos los routers autentican contra FreeRADIUS y User Manager está apagado.
- Ningún router comparte secreto con otro.
- Cada persona entra con su propia cuenta y recibe el grupo que le corresponde en cada router.
- Todas las pruebas de la sección 7 tienen evidencia guardada.

## 1. Punto de partida

- Unos 170 routers MikroTik (NAS) de varias empresas, con RouterOS 6 y RouterOS 7.
- Un puñado de cuentas administrativas y tres grupos (`full`, `read`, `write`).
- User Manager guarda las contraseñas de forma recuperable.
- Direcciones públicas variables, rangos CIDR y routers que comparten NAT.
- Instalación de uso interno: una sola organización opera el panel.

Las cifras exactas salen de la entrega 0, no de este documento.

## 2. Decisiones de arquitectura

Estas decisiones están tomadas. Cambiarlas exige revisar el documento entero.

### 2.1 FreeRADIUS autentica; Go compila su configuración

- Go guarda el estado deseado en PostgreSQL, con las credenciales cifradas (sección 3).
- Para aplicar un cambio, Go genera los archivos de FreeRADIUS (clientes, usuarios y
  política de grupos) en un volumen en memoria, con permisos `0600`.
- Antes de activarlos los valida con `radiusd -C`. Si la validación falla, no se cambia
  nada y el panel muestra el error.
- Si pasa, sustituye el conjunto anterior de forma atómica y recarga FreeRADIUS.
- Cada conjunto aplicado se guarda como versión, con su huella SHA-256. El rollback es
  volver a activar una versión anterior.

Consecuencias:

- FreeRADIUS no consulta ni la API ni PostgreSQL para autenticar. Con ambos caídos sigue
  autenticando con la última versión aplicada.
- "Estado mostrado" y "estado aplicado" se comparan con la huella del conjunto activo.

### 2.2 Registro de autenticaciones

FreeRADIUS escribe cada resultado en un archivo (módulo `linelog`, una línea JSON por
solicitud). Go lo lee y lo carga en PostgreSQL. Si Go está caído, las líneas se acumulan
y se cargan al volver.

### 2.3 Despliegue

- FreeRADIUS 3.2.5 o superior, imagen oficial.
- El contenedor de FreeRADIUS usa la red del host. Con la red puente de Docker la
  dirección de origen de los paquetes puede llegar alterada, y toda la identificación de
  routers depende de ella.
- Dos instancias de FreeRADIUS desde el principio, en máquinas distintas, que reciben el
  mismo conjunto compilado. Cada router las tiene configuradas como primaria y secundaria.

### 2.4 Métodos de autenticación

- MS-CHAPv2 para WinBox y WebFig.
- PAP para SSH.
- `Message-Authenticator` (CVE-2024-3596, BlastRADIUS): se exige por router. Los routers
  cuya versión de RouterOS lo envía quedan en "exigido"; los que no, en "tolerado", y el
  panel los lista como pendientes de actualizar.

## 3. Tres dominios de credenciales

Los tres dominios son independientes. Ninguna credencial de uno sirve en otro.

| Dominio | Qué es | Cómo se guarda |
|---|---|---|
| Secretos RADIUS | Uno por router, entre el router y FreeRADIUS | Cifrado AES-256-GCM, clave fuera de PostgreSQL |
| Contraseñas MikroTik | Las de cada administrador para entrar a los routers | Solo el hash NT, cifrado igual que los secretos |
| Credenciales del panel | Las de los operadores de RadiusControl | Argon2id, con TOTP obligatorio |

Reglas:

- El hash NT sirve para MS-CHAPv2 y para PAP, así que la contraseña en claro no se guarda
  nunca. El importador la lee de User Manager, calcula el hash y la descarta.
- El hash NT equivale a la contraseña para MS-CHAPv2. Se protege igual que un secreto.
- El panel nunca muestra un secreto ni un hash. Muestra identificador, estado y fecha de
  rotación. La única excepción es el script de configuración de un router recién generado,
  que se descarga una vez y queda registrado en auditoría.
- La clave de cifrado llega al proceso Go como secreto de Docker. Un volcado de
  PostgreSQL sin esa clave no sirve para autenticarse.
- Los archivos compilados sí contienen secretos y hashes en claro, porque FreeRADIUS los
  necesita así. Viven solo en memoria y solo en las máquinas de FreeRADIUS.

## 4. Identidad de los routers y redes

- Un router se identifica por la dirección de origen real de sus paquetes. Los atributos
  que el propio router declara, como `NAS-Identifier`, no se usan para identificarlo.
- Un router puede tener varios rangos autorizados, IPv4 e IPv6, desde `/32` y `/128`
  hasta rangos amplios.
- El panel rechaza al guardar: rangos superpuestos entre routers distintos y dos routers
  con la misma dirección de origen.
- Dos routers detrás del mismo NAT no se pueden distinguir por dirección. Para darlos de
  alta hace falta una dirección individual por router: un túnel (WireGuard) o RadSec con
  certificado por router. Sin eso, el alta se rechaza.
- Permisos por router: una matriz de usuario y grupo de routers que produce el atributo
  `Mikrotik-Group`. El grupo debe existir en el router. RadiusControl no entra a los
  routers, así que no puede comprobarlo por su cuenta: lo comprueba la prueba de login.

## 5. Entregas

Cada entrega termina con una demostración y se aprueba antes de empezar la siguiente.

### Entrega 0: datos reales

- Export de User Manager: routers, usuarios y grupos, con datos sensibles.
- Inventario por router: versión de RouterOS, dirección de origen vista desde el servidor
  y cuáles comparten NAT.
- Lista de cuentas y métodos realmente usados, sacada de los registros.

Estos datos se guardan en `datos/`, fuera de git.

### Entrega 1: núcleo y canario

- FreeRADIUS en laboratorio con dos CHR como routers de prueba: uno con RouterOS 7 y otro
  con RouterOS 6.
- Compilador de configuración en Go, usado por línea de comandos. Sin API ni panel.
- Importador desde User Manager, con comparación contra el origen.
- Un router real como canario: FreeRADIUS añadido como servidor adicional, sin quitar
  User Manager.

### Entrega 2: API y panel mínimo

API REST en Go con OpenAPI, RBAC, auditoría y migraciones SQL. Panel con cinco módulos:

1. **Routers**: alta, edición, suspensión, grupos, rangos, estado del secreto, prueba de
   conectividad, script de configuración y configuración efectiva.
2. **Usuarios MikroTik**: altas, bajas, restablecimiento, revocación y permisos por
   grupo de routers.
3. **Autenticaciones**: solicitudes, resultados, motivos de fallo y filtros.
4. **Migración**: importación, previsualización, comparación con el origen y avance del
   corte por lotes.
5. **Operadores**: cuentas del panel, roles, TOTP, sesiones y auditoría.

Interfaz en español, adaptable a móvil, con tema claro y oscuro. Ningún botón sin
operación real detrás.

### Entrega 3: corte de la flota

- Por lotes, con los secretos actuales: en cada router solo cambia el servidor.
- Condición previa por router: una cuenta local de emergencia comprobada.
- El cambio en cada router lo aplica una persona con el script que genera el panel.
- User Manager sigue encendido hasta que el último lote lleve una semana estable.

### Entrega 4: rotación de secretos

- Secreto único y aleatorio por router, por lotes.
- El panel muestra cuántos routers siguen con secreto compartido. El objetivo es cero.

### Entrega 5: segunda versión del panel

Dashboard, módulo de seguridad con alertas, métricas en Prometheus, calculadora CIDR,
y procedimientos de respaldo, restauración y actualización.

## 6. Fuera de alcance

- Servidor RADIUS propio, PHP y daloRADIUS.
- Autenticación de abonados (PPPoE, hotspot) y contabilidad de tráfico.
- Que RadiusControl se conecte a los routers para leer o cambiar su configuración.
- Varias organizaciones en una misma instalación.

## 7. Verificación y aceptación

Cada prueba se ejecuta con `radclient` o `radtest` y, donde se indica, con un login real
desde un router. La evidencia (comando, salida y fecha) se guarda en `evidencias/`.

| Prueba | Resultado esperado |
|---|---|
| Login por WinBox desde RouterOS 7 y desde RouterOS 6 | Entra, con el grupo correcto en `/user active print` |
| Login por SSH desde RouterOS 7 y desde RouterOS 6 | Entra, con el grupo correcto |
| Cambiar la IP del router dentro de su rango | Sigue autenticando |
| Solicitud desde una IP no autorizada | Sin respuesta, y el intento queda registrado |
| Secreto RADIUS incorrecto | Ningún login válido |
| Contraseña de usuario incorrecta | Rechazo |
| Usuario sin permiso en ese router | Rechazo |
| Usuario con grupos distintos en dos routers | Cada router recibe su grupo |
| Alta de dos routers con la misma IP de origen | El panel rechaza el alta |
| Rotar el secreto de un router | El anterior deja de servir y el nuevo funciona |
| Detener la API y PostgreSQL | FreeRADIUS sigue autenticando |
| Detener la instancia primaria | El router autentica por la secundaria |
| Aplicar una configuración inválida | La huella del conjunto activo no cambia |
| Importar desde User Manager | Mismo número de routers, usuarios y grupos; huella de cada secreto igual al origen |
| Rollback a una versión anterior | La huella activa vuelve a ser la de esa versión |
| Rollback de un router a User Manager | Vuelve a autenticar contra User Manager |
| Volcado de PostgreSQL sin la clave | No se obtiene ningún secreto ni hash utilizable |

Una funcionalidad no está terminada hasta que su prueba es reproducible por otra persona.

Señales de que algo está mal aunque las pruebas pasen:

- El login entra pero el grupo no es el esperado.
- WinBox funciona y SSH no, o al revés.
- La dirección de origen que registra FreeRADIUS es la de una red interna de Docker.

## 8. Riesgos y controles

| Riesgo | Control |
|---|---|
| El panel se construye y la flota no se migra | El corte va antes que el panel completo (entregas 1 y 3) |
| Pérdida de acceso por caída de RADIUS | Dos instancias y cuenta local de emergencia por router |
| Secreto compartido que se queda para siempre | La rotación es una entrega con contador a cero |
| Exposición de hashes NT o secretos | Cifrado en la base, archivos solo en memoria, nada en claro en el panel |
| Configuración mostrada distinta de la aplicada | Huella del conjunto activo comparada con la del estado deseado |
| Aplicación parcial de un cambio | Validación previa y sustitución atómica del conjunto completo |
| Login correcto con permisos equivocados | La prueba de aceptación comprueba el grupo, no solo el acceso |
| Datos reales en el repositorio | `datos/` ignorado y ejemplos con rangos de documentación |

## 9. Por confirmar en laboratorio

Estos puntos se dan por probables y la entrega 1 los confirma o los corrige:

- Qué método usa cada servicio de RouterOS (WinBox, WebFig, SSH) en las versiones 6 y 7.
- Qué versiones de RouterOS envían `Message-Authenticator` y cómo responde FreeRADIUS a
  las que no.
- Qué cambios de configuración admite FreeRADIUS con una recarga y cuáles piden reinicio.
  Con dos instancias, el reinicio se hace de una en una.
- Qué formato exacto tiene el export de User Manager y si incluye todas las contraseñas.
- Si RadSec en RouterOS sirve para distinguir routers detrás del mismo NAT.

## 10. Entregables

- Código del backend en Go y de la aplicación React.
- Plantillas de configuración de FreeRADIUS y Docker Compose.
- Migraciones de PostgreSQL y contrato OpenAPI.
- Importador desde User Manager.
- Pruebas automatizadas y evidencias de las pruebas reales.
- Manual de instalación y operación, con respaldo, restauración, actualización y rollback.
