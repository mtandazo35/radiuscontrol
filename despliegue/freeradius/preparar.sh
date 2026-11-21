#!/bin/sh
# Añade a la configuración base de FreeRADIUS el registro de autenticaciones y
# la política de accesos por router.
# Se ejecuta al construir la imagen, tanto la de FreeRADIUS como la de la API
# (que valida con la misma base). Si algo no encaja, la construcción falla.
set -eu

R=/etc/freeradius
ORIGEN=/tmp/rc
SITIO="$R/sites-available/default"

cp "$ORIGEN/rc_registro.mod" "$R/mods-available/rc_registro"
cp "$ORIGEN/rc_registro.policy" "$R/policy.d/rc_registro"
cp "$ORIGEN/rc_accesos.policy" "$R/policy.d/rc_accesos"
for f in "$R/mods-available/rc_registro" "$R/policy.d/rc_registro" "$R/policy.d/rc_accesos"; do
    chown --reference="$R/radiusd.conf" "$f"
    chmod 0640 "$f"
done
ln -sf ../mods-available/rc_registro "$R/mods-enabled/rc_registro"

# Primera sentencia de post-auth y de su rama de rechazo.
sed -i '0,/^post-auth {/s//post-auth {\n\trc_registrar_aceptado/' "$SITIO"
sed -i '0,/^[[:space:]]*Post-Auth-Type REJECT {/s//\tPost-Auth-Type REJECT {\n\t\trc_registrar_rechazado/' "$SITIO"

# Accesos por router: justo después de «files» en authorize, cuando el usuario
# ya trae su identificador y su grupo general.
sed -i '0,/^\tfiles$/s//\tfiles\n\trc_accesos/' "$SITIO"

# MS-CHAP: la rama de rechazo distingue el sondeo con la contraseña vacía.
awk -v bloque="$ORIGEN/rc_mschap.bloque" '
/^\tAuth-Type MS-CHAP \{$/ && !hecho { while ((getline l < bloque) > 0) print l; salta = 1; hecho = 1; next }
salta { if ($0 ~ /^\t\}$/) salta = 0; next }
{ print }' "$SITIO" > "$SITIO.rc"
cat "$SITIO.rc" > "$SITIO"
rm -f "$SITIO.rc"

if [ "$(grep -c 'rc_sondeo_mschap' "$SITIO")" != 1 ]; then
    echo "preparar: no se pudo insertar la detección del sondeo MS-CHAP en $SITIO" >&2
    exit 1
fi

if [ "$(grep -c 'rc_registrar_aceptado' "$SITIO")" != 1 ] || [ "$(grep -c 'rc_registrar_rechazado' "$SITIO")" != 1 ] ||
    [ "$(grep -c 'rc_accesos' "$SITIO")" != 1 ]; then
    echo "preparar: no se pudo insertar el registro o los accesos por router en $SITIO" >&2
    exit 1
fi

if ! freeradius -C -l stdout > /tmp/preparar.log 2>&1; then
    cat /tmp/preparar.log >&2
    echo "preparar: FreeRADIUS rechaza la configuración base" >&2
    exit 1
fi
rm -rf "$ORIGEN" /tmp/preparar.log
echo "preparar: registro de autenticaciones y accesos por router instalados"
