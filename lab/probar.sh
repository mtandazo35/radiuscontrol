#!/usr/bin/env bash
# Pruebas del laboratorio contra el FreeRADIUS en marcha. Deja la evidencia en
# generado/evidencia-<fecha>.txt, con el secreto y la contraseña enmascarados.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GEN="$DIR/generado"
# shellcheck disable=SC1091
. "$GEN/credenciales.env"

CONTENEDOR="radiuscontrol-freeradius"
EVIDENCIA="$GEN/evidencia-$(date +%Y%m%d-%H%M%S).txt"
IP_PUBLICA="$(ip -4 route get 192.0.2.1 | awk '{for (i = 1; i <= NF; i++) if ($i == "src") print $(i + 1)}')"
FALLOS=0

enmascarar() {
    sed -e "s/$LAB_SECRETO/<secreto>/g" -e "s/$LAB_CLAVE/<clave>/g"
}

# consulta <destino> <secreto> <atributos>
consulta() {
    printf '%s\n' "$3" \
        | docker exec -i "$CONTENEDOR" radclient -x -r 1 -t 3 "$1" auth "$2" 2>&1
}

# prueba <nombre> <debe|no-debe> <patrón> <salida>
prueba() {
    local nombre="$1" modo="$2" patron="$3" salida="$4" resultado="FALLA"
    if printf '%s' "$salida" | grep -q -- "$patron"; then
        [ "$modo" = "debe" ] && resultado="PASA"
    else
        [ "$modo" = "no-debe" ] && resultado="PASA"
    fi
    [ "$resultado" = "FALLA" ] && FALLOS=$((FALLOS + 1))
    {
        echo "[$resultado] $nombre"
        printf '%s\n' "$salida" | sed 's/^/    /'
        echo
    } | enmascarar | tee -a "$EVIDENCIA"
}

{
    echo "Laboratorio RadiusControl: $(date '+%Y-%m-%d %H:%M:%S %Z')"
    docker exec "$CONTENEDOR" sh -c 'freeradius -v 2>/dev/null || radiusd -v' | head -1
    echo
} | tee "$EVIDENCIA"

PAP_OK="User-Name = \"$LAB_USUARIO\", User-Password = \"$LAB_CLAVE\""
PAP_MAL="User-Name = \"$LAB_USUARIO\", User-Password = \"incorrecta\""
CHAP_OK="User-Name = \"$LAB_USUARIO\", MS-CHAP-Password = \"$LAB_CLAVE\""
CHAP_MAL="User-Name = \"$LAB_USUARIO\", MS-CHAP-Password = \"incorrecta\""

S="$(consulta 127.0.0.1 "$LAB_SECRETO" "$PAP_OK")"
prueba "PAP con la contraseña correcta: acepta" debe "Received Access-Accept" "$S"
prueba "PAP: la respuesta trae el grupo full" debe 'Mikrotik-Group = "full"' "$S"

S="$(consulta 127.0.0.1 "$LAB_SECRETO" "$CHAP_OK")"
prueba "MS-CHAP (v1, el que genera radclient) con la contraseña correcta: acepta" debe "Received Access-Accept" "$S"
prueba "MS-CHAP: la respuesta trae el grupo full" debe 'Mikrotik-Group = "full"' "$S"

S="$(consulta 127.0.0.1 "$LAB_SECRETO" "$PAP_MAL")"
prueba "PAP con contraseña incorrecta: rechaza" debe "Received Access-Reject" "$S"

S="$(consulta 127.0.0.1 "$LAB_SECRETO" "$CHAP_MAL")"
prueba "MS-CHAP con contraseña incorrecta: rechaza" debe "Received Access-Reject" "$S"

S="$(consulta 127.0.0.1 "secreto-equivocado" "$PAP_OK")"
prueba "Secreto RADIUS incorrecto: ningún login válido" no-debe "Access-Accept" "$S"

S="$(consulta "$IP_PUBLICA" "$LAB_SECRETO" "$PAP_OK")"
prueba "Origen no autorizado ($IP_PUBLICA): sin respuesta" no-debe "Received" "$S"

S="$(docker logs --since 2m "$CONTENEDOR" 2>&1 | grep -i 'unknown client' | tail -1)"
prueba "Origen no autorizado: el intento queda en el registro" debe "unknown client" "$S"

echo "Evidencia: $EVIDENCIA"
if [ "$FALLOS" -gt 0 ]; then
    echo "RESULTADO: $FALLOS prueba(s) fallida(s)"
    exit 1
fi
echo "RESULTADO: todas las pruebas pasan"
