-- Bloqueo del inicio de sesión por dirección IP tras varios intentos fallidos.
CREATE TABLE intentos_ip (
    id    bigserial PRIMARY KEY,
    ip    text NOT NULL,
    fecha timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX intentos_ip_por_direccion ON intentos_ip (ip, fecha);

CREATE TABLE bloqueos_ip (
    ip       text PRIMARY KEY,
    desde    timestamptz NOT NULL DEFAULT now(),
    hasta    timestamptz NOT NULL,
    intentos integer NOT NULL
);
