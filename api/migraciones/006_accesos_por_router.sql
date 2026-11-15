-- Accesos por router. En modo «general» entran todos los usuarios activos con
-- su grupo general; en modo «restringido» solo los asignados a ese router, cada
-- uno con el grupo que tenga en él.
ALTER TABLE routers ADD COLUMN acceso text NOT NULL DEFAULT 'general'
    CHECK (acceso IN ('general', 'restringido'));

-- Las asignaciones se conservan aunque el router esté en modo general: solo se
-- compilan cuando está restringido.
CREATE TABLE router_accesos (
    router_id  bigint NOT NULL REFERENCES routers (id) ON DELETE CASCADE,
    usuario_id bigint NOT NULL REFERENCES usuarios_mikrotik (id) ON DELETE CASCADE,
    grupo      text NOT NULL,
    PRIMARY KEY (router_id, usuario_id)
);

CREATE INDEX router_accesos_por_usuario ON router_accesos (usuario_id);
