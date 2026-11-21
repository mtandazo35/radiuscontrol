-- Descripción para una dirección o una red desde la que entran a los routers.
-- Solo sirve para leer mejor las autenticaciones.
CREATE TABLE origenes (
    id       bigserial PRIMARY KEY,
    red      inet NOT NULL UNIQUE,
    nombre   text NOT NULL,
    operador text NOT NULL DEFAULT '',
    creado   timestamptz NOT NULL DEFAULT now()
);

-- Nombre que le corresponde a una dirección: el de la red más pequeña que la
-- contiene. Devuelve NULL si no hay ninguna o si el texto no es una dirección
-- (el registro guarda lo que manda el router, que puede venir vacío).
CREATE FUNCTION nombre_origen(direccion text) RETURNS text
LANGUAGE plpgsql STABLE AS $$
BEGIN
    IF direccion IS NULL OR direccion = '' OR NOT pg_input_is_valid(direccion, 'inet') THEN
        RETURN NULL;
    END IF;
    RETURN (SELECT o.nombre FROM origenes o WHERE o.red >>= direccion::inet ORDER BY masklen(o.red) DESC LIMIT 1);
END;
$$;
