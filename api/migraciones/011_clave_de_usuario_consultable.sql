-- La contraseña de un usuario MikroTik se guarda también cifrada (AES-256-GCM, con
-- la clave maestra que vive fuera de la base) para que un administrador pueda
-- consultarla desde el panel. Los usuarios anteriores no la tienen hasta que se
-- les vuelva a poner una contraseña: de un hash no se puede recuperar.
ALTER TABLE usuarios_mikrotik ADD COLUMN clave_cifrada bytea;
