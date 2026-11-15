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
IP_PRUEBA="192.0.2.200"
IP_ATACANTE="198.51.100.77"
ADMIN_CLAVE="$(docker exec radiuscontrol-api radiuscontrol operador-emergencia "$ADMIN_PRUEBA" | tail -n 1)"
docker exec radiuscontrol-api radiuscontrol desbloquear-ip "$IP_PRUEBA" >/dev/null
docker exec radiuscontrol-api radiuscontrol desbloquear-ip "$IP_ATACANTE" >/dev/null
if [ "${#ADMIN_CLAVE}" -lt 12 ]; then
    echo "No se pudo crear la cuenta de pruebas." >&2
    exit 1
fi
IP_PUBLICA="$(ip -4 route get 192.0.2.1 | awk '{for (i = 1; i <= NF; i++) if ($i == "src") print $(i + 1)}')"
ROUTER_PRUEBA="prueba-automatica"
USUARIO_PRUEBA="prueba-automatica"
OPERADOR_PRUEBA="operador-prueba-automatica"
# Marcadores de las filas que inserta la sección de la purga de registros.
MARCA_ANTIGUA="prueba-automatica-antigua"
MARCA_RECIENTE="prueba-automatica-reciente"

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

# entrar <usuario> <clave> [código] [dirección]: deja el código HTTP en CODIGO y la sesión en SESION
entrar() {
    local cabeceras
    cabeceras="$(mktemp)"
    CUERPO="$(curl -sS -m 30 -D "$cabeceras" -X POST "$API/api/sesion" -H 'X-RC: 1' -H 'Content-Type: application/json' \
        -H "X-Forwarded-For: ${4:-$IP_PRUEBA}" \
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
    salida="$(curl -sS -m 90 -X "$1" "$API$2" -H 'X-RC: 1' -H 'Content-Type: application/json' -H "X-Forwarded-For: $IP_PRUEBA" \
        ${AUTO:+-H "X-RC-Auto: 1"} ${COOKIE:+-H "Cookie: rc_sesion=$COOKIE"} ${3:+--data "$3"} -w '\n%{http_code}' 2>&1)"
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

COOKIE="$(curl -sS -m 30 -D - -o /dev/null -X POST "$API/api/sesion" -H 'X-RC: 1' -H "X-Forwarded-For: $IP_PRUEBA" \
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
    "$(printf '%s' "$S" | grep -q 'Received Access-Accept'; echo $?)" "$(printf '%s' "$S" | grep -E 'Received|No reply|rror' | tail -2)"
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

# ---------------------------------------------------------------- accesos por router
# De la sección anterior llegan suspendidos el usuario (con el grupo read) y el
# router de prueba: aquí se reactivan, y al terminar se devuelven a ese estado.
# El segundo router se distingue por su dirección de origen, 127.0.0.2, que
# radclient usa cuando la petición lleva Packet-Src-IP-Address. Tiene su propia
# empresa para que los cambios masivos por empresa solo lo alcancen a él.
EMPRESA_ACCESOS="Empresa de prueba de accesos"
ROUTER_B="$ROUTER_PRUEBA-accesos"
USUARIO_B="$USUARIO_PRUEBA-accesos"
USUARIO_INEXISTENTE=2147483646999
MOTIVO_SIN_ACCESO="El usuario no tiene acceso a este router"

api PUT "/api/usuarios/$USUARIO_ID" '{"nombre_completo":"Prueba automática","grupo":"write","activo":true}'
api PUT "/api/routers/$ROUTER_ID" "$(jq -n --arg n "$ROUTER_PRUEBA" '{nombre:$n,empresa:"Empresa de prueba",redes:["127.0.0.1"],activo:true}')"
comprobar "Accesos: editar un router sin indicar el modo lo deja en general, 200" \
    "$(codigo_es 200 && printf '%s' "$CUERPO" | jq -e '.router.acceso == "general" and .router.accesos == []' >/dev/null; echo $?)"

api POST /api/routers "$(jq -n --arg n "$ROUTER_B" --arg e "$EMPRESA_ACCESOS" '{nombre:$n,empresa:$e,descripcion:"Prueba automática de accesos",redes:["127.0.0.2"]}')"
comprobar "Accesos: un router nuevo nace en modo general y sin asignaciones, 201" \
    "$(codigo_es 201 && printf '%s' "$CUERPO" | jq -e '.router.acceso == "general" and .router.accesos == []' >/dev/null; echo $?)" \
    "$(printf '%s' "$CUERPO" | jq -c '.router | {nombre, empresa, redes, acceso, accesos}')"
ROUTER_B_ID="$(printf '%s' "$CUERPO" | jq -r '.router.id')"
SECRETO_B="$(printf '%s' "$CUERPO" | jq -r '.secreto_generado')"
OCULTAR+=("$SECRETO_B")
poner_secreto /tmp/secreto-b "$SECRETO_B"

api POST /api/usuarios "$(jq -n --arg u "$USUARIO_B" '{usuario:$u,nombre_completo:"Prueba automática de accesos",grupo:"write"}')"
comprobar "Accesos: alta del segundo usuario de prueba, 201" "$(codigo_es 201; echo $?)"
USUARIO_B_ID="$(printf '%s' "$CUERPO" | jq -r '.usuario.id')"
CLAVE_B="$(printf '%s' "$CUERPO" | jq -r '.clave_generada')"
OCULTAR+=("$CLAVE_B")

# En el router A (127.0.0.1) y en el B (127.0.0.2), con cada usuario.
EN_B="Packet-Src-IP-Address = 127.0.0.2"
PAP_B="User-Name = \"$USUARIO_B\", User-Password = \"$CLAVE_B\""
acepta() { printf '%s' "$1" | grep -q 'Received Access-Accept'; }
rechaza() { printf '%s' "$1" | grep -q 'Received Access-Reject'; }
grupo_es() { printf '%s' "$1" | grep -q "Mikrotik-Group = \"$2\""; }
# editar_b <campos de acceso en JSON>: edita el router B conservando lo demás
editar_b() {
    api PUT "/api/routers/$ROUTER_B_ID" "$(jq -n --arg n "$ROUTER_B" --arg e "$EMPRESA_ACCESOS" --argjson x "$1" \
        '{nombre:$n,empresa:$e,descripcion:"Prueba automática de accesos",redes:["127.0.0.2"]} + $x')"
}
masivo() { api POST /api/accesos/masivo "$1"; }

aplicar
comprobar "Accesos: los dos routers de prueba quedan aplicados" "$?"

# (a) modo general
S="$(radius 127.0.0.1 /tmp/secreto-b "$PAP_OK, $EN_B")"
comprobar "Accesos: en un router general el usuario entra con su grupo general (write)" \
    "$(acepta "$S" && grupo_es "$S" write; echo $?)" "$S"

# (b) restringido sin asignaciones
editar_b '{"acceso":"restringido"}'
comprobar "Accesos: pasar el router a restringido, 200" \
    "$(codigo_es 200 && printf '%s' "$CUERPO" | jq -e '.router.acceso == "restringido" and .router.accesos == []' >/dev/null; echo $?)" "$CUERPO"
aplicar
S="$(radius 127.0.0.1 /tmp/secreto-b "$PAP_OK, $EN_B")"
comprobar "Accesos: en un router restringido, un usuario sin asignar es rechazado" "$(rechaza "$S"; echo $?)" "$S"
sleep 5
api GET "/api/autenticaciones?buscar=$USUARIO_PRUEBA&resultado=rechazado&tamano=100"
comprobar "Accesos: el registro anota el motivo del rechazo" \
    "$(printf '%s' "$CUERPO" | jq -e --arg r "$ROUTER_B" --arg m "$MOTIVO_SIN_ACCESO" 'any(.autenticaciones[]; .router == $r and .ip_origen == "127.0.0.2" and (.motivo | contains($m)))' >/dev/null; echo $?)" \
    "$(printf '%s' "$CUERPO" | jq -c --arg r "$ROUTER_B" '[.autenticaciones[] | select(.router == $r)][0] | {resultado, usuario, router, ip_origen, motivo}')"

# (c) asignado con otro grupo en ese router
editar_b "$(jq -n --argjson u "$USUARIO_ID" '{accesos:[{usuario_id:$u,grupo:"read"}]}')"
comprobar "Accesos: asignar un usuario al router conserva el modo y devuelve la asignación, 200" \
    "$(codigo_es 200 && printf '%s' "$CUERPO" | jq -e --arg u "$USUARIO_PRUEBA" --argjson i "$USUARIO_ID" '.router.acceso == "restringido" and .router.accesos == [{usuario_id:$i,usuario:$u,grupo:"read"}]' >/dev/null; echo $?)" \
    "$(printf '%s' "$CUERPO" | jq -c '.router | {acceso, accesos}')"
aplicar
S="$(radius 127.0.0.1 /tmp/secreto-b "$PAP_OK, $EN_B")"
comprobar "Accesos: el usuario asignado entra y recibe el grupo de ese router (read), no el general" \
    "$(acepta "$S" && grupo_es "$S" read; echo $?)" "$S"
S="$(radius 127.0.0.1 /tmp/secreto-raro "$PAP_OK")"
comprobar "Accesos: en el otro router, que es general, sigue recibiendo su grupo general (write)" \
    "$(acepta "$S" && grupo_es "$S" write; echo $?)" "$S"

# (d) un segundo usuario sin asignar
S="$(radius 127.0.0.1 /tmp/secreto-b "$PAP_B, $EN_B")"
comprobar "Accesos: el segundo usuario, sin asignar, es rechazado en el router restringido" "$(rechaza "$S"; echo $?)" "$S"
S="$(radius 127.0.0.1 /tmp/secreto-raro "$PAP_B")"
comprobar "Accesos: el segundo usuario entra en el router general con su grupo general (write)" \
    "$(acepta "$S" && grupo_es "$S" write; echo $?)" "$S"

# (e) cambio masivo: asignar por empresa (el nombre no distingue mayúsculas)
masivo "$(jq -n --arg e "$EMPRESA_ACCESOS" --argjson u "$USUARIO_B_ID" '{routers:{empresa:($e | ascii_upcase)},usuarios:[$u],accion:"asignar",grupo:"full"}')"
comprobar "Masivo: asignar un usuario a los routers de una empresa, 200" \
    "$(codigo_es 200 && printf '%s' "$CUERPO" | jq -e '.routers == 1 and .asignaciones == 1' >/dev/null; echo $?)" "$CUERPO"
aplicar
S="$(radius 127.0.0.1 /tmp/secreto-b "$PAP_B, $EN_B")"
comprobar "Masivo: el usuario asignado entra en el router restringido con el grupo full" \
    "$(acepta "$S" && grupo_es "$S" full; echo $?)" "$S"
S="$(radius 127.0.0.1 /tmp/secreto-b "$PAP_OK, $EN_B")"
comprobar "Masivo: asignar a un usuario no altera la asignación de otro (read)" \
    "$(acepta "$S" && grupo_es "$S" read; echo $?)"
api GET /api/routers
comprobar "Masivo: el listado devuelve las asignaciones ordenadas por usuario" \
    "$(printf '%s' "$CUERPO" | jq -e --argjson r "$ROUTER_B_ID" --arg a "$USUARIO_PRUEBA" --arg b "$USUARIO_B" '[.[] | select(.id == $r) | .accesos[] | [.usuario, .grupo]] == [[$a, "read"], [$b, "full"]]' >/dev/null; echo $?)" \
    "$(printf '%s' "$CUERPO" | jq -c --argjson r "$ROUTER_B_ID" '.[] | select(.id == $r) | {acceso, accesos}')"
api GET "/api/auditoria?buscar=accesos.cambio_masivo&tamano=5"
comprobar "Masivo: el cambio queda en el registro de actividad como un solo evento" \
    "$(printf '%s' "$CUERPO" | jq -e --arg o "$ADMIN_PRUEBA" '[.eventos[] | select(.accion == "accesos.cambio_masivo" and .operador == $o)] | length == 1 and .[0].objeto == "1 router" and (.[0].detalle | contains("asignar"))' >/dev/null; echo $?)" \
    "$(printf '%s' "$CUERPO" | jq -c '[.eventos[] | select(.accion == "accesos.cambio_masivo")][0] | {operador, accion, objeto, detalle}')"

# (f) cambio masivo: quitar, eligiendo los routers por lista
masivo "$(jq -n --argjson r "$ROUTER_B_ID" --argjson u "$USUARIO_B_ID" '{routers:{ids:[$r]},usuarios:[$u],accion:"quitar"}')"
comprobar "Masivo: quitar la asignación en una lista de routers, 200" \
    "$(codigo_es 200 && printf '%s' "$CUERPO" | jq -e '.routers == 1 and .asignaciones == 1' >/dev/null; echo $?)" "$CUERPO"
aplicar
S="$(radius 127.0.0.1 /tmp/secreto-b "$PAP_B, $EN_B")"
comprobar "Masivo: el usuario al que se quita la asignación vuelve a quedar fuera" "$(rechaza "$S"; echo $?)" "$S"

# (g) cambio masivo: volver al modo general
masivo "$(jq -n --arg e "$EMPRESA_ACCESOS" '{routers:{empresa:$e},accion:"modo",modo:"general"}')"
comprobar "Masivo: cambiar el modo de los routers de una empresa, 200" \
    "$(codigo_es 200 && printf '%s' "$CUERPO" | jq -e '.routers == 1 and .asignaciones == 0' >/dev/null; echo $?)" "$CUERPO"
aplicar
S="$(radius 127.0.0.1 /tmp/secreto-b "$PAP_OK, $EN_B")"
comprobar "Masivo: de vuelta en modo general, el usuario asignado entra con su grupo general (write)" \
    "$(acepta "$S" && grupo_es "$S" write; echo $?)" "$S"
S="$(radius 127.0.0.1 /tmp/secreto-b "$PAP_B, $EN_B")"
comprobar "Masivo: de vuelta en modo general, el usuario sin asignar también entra (write)" \
    "$(acepta "$S" && grupo_es "$S" write; echo $?)" "$S"
api GET /api/routers
comprobar "Masivo: en modo general el router conserva sus asignaciones para cuando vuelva a restringido" \
    "$(printf '%s' "$CUERPO" | jq -e --argjson r "$ROUTER_B_ID" --argjson i "$USUARIO_ID" '.[] | select(.id == $r) | .acceso == "general" and (.accesos | length) == 1 and .accesos[0].usuario_id == $i and .accesos[0].grupo == "read"' >/dev/null; echo $?)"

# (h) validaciones: ninguna debe cambiar nada
masivo '{"routers":{"todos":false,"empresa":"","ids":[]},"accion":"modo","modo":"general"}'
comprobar "Masivo: sin criterio para elegir los routers se rechaza, 400" "$(codigo_es 400; echo $?)" "$CUERPO"
masivo "$(jq -n --arg e "$EMPRESA_ACCESOS" --argjson r "$ROUTER_B_ID" '{routers:{empresa:$e,ids:[$r]},accion:"modo",modo:"general"}')"
comprobar "Masivo: dos criterios a la vez se rechazan, 400" "$(codigo_es 400; echo $?)" "$CUERPO"
masivo '{"routers":{"empresa":"empresa-que-no-existe-automatica"},"accion":"modo","modo":"general"}'
comprobar "Masivo: una selección que no alcanza a ningún router se rechaza, 400" "$(codigo_es 400; echo $?)" "$CUERPO"
masivo "$(jq -n --argjson r "$ROUTER_B_ID" --argjson u "$USUARIO_B_ID" '{routers:{ids:[$r]},usuarios:[$u],accion:"asignar",grupo:"no válido"}')"
comprobar "Masivo: un grupo no válido se rechaza, 400" "$(codigo_es 400; echo $?)" "$CUERPO"
masivo "$(jq -n --argjson r "$ROUTER_B_ID" --argjson u "$USUARIO_INEXISTENTE" '{routers:{ids:[$r]},usuarios:[$u],accion:"asignar",grupo:"read"}')"
comprobar "Masivo: un usuario inexistente se rechaza, 400" "$(codigo_es 400; echo $?)" "$CUERPO"
masivo "$(jq -n --argjson r "$ROUTER_B_ID" '{routers:{ids:[$r]},accion:"modo",modo:"abierto"}')"
comprobar "Masivo: un modo desconocido se rechaza, 400" "$(codigo_es 400; echo $?)" "$CUERPO"
masivo "$(jq -n --argjson r "$ROUTER_B_ID" '{routers:{ids:[$r]},usuarios:[],accion:"asignar",grupo:"read"}')"
comprobar "Masivo: asignar sin usuarios se rechaza, 400" "$(codigo_es 400; echo $?)" "$CUERPO"
editar_b '{"acceso":"abierto"}'
comprobar "Accesos: al editar un router, un modo desconocido se rechaza, 400" "$(codigo_es 400; echo $?)" "$CUERPO"
editar_b "$(jq -n --argjson u "$USUARIO_INEXISTENTE" '{accesos:[{usuario_id:$u,grupo:"read"}]}')"
comprobar "Accesos: al editar un router, un usuario inexistente se rechaza, 400" "$(codigo_es 400; echo $?)" "$CUERPO"
editar_b "$(jq -n --argjson u "$USUARIO_ID" '{accesos:[{usuario_id:$u,grupo:"read"},{usuario_id:$u,grupo:"full"}]}')"
comprobar "Accesos: al editar un router, un usuario repetido se rechaza, 400" "$(codigo_es 400; echo $?)" "$CUERPO"
api GET /api/routers
comprobar "Accesos: las solicitudes rechazadas no alteran el router" \
    "$(printf '%s' "$CUERPO" | jq -e --argjson r "$ROUTER_B_ID" '.[] | select(.id == $r) | .acceso == "general" and (.accesos | length) == 1 and .accesos[0].grupo == "read"' >/dev/null; echo $?)"

# Se deja todo como estaba al llegar: fuera el segundo router y el segundo
# usuario, y suspendidos de nuevo el usuario y el router de prueba.
api DELETE "/api/routers/$ROUTER_B_ID"
api DELETE "/api/usuarios/$USUARIO_B_ID"
api PUT "/api/usuarios/$USUARIO_ID" '{"nombre_completo":"Prueba automática","grupo":"read","activo":false}'
api PUT "/api/routers/$ROUTER_ID" "$(jq -n --arg n "$ROUTER_PRUEBA" '{nombre:$n,empresa:"Empresa de prueba",redes:["127.0.0.1"],activo:false}')"
aplicar
comprobar "Accesos: datos propios de la sección retirados y configuración aplicada" "$?"
docker exec "$RADIUS" rm -f /tmp/secreto-b
S="$(radius 127.0.0.1 /tmp/secreto-raro "$PAP_OK")"
comprobar "Accesos: el router de prueba vuelve a quedar suspendido" "$(printf '%s' "$S" | grep -q 'Received'; [ $? -ne 0 ]; echo $?)"

# ---------------------------------------------------------------- acceso y seguridad del panel
COOKIE_ADMIN="$COOKIE"
# Los ajustes de la purga tal como están: la cuenta de solo lectura intentará
# guardar estos mismos, así que si el control fallara no cambiaría nada.
api GET /api/purga
AJUSTES_PURGA="$(printf '%s' "$CUERPO" | jq -c '.ajustes' 2>/dev/null)"
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
# Solo apunta al router de prueba: si el control fallara, no tocaría nada más.
api POST /api/accesos/masivo "$(jq -n --argjson r "$ROUTER_ID" '{routers:{ids:[$r]},accion:"modo",modo:"restringido"}')"
comprobar "Seguridad: la cuenta de solo lectura no puede hacer cambios masivos de accesos, 403" "$(codigo_es 403; echo $?)" "$CUERPO"
api GET /api/operadores
comprobar "Seguridad: la cuenta de solo lectura no ve los operadores, 403" "$(codigo_es 403; echo $?)"
api GET /api/auditoria
comprobar "Seguridad: la cuenta de solo lectura no ve el registro de actividad, 403" "$(codigo_es 403; echo $?)"
api POST /api/actualizacion/aplicar '{"commit":"0123456789abcdef0123456789abcdef01234567"}'
comprobar "Seguridad: la cuenta de solo lectura no puede lanzar una actualización, 403" "$(codigo_es 403; echo $?)"
api GET /api/purga
comprobar "Seguridad: la cuenta de solo lectura no ve la purga de registros, 403" "$(codigo_es 403; echo $?)"
api PUT /api/purga "$AJUSTES_PURGA"
comprobar "Seguridad: la cuenta de solo lectura no puede cambiar los ajustes de la purga, 403" "$(codigo_es 403; echo $?)" "$CUERPO"
api POST /api/purga/ejecutar '{}'
comprobar "Seguridad: la cuenta de solo lectura no puede ejecutar una purga, 403" "$(codigo_es 403; echo $?)" "$CUERPO"
# Accesos al servidor: el alta usa una red de documentación y la baja un
# identificador que no existe, así que si el control fallara no tocaría nada real.
api GET /api/servidor/accesos
comprobar "Seguridad: la cuenta de solo lectura no ve los accesos al servidor, 403" "$(codigo_es 403; echo $?)"
api POST /api/servidor/accesos '{"servicio":"panel","red":"192.0.2.0/24","descripcion":"Prueba automática"}'
comprobar "Seguridad: la cuenta de solo lectura no puede dar acceso al servidor, 403" "$(codigo_es 403; echo $?)" "$CUERPO"
api DELETE /api/servidor/accesos/2147483646
comprobar "Seguridad: la cuenta de solo lectura no puede quitar accesos al servidor, 403" "$(codigo_es 403; echo $?)" "$CUERPO"

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

# ---------------------------------------------------------------- bloqueo por dirección IP
for n in 1 2 3; do
    entrar "$ADMIN_PRUEBA" "equivocada-$n" "" "$IP_ATACANTE"
done
comprobar "Bloqueo por IP: los tres primeros intentos fallidos responden 401" "$([ "$CODIGO" = 401 ]; echo $?)"
entrar "usuario-que-no-existe" "equivocada-4" "" "$IP_ATACANTE"
comprobar "Bloqueo por IP: el cuarto intento fallido también responde 401, aunque sea con otra cuenta" "$([ "$CODIGO" = 401 ]; echo $?)"
entrar "$ADMIN_PRUEBA" "$ADMIN_CLAVE" "" "$IP_ATACANTE"
comprobar "Bloqueo por IP: el quinto intento se bloquea aunque la contraseña sea correcta, 429" \
    "$([ "$CODIGO" = 429 ] && [ -z "$SESION" ]; echo $?)" "$CUERPO"
entrar "$ADMIN_PRUEBA" "$ADMIN_CLAVE"
comprobar "Bloqueo por IP: desde otra dirección la misma cuenta sigue entrando, 200" "$([ "$CODIGO" = 200 ] && [ -n "$SESION" ]; echo $?)"
OCULTAR+=("$SESION")
api GET /api/bloqueos
comprobar "Bloqueo por IP: el panel lista la dirección bloqueada" \
    "$(printf '%s' "$CUERPO" | jq -e --arg ip "$IP_ATACANTE" 'any(.bloqueos[]; .ip == $ip and .intentos == 4)' >/dev/null; echo $?)" \
    "$(printf '%s' "$CUERPO" | jq -c '.regla')"
api GET /api/routers
comprobar "Bloqueo por IP: una sesión ya abierta no se ve afectada" "$(codigo_es 200; echo $?)"
api GET "/api/auditoria?buscar=ip.bloqueada&tamano=5"
comprobar "Bloqueo por IP: el bloqueo queda en el registro de actividad" \
    "$(printf '%s' "$CUERPO" | jq -e --arg ip "$IP_ATACANTE" 'any(.eventos[]; .accion == "ip.bloqueada" and .objeto == $ip)' >/dev/null; echo $?)"
api POST /api/bloqueos/desbloquear "$(jq -n --arg ip "$IP_ATACANTE" '{ip:$ip}')"
comprobar "Bloqueo por IP: un administrador puede desbloquear la dirección, 200" "$(codigo_es 200; echo $?)"
entrar "$ADMIN_PRUEBA" "$ADMIN_CLAVE" "" "$IP_ATACANTE"
comprobar "Bloqueo por IP: tras desbloquear, esa dirección vuelve a entrar, 200" "$([ "$CODIGO" = 200 ]; echo $?)"
OCULTAR+=("$SESION")

# Tres fallos y un acierto: el acierto pone el contador a cero.
for n in 1 2 3; do
    entrar "$ADMIN_PRUEBA" "equivocada-$n" "" "$IP_ATACANTE"
done
entrar "$ADMIN_PRUEBA" "$ADMIN_CLAVE" "" "$IP_ATACANTE"
OCULTAR+=("$SESION")
for n in 1 2 3; do
    entrar "$ADMIN_PRUEBA" "equivocada-$n" "" "$IP_ATACANTE"
done
comprobar "Bloqueo por IP: un acceso correcto pone a cero los fallos anteriores" "$([ "$CODIGO" = 401 ]; echo $?)"
docker exec radiuscontrol-api radiuscontrol desbloquear-ip "$IP_ATACANTE" >/dev/null

# ---------------------------------------------------------------- cierre de sesiones
# Se prueba con una cuenta de solo lectura creada para esto: «cerrar las demás»
# con un administrador cerraría también las sesiones de las personas reales.
SESIONES_PRUEBA="operador-sesiones-automatica"
api GET /api/operadores
for id in $(printf '%s' "$CUERPO" | jq -r ".[] | select(.usuario == \"$SESIONES_PRUEBA\") | .id"); do
    api DELETE "/api/operadores/$id"
done
api POST /api/operadores "$(jq -n --arg u "$SESIONES_PRUEBA" '{usuario:$u,rol:"lectura"}')"
SESIONES_ID="$(printf '%s' "$CUERPO" | jq -r '.operador.id')"
SESIONES_CLAVE="$(printf '%s' "$CUERPO" | jq -r '.clave_generada')"
OCULTAR+=("$SESIONES_CLAVE")
entrar "$SESIONES_PRUEBA" "$SESIONES_CLAVE"
S_A="$SESION"
entrar "$SESIONES_PRUEBA" "$SESIONES_CLAVE"
S_B="$SESION"
entrar "$SESIONES_PRUEBA" "$SESIONES_CLAVE"
S_C="$SESION"
OCULTAR+=("$S_A" "$S_B" "$S_C")
COOKIE_ADMIN_PRUEBA="$COOKIE"
SESIONES_REALES="$(docker compose exec -T postgres psql -U radiuscontrol -d radiuscontrol -At -c \
    "SELECT count(*) FROM sesiones s JOIN operadores o ON o.id = s.operador_id WHERE o.usuario NOT LIKE '%-automatica'")"

COOKIE="$S_A"
api GET /api/sesiones
comprobar "Sesiones: una cuenta de solo lectura ve solo sus propias sesiones" \
    "$(printf '%s' "$CUERPO" | jq -e --arg u "$SESIONES_PRUEBA" 'length == 3 and all(.[]; .operador == $u)' >/dev/null; echo $?)"
ID_B="$(printf '%s' "$CUERPO" | jq -r '[.[] | select(.actual | not)] | sort_by(.id)[0].id')"
api DELETE "/api/sesiones/$ID_B"
comprobar "Sesiones: cerrar una sesión concreta, 200" "$(codigo_es 200; echo $?)"
api DELETE /api/sesiones
comprobar "Sesiones: cerrar todas las demás de una vez, 200" "$(codigo_es 200; echo $?)" "$CUERPO"
COOKIE="$S_B"
api GET /api/sesiones
R1="$CODIGO"
COOKIE="$S_C"
api GET /api/sesiones
R2="$CODIGO"
comprobar "Sesiones: las sesiones cerradas dejan de valer, 401" "$([ "$R1" = 401 ] && [ "$R2" = 401 ]; echo $?)"
COOKIE="$S_A"
api GET /api/sesiones
comprobar "Sesiones: la sesión desde la que se cierran las demás sigue abierta" \
    "$(codigo_es 200 && printf '%s' "$CUERPO" | jq -e 'length == 1 and .[0].actual' >/dev/null; echo $?)"
# ---------- inactividad
sql() { docker compose exec -T postgres psql -U radiuscontrol -d radiuscontrol -At -c "$1"; }
minutos_sin_actividad() { sql "SELECT floor(extract(epoch FROM now() - s.ultima_actividad) / 60) FROM sesiones s JOIN operadores o ON o.id = s.operador_id WHERE o.usuario = '$SESIONES_PRUEBA'"; }
envejecer() { sql "UPDATE sesiones s SET ultima_actividad = now() - interval '$1 minutes' FROM operadores o WHERE o.id = s.operador_id AND o.usuario = '$SESIONES_PRUEBA'" >/dev/null; }

envejecer 29
AUTO=1
api GET /api/estado
AUTO=""
comprobar "Inactividad: un refresco automático del panel no cuenta como actividad" \
    "$(codigo_es 200 && [ "$(minutos_sin_actividad)" = 29 ]; echo $?)"
api GET /api/sesiones
comprobar "Inactividad: una acción de la persona sí renueva la sesión" \
    "$(codigo_es 200 && [ "$(minutos_sin_actividad)" = 0 ]; echo $?)"
envejecer 31
api GET /api/sesiones
comprobar "Inactividad: con más de 30 minutos sin actividad la sesión se cierra, 401" \
    "$(codigo_es 401 && [ "$(printf '%s' "$CUERPO" | jq -r .motivo)" = "inactividad" ]; echo $?)" "$CUERPO"
comprobar "Inactividad: la sesión cerrada desaparece de la base" \
    "$([ "$(sql "SELECT count(*) FROM sesiones s JOIN operadores o ON o.id = s.operador_id WHERE o.usuario = '$SESIONES_PRUEBA'")" = 0 ]; echo $?)"

# Sin ninguna petición: la cierra el propio servidor.
entrar "$SESIONES_PRUEBA" "$SESIONES_CLAVE"
OCULTAR+=("$SESION")
envejecer 45
for _ in $(seq 1 45); do
    [ "$(sql "SELECT count(*) FROM sesiones s JOIN operadores o ON o.id = s.operador_id WHERE o.usuario = '$SESIONES_PRUEBA'")" = 0 ] && break
    sleep 1
done
comprobar "Inactividad: el servidor cierra la sesión aunque nadie vuelva a usarla" \
    "$([ "$(sql "SELECT count(*) FROM sesiones s JOIN operadores o ON o.id = s.operador_id WHERE o.usuario = '$SESIONES_PRUEBA'")" = 0 ]; echo $?)"

COOKIE="$COOKIE_ADMIN_PRUEBA"
api GET "/api/auditoria?buscar=$SESIONES_PRUEBA&tamano=100"
comprobar "Inactividad: los dos cierres quedan en el registro de actividad con su motivo" \
    "$(printf '%s' "$CUERPO" | jq -e '[.eventos[] | select(.accion == "sesion.cerrada_por_inactividad" and (.detalle | contains("30 minutos sin actividad")))] | length == 2' >/dev/null; echo $?)" \
    "$(printf '%s' "$CUERPO" | jq -c '[.eventos[] | select(.accion == "sesion.cerrada_por_inactividad")][0] | {operador, ip, accion, detalle}')"

api GET /api/routers
comprobar "Sesiones: cerrar las propias no toca las sesiones de otros operadores" \
    "$(codigo_es 200 && [ "$(docker compose exec -T postgres psql -U radiuscontrol -d radiuscontrol -At -c \
        "SELECT count(*) FROM sesiones s JOIN operadores o ON o.id = s.operador_id WHERE o.usuario NOT LIKE '%-automatica'")" = "$SESIONES_REALES" ]; echo $?)"
api DELETE "/api/operadores/$SESIONES_ID"

# ---------------------------------------------------------------- bloqueo por cuenta
CUENTA_PRUEBA="operador-bloqueo-automatica"
api GET /api/operadores
for id in $(printf '%s' "$CUERPO" | jq -r ".[] | select(.usuario == \"$CUENTA_PRUEBA\") | .id"); do
    api DELETE "/api/operadores/$id"
done
api POST /api/operadores "$(jq -n --arg u "$CUENTA_PRUEBA" '{usuario:$u,rol:"lectura"}')"
CUENTA_ID="$(printf '%s' "$CUERPO" | jq -r '.operador.id')"
CUENTA_CLAVE="$(printf '%s' "$CUERPO" | jq -r '.clave_generada')"
OCULTAR+=("$CUENTA_CLAVE")
# Cada fallo llega desde una dirección distinta: así no salta el bloqueo por IP
# y se prueba el de la cuenta por separado.
for n in 1 2 3 4; do
    entrar "$CUENTA_PRUEBA" "equivocada-$n" "" "192.0.2.$((210 + n))"
done
comprobar "Bloqueo por cuenta: los cuatro intentos fallidos responden 401" "$([ "$CODIGO" = 401 ]; echo $?)"
entrar "$CUENTA_PRUEBA" "$CUENTA_CLAVE" "" "192.0.2.220"
RESPUESTA_BLOQUEADA="$CODIGO $CUERPO"
comprobar "Bloqueo por cuenta: el quinto intento no entra aunque venga de otra dirección y con la contraseña correcta" \
    "$([ "$CODIGO" = 401 ] && [ -z "$SESION" ]; echo $?)" "$CUERPO"
entrar "usuario-que-no-existe" "$CUENTA_CLAVE" "" "192.0.2.221"
comprobar "Bloqueo por cuenta: la respuesta es idéntica a la de un usuario que no existe (no revela qué cuentas hay)" \
    "$([ "$RESPUESTA_BLOQUEADA" = "$CODIGO $CUERPO" ]; echo $?)"
for n in 1 2 3 4 5; do
    entrar "$CUENTA_PRUEBA" "equivocada-$n" "" "192.0.2.222"
done
api GET /api/bloqueos
comprobar "Bloqueo por cuenta: insistir sobre una cuenta ya bloqueada no bloquea además la dirección del operador" \
    "$(printf '%s' "$CUERPO" | jq -e 'all(.bloqueos[]; .ip != "192.0.2.222")' >/dev/null; echo $?)"
comprobar "Bloqueo por cuenta: el panel lista la cuenta bloqueada junto a las direcciones" \
    "$(printf '%s' "$CUERPO" | jq -e --arg u "$CUENTA_PRUEBA" 'any(.cuentas[]; .usuario == $u and .intentos == 4)' >/dev/null; echo $?)" \
    "$(printf '%s' "$CUERPO" | jq -c '{cuentas: [.cuentas[] | {usuario, intentos}], regla}')"

# El bloqueo caduca: se simula adelantando su fin. La cuenta debe empezar de
# cero, no volver a bloquearse con un solo fallo.
sql "UPDATE operadores SET bloqueado_hasta = now() - interval '1 minute' WHERE id = $CUENTA_ID" >/dev/null
entrar "$CUENTA_PRUEBA" "equivocada-tras-caducar" "" "192.0.2.223"
comprobar "Bloqueo por cuenta: tras caducar el bloqueo, un fallo suelto no vuelve a bloquear y el contador empieza de cero" \
    "$([ "$(sql "SELECT intentos_fallidos || ' ' || (bloqueado_hasta IS NULL) FROM operadores WHERE id = $CUENTA_ID")" = "1 true" ]; echo $?)" \
    "$(sql "SELECT 'intentos=' || intentos_fallidos || ' bloqueada=' || COALESCE(bloqueado_hasta > now(), false) FROM operadores WHERE id = $CUENTA_ID")"
entrar "$CUENTA_PRUEBA" "$CUENTA_CLAVE" "" "192.0.2.220"
comprobar "Bloqueo por cuenta: con el bloqueo caducado la contraseña correcta vuelve a entrar, 200" "$([ "$CODIGO" = 200 ] && [ -n "$SESION" ]; echo $?)"
OCULTAR+=("$SESION")

# Doce intentos a la vez, cada uno desde una dirección distinta: solo cuatro
# pueden llegar a comprobar la contraseña; el resto debe encontrar la cuenta ya
# bloqueada.
MARCA_AUDITORIA="$(sql "SELECT COALESCE(max(id), 0) FROM auditoria")"
for n in $(seq 1 12); do
    curl -sS -m 60 -o /dev/null -X POST "$API/api/sesion" -H 'X-RC: 1' -H 'Content-Type: application/json' \
        -H "X-Forwarded-For: 192.0.2.$((230 + n))" \
        --data "$(jq -n --arg u "$CUENTA_PRUEBA" --arg c "rafaga-$n" '{usuario:$u,clave:$c,codigo:""}')" &
done
wait
COMPROBADAS="$(sql "SELECT count(*) FROM auditoria WHERE id > $MARCA_AUDITORIA AND operador = '$CUENTA_PRUEBA' AND detalle->>'motivo' = 'contraseña incorrecta'")"
RECHAZADAS="$(sql "SELECT count(*) FROM auditoria WHERE id > $MARCA_AUDITORIA AND operador = '$CUENTA_PRUEBA' AND detalle->>'motivo' = 'cuenta bloqueada'")"
comprobar "Bloqueo por cuenta: de doce intentos simultáneos solo cuatro llegan a comprobar la contraseña" \
    "$([ "$COMPROBADAS" = 4 ] && [ "$RECHAZADAS" = 8 ]; echo $?)" "comprobadas=$COMPROBADAS rechazadas sin comprobar=$RECHAZADAS"

api POST "/api/operadores/$CUENTA_ID/desbloquear" '{}'
comprobar "Bloqueo por cuenta: un administrador puede desbloquearla, 200" "$(codigo_es 200; echo $?)"
entrar "$CUENTA_PRUEBA" "$CUENTA_CLAVE" "" "192.0.2.220"
comprobar "Bloqueo por cuenta: tras desbloquear, la cuenta vuelve a entrar, 200" "$([ "$CODIGO" = 200 ] && [ -n "$SESION" ]; echo $?)"
OCULTAR+=("$SESION")
api DELETE "/api/operadores/$CUENTA_ID"

# ---------------------------------------------------------------- huellas con clave
api GET /api/estado
SHA_CLIENTS="$(docker exec radiuscontrol-api sha256sum /compilado/actual/clients.conf | cut -d' ' -f1)"
SHA_AUTHORIZE="$(docker exec radiuscontrol-api sha256sum /compilado/actual/authorize | cut -d' ' -f1)"
comprobar "Huellas: el panel no entrega el SHA-256 de los archivos que llevan secretos" \
    "$([ "${#SHA_CLIENTS}" = 64 ] && ! printf '%s' "$CUERPO" | grep -q -e "$SHA_CLIENTS" -e "$SHA_AUTHORIZE"; echo $?)"
comprobar "Huellas: con huellas con clave el panel sigue viendo que lo aplicado y lo cargado coinciden" \
    "$(printf '%s' "$CUERPO" | jq -e '.sincronizado and (.cambios_pendientes | not) and (.activa.sha_clients | length) == 64 and .activa.sha_clients == .freeradius.sha_clients and .activa.sha_clients == .deseado.sha_clients' >/dev/null; echo $?)"
comprobar "Huellas: la base tampoco guarda el SHA-256 a secas de ninguna versión" \
    "$([ "$(sql "SELECT count(*) FROM versiones_config WHERE NOT huella_con_clave OR sha_clients = '$SHA_CLIENTS' OR sha_authorize = '$SHA_AUTHORIZE'")" = 0 ]; echo $?)"

# Por el camino real (el proxy web) no se puede fingir otra dirección.
curl -sk -m 30 -o /dev/null -X POST "https://$IP_PUBLICA/api/sesion" -H 'X-RC: 1' -H 'Content-Type: application/json' \
    -H 'X-Forwarded-For: 203.0.113.99' --data '{"usuario":"prueba-direccion-fingida","clave":"x"}'
api GET "/api/auditoria?buscar=prueba-direccion-fingida&tamano=5"
comprobar "Bloqueo por IP: la dirección que anota el panel es la real, no la que declara el visitante" \
    "$(printf '%s' "$CUERPO" | jq -e --arg ip "$IP_PUBLICA" '(.eventos | length) > 0 and all(.eventos[]; .ip == $ip)' >/dev/null; echo $?)" \
    "$(printf '%s' "$CUERPO" | jq -c '[.eventos[] | {ip, accion}][0]')"
docker exec radiuscontrol-api radiuscontrol desbloquear-ip "$IP_PUBLICA" >/dev/null

# ---------------------------------------------------------------- purga de registros
# El servidor tiene datos reales. Por eso los ajustes no se cambian (se vuelven
# a guardar los mismos), los valores que deben rechazarse pecan siempre por
# exceso (si alguno se aceptara por error, conservaría más, nunca menos) y la
# purga de emergencia por disco no se prueba. Lo que se borra son filas propias,
# con marcador y con fecha de hace 4000 días.
# cuenta_marca <marcador>: «<filas en autenticaciones> <filas en auditoria>»
cuenta_marca() { sql "SELECT (SELECT count(*) FROM autenticaciones WHERE usuario = '$1') || ' ' || (SELECT count(*) FROM auditoria WHERE operador = '$1')"; }
quitar_marcas() { sql "DELETE FROM autenticaciones WHERE usuario IN ('$MARCA_ANTIGUA', '$MARCA_RECIENTE'); DELETE FROM auditoria WHERE operador IN ('$MARCA_ANTIGUA', '$MARCA_RECIENTE')" >/dev/null; }
quitar_marcas

api GET /api/purga
comprobar "Purga: el panel ve los ajustes, el uso del disco y lo que hay guardado, 200" \
    "$(codigo_es 200 && printf '%s' "$CUERPO" | jq -e '.disco.porcentaje >= 1 and .disco.porcentaje <= 100 and .disco.total_bytes > 0 and (.disco.libre_bytes | type == "number") and (.ajustes | [.dias_autenticaciones, .dias_actividad, .cada_horas, .porcentaje_disco] | all(type == "number")) and (.filas | [.autenticaciones, .actividad] | all(type == "number")) and (.mas_antiguo | has("autenticaciones") and has("actividad")) and (.ultimas | type == "array")' >/dev/null; echo $?)" \
    "$(printf '%s' "$CUERPO" | jq -c '{ajustes, disco, filas, mas_antiguo}' 2>/dev/null)"
AJUSTES="$(printf '%s' "$CUERPO" | jq -cS '.ajustes' 2>/dev/null)"
# ajustes_iguales: los ajustes del servidor son los que había al empezar
ajustes_iguales() {
    api GET /api/purga
    [ -n "$AJUSTES" ] && [ "$AJUSTES" != "null" ] && [ "$(printf '%s' "$CUERPO" | jq -cS '.ajustes' 2>/dev/null)" = "$AJUSTES" ]
}

for cambio in '.dias_autenticaciones = 3651' '.dias_actividad = 3651' '.cada_horas = 721' '.porcentaje_disco = 96'; do
    api PUT /api/purga "$(printf '%s' "$AJUSTES" | jq -c "$cambio" 2>/dev/null)"
    RECHAZADO="$CODIGO"
    DETALLE="$CUERPO"
    ajustes_iguales
    IGUALES=$?
    comprobar "Purga: un valor fuera de rango ($cambio) se rechaza y no cambia los ajustes, 400" \
        "$([ "$RECHAZADO" = 400 ] && [ "$IGUALES" -eq 0 ]; echo $?)" "$DETALLE"
done

if [ -n "$AJUSTES" ] && [ "$AJUSTES" != "null" ]; then
    api PUT /api/purga "$AJUSTES"
    comprobar "Purga: volver a guardar los mismos ajustes responde con el estado completo, 200" \
        "$(codigo_es 200 && [ "$(printf '%s' "$CUERPO" | jq -cS '.ajustes')" = "$AJUSTES" ] && printf '%s' "$CUERPO" | jq -e '.disco.porcentaje >= 1 and (.ultimas | type == "array")' >/dev/null; echo $?)" \
        "$(printf '%s' "$CUERPO" | jq -c '.ajustes' 2>/dev/null)"
else
    comprobar "Purga: volver a guardar los mismos ajustes responde con el estado completo, 200" 1 "no se pudieron leer los ajustes"
fi
api GET "/api/auditoria?buscar=sistema.purga_ajustada&tamano=5"
comprobar "Purga: guardar los ajustes queda en el registro de actividad" \
    "$(printf '%s' "$CUERPO" | jq -e --arg o "$ADMIN_PRUEBA" 'any(.eventos[]; .accion == "sistema.purga_ajustada" and .operador == $o and .objeto == "purga" and (.detalle | contains("dias_autenticaciones")))' >/dev/null; echo $?)" \
    "$(printf '%s' "$CUERPO" | jq -c '[.eventos[] | select(.accion == "sistema.purga_ajustada")][0] | {operador, accion, objeto, detalle}' 2>/dev/null)"

# La limpieza solo se ejecuta si los ajustes siguen siendo los del servidor.
if ajustes_iguales; then
    sql "INSERT INTO autenticaciones (fecha, resultado, usuario, ip_origen) VALUES (now() - interval '4000 days', 'rechazado', '$MARCA_ANTIGUA', '$IP_PRUEBA'), (now(), 'rechazado', '$MARCA_RECIENTE', '$IP_PRUEBA'); INSERT INTO auditoria (fecha, operador, ip, accion, objeto) VALUES (now() - interval '4000 days', '$MARCA_ANTIGUA', '$IP_PRUEBA', 'prueba.purga', 'prueba'), (now(), '$MARCA_RECIENTE', '$IP_PRUEBA', 'prueba.purga', 'prueba')" >/dev/null
    comprobar "Purga: filas de prueba insertadas, una antiquísima y una reciente en cada tabla" \
        "$([ "$(cuenta_marca "$MARCA_ANTIGUA")" = "1 1" ] && [ "$(cuenta_marca "$MARCA_RECIENTE")" = "1 1" ]; echo $?)"
    api POST /api/purga/ejecutar '{}'
    PURGA="$CUERPO"
    comprobar "Purga: ejecutar una limpieza a mano responde con lo que borró de cada tabla, 200" \
        "$(codigo_es 200 && printf '%s' "$PURGA" | jq -e --arg o "$ADMIN_PRUEBA" '.purga.motivo == "manual" and .purga.operador == $o and .purga.autenticaciones >= 1 and .purga.actividad >= 1 and (.purga.disco_antes | type == "number") and (.purga.disco_despues | type == "number")' >/dev/null; echo $?)" "$PURGA"
    PURGA_ID="$(printf '%s' "$PURGA" | jq -r '.purga.id' 2>/dev/null)"
    comprobar "Purga: las filas más antiguas que la retención ya no están" \
        "$([ "$(cuenta_marca "$MARCA_ANTIGUA")" = "0 0" ]; echo $?)"
    comprobar "Purga: las filas recientes siguen en su sitio" \
        "$([ "$(cuenta_marca "$MARCA_RECIENTE")" = "1 1" ]; echo $?)"
    api GET /api/purga
    comprobar "Purga: la limpieza aparece entre las últimas con el motivo manual" \
        "$(printf '%s' "$CUERPO" | jq -e --arg id "$PURGA_ID" '(.ultimas | length) <= 10 and any(.ultimas[]; (.id | tostring) == $id and .motivo == "manual")' >/dev/null; echo $?)" \
        "$(printf '%s' "$CUERPO" | jq -c --arg id "$PURGA_ID" '[.ultimas[] | select((.id | tostring) == $id)][0]' 2>/dev/null)"
    api GET "/api/auditoria?buscar=sistema.purga&tamano=20"
    comprobar "Purga: la limpieza queda en el registro de actividad y no se borra a sí misma" \
        "$(printf '%s' "$CUERPO" | jq -e --arg o "$ADMIN_PRUEBA" 'any(.eventos[]; .accion == "sistema.purga" and .operador == $o and .objeto == "manual" and (.detalle | contains("autenticaciones")))' >/dev/null; echo $?)" \
        "$(printf '%s' "$CUERPO" | jq -c '[.eventos[] | select(.accion == "sistema.purga" and .objeto == "manual")][0] | {operador, ip, accion, objeto, detalle}' 2>/dev/null)"
else
    comprobar "Purga: los ajustes siguen como estaban, condición para ejecutar la limpieza" 1 "$CUERPO"
fi

# Se retira lo que ha puesto esta sección. Los eventos del registro de
# actividad se borran con los demás en la limpieza final.
quitar_marcas
sql "DELETE FROM purgas WHERE operador = '$ADMIN_PRUEBA'" >/dev/null
comprobar "Purga: datos propios de la sección retirados" \
    "$([ "$(cuenta_marca "$MARCA_ANTIGUA")" = "0 0" ] && [ "$(cuenta_marca "$MARCA_RECIENTE")" = "0 0" ] && [ "$(sql "SELECT count(*) FROM purgas WHERE operador = '$ADMIN_PRUEBA'")" = 0 ]; echo $?)"

# ---------------------------------------------------------------- vaciado a petición
# NUNCA se prueba con «dias: 0»: vaciaría los registros reales del servidor.
# Se usa el máximo (3650 días) con una fila propia de hace 4000 días.
sql "INSERT INTO autenticaciones (fecha, resultado, usuario, ip_origen) VALUES (now() - interval '4000 days', 'aceptado', 'prueba-automatica-vaciado', '192.0.2.9')" >/dev/null
sql "INSERT INTO autenticaciones (fecha, resultado, usuario, ip_origen) VALUES (now(), 'aceptado', 'prueba-automatica-vaciado-reciente', '192.0.2.9')" >/dev/null
REALES_ANTES="$(sql "SELECT count(*) FROM autenticaciones WHERE usuario NOT LIKE 'prueba-automatica%'")"
api POST /api/purga/vaciar '{"registro":"autenticaciones","dias":3650}'
comprobar "Vaciado: borrar a petición las autenticaciones de más de 3650 días, 200" \
    "$(codigo_es 200 && [ "$(printf '%s' "$CUERPO" | jq -r '.purga.autenticaciones')" -ge 1 ] && [ "$(printf '%s' "$CUERPO" | jq -r '.purga.motivo')" = "vaciado" ]; echo $?)" \
    "$(printf '%s' "$CUERPO" | jq -c '.purga | {motivo, operador, autenticaciones, actividad}')"
comprobar "Vaciado: la fila antigua ya no está y la reciente sigue" \
    "$([ "$(sql "SELECT count(*) FROM autenticaciones WHERE usuario = 'prueba-automatica-vaciado'")" = 0 ] && [ "$(sql "SELECT count(*) FROM autenticaciones WHERE usuario = 'prueba-automatica-vaciado-reciente'")" = 1 ]; echo $?)"
comprobar "Vaciado: no toca las autenticaciones reales dentro del periodo" \
    "$([ "$(sql "SELECT count(*) FROM autenticaciones WHERE usuario NOT LIKE 'prueba-automatica%'")" = "$REALES_ANTES" ]; echo $?)"
api POST /api/purga/vaciar '{"registro":"todo","dias":3650}'
comprobar "Vaciado: un registro desconocido se rechaza, 400" "$(codigo_es 400; echo $?)" "$CUERPO"
api POST /api/purga/vaciar '{"registro":"actividad","dias":-1}'
comprobar "Vaciado: unos días negativos se rechazan, 400" "$(codigo_es 400; echo $?)"
api GET "/api/auditoria?buscar=sistema.registros_vaciados&tamano=5"
comprobar "Vaciado: queda anotado quién lo hizo en el registro de actividad" \
    "$(printf '%s' "$CUERPO" | jq -e --arg o "$ADMIN_PRUEBA" 'any(.eventos[]; .accion == "sistema.registros_vaciados" and .operador == $o)' >/dev/null; echo $?)"
sql "DELETE FROM autenticaciones WHERE usuario LIKE 'prueba-automatica-vaciado%'; DELETE FROM purgas WHERE operador = '$ADMIN_PRUEBA'" >/dev/null

# ---------------------------------------------------------------- accesos al servidor (panel y SSH)
# El servidor tiene las reglas reales de UFW de su dueño, y un error aquí puede
# dejarlo sin acceso. Por eso solo se dan de alta redes de documentación, nunca
# «cualquiera», y solo se retira lo que la propia sección ha creado. Al final
# se comprueba que ninguna otra regla del firewall ha cambiado.
RED_ACC_A="192.0.2.0/24"     # panel; contiene a $IP_PRUEBA
RED_ACC_B="198.51.100.0/24"  # panel
RED_ACC_SSH="203.0.113.0/24" # SSH
# Dirección simulada que no está en ninguna red del panel de la prueba.
IP_FUERA="203.0.113.200"
REDES_ACC_SQL="'$RED_ACC_A', '$RED_ACC_B', '$RED_ACC_SSH'"

reglas_propias() { ufw show added | grep -e "comment 'radiuscontrol-panel'" -e "comment 'radiuscontrol-ssh'"; }
reglas_ajenas() { ufw show added | grep -v -e "comment 'radiuscontrol-panel'" -e "comment 'radiuscontrol-ssh'"; }
# Reglas gestionadas que son de las redes de la prueba.
restos_prueba() { reglas_propias | grep -F -e "from $RED_ACC_A to " -e "from $RED_ACC_B to " -e "from $RED_ACC_SSH to "; }
regla_acceso() { # <red> <puerto> <comentario>
    ufw show added | grep -q -x -F "ufw allow from $1 to any port $2 proto tcp comment '$3'"
}
esperar_regla() { # <0: debe existir | 1: no debe existir> <red> <puerto> <comentario>
    for _ in $(seq 1 20); do
        regla_acceso "$2" "$3" "$4"
        [ $? -eq "$1" ] && return 0
        sleep 1
    done
    return 1
}
# id_acceso <servicio> <red>: identificador de ese acceso en la última respuesta
id_acceso() {
    printf '%s' "$CUERPO" | jq -r --arg s "$1" --arg r "$2" \
        '[.gestionadas[]? | select(.servicio == $s and .red == $r)][0].id // empty' 2>/dev/null
}
alta_acceso() { # <servicio> <red>
    api POST /api/servidor/accesos "$(jq -n --arg s "$1" --arg r "$2" '{servicio:$s,red:$r,descripcion:"Prueba automática"}')"
}
# Último recurso para retirar lo que quede de las redes de la prueba: se borran
# de la base y se reinicia la API, que al arrancar vuelve a escribir la lista
# que lee el agente de firewall. No pasa por las salvaguardas del panel.
retirar_accesos_prueba() {
    [ "$(sql "SELECT count(*) FROM accesos_servidor WHERE red IN ($REDES_ACC_SQL)")" = 0 ] && return 0
    sql "DELETE FROM accesos_servidor WHERE red IN ($REDES_ACC_SQL)" >/dev/null
    docker compose restart api >/dev/null 2>&1
    for _ in $(seq 1 40); do
        api GET /api/estado
        codigo_es 200 && break
        sleep 1
    done
}

# Si una ejecución anterior se cortó a medias, primero se retira lo que dejó.
retirar_accesos_prueba
for _ in $(seq 1 20); do
    [ -z "$(restos_prueba)" ] && break
    sleep 1
done

api GET /api/servidor/accesos
PUERTO_SSH="$(printf '%s' "$CUERPO" | jq -r '.puerto_ssh' 2>/dev/null)"
comprobar "Accesos al servidor: el panel ve el puerto de SSH, tu dirección y las reglas cargadas a mano del panel y del SSH, 200" \
    "$(codigo_es 200 && printf '%s' "$CUERPO" | jq -e --arg ip "$IP_PRUEBA" '(.puerto_ssh | type == "number") and .puerto_ssh >= 1 and .puerto_ssh <= 65535 and .tu_ip == $ip and (.gestionadas | type == "array") and any(.ajenas[]; .servicio == "panel") and any(.ajenas[]; .servicio == "ssh") and (.firewall.estado | type == "string") and (.firewall.ufw_activo | type == "boolean") and (.firewall.desde | type == "string")' >/dev/null; echo $?)" \
    "$(printf '%s' "$CUERPO" | jq -c '{puerto_ssh, tu_ip, gestionadas, ajenas, firewall}' 2>/dev/null)"

# La sección solo sigue si puede asegurar que no tocará nada ajeno: el puerto
# de SSH se conoce, no quedan restos de otra ejecución y el dueño no tiene
# reglas propias con estas mismas redes (el agente las adoptaría y, al retirar
# la prueba, se las llevaría).
CHOQUE=""
if [[ "$PUERTO_SSH" =~ ^[0-9]+$ ]]; then
    CHOQUE="$(reglas_ajenas | grep -F -e "from $RED_ACC_A to any port 443" -e "from $RED_ACC_B to any port 443" -e "from $RED_ACC_SSH to any port $PUERTO_SSH")"
fi
if ! [[ "$PUERTO_SSH" =~ ^[0-9]+$ ]] || [ -n "$CHOQUE" ] || [ -n "$(restos_prueba)" ]; then
    comprobar "Accesos al servidor: condiciones para probar sin tocar reglas ajenas" 1 \
        "puerto de SSH: «$PUERTO_SSH»; reglas del dueño con las redes de la prueba: «$CHOQUE»; restos de otra ejecución: «$(restos_prueba)»"
else
    AJENAS_ANTES="$(reglas_ajenas)"
    PROPIAS_ANTES="$(reglas_propias)"

    # Alta en el panel de la red que contiene a la dirección de la prueba.
    alta_acceso panel "$RED_ACC_A"
    ACC_A="$(id_acceso panel "$RED_ACC_A")"
    comprobar "Accesos al servidor: alta de una red para el panel, 201" "$(codigo_es 201 && [ -n "$ACC_A" ]; echo $?)" \
        "$(printf '%s' "$CUERPO" | jq -c '.gestionadas' 2>/dev/null)"
    esperar_regla 0 "$RED_ACC_A" 443 radiuscontrol-panel
    comprobar "Accesos al servidor: en menos de 20 s UFW tiene la regla de 443/tcp con el comentario radiuscontrol-panel" "$?" "$(reglas_propias)"
    aplicada_a() { printf '%s' "$CUERPO" | jq -e --arg r "$RED_ACC_A" 'any(.gestionadas[]; .servicio == "panel" and .red == $r and .aplicada)' >/dev/null 2>&1; }
    for _ in $(seq 1 20); do
        api GET /api/servidor/accesos
        aplicada_a && break
        sleep 1
    done
    comprobar "Accesos al servidor: el panel marca el acceso como aplicado" "$(aplicada_a; echo $?)" \
        "$(printf '%s' "$CUERPO" | jq -c '{gestionadas, firewall}' 2>/dev/null)"

    api DELETE "/api/servidor/accesos/$ACC_A"
    comprobar "Accesos al servidor: no deja quitar la red desde la que está conectado el operador, 409" "$(codigo_es 409; echo $?)" "$CUERPO"
    sleep 6
    comprobar "Accesos al servidor: la regla que no se dejó quitar sigue en UFW" \
        "$(regla_acceso "$RED_ACC_A" 443 radiuscontrol-panel; echo $?)"

    alta_acceso panel "$RED_ACC_A"
    comprobar "Accesos al servidor: una red repetida se rechaza, 409" "$(codigo_es 409; echo $?)" "$CUERPO"

    # Otra red del panel: quitarla no deja fuera al operador.
    alta_acceso panel "$RED_ACC_B"
    ACC_B="$(id_acceso panel "$RED_ACC_B")"
    comprobar "Accesos al servidor: alta de una segunda red para el panel, 201" "$(codigo_es 201 && [ -n "$ACC_B" ]; echo $?)"
    esperar_regla 0 "$RED_ACC_B" 443 radiuscontrol-panel
    comprobar "Accesos al servidor: la segunda red llega a UFW" "$?"
    api DELETE "/api/servidor/accesos/$ACC_B"
    comprobar "Accesos al servidor: quitar una red que no deja fuera al operador, 200" \
        "$(codigo_es 200 && printf '%s' "$CUERPO" | jq -e --arg r "$RED_ACC_B" 'all(.gestionadas[]; .red != $r)' >/dev/null; echo $?)" "$CUERPO"
    esperar_regla 1 "$RED_ACC_B" 443 radiuscontrol-panel
    comprobar "Accesos al servidor: al quitarla, su regla desaparece de UFW" "$?" "$(reglas_propias)"

    # SSH: la regla va al puerto que informa el panel.
    alta_acceso ssh "$RED_ACC_SSH"
    ACC_SSH="$(id_acceso ssh "$RED_ACC_SSH")"
    comprobar "Accesos al servidor: alta de una red para el SSH, 201" "$(codigo_es 201 && [ -n "$ACC_SSH" ]; echo $?)"
    esperar_regla 0 "$RED_ACC_SSH" "$PUERTO_SSH" radiuscontrol-ssh
    comprobar "Accesos al servidor: UFW tiene la regla del puerto de SSH ($PUERTO_SSH/tcp) con el comentario radiuscontrol-ssh" "$?" "$(reglas_propias)"
    api DELETE "/api/servidor/accesos/$ACC_SSH"
    comprobar "Accesos al servidor: quitar la red del SSH mientras quedan otras reglas de SSH, 200" "$(codigo_es 200; echo $?)" "$CUERPO"
    esperar_regla 1 "$RED_ACC_SSH" "$PUERTO_SSH" radiuscontrol-ssh
    comprobar "Accesos al servidor: al quitarla, la regla de SSH desaparece de UFW" "$?" "$(reglas_propias)"

    # Validaciones: ninguna debe crear nada.
    api POST /api/servidor/accesos '{"servicio":"panel","red":"0.0.0.0/0"}'
    comprobar "Accesos al servidor: 0.0.0.0/0 se rechaza, 400" "$(codigo_es 400; echo $?)" "$CUERPO"
    api POST /api/servidor/accesos '{"servicio":"panel","red":"no-es-una-red"}'
    comprobar "Accesos al servidor: una red que no es válida se rechaza, 400" "$(codigo_es 400; echo $?)" "$CUERPO"
    api POST /api/servidor/accesos "$(jq -n --arg r "$RED_ACC_B" '{servicio:"ftp",red:$r}')"
    comprobar "Accesos al servidor: un servicio desconocido se rechaza, 400" "$(codigo_es 400; echo $?)" "$CUERPO"
    api POST /api/servidor/accesos "$(jq -n --arg r "$RED_ACC_B" '{servicio:"panel",red:$r,descripcion:("x" * 121)}')"
    comprobar "Accesos al servidor: una descripción de más de 120 caracteres se rechaza, 400" "$(codigo_es 400; echo $?)" "$CUERPO"
    api GET /api/servidor/accesos
    comprobar "Accesos al servidor: las solicitudes rechazadas no crean ningún acceso" \
        "$(printf '%s' "$CUERPO" | jq -e --arg a "$RED_ACC_A" --arg b "$RED_ACC_B" --arg s "$RED_ACC_SSH" '[.gestionadas[] | select(.red == $a or .red == $b or .red == $s) | .servicio + " " + .red] == ["panel " + $a]' >/dev/null; echo $?)" \
        "$(printf '%s' "$CUERPO" | jq -c '.gestionadas' 2>/dev/null)"

    api GET "/api/auditoria?buscar=servidor.acceso&tamano=50"
    comprobar "Accesos al servidor: las altas y las bajas quedan en el registro de actividad" \
        "$(printf '%s' "$CUERPO" | jq -e --arg o "$ADMIN_PRUEBA" --arg a "panel $RED_ACC_A" --arg b "panel $RED_ACC_B" 'any(.eventos[]; .accion == "servidor.acceso_añadido" and .operador == $o and .objeto == $a and (.detalle | contains("Prueba"))) and any(.eventos[]; .accion == "servidor.acceso_quitado" and .operador == $o and .objeto == $b)' >/dev/null; echo $?)" \
        "$(printf '%s' "$CUERPO" | jq -c '[.eventos[] | select(.accion | startswith("servidor.acceso")) | {accion, objeto, detalle}][0:4]' 2>/dev/null)"

    # Retirada de la red protegida: la misma baja, pedida desde una dirección
    # simulada que no depende de esa red, sí se permite.
    CODIGO="$(curl -sS -m 90 -o /dev/null -w '%{http_code}' -X DELETE "$API/api/servidor/accesos/$ACC_A" -H 'X-RC: 1' \
        -H "X-Forwarded-For: $IP_FUERA" -H "Cookie: rc_sesion=$COOKIE")"
    comprobar "Accesos al servidor: desde una dirección que no depende de esa red, sí se puede quitar, 200" "$(codigo_es 200; echo $?)"
    # Si no se pudo por la API, se retira por la base.
    retirar_accesos_prueba
    for _ in $(seq 1 20); do
        [ "$(reglas_propias)" = "$PROPIAS_ANTES" ] && break
        sleep 1
    done
    comprobar "Accesos al servidor: no queda en UFW ninguna regla de panel ni de SSH creada por la prueba" \
        "$([ "$(reglas_propias)" = "$PROPIAS_ANTES" ] && [ -z "$(restos_prueba)" ]; echo $?)" "$(reglas_propias)"
    comprobar "Accesos al servidor: las reglas que no gestiona el panel siguen exactamente como estaban" \
        "$([ "$(reglas_ajenas)" = "$AJENAS_ANTES" ]; echo $?)"
    comprobar "Accesos al servidor: datos propios de la sección retirados" \
        "$([ "$(sql "SELECT count(*) FROM accesos_servidor WHERE red IN ($REDES_ACC_SQL)")" = 0 ]; echo $?)"
fi

# ---------------------------------------------------------------- actualizaciones
api POST /api/actualizacion/buscar '{}'
comprobar "Actualización: pedir una búsqueda, 202" "$(codigo_es 202; echo $?)"
for _ in $(seq 1 30); do
    [ ! -e /var/lib/docker/volumes/radiuscontrol_compilado/_data/estado/actualizar-buscar ] && break
    sleep 1
done
sleep 2
api GET /api/actualizacion
comprobar "Actualización: el panel conoce la versión instalada, que es la del repositorio del servidor" \
    "$([ "$(printf '%s' "$CUERPO" | jq -r .busqueda.instalado)" = "$(git -C "$DIR/.." rev-parse HEAD)" ]; echo $?)" \
    "$(printf '%s' "$CUERPO" | jq -c '.busqueda | {instalado: .instalado[0:7], ultimo: .ultimo[0:7], cambios: (.cambios | length), error}')"
api POST /api/actualizacion/aplicar '{"commit":"no-es-un-commit"}'
comprobar "Actualización: una versión mal escrita se rechaza, 400" "$(codigo_es 400; echo $?)"
api POST /api/actualizacion/aplicar '{"commit":"0123456789abcdef0123456789abcdef01234567"}'
comprobar "Actualización: no se puede pedir una versión que no sea la última publicada, 409" "$(codigo_es 409; echo $?)" "$CUERPO"
comprobar "Actualización: un pedido rechazado no deja nada pendiente para el agente" \
    "$([ ! -e /var/lib/docker/volumes/radiuscontrol_compilado/_data/estado/actualizar-pedido.json ]; echo $?)"

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
docker exec "$RADIUS" rm -f /tmp/secreto /tmp/secreto-malo /tmp/secreto-raro /tmp/secreto-b
api DELETE /api/sesion
docker compose exec -T postgres psql -q -U radiuscontrol -d radiuscontrol -c     "DELETE FROM accesos_servidor WHERE red IN ($REDES_ACC_SQL); DELETE FROM auditoria WHERE accion LIKE 'servidor.acceso%' AND (objeto LIKE '% $RED_ACC_A' OR objeto LIKE '% $RED_ACC_B' OR objeto LIKE '% $RED_ACC_SSH'); DELETE FROM autenticaciones WHERE router_nombre LIKE '$ROUTER_PRUEBA%' OR usuario LIKE '$USUARIO_PRUEBA%' OR usuario IN ('no-existe', 'DEFAULT', '$MARCA_ANTIGUA', '$MARCA_RECIENTE'); DELETE FROM purgas WHERE operador = '$ADMIN_PRUEBA'; DELETE FROM operadores WHERE usuario = '$ADMIN_PRUEBA'; DELETE FROM intentos_ip WHERE ip IN ('$IP_PRUEBA', '$IP_ATACANTE', '$IP_PUBLICA') OR ip LIKE '192.0.2.2%'; DELETE FROM auditoria WHERE ip LIKE '192.0.2.2%' OR operador IN ('operador-bloqueo-automatica', 'operador-sesiones-automatica') OR objeto IN ('operador-bloqueo-automatica', 'operador-sesiones-automatica', 'todas las demás'); DELETE FROM auditoria WHERE operador IN ('$OPERADOR_PRUEBA', '$ADMIN_PRUEBA', 'prueba-direccion-fingida', 'usuario-que-no-existe', '$MARCA_ANTIGUA', '$MARCA_RECIENTE') OR ip IN ('$IP_PRUEBA', '$IP_ATACANTE') OR objeto IN ('$IP_ATACANTE', '$IP_PRUEBA') OR objeto = '$ADMIN_PRUEBA' OR objeto IN ('$OPERADOR_PRUEBA', 'Empresa de prueba') OR objeto LIKE '$ROUTER_PRUEBA%' OR objeto LIKE '$USUARIO_PRUEBA%' OR (accion = 'accesos.cambio_masivo' AND operador = '$ADMIN_PRUEBA'); DELETE FROM empresas e WHERE e.nombre IN ('Empresa de prueba', '$EMPRESA_ACCESOS') AND NOT EXISTS (SELECT 1 FROM routers r WHERE r.empresa_id = e.id)" >/dev/null 2>&1

anotar ""
anotar "Evidencia: $EVIDENCIA"
if [ "$FALLOS" -gt 0 ]; then
    anotar "RESULTADO: $FALLOS prueba(s) fallida(s)"
    exit 1
fi
anotar "RESULTADO: todas las pruebas pasan"
