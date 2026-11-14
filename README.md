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
