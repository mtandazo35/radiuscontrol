-- Operadores del panel. Dominio de credenciales C: Argon2id.
CREATE TABLE operadores (
    id                bigserial PRIMARY KEY,
    usuario           text NOT NULL UNIQUE,
    clave_hash        text NOT NULL,
    rol               text NOT NULL DEFAULT 'administrador',
    activo            boolean NOT NULL DEFAULT true,
    intentos_fallidos integer NOT NULL DEFAULT 0,
    bloqueado_hasta   timestamptz,
    creado            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sesiones (
    token_hash  bytea PRIMARY KEY,
    operador_id bigint NOT NULL REFERENCES operadores (id) ON DELETE CASCADE,
    ip          text NOT NULL,
    creada      timestamptz NOT NULL DEFAULT now(),
    expira      timestamptz NOT NULL
);

-- Routers (NAS). Dominio de credenciales A: secreto RADIUS cifrado.
CREATE TABLE routers (
    id                           bigserial PRIMARY KEY,
    nombre                       text NOT NULL UNIQUE,
    descripcion                  text NOT NULL DEFAULT '',
    activo                       boolean NOT NULL DEFAULT true,
    secreto_cifrado              bytea NOT NULL,
    secreto_rotado               timestamptz NOT NULL DEFAULT now(),
    exigir_message_authenticator boolean NOT NULL DEFAULT true,
    creado                       timestamptz NOT NULL DEFAULT now(),
    actualizado                  timestamptz NOT NULL DEFAULT now()
);

-- Redes autorizadas de cada router. La base impide que dos redes se
-- superpongan: un router se identifica solo por su dirección de origen.
CREATE TABLE router_redes (
    id        bigserial PRIMARY KEY,
    router_id bigint NOT NULL REFERENCES routers (id) ON DELETE CASCADE,
    red       inet NOT NULL,
    CONSTRAINT redes_sin_superposicion EXCLUDE USING gist (red inet_ops WITH &&)
);

-- Administradores de MikroTik. Dominio de credenciales B: solo el hash NT, cifrado.
CREATE TABLE usuarios_mikrotik (
    id              bigserial PRIMARY KEY,
    usuario         text NOT NULL UNIQUE,
    nombre_completo text NOT NULL DEFAULT '',
    grupo           text NOT NULL,
    activo          boolean NOT NULL DEFAULT true,
    hash_nt_cifrado bytea NOT NULL,
    clave_cambiada  timestamptz NOT NULL DEFAULT now(),
    creado          timestamptz NOT NULL DEFAULT now(),
    actualizado     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX usuarios_mikrotik_sin_distinguir_mayusculas
    ON usuarios_mikrotik (lower(usuario));

-- Cada configuración de FreeRADIUS compilada, con su contenido cifrado para
-- poder volver a ella.
CREATE TABLE versiones_config (
    id                bigserial PRIMARY KEY,
    creada            timestamptz NOT NULL DEFAULT now(),
    operador          text NOT NULL,
    estado            text NOT NULL,
    mensaje           text NOT NULL DEFAULT '',
    activa            boolean NOT NULL DEFAULT false,
    routers           integer NOT NULL DEFAULT 0,
    usuarios          integer NOT NULL DEFAULT 0,
    sha_clients       text NOT NULL,
    sha_authorize     text NOT NULL,
    clients_cifrado   bytea NOT NULL,
    authorize_cifrado bytea NOT NULL
);

CREATE UNIQUE INDEX una_sola_version_activa ON versiones_config (activa) WHERE activa;

CREATE TABLE auditoria (
    id       bigserial PRIMARY KEY,
    fecha    timestamptz NOT NULL DEFAULT now(),
    operador text NOT NULL,
    ip       text NOT NULL,
    accion   text NOT NULL,
    objeto   text NOT NULL,
    detalle  jsonb NOT NULL DEFAULT '{}'
);
