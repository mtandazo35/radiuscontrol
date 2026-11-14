#!/usr/bin/env bash
# Agente de actualización de RadiusControl. Corre en el servidor (no en un
# contenedor), como el agente de firewall.
#
# - Busca cada 30 minutos, o cuando el panel lo pide, si la rama principal del
#   repositorio tiene cambios nuevos, y deja la lista para que el panel la muestre.
# - Cuando un administrador pulsa «Actualizar ahora», hace el respaldo, instala
#   la versión nueva, comprueba que todo responde y, si algo falla, vuelve a la
#   versión anterior.
#
# No hay actualización automática: siempre la lanza una persona desde el panel.
set -u
export LC_ALL=C

REPO="${RC_REPO:-/root/radiuscontrol}"
DESPLIEGUE="$REPO/despliegue"
VOLUMEN="${RC_VOLUMEN:-/var/lib/docker/volumes/radiuscontrol_compilado/_data}"
ESTADO="$VOLUMEN/estado"
BUSQUEDA="$ESTADO/actualizacion.json"
PROCESO="$ESTADO/actualizacion-proceso.json"
PEDIDO="$ESTADO/actualizar-pedido.json"
PIDE_BUSCAR="$ESTADO/actualizar-buscar"
RESPALDOS=/root/backups
RAMA=main
CADA=1800
SIMULAR_FALLO=/root/radiuscontrol-simular-fallo
PASOS='["descargar","respaldo","construir","instalar","comprobar"]'

registrar() { echo "radiuscontrol-actualizar: $*"; }
ahora() { date -u +%Y-%m-%dT%H:%M:%SZ; }
git_repo() { git -C "$REPO" "$@"; }
compose() { (cd "$DESPLIEGUE" && docker compose "$@"); }
sql() { compose exec -T postgres psql -U radiuscontrol -d radiuscontrol -At -v ON_ERROR_STOP=1 "$@"; }

guardar() { # <archivo> <json>
    mkdir -p "$ESTADO"
    printf '%s\n' "$2" > "$1.tmp" && mv "$1.tmp" "$1"
}

# ------------------------------------------------------------------ búsqueda
buscar() {
    local error="" instalado ultimo cambios
    if ! timeout 90 git -C "$REPO" fetch --quiet origin "$RAMA" 2>/tmp/rc-fetch.err; then
        error="No se pudo consultar el repositorio: $(tail -n 1 /tmp/rc-fetch.err)"
    fi
    instalado="$(git_repo rev-parse HEAD 2>/dev/null)"
    ultimo="$(git_repo rev-parse "origin/$RAMA" 2>/dev/null || echo "$instalado")"
    cambios="$(git_repo log --format='%H%x1f%s%x1f%cI' "HEAD..origin/$RAMA" 2>/dev/null \
        | jq -R -s 'split("\n") | map(select(length > 0) | split("\u001f") | {commit: .[0], asunto: .[1], fecha: .[2]})')"
    guardar "$BUSQUEDA" "$(jq -n \
        --arg instalado "$instalado" \
        --arg instalado_fecha "$(git_repo log -1 --format=%cI HEAD 2>/dev/null)" \
        --arg instalado_asunto "$(git_repo log -1 --format=%s HEAD 2>/dev/null)" \
        --arg ultimo "$ultimo" --arg buscado "$(ahora)" --arg error "$error" \
        --argjson cambios "${cambios:-[]}" \
        '{instalado: $instalado, instalado_fecha: $instalado_fecha, instalado_asunto: $instalado_asunto,
          ultimo: $ultimo, cambios: $cambios, buscado: $buscado, error: $error}')"
}

# ------------------------------------------------------------------ avance
P_DE="" P_A="" P_QUIEN="" P_INICIO=""

avance() { # <estado> <paso en curso> <mensaje>
    guardar "$PROCESO" "$(jq -n --arg estado "$1" --arg paso "$2" --arg mensaje "$3" \
        --arg de "$P_DE" --arg a "$P_A" --arg quien "$P_QUIEN" --arg inicio "$P_INICIO" \
        --arg fin "$([ "$1" = "en-curso" ] || ahora)" --argjson pasos "$PASOS" \
        '{estado: $estado, paso: $paso, pasos: $pasos, mensaje: $mensaje, de: $de, a: $a,
          quien: $quien, inicio: $inicio, fin: $fin}')"
    registrar "$1 ($2) $3"
}

anotar_actividad() { # <acción> <detalle json>
    sql -c "INSERT INTO auditoria (operador, ip, accion, objeto, detalle)
            VALUES ('$P_QUIEN', 'servidor', '$1', 'versión ${P_A:0:7}', '$2'::jsonb)" >/dev/null 2>&1 || true
}

# ------------------------------------------------------------------ respaldo
hacer_respaldo() {
    local marca dir archivo
    marca="$(date +%Y%m%d-%H%M%S)"
    dir="$(mktemp -d /root/rc-respaldo.XXXXXX)"
    archivo="$RESPALDOS/radiuscontrol-actualizar-$marca.tar.gz"
    mkdir -p "$RESPALDOS"
    # Base de datos en formato propio de PostgreSQL, que se puede restaurar entera.
    if ! compose exec -T postgres pg_dump -U radiuscontrol -Fc radiuscontrol > "$dir/base.dump" 2>/dev/null \
        || [ ! -s "$dir/base.dump" ]; then
        rm -rf "$dir"
        return 1
    fi
    # Se comprueba que el volcado se puede leer antes de darlo por bueno.
    if ! compose exec -T postgres pg_restore --list < "$dir/base.dump" >/dev/null 2>&1; then
        rm -rf "$dir"
        return 1
    fi
    printf '%s\n' "$P_DE" > "$dir/commit.txt"
    cp -a "$DESPLIEGUE/secrets" "$dir/secrets"
    cp -a "$DESPLIEGUE/.env" "$dir/env"
    ( umask 077; tar czf "$archivo" -C "$dir" . ) || { rm -rf "$dir"; return 1; }
    tar tzf "$archivo" >/dev/null 2>&1 || { rm -rf "$dir"; return 1; }
    cp "$dir/base.dump" /root/rc-ultimo.dump
    chmod 600 /root/rc-ultimo.dump
    rm -rf "$dir"
    # Se conservan los cinco últimos.
    ls -1t "$RESPALDOS"/radiuscontrol-actualizar-*.tar.gz 2>/dev/null | tail -n +6 | xargs -r rm -f
    RESPALDO="$archivo"
}

migraciones() { sql -c "SELECT count(*) FROM migraciones_aplicadas" 2>/dev/null || echo "?"; }

# ------------------------------------------------------------------ instalar
levantar() {
    compose build >/tmp/rc-build.log 2>&1 || return 1
    compose up -d >/tmp/rc-up.log 2>&1 || return 1
    install -m 0755 "$DESPLIEGUE/firewall/radiuscontrol-firewall.sh" /usr/local/sbin/radiuscontrol-firewall.sh
    install -m 0644 "$DESPLIEGUE/firewall/radiuscontrol-firewall.service" /etc/systemd/system/radiuscontrol-firewall.service
    install -m 0755 "$DESPLIEGUE/actualizar/radiuscontrol-actualizar.sh" /usr/local/sbin/radiuscontrol-actualizar.sh
    install -m 0644 "$DESPLIEGUE/actualizar/radiuscontrol-actualizar.service" /etc/systemd/system/radiuscontrol-actualizar.service
    systemctl daemon-reload
    systemctl restart radiuscontrol-firewall.service
}

# Todo responde: la API, FreeRADIUS con su configuración cargada y la web.
comprobar_salud() {
    local sitio
    sitio="$(sed -n 's/^SITIO=//p' "$DESPLIEGUE/.env")"
    if [ -e "$SIMULAR_FALLO" ]; then
        rm -f "$SIMULAR_FALLO"
        return 1
    fi
    for _ in $(seq 1 75); do
        if [ "$(curl -s -o /dev/null -m 5 -w '%{http_code}' http://127.0.0.1:8080/api/sesion)" = "401" ] \
            && [ "$(jq -r .estado "$ESTADO/cargado.json" 2>/dev/null)" = "en-marcha" ] \
            && [ "$(curl -sk -o /dev/null -m 5 -w '%{http_code}' "$sitio/")" = "200" ]; then
            return 0
        fi
        sleep 2
    done
    return 1
}

revertir() { # <migraciones antes>
    registrar "volviendo a ${P_DE:0:7}"
    git_repo reset --quiet --hard "$P_DE"
    if [ "$(migraciones)" != "$1" ]; then
        # La versión nueva cambió la base: se restaura el volcado del respaldo.
        compose stop api >/dev/null 2>&1
        sql -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public" >/dev/null 2>&1
        compose exec -T postgres pg_restore -U radiuscontrol -d radiuscontrol --no-owner < /root/rc-ultimo.dump >/dev/null 2>&1
    fi
    levantar
    for _ in $(seq 1 60); do
        [ "$(curl -s -o /dev/null -m 5 -w '%{http_code}' http://127.0.0.1:8080/api/sesion)" = "401" ] && return 0
        sleep 2
    done
    return 1
}

# ------------------------------------------------------------------ actualización
actualizar() {
    local commit quien antes
    commit="$(jq -r '.commit // ""' "$PEDIDO" 2>/dev/null)"
    quien="$(jq -r '.operador // ""' "$PEDIDO" 2>/dev/null)"
    rm -f "$PEDIDO"
    # El pedido lo escribe la API, pero aquí no se confía en su contenido.
    [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { registrar "pedido con un commit no válido"; return; }
    [[ "$quien" =~ ^[A-Za-z0-9._@-]{1,64}$ ]] || quien="desconocido"

    P_DE="$(git_repo rev-parse HEAD)"
    P_A="$commit"
    P_QUIEN="$quien"
    P_INICIO="$(ahora)"

    avance en-curso descargar ""
    if ! timeout 90 git -C "$REPO" fetch --quiet origin "$RAMA"; then
        avance fallida descargar "No se pudo descargar del repositorio. No se cambió nada."
        return
    fi
    if [ "$commit" != "$(git_repo rev-parse "origin/$RAMA")" ]; then
        avance fallida descargar "Esa versión ya no es la última publicada. Busca actualizaciones de nuevo. No se cambió nada."
        buscar
        return
    fi
    if [ "$commit" = "$P_DE" ] || ! git_repo merge-base --is-ancestor "$P_DE" "$commit"; then
        avance fallida descargar "Solo se puede avanzar a una versión posterior a la instalada. No se cambió nada."
        return
    fi
    if [ -n "$(git_repo status --porcelain --untracked-files=no)" ]; then
        avance fallida descargar "Hay archivos modificados a mano en el servidor. No se cambió nada."
        return
    fi

    avance en-curso respaldo ""
    RESPALDO=""
    if ! hacer_respaldo; then
        avance fallida respaldo "No se pudo hacer o verificar el respaldo. No se cambió nada."
        anotar_actividad sistema.actualizacion_fallida '{"paso": "respaldo"}'
        return
    fi
    antes="$(migraciones)"

    avance en-curso construir ""
    git_repo merge --quiet --ff-only "$commit"
    if ! compose build >/tmp/rc-build.log 2>&1; then
        git_repo reset --quiet --hard "$P_DE"
        avance fallida construir "La versión nueva no se pudo construir. Sigue en marcha la anterior, sin cambios."
        anotar_actividad sistema.actualizacion_fallida '{"paso": "construir"}'
        return
    fi

    avance en-curso instalar ""
    levantar

    avance en-curso comprobar ""
    if comprobar_salud; then
        avance ok comprobar "Actualizado. Respaldo previo en $RESPALDO"
        anotar_actividad sistema.actualizada "$(jq -n --arg de "${P_DE:0:7}" --arg a "${P_A:0:7}" '{de: $de, a: $a}')"
        buscar
        # El propio agente pudo cambiar: se reinicia solo, fuera de este proceso.
        systemd-run --quiet --on-active=3 systemctl restart radiuscontrol-actualizar.service >/dev/null 2>&1 || true
        return
    fi

    if revertir "$antes"; then
        avance revertida comprobar "La versión nueva no respondió bien y se volvió a la anterior. Respaldo en $RESPALDO"
    else
        avance fallida comprobar "La versión nueva falló y la anterior no arrancó sola. Revisa el servidor. Respaldo en $RESPALDO"
    fi
    anotar_actividad sistema.actualizacion_revertida "$(jq -n --arg de "${P_DE:0:7}" --arg a "${P_A:0:7}" '{de: $de, intentada: $a}')"
    buscar
}

# ------------------------------------------------------------------ bucle
if [ "${1:-}" = "buscar" ]; then
    buscar
    cat "$BUSQUEDA"
    exit 0
fi

registrar "en marcha; repositorio $REPO"
# Si el agente se reinició a mitad de una actualización, no se deja «en curso» para siempre.
if [ "$(jq -r .estado "$PROCESO" 2>/dev/null)" = "en-curso" ]; then
    P_DE="$(jq -r .de "$PROCESO")"; P_A="$(jq -r .a "$PROCESO")"; P_QUIEN="$(jq -r .quien "$PROCESO")"; P_INICIO="$(jq -r .inicio "$PROCESO")"
    avance fallida "$(jq -r .paso "$PROCESO")" "La actualización se interrumpió. Revisa el servidor."
fi
SEGUNDOS=$CADA
while :; do
    if [ -f "$PEDIDO" ]; then
        actualizar
        SEGUNDOS=0
    elif [ -f "$PIDE_BUSCAR" ] || [ "$SEGUNDOS" -ge "$CADA" ]; then
        rm -f "$PIDE_BUSCAR"
        buscar
        SEGUNDOS=0
    fi
    sleep 3
    SEGUNDOS=$((SEGUNDOS + 3))
done
