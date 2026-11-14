-- Momento de la última acción hecha por la persona en cada sesión. Las
-- consultas automáticas del panel no lo actualizan.
ALTER TABLE sesiones ADD COLUMN ultima_actividad timestamptz NOT NULL DEFAULT now();
