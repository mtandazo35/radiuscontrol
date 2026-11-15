-- Accesos al propio servidor que el operador gestiona desde el panel: quién
-- llega a la web del panel (443/tcp) y al SSH. La lista empieza vacía; las
-- reglas que el operador tenga cargadas a mano en el firewall no están aquí.
-- «red» guarda un prefijo canónico (192.0.2.0/24, 192.0.2.7/32, 2001:db8::/64)
-- o la palabra «cualquiera», que abre el servicio a cualquier dirección.
CREATE TABLE accesos_servidor (
    id          bigserial PRIMARY KEY,
    servicio    text NOT NULL CHECK (servicio IN ('panel', 'ssh')),
    red         text NOT NULL,
    descripcion text NOT NULL DEFAULT '',
    operador    text NOT NULL,
    creado      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (servicio, red)
);
