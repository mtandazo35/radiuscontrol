-- La pantalla de inicio cuenta autenticaciones por fecha y por router.
CREATE INDEX IF NOT EXISTS autenticaciones_por_momento ON autenticaciones (fecha);
CREATE INDEX IF NOT EXISTS autenticaciones_por_router ON autenticaciones (router_id, fecha);
