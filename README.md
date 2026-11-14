# RadiusControl

Plataforma para sustituir MikroTik User Manager por FreeRADIUS en la autenticación
administrativa de routers MikroTik (WinBox, SSH y WebFig), con un panel propio para
administrar routers, secretos RADIUS, usuarios y accesos.

## Qué hace

- **FreeRADIUS autentica; el panel compila su configuración.** Cada cambio se valida con
  el propio FreeRADIUS antes de activarse. FreeRADIUS no consulta la API ni la base para
  autenticar: si ambas caen, sigue funcionando.
- **Routers** identificados por la dirección de origen de sus paquetes, cada uno con su
  secreto y su empresa. Dos routers no pueden compartir dirección.
- **Usuarios MikroTik** con su grupo. Solo se guarda el hash NT, cifrado.
- **Firewall automático**: el puerto 1812/udp se abre en UFW solo para las redes de los
  routers activos y se cierra al quitarlos.
- **Registro de autenticaciones** con usuario, router, empresa, método y motivo del rechazo.
- **Seguridad del panel**: operadores con roles, verificación en dos pasos, bloqueo por
  dirección IP y por cuenta tras 4 intentos fallidos, cierre por 30 minutos de
  inactividad, sesiones revocables y registro de actividad.
- **Actualización desde el panel**, con respaldo previo y vuelta atrás si algo falla.

## Tecnologías

FreeRADIUS 3.2.x, Go (API REST), React + TypeScript + Tailwind, PostgreSQL y Docker
Compose. Los agentes del servidor (firewall y actualización) son guiones de Bash con
systemd.

## Instalación

En un servidor Debian o Ubuntu, como root:

```
git clone https://github.com/mtandazo35/radiuscontrol.git /root/radiuscontrol
cd /root/radiuscontrol/despliegue
RED_GESTION=192.0.2.0/24 ./instalar.sh
```

`RED_GESTION` es la red desde la que se podrá abrir el panel (puerto 443). El instalador
muestra la contraseña inicial de `admin` una sola vez y la borra del disco.

Para comprobar la instalación:

```
./probar.sh
```

Ejecuta las pruebas de extremo a extremo, con logins RADIUS reales contra FreeRADIUS, y
guarda la evidencia en `despliegue/evidencias/`. Crea sus propios datos de prueba y los
borra al terminar.

## Operación

| Necesidad | Orden en el servidor |
|---|---|
| Recuperar el acceso de administrador | `docker exec radiuscontrol-api radiuscontrol operador-emergencia admin` |
| Desbloquear una dirección IP, o todas | `docker exec radiuscontrol-api radiuscontrol desbloquear-ip todas` |
| Ver el agente de firewall | `journalctl -u radiuscontrol-firewall` |
| Ver el agente de actualización | `journalctl -u radiuscontrol-actualizar` |

Las actualizaciones se instalan desde el panel (menú de usuario o Configuración). Antes de
cambiar nada se guarda un respaldo de la base y de los secretos en `/root/backups/`.

## Documentos

- [docs/especificacion.md](docs/especificacion.md): el planteamiento original, con el
  orden de entregas y los criterios de aceptación.

## Reglas del repositorio

- Ningún dato real entra aquí: ni nombres de clientes, ni direcciones IP reales, ni
  secretos, ni volcados de routers. Los ejemplos usan nombres genéricos y rangos de
  documentación (`192.0.2.0/24`, `198.51.100.0/24`, `2001:db8::/32`).
- Los datos reales de trabajo van en `datos/`, que git ignora.
- Finales de línea LF en todo el repositorio.
