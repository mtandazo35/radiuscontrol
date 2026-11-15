-- Las huellas de las versiones dejan de ser el SHA-256 a secas de archivos que
-- contienen secretos: pasan a ser una huella con clave. La API convierte al
-- arrancar las filas que todavía no lo estén.
ALTER TABLE versiones_config ADD COLUMN huella_con_clave boolean NOT NULL DEFAULT false;
