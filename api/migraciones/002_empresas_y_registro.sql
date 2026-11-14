-- Empresa a la que pertenece cada router.
CREATE TABLE empresas (
    id     bigserial PRIMARY KEY,
    nombre text NOT NULL,
    creada timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX empresas_nombre_unico ON empresas (lower(nombre));

ALTER TABLE routers ADD COLUMN empresa_id bigint REFERENCES empresas (id);

-- Registro de autenticaciones que FreeRADIUS escribe y la API carga.
-- Guarda el nombre del router y de la empresa tal como eran en ese momento.
CREATE TABLE autenticaciones (
    id             bigserial PRIMARY KEY,
    fecha          timestamptz NOT NULL,
    resultado      text NOT NULL,
    usuario        text NOT NULL,
    ip_origen      text NOT NULL,
    router_id      bigint,
    router_nombre  text NOT NULL DEFAULT '',
    empresa_nombre text NOT NULL DEFAULT '',
    nas_identifier text NOT NULL DEFAULT '',
    nas_ip         text NOT NULL DEFAULT '',
    origen         text NOT NULL DEFAULT '',
    metodo         text NOT NULL DEFAULT '',
    grupo          text NOT NULL DEFAULT '',
    motivo         text NOT NULL DEFAULT ''
);

CREATE INDEX autenticaciones_por_fecha ON autenticaciones (id DESC);

-- Hasta dónde se ha leído el archivo del registro. Se actualiza en la misma
-- transacción que inserta las líneas, para no repetir ni perder ninguna.
CREATE TABLE registro_posicion (
    id             integer PRIMARY KEY CHECK (id = 1),
    inodo          bigint NOT NULL,
    desplazamiento bigint NOT NULL
);
