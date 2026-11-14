# RadiusControl

Plataforma para sustituir MikroTik User Manager por FreeRADIUS en la autenticación
administrativa de routers MikroTik (WinBox, SSH y WebFig), con un panel propio para
administrar routers, secretos RADIUS, usuarios y permisos.

**Estado:** especificación en revisión. Todavía no hay código.

## Documentos

- [docs/especificacion.md](docs/especificacion.md): qué se construye, en qué orden y
  cómo se comprueba que funciona.

## Tecnologías

FreeRADIUS 3.2.x, Go (API REST), React + TypeScript + Tailwind + shadcn/ui,
PostgreSQL y Docker Compose.

## Reglas del repositorio

- Ningún dato real entra aquí: ni nombres de clientes, ni direcciones IP reales, ni
  secretos, ni volcados de routers. Los ejemplos usan nombres genéricos y rangos de
  documentación (`192.0.2.0/24`, `198.51.100.0/24`, `2001:db8::/32`).
- Los datos reales de trabajo van en `datos/`, que git ignora.
- Finales de línea LF en todo el repositorio.

## Laboratorio

`lab/` levanta solo FreeRADIUS, con un cliente local y un usuario de prueba, para
comprobar la base antes de construir la API y el panel.

```
cd /root/radiuscontrol/lab
./instalar.sh   # instala Docker si falta, genera credenciales de prueba y arranca
./probar.sh     # ejecuta las pruebas y guarda la evidencia en generado/
```

Lo que `probar.sh` comprueba hoy: PAP y MS-CHAP contra un hash NT, contraseña
incorrecta, secreto incorrecto y origen no autorizado. `radclient` genera MS-CHAP
versión 1; MS-CHAPv2 se comprueba con un login real desde un router.
