#!/bin/sh
# Arranque del contenedor de FreeRADIUS.
#
# Carga la configuración que la API deja en el volumen compartido y reinicia
# FreeRADIUS cuando el enlace «actual» apunta a otra versión. No depende de la
# API ni de la base: si ambas caen, sigue con la última versión cargada.
set -u

COMP="${DIR_COMPILADO:-/compilado}"
RADDB="${DIR_RADDB:-/etc/freeradius}"
GRUPO="$(stat -c %g "$RADDB/radiusd.conf")"
PID=""

terminar() {
    [ -n "$PID" ] && kill -TERM "$PID" 2>/dev/null
    wait 2>/dev/null
    exit 0
}
trap terminar TERM INT

mkdir -p "$COMP/estado"

# Carpeta del registro de autenticaciones: la escribe FreeRADIUS y la lee la API.
REGISTRO="${DIR_REGISTRO:-/registro}"
mkdir -p "$REGISTRO"
chown "$(stat -c %U "$RADDB/mods-config/files" 2>/dev/null || echo root):$GRUPO" "$REGISTRO"
chmod 0770 "$REGISTRO"

FIFO=/tmp/rc-salida-freeradius
DESCARTES="$REGISTRO/descartes.log"
[ -f "$DESCARTES" ] || install -m 0640 -g "$GRUPO" /dev/null "$DESCARTES"

copiar_descartes() {
    while IFS= read -r linea; do
        printf '%s\n' "$linea"
        case "$linea" in
            *"Dropping packet without response"*"(from client rc-"*)
                printf '%s\t%s\n' "$(date +%s)" "$linea" >> "$DESCARTES"
                ;;
        esac
    done
}

# informar <estado> <versión> <huella clients> <huella authorize>
informar() {
    printf '{"estado":"%s","version":"%s","sha_clients":"%s","sha_authorize":"%s","desde":"%s"}\n' \
        "$1" "$2" "$3" "$4" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$COMP/estado/cargado.json.tmp" \
        && mv "$COMP/estado/cargado.json.tmp" "$COMP/estado/cargado.json"
}

version_actual() {
    readlink "$COMP/actual" 2>/dev/null || true
}

AVISADO=""
while :; do
    V="$(version_actual)"
    if [ -z "$V" ] || [ ! -f "$COMP/$V/clients.conf" ] || [ ! -f "$COMP/$V/authorize" ]; then
        if [ -z "$AVISADO" ]; then
            echo "arranque: todavía no hay configuración aplicada; en espera"
            informar sin-configuracion "" "" ""
            AVISADO=1
        fi
        sleep 2
        continue
    fi
    AVISADO=""

    install -o root -g "$GRUPO" -m 0640 "$COMP/$V/clients.conf" "$RADDB/clients.conf"
    install -o root -g "$GRUPO" -m 0640 "$COMP/$V/authorize" "$RADDB/mods-config/files/authorize"
    SC="$(sha256sum "$RADDB/clients.conf" | cut -d' ' -f1)"
    SA="$(sha256sum "$RADDB/mods-config/files/authorize" | cut -d' ' -f1)"

    echo "arranque: cargando la versión ${V##*/}"
    # La salida de FreeRADIUS sigue yendo al registro del contenedor y, además,
    # las peticiones que descarta sin responder viniendo de un router del panel
    # (secreto que no coincide, falta de Message-Authenticator...) se copian a
    # descartes.log para que la API las enseñe como aviso.
    rm -f "$FIFO"
    mkfifo "$FIFO"
    copiar_descartes < "$FIFO" &
    freeradius -f -l stdout > "$FIFO" 2>&1 &
    PID=$!
    # Solo se declara «en marcha» cuando el puerto 1812/udp ya está escuchando.
    # 0714 es 1812 en hexadecimal, que es como lo lista el núcleo.
    INTENTOS=0
    while kill -0 "$PID" 2>/dev/null && [ "$INTENTOS" -lt 60 ]; do
        if grep -q ':0714 ' /proc/net/udp 2>/dev/null; then
            informar en-marcha "${V##*/}" "$SC" "$SA"
            break
        fi
        INTENTOS=$((INTENTOS + 1))
        sleep 0.5
    done

    while kill -0 "$PID" 2>/dev/null; do
        sleep 1
        if [ "$(version_actual)" != "$V" ]; then
            echo "arranque: hay una versión nueva; reiniciando FreeRADIUS"
            kill -TERM "$PID" 2>/dev/null
            break
        fi
    done
    wait "$PID" 2>/dev/null
    PID=""

    if [ "$(version_actual)" = "$V" ]; then
        # FreeRADIUS se detuvo sin que cambiara la versión: algo falló.
        echo "arranque: FreeRADIUS se detuvo de forma inesperada; reintento en 5 s"
        informar error "${V##*/}" "$SC" "$SA"
        sleep 5
    fi
done
