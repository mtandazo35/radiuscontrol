#!/usr/bin/env bash
# Agente de firewall de RadiusControl. Corre en el servidor (no en un
# contenedor) y mantiene en UFW una regla de 1812/udp por cada red de origen de
# la configuración aplicada. Cuando una red deja de estar aplicada, su regla
# se elimina.
#
# Mantiene también los accesos al propio servidor que el operador gestiona
# desde el panel: quién llega a la web del panel (443/tcp) y al SSH.
#
# Solo toca las reglas que llevan sus comentarios: «radiuscontrol» en 1812/udp,
# «radiuscontrol-panel» en 443/tcp y «radiuscontrol-ssh» en el puerto de SSH.
# No activa ni desactiva UFW y no modifica ninguna otra regla: las que el
# operador cargó a mano solo se leen, para informar de ellas al panel.
set -u
export LC_ALL=C

VOLUMEN="${RC_VOLUMEN:-/var/lib/docker/volumes/radiuscontrol_compilado/_data}"
PUERTO=1812
MARCA="radiuscontrol"
INTERVALO=3
REVISION=60
VALIDA='^([0-9]{1,3}\.){3}[0-9]{1,3}(/[0-9]{1,2})?$|^[0-9a-fA-F:]+(/[0-9]{1,3})?$'

# Accesos al servidor gestionados desde el panel.
ACCESOS="$VOLUMEN/servidor/accesos.txt"
PUERTO_PANEL=443
MARCA_PANEL="radiuscontrol-panel"
MARCA_SSH="radiuscontrol-ssh"
# Lo último que se sabe de esos accesos, en JSON; vacío si no se pudo componer.
SERVIDOR_JSON=""
LISTA_ACCESOS=""

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

# ------------------------------------------------------------ accesos al servidor

# Puerto en el que escucha el SSH de este servidor; 22 si no se puede saber.
puerto_ssh() {
    local p
    p="$(sshd -T 2>/dev/null | awk '$1 == "port" {print $2; exit}')"
    if [[ "$p" =~ ^[0-9]{1,5}$ ]] && [ "$((10#$p))" -ge 1 ] && [ "$((10#$p))" -le 65535 ]; then
        echo "$((10#$p))"
    else
        echo 22
    fi
}

# Lee la lista que deja la API y la guarda en LISTA_ACCESOS. Falla si no está o
# está incompleta: en ese caso no se toca ninguna regla del panel ni del SSH.
leer_accesos() {
    LISTA_ACCESOS=""
    [ -f "$ACCESOS" ] || return 1
    LISTA_ACCESOS="$(cat "$ACCESOS" 2>/dev/null)" || return 1
    [ "$(printf '%s\n' "$LISTA_ACCESOS" | tail -n 1)" = "# fin" ]
}

# Redes que el panel quiere para un servicio, ya validadas. «cualquiera» abre el
# servicio a todas las direcciones; un prefijo /0 no se admite por otro camino.
deseadas_servidor() { # <servicio>
    printf '%s\n' "$LISTA_ACCESOS" \
        | awk -v servicio="$1" 'NF == 2 && $1 == servicio {print $2}' \
        | grep -E -e "$VALIDA" -e '^cualquiera$' | grep -v -E '/0+$' | normalizar | sort -u
}

# Todas las reglas «allow» de UFW que dejan llegar por TCP a un puerto, una por
# línea y separadas por tabuladores: servicio, red, gestionada, comentario.
# La red es «cualquiera» si la regla no limita el origen. Una regla es
# gestionada solo si lleva nuestro comentario y tiene exactamente la forma que
# este agente crea. No cuentan las reglas de salida, las atadas a una interfaz,
# las que fijan una dirección de destino o un puerto de origen, ni los perfiles
# de aplicación.
reglas_de() { # <servicio> <puerto> <comentario propio>
    ufw show added 2>/dev/null | awk -v servicio="$1" -v puerto="$2" -v marca="$3" -v q="'" '
        # cubre: el puerto está en una lista como «80,443» o en un rango «8000:8100»
        function cubre(lista,    n, i, partes, extremos) {
            n = split(lista, partes, ",")
            for (i = 1; i <= n; i++) {
                if (partes[i] == puerto) return 1
                if (split(partes[i], extremos, ":") == 2 && extremos[1] ~ /^[0-9]+$/ && extremos[2] ~ /^[0-9]+$/ &&
                    puerto + 0 >= extremos[1] + 0 && puerto + 0 <= extremos[2] + 0) return 1
            }
            return 0
        }
        $1 == "ufw" && $2 == "allow" {
            linea = $0
            comentario = ""
            corte = index(linea, " comment " q)
            if (corte > 0) {
                comentario = substr(linea, corte + 10)
                if (substr(comentario, length(comentario)) == q) comentario = substr(comentario, 1, length(comentario) - 1)
                linea = substr(linea, 1, corte - 1)
            }
            total = split(linea, t, " ")
            origen = "any"; destino = "any"; dport = ""; proto = ""; sitio = ""; descartar = 0
            for (k = 3; k <= total; k++) {
                if (t[k] == "log" || t[k] == "log-all") continue
                if (t[k] == "from" && k < total) { origen = t[++k]; sitio = "origen"; continue }
                if (t[k] == "to" && k < total) { destino = t[++k]; sitio = "destino"; continue }
                if (t[k] == "port" && k < total && sitio == "destino") { dport = t[++k]; continue }
                if (t[k] == "proto" && k < total) { proto = t[++k]; continue }
                if (sitio == "" && dport == "" && t[k] != "in" && t[k] != "out" && t[k] != "on" && t[k] != "app") {
                    # Forma corta: «443/tcp», «22» o «80,443/tcp».
                    partes_n = split(t[k], corto, "/")
                    dport = corto[1]
                    if (partes_n > 1) proto = corto[2]
                    sitio = "corta"
                    continue
                }
                descartar = 1
                break
            }
            if (descartar || dport == "" || !cubre(dport)) next
            if (proto != "" && proto != "any" && proto != "tcp") next
            if (destino != "any" && destino != "0.0.0.0/0" && destino != "::/0") next
            red = origen
            if (origen == "any" || origen == "0.0.0.0/0" || origen == "::/0") red = "cualquiera"
            gestionada = "false"
            if (comentario == marca) {
                if (red == "cualquiera") forma = "ufw allow " puerto "/tcp"
                else forma = "ufw allow from " red " to any port " puerto " proto tcp"
                if (linea == forma) gestionada = "true"
            }
            printf "%s\t%s\t%s\t%s\n", servicio, red, gestionada, comentario
        }'
}

# Redes de un servicio que hoy tienen una regla gestionada por este agente.
gestionadas_de() { # <servicio> <puerto> <comentario propio>
    reglas_de "$1" "$2" "$3" | awk -F '\t' '$3 == "true" {print $2}' | sort -u
}

# Las reglas del panel y del SSH, gestionadas o no, en el formato de reglas_de.
reglas_servidor() { # <puerto de SSH>
    reglas_de panel "$PUERTO_PANEL" "$MARCA_PANEL"
    reglas_de ssh "$1" "$MARCA_SSH"
}

# Convierte la salida de reglas_de en una lista JSON.
reglas_json() {
    jq -R -s -c 'split("\n") | map(select(length > 0) | split("\t")
        | {servicio: .[0], red: .[1], gestionada: (.[2] == "true"), comentario: (.[3:] | join("\t"))})' 2>/dev/null
}

permitir_acceso() { # <red> <puerto> <comentario propio>
    if [ "$1" = "cualquiera" ]; then
        ufw allow "$2/tcp" comment "$3" >/dev/null 2>&1
    else
        ufw allow from "$1" to any port "$2" proto tcp comment "$3" >/dev/null 2>&1
    fi
}

retirar_acceso() { # <red> <puerto>
    if [ "$1" = "cualquiera" ]; then
        ufw delete allow "$2/tcp" >/dev/null 2>&1
    else
        ufw delete allow from "$1" to any port "$2" proto tcp >/dev/null 2>&1
    fi
}

# Deja en SERVIDOR_JSON el estado de los accesos al servidor. Si la lista de la
# API está completa, antes iguala las reglas gestionadas a lo que pide: primero
# añade las que faltan y después quita las que sobran, nunca al revés. Permitir
# una red que el operador ya tenía a mano no la duplica: UFW le cambia el
# comentario y la regla pasa a estar gestionada.
sincronizar_servidor() {
    local puerto_de_ssh servicio puerto marca quiero tengo red reglas estado="sincronizado"
    SERVIDOR_JSON=""
    puerto_de_ssh="$(puerto_ssh)"
    if ! leer_accesos; then
        estado="sin-configuracion"
    else
        for servicio in panel ssh; do
            if [ "$servicio" = "panel" ]; then
                puerto="$PUERTO_PANEL"
                marca="$MARCA_PANEL"
            else
                puerto="$puerto_de_ssh"
                marca="$MARCA_SSH"
            fi
            quiero="$(deseadas_servidor "$servicio")"
            tengo="$(gestionadas_de "$servicio" "$puerto" "$marca")"
            while IFS= read -r red; do
                [ -n "$red" ] || continue
                if permitir_acceso "$red" "$puerto" "$marca"; then
                    registrar "$servicio ($puerto/tcp): permitida $red"
                else
                    registrar "$servicio ($puerto/tcp): ERROR al permitir $red"
                    estado="error"
                fi
            done < <(comm -23 <(printf '%s\n' "$quiero") <(printf '%s\n' "$tengo"))
            while IFS= read -r red; do
                [ -n "$red" ] || continue
                if retirar_acceso "$red" "$puerto"; then
                    registrar "$servicio ($puerto/tcp): retirada $red"
                else
                    registrar "$servicio ($puerto/tcp): ERROR al retirar $red"
                    estado="error"
                fi
            done < <(comm -13 <(printf '%s\n' "$quiero") <(printf '%s\n' "$tengo"))
            # Se compara con lo que UFW tiene de verdad, no con lo que se pidió.
            tengo="$(gestionadas_de "$servicio" "$puerto" "$marca")"
            [ "$tengo" = "$quiero" ] || estado="error"
        done
    fi
    # El informe se compone con jq para que un comentario raro no lo rompa.
    reglas="$(reglas_servidor "$puerto_de_ssh" | reglas_json)" || reglas=""
    [ -n "$reglas" ] || return
    SERVIDOR_JSON="$(jq -n -c --arg estado "$estado" --argjson puerto "$puerto_de_ssh" --argjson reglas "$reglas" \
        '{estado: $estado, puerto_ssh: $puerto, reglas: $reglas}' 2>/dev/null)" || SERVIDOR_JSON=""
}

# ------------------------------------------------------------ informe

informar() { # <estado> <versión> <lista de redes, una por línea>
    local lista activo="false" base completo=""
    ufw status 2>/dev/null | grep -q '^Status: active' && activo="true"
    lista="$(printf '%s\n' "$3" | grep -v '^$' | sed 's/.*/"&"/' | paste -sd, -)"
    mkdir -p "$VOLUMEN/estado"
    base="$(printf '{"estado":"%s","version":"%s","ufw_activo":%s,"redes":[%s],"desde":"%s"}' \
        "$1" "$2" "$activo" "$lista" "$(date -u +%Y-%m-%dT%H:%M:%SZ)")"
    # Los accesos al servidor van en un objeto aparte. Si no se pudo componer,
    # el informe sale como siempre, sin él: el panel no permite entonces quitar
    # accesos.
    if [ -n "$SERVIDOR_JSON" ]; then
        completo="$(printf '%s' "$base" | jq -c --argjson servidor "$SERVIDOR_JSON" '. + {servidor: $servidor}' 2>/dev/null)" \
            || completo=""
    fi
    printf '%s\n' "${completo:-$base}" > "$VOLUMEN/estado/firewall.json.tmp" \
        && mv "$VOLUMEN/estado/firewall.json.tmp" "$VOLUMEN/estado/firewall.json"
}

sincronizar() {
    local quiero tengo red estado="sincronizado"
    # Los accesos al servidor no dependen de la configuración aplicada: se
    # atienden primero y su resultado viaja en el mismo informe.
    sincronizar_servidor
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

# Huella de la lista de accesos: cambia en cuanto el panel la reescribe.
huella_accesos() { cksum "$ACCESOS" 2>/dev/null; }

if [ "${1:-}" = "una-vez" ]; then
    sincronizar
    exit 0
fi

registrar "en marcha; volumen $VOLUMEN"
ANTERIOR=""
ACCESOS_ANTES=""
SEGUNDOS=$REVISION
while :; do
    AHORA="$(version_aplicada)"
    ACCESOS_AHORA="$(huella_accesos)"
    if [ "$AHORA" != "$ANTERIOR" ] || [ "$ACCESOS_AHORA" != "$ACCESOS_ANTES" ] || [ "$SEGUNDOS" -ge "$REVISION" ]; then
        sincronizar
        ANTERIOR="$AHORA"
        ACCESOS_ANTES="$ACCESOS_AHORA"
        SEGUNDOS=0
    fi
    sleep "$INTERVALO"
    SEGUNDOS=$((SEGUNDOS + INTERVALO))
done
