#!/usr/bin/env bash
# Laboratorio de RadiusControl: levanta FreeRADIUS con un cliente local y un
# usuario de prueba. Se ejecuta como root en el servidor, desde esta carpeta.
#
# Es idempotente: si las credenciales de prueba ya existen, no las cambia.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GEN="$DIR/generado"
CRED="$GEN/credenciales.env"
IMAGEN="freeradius/freeradius-server:${FREERADIUS_TAG:-latest-3.2}"

if [ "$(id -u)" -ne 0 ]; then
    echo "Este script se ejecuta como root." >&2
    exit 1
fi

hash_nt() {
    # Hash NT = MD4 de la contraseña en UTF-16LE. MD4 vive en el proveedor
    # "legacy" de OpenSSL 3.
    printf '%s' "$1" | iconv -f UTF-8 -t UTF-16LE \
        | openssl dgst -md4 -provider legacy -provider default -r \
        | awk '{print toupper($1)}'
}

echo "== 1. Docker"
if ! command -v docker >/dev/null 2>&1; then
    if ! command -v curl >/dev/null 2>&1; then
        apt-get update -q
        apt-get install -y -q curl ca-certificates
    fi
    curl -fsSL https://get.docker.com -o /root/get-docker.sh
    sh /root/get-docker.sh
fi
docker --version
docker compose version

echo "== 2. Comprobación del cálculo del hash NT"
# Vector conocido: el hash NT de "password" es 8846F7EAEE8FB117AD06BDD830B7586C.
if [ "$(hash_nt password)" != "8846F7EAEE8FB117AD06BDD830B7586C" ]; then
    echo "El cálculo del hash NT no da el valor de referencia. Se detiene." >&2
    exit 1
fi
echo "correcto"

echo "== 3. Credenciales de prueba"
install -d -m 0700 "$GEN"
if [ ! -f "$CRED" ]; then
    {
        echo "LAB_SECRETO=$(openssl rand -hex 16)"
        echo "LAB_USUARIO=tecnico-prueba"
        echo "LAB_CLAVE=$(openssl rand -hex 12)"
    } > "$CRED"
    chmod 0600 "$CRED"
    echo "generadas en $CRED"
else
    echo "ya existían, se conservan"
fi
# shellcheck disable=SC1090
. "$CRED"

echo "== 4. Imagen de FreeRADIUS"
docker pull "$IMAGEN"
RADDB=""
for candidato in /etc/raddb /etc/freeradius; do
    if docker run --rm --entrypoint test "$IMAGEN" -f "$candidato/clients.conf"; then
        RADDB="$candidato"
        break
    fi
done
if [ -z "$RADDB" ]; then
    echo "No se encontró la carpeta de configuración dentro de la imagen." >&2
    exit 1
fi
PROPIETARIO="$(docker run --rm --entrypoint stat "$IMAGEN" -c '%u:%g' "$RADDB/clients.conf")"
echo "configuración en $RADDB, propietario $PROPIETARIO"
echo "RADDB=$RADDB" > "$DIR/.env"

echo "== 5. Configuración generada"
cat > "$GEN/clients.conf" <<EOF
# Generado por instalar.sh. No editar a mano.
client laboratorio-local {
    ipaddr = 127.0.0.1
    secret = $LAB_SECRETO
    shortname = laboratorio-local
    require_message_authenticator = yes
    limit_proxy_state = yes
}
EOF

cat > "$GEN/authorize" <<EOF
# Generado por instalar.sh. No editar a mano.
# Solo se guarda el hash NT: sirve para PAP y para MS-CHAPv2.
$LAB_USUARIO  NT-Password := "$(hash_nt "$LAB_CLAVE")"
        Mikrotik-Group := "full"
EOF

chown "$PROPIETARIO" "$GEN/clients.conf" "$GEN/authorize"
chmod 0640 "$GEN/clients.conf" "$GEN/authorize"

echo "== 6. Validación antes de arrancar"
docker run --rm --network none \
    -v "$GEN/clients.conf:$RADDB/clients.conf:ro" \
    -v "$GEN/authorize:$RADDB/mods-config/files/authorize:ro" \
    "$IMAGEN" -C -l stdout
echo "configuración válida"

echo "== 7. Arranque"
cd "$DIR"
docker compose up -d --force-recreate
sleep 3
docker compose ps
docker exec radiuscontrol-freeradius sh -c 'freeradius -v 2>/dev/null || radiusd -v' | head -1

echo
echo "Listo. Ejecuta ./probar.sh para las pruebas."
