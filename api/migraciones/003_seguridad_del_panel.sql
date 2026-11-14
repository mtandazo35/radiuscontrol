-- Gestión del acceso al panel: doble factor, último acceso y sesiones revocables.
ALTER TABLE operadores
    ADD COLUMN totp_cifrado           bytea,
    ADD COLUMN totp_pendiente_cifrado bytea,
    ADD COLUMN totp_ultimo            bigint NOT NULL DEFAULT 0,
    ADD COLUMN ultimo_acceso          timestamptz,
    ADD COLUMN clave_cambiada         timestamptz NOT NULL DEFAULT now(),
    ADD CONSTRAINT operadores_rol_valido CHECK (rol IN ('administrador', 'lectura'));

CREATE UNIQUE INDEX operadores_sin_distinguir_mayusculas ON operadores (lower(usuario));

ALTER TABLE sesiones ADD COLUMN id bigserial UNIQUE;

CREATE INDEX auditoria_por_fecha ON auditoria (id DESC);
