-- Ajustes del panel que se guardan en la base. Los de la purga de registros
-- van en la fila de clave «purga».
CREATE TABLE ajustes (
    clave text PRIMARY KEY,
    valor jsonb NOT NULL
);

-- Cada purga de registros que se ejecuta: cuánto borró de los inicios de sesión
-- y del registro de actividad, y el uso del disco antes y después.
CREATE TABLE purgas (
    id              bigserial PRIMARY KEY,
    fecha           timestamptz NOT NULL DEFAULT now(),
    motivo          text NOT NULL,
    operador        text NOT NULL,
    autenticaciones bigint NOT NULL DEFAULT 0,
    actividad       bigint NOT NULL DEFAULT 0,
    disco_antes     integer NOT NULL,
    disco_despues   integer NOT NULL
);
