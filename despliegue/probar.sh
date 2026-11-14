#!/usr/bin/env bash
# Pruebas de extremo a extremo: usa la API como lo haría el panel y comprueba el
# resultado con logins RADIUS reales contra FreeRADIUS.
#
# Crea un router y un usuario de prueba, y los borra al terminar. La evidencia
# queda en evidencias/, con secretos y contraseñas enmascarados.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

API="http://127.0.0.1:8080"
RADIUS="radiuscontrol-freeradius"
mkdir -p "$DIR/evidencias"
EVIDENCIA="$DIR/evidencias/evidencia-$(date +%Y%m%d-%H%M%S).txt"
# Las pruebas usan una cuenta de administrador propia, creada por la consola
# del servidor, para no depender de la contraseña de ninguna persona.
ADMIN_PRUEBA="admin-prueba-automatica"
ADMIN_CLAVE="$(docker exec radiuscontrol-api radiuscontrol operador-emergencia "$ADMIN_PRUEBA" | tail -n 1)"
if [ "${#ADMIN_CLAVE}" -lt 12 ]; then
    echo "No se pudo crear la cuenta de pruebas." >&2
    exit 1
fi
IP_PUBLICA="$(ip -4 route get 192.0.2.1 | awk '{for (i = 1; i <= NF; i++) if ($i == "src") print $(i + 1)}')"
ROUTER_PRUEBA="prueba-automatica"
USUARIO_PRUEBA="prueba-automatica"
OPERADOR_PRUEBA="operador-prueba-automatica"

# totp <secreto en base32>: código de 6 cifras del periodo actual (RFC 6238).
totp() {
    local clave contador mac pos valor
    clave="$(printf '%s' "$1" | base32 -d | od -An -tx1 | tr -d ' \n')"
    contador="$(printf '%016x' $(( $(date +%s) / 30 )))"
    mac="$(printf "$(printf '%s' "$contador" | sed 's/../\\x&/g')" | openssl dgst -sha1 -mac HMAC -macopt "hexkey:$clave" -r | cut -d' ' -f1)"
    pos=$(( 16#${mac:39:1} ))
    valor=$(( 16#${mac:$((pos * 2)):8} & 0x7fffffff ))
    printf '%06d' $(( valor % 1000000 ))
}

# entrar <usuario> <clave> [código]: deja el código HTTP en CODIGO y la sesión en SESION
entrar() {
    local cabeceras
    cabeceras="$(mktemp)"
    CUERPO="$(curl -sS -m 30 -D "$cabeceras" -X POST "$API/api/sesion" -H 'X-RC: 1' -H 'Content-Type: application/json' \
        --data "$(jq -n --arg u "$1" --arg c "$2" --arg k "${3:-}" '{usuario:$u,clave:$c,codigo:$k}')")"
    CODIGO="$(awk 'NR == 1 {print $2}' "$cabeceras")"
    SESION="$(awk -F'[=;]' 'tolower($1) ~ /^set-cookie: rc_sesion/ {print $2}' "$cabeceras" | tr -d '\r')"
    rm -f "$cabeceras"
}
# Secretos con caracteres delicados. Las barras invertidas van en octal (\134)
# y las comillas en \047 y \042 para que no haya duda de qué se envía.
SECRETOS_RAROS=(
    "$(printf 'barra\134invertida')"
    "$(printf 'dos\134\134barras')"
    "$(printf 'comilla\047simple')"
    "$(printf 'comilla\042doble')"
    'variable ${confdir} y %{User-Name}'
    'almohadilla #y con espacios'
    "$(printf 'todo \047 \042 \134 ${x} #z')"
)
SECRETOS_PROHIBIDOS=(
    "$(printf 'termina-en-barra\134')"
    "$(printf 'barra\134\047comilla')"
    "$(printf 'salto\012de-linea')"
)
FALLOS=0
COOKIE=""
OCULTAR=("$ADMIN_CLAVE")

enmascarar() {
    local texto
    texto="$(cat)"
    for s in "${OCULTAR[@]}"; do
        [ -n "$s" ] && texto="${texto//"$s"/<oculto>}"
    done
    printf '%s\n' "$texto"
}

anotar() { printf '%s\n' "$*" | enmascarar | tee -a "$EVIDENCIA"; }

# api <método> <ruta> [cuerpo]  ->  deja el código en CODIGO y el cuerpo en CUERPO
api() {
    local salida
    salida="$(curl -sS -m 90 -X "$1" "$API$2" -H 'X-RC: 1' -H 'Content-Type: application/json' \
        ${COOKIE:+-H "Cookie: rc_sesion=$COOKIE"} ${3:+--data "$3"} -w '\n%{http_code}' 2>&1)"
    CODIGO="${salida##*$'\n'}"
    CUERPO="${salida%$'\n'*}"
}

# comprobar <nombre> <condición ya evaluada: 0 pasa> [detalle]
comprobar() {
    local resultado="PASA"
    if [ "$2" -ne 0 ]; then
        resultado="FALLA"
        FALLOS=$((FALLOS + 1))
    fi
    anotar "[$resultado] $1"
    if [ -n "${3:-}" ]; then
        printf '%s\n' "$3" | sed 's/^/    /' | enmascarar | tee -a "$EVIDENCIA"
    fi
}

codigo_es() { [ "$CODIGO" = "$1" ]; }

# radius <destino> <archivo con el secreto> <atributos>
radius() {
    printf '%s\n' "$3" | docker exec -i "$RADIUS" radclient -x -r 1 -t 3 -S "$2" "$1" auth 2>&1
}

poner_secreto() { # <archivo dentro del contenedor> <secreto>
    printf '%s' "$2" | docker exec -i "$RADIUS" sh -c "umask 077; cat > $1"
}

esperar_sincronizado() {
    for _ in $(seq 1 30); do
        api GET /api/estado
        if [ "$(printf '%s' "$CUERPO" | jq -r '.sincronizado and (.cambios_pendientes | not)')" = "true" ]; then
            return 0
        fi
        sleep 1
    done
    return 1
}

aplicar() {
    api POST /api/aplicar
    codigo_es 200 || return 1
    esperar_sincronizado
}

limpiar() {
    api GET /api/routers
    for id in $(printf '%s' "$CUERPO" | jq -r ".[] | select(.nombre | startswith(\"$ROUTER_PRUEBA\")) | .id" 2>/dev/null); do
        api DELETE "/api/routers/$id"
    done
    api GET /api/usuarios
    for id in $(printf '%s' "$CUERPO" | jq -r ".[] | select(.usuario | startswith(\"$USUARIO_PRUEBA\")) | .id" 2>/dev/null); do
        api DELETE "/api/usuarios/$id"
    done
}

anotar "RadiusControl, pruebas de extremo a extremo: $(date '+%Y-%m-%d %H:%M:%S %Z')"
anotar "$(docker exec "$RADIUS" freeradius -v | head -1)"
anotar ""

# ---------------------------------------------------------------- sesión
api POST /api/sesion "$(jq -n --arg u "$ADMIN_PRUEBA" '{usuario:$u,clave:"clave-equivocada"}')"
comprobar "Panel: contraseña incorrecta, 401" "$(codigo_es 401; echo $?)" "$CUERPO"

api GET /api/routers
comprobar "Panel: sin sesión no se puede consultar, 401" "$(codigo_es 401; echo $?)"

COOKIE="$(curl -sS -m 30 -D - -o /dev/null -X POST "$API/api/sesion" -H 'X-RC: 1' \
    -H 'Content-Type: application/json' \
    --data "$(jq -n --arg u "$ADMIN_PRUEBA" --arg c "$ADMIN_CLAVE" '{usuario:$u,clave:$c}')" \
    | awk -F'[=;]' 'tolower($1) ~ /^set-cookie: rc_sesion/ {print $2}' | tr -d '\r')"
comprobar "Panel: inicio de sesión correcto" "$([ -n "$COOKIE" ]; echo $?)"
OCULTAR+=("$COOKIE")

CODIGO="$(curl -sS -m 30 -o /dev/null -w '%{http_code}' -X POST "$API/api/aplicar" -H "Cookie: rc_sesion=$COOKIE")"
comprobar "Panel: un cambio sin la cabecera propia se rechaza, 403" "$(codigo_es 403; echo $?)"

limpiar

# ---------------------------------------------------------------- altas
api POST /api/routers "$(jq -n --arg n "$ROUTER_PRUEBA" '{nombre:$n,empresa:"Empresa de prueba",descripcion:"Prueba automática",redes:["127.0.0.1"]}')"
comprobar "Router: alta con secreto generado, 201" "$(codigo_es 201; echo $?)"
ROUTER_ID="$(printf '%s' "$CUERPO" | jq -r '.router.id')"
SECRETO="$(printf '%s' "$CUERPO" | jq -r '.secreto_generado')"
OCULTAR+=("$SECRETO")

api GET /api/routers
comprobar "Router: el listado no devuelve el secreto" \
    "$(printf '%s' "$CUERPO" | grep -q -e "$SECRETO" -e secreto_cifrado; [ $? -ne 0 ]; echo $?)"

api POST /api/routers "$(jq -n --arg n "$ROUTER_PRUEBA-2" '{nombre:$n,empresa:"Empresa de prueba",redes:["127.0.0.0/8"]}')"
comprobar "Router: una red que se superpone con otro router se rechaza, 409" "$(codigo_es 409; echo $?)" "$CUERPO"

api POST /api/routers "$(jq -n --arg n "$ROUTER_PRUEBA-3" '{nombre:$n,empresa:"Empresa de prueba",redes:["0.0.0.0/0"]}')"
comprobar "Router: una red que abarca todo se rechaza, 400" "$(codigo_es 400; echo $?)" "$CUERPO"

api POST /api/routers "$(jq -n --arg n "$ROUTER_PRUEBA-4" '{nombre:$n,redes:["192.0.2.77"]}')"
comprobar "Router: sin empresa se rechaza, 400" "$(codigo_es 400; echo $?)" "$CUERPO"

api GET /api/routers
comprobar "Router: el listado indica la empresa del router"     "$([ "$(printf '%s' "$CUERPO" | jq -r ".[] | select(.id == $ROUTER_ID) | .empresa")" = "Empresa de prueba" ]; echo $?)"

api POST /api/usuarios '{"usuario":"DEFAULT","grupo":"full"}'
comprobar "Usuario: el nombre reservado DEFAULT se rechaza, 400" "$(codigo_es 400; echo $?)" "$CUERPO"

api POST /api/usuarios "$(jq -n --arg u "$USUARIO_PRUEBA" '{usuario:$u,nombre_completo:"Prueba automática",grupo:"full"}')"
comprobar "Usuario: alta con contraseña generada, 201" "$(codigo_es 201; echo $?)"
USUARIO_ID="$(printf '%s' "$CUERPO" | jq -r '.usuario.id')"
CLAVE="$(printf '%s' "$CUERPO" | jq -r '.clave_generada')"
OCULTAR+=("$CLAVE")
HASH_NT="$(printf '%s' "$CLAVE" | iconv -f UTF-8 -t UTF-16LE | openssl dgst -md4 -provider legacy -provider default -r | awk '{print toupper($1)}')"
OCULTAR+=("$HASH_NT")


PAP_OK="User-Name = \"$USUARIO_PRUEBA\", User-Password = \"$CLAVE\""
CHAP_OK="User-Name = \"$USUARIO_PRUEBA\", MS-CHAP-Password = \"$CLAVE\""
poner_secreto /tmp/secreto "$SECRETO"
poner_secreto /tmp/secreto-malo "secreto-equivocado"

# ---------------------------------------------------------------- aplicación automática
esperar_sincronizado
comprobar "Aplicación automática: los cambios guardados llegan a FreeRADIUS sin pulsar nada" "$?" \
    "$(printf '%s' "$CUERPO" | jq -c '{cambios_pendientes, sincronizado, activa: .activa.id, freeradius}')"

api GET /api/estado
VERSION_ANTES="$(printf '%s' "$CUERPO" | jq -r '.activa.id')"
api PUT "/api/routers/$ROUTER_ID" "$(jq -n --arg n "$ROUTER_PRUEBA" '{nombre:$n,empresa:"Empresa de prueba",descripcion:"Otra descripción",redes:["127.0.0.1"]}')"
sleep 5
api GET /api/estado
comprobar "Edición: cambiar solo la descripción no genera una versión nueva ni reinicia FreeRADIUS" \
    "$([ "$(printf '%s' "$CUERPO" | jq -r '.activa.id')" = "$VERSION_ANTES" ] && [ "$(printf '%s' "$CUERPO" | jq -r .cambios_pendientes)" = "false" ]; echo $?)"
api POST /api/aplicar
comprobar "Aplicar a mano sin cambios pendientes no hace nada" \
    "$([ "$(printf '%s' "$CUERPO" | jq -r .sin_cambios)" = "true" ]; echo $?)"

regla_fw() { ufw show added | grep -q -x "ufw allow from 127.0.0.1 to any port 1812 proto udp comment 'radiuscontrol'"; }
esperar_fw() { # <0: debe existir | 1: no debe existir>
    for _ in $(seq 1 20); do
        regla_fw
        [ $? -eq "$1" ] && return 0
        sleep 1
    done
    return 1
}
OTRAS_REGLAS="$(ufw show added | grep -v "comment 'radiuscontrol'")"
esperar_fw 0
comprobar "Firewall: al aplicar, se abre 1812/udp para la red del router" "$?" "$(ufw show added | grep "'radiuscontrol'")"
for _ in $(seq 1 15); do
    api GET /api/estado
    [ "$(printf '%s' "$CUERPO" | jq -r .firewall_al_dia)" = "true" ] && break
    sleep 1
done
comprobar "Firewall: el panel ve el firewall al día con la versión aplicada" \
    "$([ "$(printf '%s' "$CUERPO" | jq -r .firewall_al_dia)" = "true" ]; echo $?)" "$(printf '%s' "$CUERPO" | jq -c .firewall)"

S="$(radius 127.0.0.1 /tmp/secreto "$PAP_OK")"
comprobar "RADIUS: PAP con la contraseña correcta, acepta" "$(printf '%s' "$S" | grep -q 'Received Access-Accept'; echo $?)"
comprobar "RADIUS: PAP devuelve el grupo full" "$(printf '%s' "$S" | grep -q 'Mikrotik-Group = "full"'; echo $?)" "$S"

S="$(radius 127.0.0.1 /tmp/secreto "$CHAP_OK")"
comprobar "RADIUS: MS-CHAP (v1, el que genera radclient) con la contraseña correcta, acepta" \
    "$(printf '%s' "$S" | grep -q 'Received Access-Accept'; echo $?)"
comprobar "RADIUS: MS-CHAP devuelve el grupo full" "$(printf '%s' "$S" | grep -q 'Mikrotik-Group = "full"'; echo $?)"

S="$(radius 127.0.0.1 /tmp/secreto "User-Name = \"$USUARIO_PRUEBA\", User-Password = \"incorrecta\"")"
comprobar "RADIUS: PAP con contraseña incorrecta, rechaza" "$(printf '%s' "$S" | grep -q 'Received Access-Reject'; echo $?)"

S="$(radius 127.0.0.1 /tmp/secreto "User-Name = \"$USUARIO_PRUEBA\", MS-CHAP-Password = \"incorrecta\"")"
comprobar "RADIUS: MS-CHAP con contraseña incorrecta, rechaza" "$(printf '%s' "$S" | grep -q 'Received Access-Reject'; echo $?)"

S="$(radius 127.0.0.1 /tmp/secreto "User-Name = \"no-existe\", User-Password = \"$CLAVE\"")"
comprobar "RADIUS: usuario inexistente, rechaza" "$(printf '%s' "$S" | grep -q 'Received Access-Reject'; echo $?)"

S="$(radius 127.0.0.1 /tmp/secreto "User-Name = \"DEFAULT\", User-Password = \"$CLAVE\"")"
comprobar "RADIUS: el usuario DEFAULT no entra" "$(printf '%s' "$S" | grep -q 'Received Access-Accept'; [ $? -ne 0 ]; echo $?)"

S="$(radius 127.0.0.1 /tmp/secreto-malo "$PAP_OK")"
comprobar "RADIUS: secreto incorrecto, ningún login válido" \
    "$(printf '%s' "$S" | grep -q 'Access-Accept'; [ $? -ne 0 ]; echo $?)" "$(printf '%s' "$S" | tail -1)"

S="$(radius "$IP_PUBLICA" /tmp/secreto "$PAP_OK")"
comprobar "RADIUS: origen no autorizado ($IP_PUBLICA), sin respuesta" \
    "$(printf '%s' "$S" | grep -q 'Received'; [ $? -ne 0 ]; echo $?)" "$(printf '%s' "$S" | tail -1)"
S="$(docker logs --since 1m "$RADIUS" 2>&1 | grep -i 'unknown client' | tail -1)"
comprobar "RADIUS: el intento no autorizado queda en el registro" "$([ -n "$S" ]; echo $?)" "$S"

# ---------------------------------------------------------------- registro de autenticaciones
sleep 5
api GET "/api/autenticaciones?buscar=$USUARIO_PRUEBA&tamano=100"
REG="$CUERPO"
tiene() { [ "$(printf '%s' "$REG" | jq "[.autenticaciones[] | select($1)] | length")" -gt 0 ]; }
comprobar "Registro: el login aceptado por PAP queda anotado con router, empresa y grupo"     "$(tiene '.resultado == "aceptado" and .metodo == "PAP" and .router == "prueba-automatica" and .empresa == "Empresa de prueba" and .grupo == "full" and .ip_origen == "127.0.0.1"'; echo $?)"     "$(printf '%s' "$REG" | jq -c '[.autenticaciones[] | select(.resultado == "aceptado" and .metodo == "PAP")][0]')"
comprobar "Registro: el login aceptado por MS-CHAP queda anotado con su método"     "$(tiene '.resultado == "aceptado" and .metodo == "MS-CHAPv1"'; echo $?)"
comprobar "Registro: el rechazo por contraseña incorrecta queda anotado con su motivo"     "$(tiene '.resultado == "rechazado" and .metodo == "PAP" and (.motivo | length) > 0'; echo $?)"     "$(printf '%s' "$REG" | jq -c '[.autenticaciones[] | select(.resultado == "rechazado")][0] | {resultado, metodo, motivo}')"
api GET "/api/autenticaciones?buscar=no-existe&resultado=rechazado"
comprobar "Registro: el intento de un usuario inexistente queda anotado"     "$([ "$(printf '%s' "$CUERPO" | jq '.total')" -gt 0 ]; echo $?)"
api GET "/api/autenticaciones?buscar=$USUARIO_PRUEBA&tamano=2&pagina=1"
A1="$CUERPO"
api GET "/api/autenticaciones?buscar=$USUARIO_PRUEBA&tamano=2&pagina=2"
A2="$CUERPO"
comprobar "Registro: la primera página trae 2 logins e indica el total y las páginas" \
    "$(printf '%s' "$A1" | jq -e '(.autenticaciones | length) == 2 and .pagina == 1 and .total > 2 and .paginas == ((.total + 1) / 2 | floor)' >/dev/null; echo $?)" \
    "$(printf '%s' "$A1" | jq -c '{total, pagina, paginas, tamano}')"
comprobar "Registro: la segunda página continúa donde acaba la primera, sin repetir" \
    "$(jq -n --argjson a "$A1" --argjson b "$A2" '($a.autenticaciones | map(.id) | min) > ($b.autenticaciones | map(.id) | max)' | grep -q true; echo $?)"
comprobar "Registro: no guarda contraseñas ni secretos"     "$(docker exec "$RADIUS" cat /registro/auth.log | grep -q -e "$CLAVE" -e "$SECRETO" -e "$HASH_NT"; [ $? -ne 0 ]; echo $?)"

docker exec "$RADIUS" chmod 000 /registro
S="$(radius 127.0.0.1 /tmp/secreto "$PAP_OK")"
docker exec "$RADIUS" chmod 0770 /registro
comprobar "Registro: si no se puede escribir, el login se acepta igualmente"     "$(printf '%s' "$S" | grep -q 'Received Access-Accept'; echo $?)"

# ---------------------------------------------------------------- base de datos
VOLCADO="$(docker compose exec -T postgres pg_dump -U radiuscontrol radiuscontrol 2>&1)"
comprobar "Base: el volcado no contiene el secreto, la contraseña ni el hash NT" \
    "$(printf '%s' "$VOLCADO" | grep -q -i -e "$SECRETO" -e "$CLAVE" -e "$HASH_NT" -e "$ADMIN_CLAVE"; [ $? -ne 0 ]; echo $?)" \
    "volcado de $(printf '%s' "$VOLCADO" | wc -l) líneas revisado"

# ---------------------------------------------------------------- independencia
docker compose stop api postgres >/dev/null 2>&1
S="$(radius 127.0.0.1 /tmp/secreto "$PAP_OK")"
comprobar "Independencia: con la API y la base detenidas, FreeRADIUS sigue autenticando" \
    "$(printf '%s' "$S" | grep -q 'Received Access-Accept'; echo $?)"
docker compose restart freeradius >/dev/null 2>&1
sleep 5
S="$(radius 127.0.0.1 /tmp/secreto "$PAP_OK")"
comprobar "Independencia: FreeRADIUS reiniciado sin API ni base, sigue autenticando" \
    "$(printf '%s' "$S" | grep -q 'Received Access-Accept'; echo $?)"
docker compose start postgres api >/dev/null 2>&1
for _ in $(seq 1 40); do
    api GET /api/estado
    codigo_es 200 && break
    sleep 1
done
comprobar "Independencia: la API vuelve y la sesión sigue siendo válida" "$(codigo_es 200; echo $?)"

# ---------------------------------------------------------------- secretos con caracteres especiales

N=0
for s in "${SECRETOS_RAROS[@]}"; do
    N=$((N + 1))
    OCULTAR+=("$s")
    api POST "/api/routers/$ROUTER_ID/secreto" "$(jq -n --arg s "$s" '{secreto:$s}')"
    codigo_es 200 && aplicar
    APLICADO=$?
    poner_secreto /tmp/secreto-raro "$s"
    S="$(radius 127.0.0.1 /tmp/secreto-raro "$PAP_OK")"
    comprobar "Secreto especial $N de ${#SECRETOS_RAROS[@]}: se aplica y autentica tal como se escribió"         "$([ "$APLICADO" -eq 0 ] && printf '%s' "$S" | grep -q 'Received Access-Accept'; echo $?)"
done
S="$(radius 127.0.0.1 /tmp/secreto "$PAP_OK")"
comprobar "Secreto: tras rotar, el secreto anterior deja de servir" "$(printf '%s' "$S" | grep -q 'Access-Accept'; [ $? -ne 0 ]; echo $?)"

N=0
for s in "${SECRETOS_PROHIBIDOS[@]}"; do
    N=$((N + 1))
    api POST "/api/routers/$ROUTER_ID/secreto" "$(jq -n --arg s "$s" '{secreto:$s}')"
    comprobar "Secreto no representable $N de ${#SECRETOS_PROHIBIDOS[@]}: se rechaza, 400" "$(codigo_es 400; echo $?)" "$CUERPO"
done
S="$(radius 127.0.0.1 /tmp/secreto-raro "$PAP_OK")"
comprobar "Secreto: un intento rechazado no altera el secreto en uso" "$(printf '%s' "$S" | grep -q 'Received Access-Accept'; echo $?)"

# ---------------------------------------------------------------- grupo y suspensión
api PUT "/api/usuarios/$USUARIO_ID" '{"nombre_completo":"Prueba automática","grupo":"read","activo":true}'
aplicar
S="$(radius 127.0.0.1 /tmp/secreto-raro "$PAP_OK")"
comprobar "Grupo: al cambiarlo a read, el login devuelve read" "$(printf '%s' "$S" | grep -q 'Mikrotik-Group = "read"'; echo $?)"

api PUT "/api/usuarios/$USUARIO_ID" '{"nombre_completo":"Prueba automática","grupo":"read","activo":false}'
aplicar
S="$(radius 127.0.0.1 /tmp/secreto-raro "$PAP_OK")"
comprobar "Suspensión: un usuario suspendido deja de entrar" "$(printf '%s' "$S" | grep -q 'Received Access-Reject'; echo $?)"

api PUT "/api/routers/$ROUTER_ID" "$(jq -n --arg n "$ROUTER_PRUEBA" '{nombre:$n,empresa:"Empresa de prueba",redes:["127.0.0.1"],activo:false}')"
aplicar
S="$(radius 127.0.0.1 /tmp/secreto-raro "$PAP_OK")"
esperar_fw 1
comprobar "Firewall: al suspender el router, su regla de 1812/udp se retira" "$?"
comprobar "Firewall: las demás reglas del servidor no cambian" \
    "$([ "$(ufw show added | grep -v "comment 'radiuscontrol'")" = "$OTRAS_REGLAS" ]; echo $?)"
comprobar "Suspensión: un router suspendido deja de recibir respuesta" "$(printf '%s' "$S" | grep -q 'Received'; [ $? -ne 0 ]; echo $?)"

# ---------------------------------------------------------------- acceso y seguridad del panel
COOKIE_ADMIN="$COOKIE"
api GET /api/operadores
for id in $(printf '%s' "$CUERPO" | jq -r ".[] | select(.usuario == \"$OPERADOR_PRUEBA\") | .id"); do
    api DELETE "/api/operadores/$id"
done

api POST /api/operadores "$(jq -n --arg u "$OPERADOR_PRUEBA" '{usuario:$u,rol:"lectura"}')"
comprobar "Seguridad: alta de un operador de solo lectura, 201" "$(codigo_es 201; echo $?)"
OP_ID="$(printf '%s' "$CUERPO" | jq -r '.operador.id')"
OP_CLAVE="$(printf '%s' "$CUERPO" | jq -r '.clave_generada')"
OCULTAR+=("$OP_CLAVE")

entrar "$OPERADOR_PRUEBA" "$OP_CLAVE"
comprobar "Seguridad: el operador nuevo inicia sesión" "$([ "$CODIGO" = 200 ] && [ -n "$SESION" ]; echo $?)"
COOKIE="$SESION"
OCULTAR+=("$SESION")
api GET /api/routers
comprobar "Seguridad: la cuenta de solo lectura puede consultar, 200" "$(codigo_es 200; echo $?)"
api POST /api/routers "$(jq -n --arg n "$ROUTER_PRUEBA-5" '{nombre:$n,empresa:"Empresa de prueba",redes:["192.0.2.55"]}')"
comprobar "Seguridad: la cuenta de solo lectura no puede crear routers, 403" "$(codigo_es 403; echo $?)" "$CUERPO"
api GET /api/operadores
comprobar "Seguridad: la cuenta de solo lectura no ve los operadores, 403" "$(codigo_es 403; echo $?)"
api GET /api/auditoria
comprobar "Seguridad: la cuenta de solo lectura no ve el registro de actividad, 403" "$(codigo_es 403; echo $?)"

api POST /api/cuenta/clave "$(jq -n --arg n "otra-clave-larga-1" '{actual:"equivocada",nueva:$n}')"
comprobar "Cuenta: cambiar la contraseña con la actual equivocada se rechaza, 400" "$(codigo_es 400; echo $?)"
api POST /api/cuenta/clave "$(jq -n --arg a "$OP_CLAVE" '{actual:$a,nueva:"corta"}')"
comprobar "Cuenta: una contraseña nueva demasiado corta se rechaza, 400" "$(codigo_es 400; echo $?)" "$CUERPO"
OP_CLAVE2="clave-nueva-$(openssl rand -hex 6)"
OCULTAR+=("$OP_CLAVE2")
api POST /api/cuenta/clave "$(jq -n --arg a "$OP_CLAVE" --arg n "$OP_CLAVE2" '{actual:$a,nueva:$n}')"
comprobar "Cuenta: cambio de contraseña correcto, 200" "$(codigo_es 200; echo $?)"
entrar "$OPERADOR_PRUEBA" "$OP_CLAVE"
comprobar "Cuenta: la contraseña anterior deja de servir, 401" "$([ "$CODIGO" = 401 ]; echo $?)"

api POST /api/cuenta/totp
comprobar "Doble factor: se genera el secreto para la aplicación, 200" "$(codigo_es 200; echo $?)"
TOTP_SECRETO="$(printf '%s' "$CUERPO" | jq -r '.secreto')"
OCULTAR+=("$TOTP_SECRETO")
api POST /api/cuenta/totp/confirmar '{"codigo":"000000"}'
comprobar "Doble factor: un código equivocado no lo activa, 400" "$(codigo_es 400; echo $?)"
api POST /api/cuenta/totp/confirmar "$(jq -n --arg c "$(totp "$TOTP_SECRETO")" '{codigo:$c}')"
comprobar "Doble factor: el código correcto lo activa, 200" "$(codigo_es 200; echo $?)" "$CUERPO"

entrar "$OPERADOR_PRUEBA" "$OP_CLAVE2"
comprobar "Doble factor: sin código no se entra y el panel lo pide, 401" \
    "$([ "$CODIGO" = 401 ] && [ "$(printf '%s' "$CUERPO" | jq -r .requiere_codigo)" = "true" ]; echo $?)"
entrar "$OPERADOR_PRUEBA" "$OP_CLAVE2" "000000"
comprobar "Doble factor: con un código equivocado no se entra, 401" "$([ "$CODIGO" = 401 ] && [ -z "$SESION" ]; echo $?)"
# El código del periodo en que se activó ya está gastado: se espera al siguiente.
sleep $(( 31 - $(date +%s) % 30 ))
CODIGO_TOTP="$(totp "$TOTP_SECRETO")"
entrar "$OPERADOR_PRUEBA" "$OP_CLAVE2" "$CODIGO_TOTP"
comprobar "Doble factor: con contraseña y código correctos se entra, 200" "$([ "$CODIGO" = 200 ] && [ -n "$SESION" ]; echo $?)"
SESION_TOTP="$SESION"
OCULTAR+=("$SESION_TOTP")
entrar "$OPERADOR_PRUEBA" "$OP_CLAVE2" "$CODIGO_TOTP"
comprobar "Doble factor: el mismo código no sirve dos veces, 401" "$([ "$CODIGO" = 401 ] && [ -z "$SESION" ]; echo $?)"

COOKIE="$COOKIE_ADMIN"
api GET /api/sesiones
ID_SESION="$(printf '%s' "$CUERPO" | jq -r "[.[] | select(.operador == \"$OPERADOR_PRUEBA\")][0].id")"
comprobar "Sesiones: el administrador ve las sesiones abiertas del operador" "$([ "$ID_SESION" != "null" ] && [ -n "$ID_SESION" ]; echo $?)"
api PUT "/api/operadores/$OP_ID" '{"rol":"lectura","activo":false}'
comprobar "Operadores: suspender una cuenta, 200" "$(codigo_es 200; echo $?)"
COOKIE="$SESION_TOTP"
api GET /api/routers
comprobar "Operadores: al suspender la cuenta, su sesión abierta deja de valer, 401" "$(codigo_es 401; echo $?)"
COOKIE="$COOKIE_ADMIN"

api GET /api/sesiones
MI_SESION="$(printf '%s' "$CUERPO" | jq -r '[.[] | select(.actual)][0].id')"
api GET /api/operadores
MI_ID="$(printf '%s' "$CUERPO" | jq -r ".[] | select(.usuario == \"$ADMIN_PRUEBA\") | .id")"
api PUT "/api/operadores/$MI_ID" '{"rol":"lectura","activo":true}'
comprobar "Operadores: el administrador no puede quitarse su propio rol, 400" "$(codigo_es 400; echo $?)" "$CUERPO"
api DELETE "/api/operadores/$MI_ID"
comprobar "Operadores: el administrador no puede eliminar su propia cuenta, 400" "$(codigo_es 400; echo $?)"

api GET "/api/auditoria?buscar=$OPERADOR_PRUEBA&tamano=100"
comprobar "Actividad: quedan anotados el alta, los accesos fallidos y el doble factor" \
    "$(for a in operador.creado sesion.fallida sesion.iniciada cuenta.doble_factor_activado cuenta.clave_cambiada; do printf '%s' "$CUERPO" | jq -e --arg a "$a" 'any(.eventos[]; .accion == $a)' >/dev/null || exit 1; done; echo $?)" \
    "$(printf '%s' "$CUERPO" | jq -r '[.eventos[].accion] | unique | join(", ")')"
comprobar "Actividad: el registro no contiene contraseñas ni el secreto del doble factor" \
    "$(printf '%s' "$CUERPO" | grep -q -e "$OP_CLAVE" -e "$OP_CLAVE2" -e "$TOTP_SECRETO"; [ $? -ne 0 ]; echo $?)"

api GET "/api/auditoria?tamano=5&pagina=1"
P1="$CUERPO"
api GET "/api/auditoria?tamano=5&pagina=2"
P2="$CUERPO"
comprobar "Actividad: la primera página trae 5 eventos e indica el total y las páginas" \
    "$(printf '%s' "$P1" | jq -e '(.eventos | length) == 5 and .pagina == 1 and .total > 5 and .paginas == ((.total + 4) / 5 | floor)' >/dev/null; echo $?)" \
    "$(printf '%s' "$P1" | jq -c '{total, pagina, paginas, tamano}')"
comprobar "Actividad: la segunda página continúa donde acaba la primera, sin repetir" \
    "$(jq -n --argjson a "$P1" --argjson b "$P2" '($a.eventos | map(.id) | min) > ($b.eventos | map(.id) | max)' | grep -q true; echo $?)"
api GET "/api/auditoria?tamano=5&pagina=999999"
comprobar "Actividad: pedir una página más allá del final devuelve la última" \
    "$(printf '%s' "$CUERPO" | jq -e '.pagina == .paginas and (.eventos | length) > 0' >/dev/null; echo $?)"

api DELETE "/api/operadores/$OP_ID"
comprobar "Operadores: eliminar la cuenta de prueba, 200" "$(codigo_es 200; echo $?)"
api GET /api/versiones
comprobar "El historial de versiones ya no está disponible, 404" "$(codigo_es 404; echo $?)"

# ---------------------------------------------------------------- limpieza
limpiar
aplicar
comprobar "Limpieza: datos de prueba borrados y configuración aplicada" "$?"
docker exec "$RADIUS" rm -f /tmp/secreto /tmp/secreto-malo /tmp/secreto-raro
api DELETE /api/sesion
docker compose exec -T postgres psql -q -U radiuscontrol -d radiuscontrol -c     "DELETE FROM autenticaciones WHERE router_nombre LIKE '$ROUTER_PRUEBA%' OR usuario IN ('$USUARIO_PRUEBA', 'no-existe', 'DEFAULT'); DELETE FROM operadores WHERE usuario = '$ADMIN_PRUEBA'; DELETE FROM auditoria WHERE operador IN ('$OPERADOR_PRUEBA', '$ADMIN_PRUEBA') OR objeto = '$ADMIN_PRUEBA' OR objeto IN ('$OPERADOR_PRUEBA', 'Empresa de prueba') OR objeto LIKE '$ROUTER_PRUEBA%'; DELETE FROM empresas e WHERE e.nombre = 'Empresa de prueba' AND NOT EXISTS (SELECT 1 FROM routers r WHERE r.empresa_id = e.id)" >/dev/null 2>&1

anotar ""
anotar "Evidencia: $EVIDENCIA"
if [ "$FALLOS" -gt 0 ]; then
    anotar "RESULTADO: $FALLOS prueba(s) fallida(s)"
    exit 1
fi
anotar "RESULTADO: todas las pruebas pasan"
