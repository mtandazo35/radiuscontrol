-- Peticiones que FreeRADIUS descarta sin responder aunque vengan de un router
-- dado de alta (secreto que no coincide, falta de Message-Authenticator...).
CREATE TABLE descartes (
    id        bigserial PRIMARY KEY,
    fecha     timestamptz NOT NULL,
    ip        text NOT NULL,
    router_id bigint,
    motivo    text NOT NULL,
    detalle   text NOT NULL DEFAULT ''
);

CREATE INDEX descartes_por_fecha ON descartes (fecha);

-- Hasta dónde se ha leído descartes.log (igual que registro_posicion).
CREATE TABLE descartes_posicion (
    id             integer PRIMARY KEY CHECK (id = 1),
    inodo          bigint NOT NULL,
    desplazamiento bigint NOT NULL
);
