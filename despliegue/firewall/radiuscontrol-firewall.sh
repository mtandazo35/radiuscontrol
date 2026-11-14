#!/usr/bin/env bash
# Agente de firewall de RadiusControl. Corre en el servidor (no en un
# contenedor) y mantiene en UFW una regla de 1812/udp por cada red de origen de
# la configuración aplicada. Cuando una red deja de estar aplicada, su regla
# se elimina.
#
# Solo toca las reglas de 1812/udp que llevan el comentario «radiuscontrol».
# No activa ni desactiva UFW y no modifica ninguna otra regla.
set -u
export LC_ALL=C

VOLUMEN="${RC_VOLUMEN:-/var/lib/docker/volumes/radiuscontrol_compilado/_data}"
PUERTO=1812
MARCA="radiuscontrol"
INTERVALO=3
REVISION=60
VALIDA='^([0-9]{1,3}\.){3}[0-9]{1,3}(/[0-9]{1,2})?$|^[0-9a-fA-F:]+(/[0-9]{1,3})?$'

registrar() { echo "radiuscontrol-firewall: $*"; }

# UFW guarda las direcciones sueltas sin máscara; se comparan en esa forma.
normalizar() { sed -E 's#^([0-9.]+)/32$#\1#; s#^([0-9a-fA-F:]+)/128$#\1#'; }

version_aplicada() { basename "$(readlink "$VOLUMEN/actual" 2>/dev/null)" 2>/dev/null; }

# Redes de la configuración aplicada. Falla si la lista no está o está incompleta:
# en ese caso no se toca nada.
deseadas() {
    local f="$VOLUMEN/actual/redes.txt"
    [ -f "$f" ] || return 1
    [ "$(tail -n 1 "$f")" = "# fin" ] || return 1
    grep -v '^#' "$f" | grep -E "$VALIDA" | normalizar | sort -u
}

actuales() {
    ufw show added 2>/dev/null \
        | sed -n "s/^ufw allow from \([^ ]*\) to any port $PUERTO proto udp comment '$MARCA'\$/\1/p" \
        | sort -u
}

informar() { # <estado> <versión> <lista de redes, una por línea>
    local lista activo="false"
    ufw status 2>/dev/null | grep -q '^Status: active' && activo="true"
    lista="$(printf '%s\n' "$3" | grep -v '^$' | sed 's/.*/"&"/' | paste -sd, -)"
    mkdir -p "$VOLUMEN/estado"
    printf '{"estado":"%s","version":"%s","ufw_activo":%s,"redes":[%s],"desde":"%s"}\n' \
        "$1" "$2" "$activo" "$lista" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$VOLUMEN/estado/firewall.json.tmp" \
        && mv "$VOLUMEN/estado/firewall.json.tmp" "$VOLUMEN/estado/firewall.json"
}

sincronizar() {
    local quiero tengo red estado="sincronizado"
    if ! quiero="$(deseadas)"; then
        informar "sin-configuracion" "" "$(actuales)"
        return
    fi
    tengo="$(actuales)"
    while IFS= read -r red; do
        [ -n "$red" ] || continue
        if ufw allow from "$red" to any port "$PUERTO" proto udp comment "$MARCA" >/dev/null 2>&1; then
            registrar "permitida $red"
        else
            registrar "ERROR al permitir $red"
            estado="error"
        fi
    done < <(comm -23 <(printf '%s\n' "$quiero") <(printf '%s\n' "$tengo"))
    while IFS= read -r red; do
        [ -n "$red" ] || continue
        if ufw delete allow from "$red" to any port "$PUERTO" proto udp >/dev/null 2>&1; then
            registrar "retirada $red"
        else
            registrar "ERROR al retirar $red"
            estado="error"
        fi
    done < <(comm -13 <(printf '%s\n' "$quiero") <(printf '%s\n' "$tengo"))
    # Se informa de lo que UFW tiene de verdad, no de lo que se pidió.
    tengo="$(actuales)"
    [ "$tengo" = "$quiero" ] || estado="error"
    informar "$estado" "$(version_aplicada)" "$tengo"
}

if [ "${1:-}" = "una-vez" ]; then
    sincronizar
    exit 0
fi

registrar "en marcha; volumen $VOLUMEN"
ANTERIOR=""
SEGUNDOS=$REVISION
while :; do
    AHORA="$(version_aplicada)"
    if [ "$AHORA" != "$ANTERIOR" ] || [ "$SEGUNDOS" -ge "$REVISION" ]; then
        sincronizar
        ANTERIOR="$AHORA"
        SEGUNDOS=0
    fi
    sleep "$INTERVALO"
    SEGUNDOS=$((SEGUNDOS + INTERVALO))
done
