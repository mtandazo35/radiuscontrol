#!/usr/bin/env bash
# Instala o actualiza RadiusControl en este servidor. Se ejecuta como root desde
# la carpeta despliegue/ del repositorio.
#
# Variables opcionales:
#   IP_PUBLICA    dirección por la que se llega al servidor (se detecta sola)
#   RED_GESTION   red que puede abrir el panel; solo si se indica se abre el 443.
#                 Sin ella, el operador abre el panel con su propia regla.
#   SERVICIOS     servicios de Compose a levantar (por omisión, todos)
#
# Es idempotente: no regenera secretos ni credenciales que ya existan.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

if [ "$(id -u)" -ne 0 ]; then
    echo "Este script se ejecuta como root." >&2
    exit 1
fi

echo "== 1. Dependencias"
if ! command -v curl >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1 || ! command -v git >/dev/null 2>&1; then
    apt-get update -q
    apt-get install -y -q curl ca-certificates jq git
fi
if ! command -v docker >/dev/null 2>&1; then
    curl -fsSL https://get.docker.com -o /root/get-docker.sh
    sh /root/get-docker.sh
fi
docker --version
docker compose version

echo "== 1b. Repositorio"
# Las actualizaciones desde el panel necesitan que esta carpeta sea una copia
# de git del repositorio. Una instalación hecha copiando archivos se convierte
# aquí: los archivos versionados pasan a ser los de la rama principal; los
# secretos y el entorno no están versionados y no se tocan.
RAIZ="$(cd "$DIR/.." && pwd)"
URL_REPO="${RC_REPO_URL:-https://github.com/mtandazo35/radiuscontrol.git}"
# git se niega a trabajar en una carpeta cuyos archivos son de otro usuario.
if [ "$(stat -c %u "$RAIZ")" != "0" ] || [ -n "$(find "$RAIZ" -maxdepth 2 ! -user root -print -quit)" ]; then
    chown -R root:root "$RAIZ"
fi
if ! git -C "$RAIZ" rev-parse HEAD >/dev/null 2>&1; then
    [ -d "$RAIZ/.git" ] || git -C "$RAIZ" init -q -b main
    git -C "$RAIZ" remote get-url origin >/dev/null 2>&1 || git -C "$RAIZ" remote add origin "$URL_REPO"
    git -C "$RAIZ" fetch -q origin main
    git -C "$RAIZ" reset -q --hard origin/main
    git -C "$RAIZ" branch -q --set-upstream-to=origin/main main 2>/dev/null || true
    echo "carpeta convertida en copia de git: $(git -C "$RAIZ" rev-parse --short HEAD)"
else
    echo "versión instalada: $(git -C "$RAIZ" rev-parse --short HEAD)"
fi

echo "== 2. Secretos"
install -d -m 0700 "$DIR/secrets"
crear_secreto() { # <archivo> <comando que lo genera>
    if [ ! -s "$DIR/secrets/$1" ]; then
        ( umask 077; eval "$2" > "$DIR/secrets/$1" )
        echo "generado: secrets/$1"
    else
        echo "se conserva: secrets/$1"
    fi
}
crear_secreto postgres_clave "openssl rand -hex 24"
crear_secreto clave_maestra "openssl rand -base64 32"
crear_secreto admin_clave "openssl rand -hex 12"

echo "== 3. Entorno"
IP="${IP_PUBLICA:-$(ip -4 route get 192.0.2.1 | awk '{for (i = 1; i <= NF; i++) if ($i == "src") print $(i + 1)}')}"
if [ ! -f "$DIR/.env" ]; then
    {
        echo "SITIO=https://$IP"
        echo "SERVIDOR_RADIUS=$IP"
        echo "ADMIN_USUARIO=admin"
    } > "$DIR/.env"
    chmod 0600 "$DIR/.env"
    echo "generado: .env"
else
    echo "se conserva: .env"
fi

echo "== 4. Laboratorio anterior"
if docker ps -a --format '{{.Names}} {{.Label "com.docker.compose.project"}}' \
    | grep -q '^radiuscontrol-freeradius radiuscontrol-lab$'; then
    docker rm -f radiuscontrol-freeradius
    echo "retirado el contenedor del laboratorio"
else
    echo "no hay laboratorio anterior"
fi

echo "== 5. Construcción y arranque"
# shellcheck disable=SC2086
docker compose build ${SERVICIOS:-}
# shellcheck disable=SC2086
docker compose up -d ${SERVICIOS:-}
sleep 4
docker compose ps

# Imágenes sin usar y caché de construcciones anteriores: sin esto acaban
# llenando el disco (8 GB en pocos días de uso). La siguiente construcción
# tarda unos minutos más.
docker image prune -f >/dev/null 2>&1 || true
docker builder prune -af >/dev/null 2>&1 || true

echo "== 6. Firewall"
# El instalador no decide la seguridad del servidor: esas reglas las carga el
# operador. Solo hace lo imprescindible para que RadiusControl funcione:
#   - UFW instalado y activo, porque el puerto RADIUS (1812/udp) se abre y se
#     cierra solo, únicamente para las redes de los routers dados de alta;
#   - el SSH abierto para la conexión desde la que se está instalando, para que
#     activar UFW no deje fuera a quien instala.
# El panel (443) se abre solo si se indica RED_GESTION.
FW_NUEVO=0
if ! command -v ufw >/dev/null 2>&1; then
    apt-get update -q
    apt-get install -y -q ufw
fi
mkdir -p /root/backups
tar czf "/root/backups/ufw-antes-radiuscontrol-$(date +%Y%m%d-%H%M%S).tar.gz" /etc/ufw 2>/dev/null || true
if ufw status | grep -q '^Status: active'; then
    echo "UFW ya estaba activo: no se toca ninguna regla existente"
else
    FW_NUEVO=1
    # La regla de SSH va antes de activar: nunca al revés.
    CONEXION="${SSH_CONNECTION:-}"
    if [ -n "$CONEXION" ]; then
        # SSH_CONNECTION: «IP del cliente, puerto del cliente, IP del servidor, puerto del servidor».
        # shellcheck disable=SC2086
        set -- $CONEXION
        ufw allow from "$1" to any port "$4" proto tcp comment 'SSH de la instalacion'
        echo "SSH abierto solo para $1 (puerto $4)"
    else
        # Sin sesión SSH (instalación por consola) no hay conexión que proteger:
        # se deja el SSH como estaba, abierto, para no cerrarlo por sorpresa.
        ufw allow 22/tcp comment 'SSH'
        echo "instalación por consola: SSH (22) queda abierto como antes; restríngelo con tus reglas"
    fi
    ufw --force enable
fi
if [ -n "${RED_GESTION:-}" ]; then
    ufw allow from "$RED_GESTION" to any port 443 proto tcp comment 'Panel RadiusControl'
fi
# Agente que abre 1812/udp solo a las redes de los routers aplicados.
install -m 0755 "$DIR/firewall/radiuscontrol-firewall.sh" /usr/local/sbin/radiuscontrol-firewall.sh
install -m 0644 "$DIR/firewall/radiuscontrol-firewall.service" /etc/systemd/system/radiuscontrol-firewall.service
systemctl daemon-reload
systemctl enable radiuscontrol-firewall.service >/dev/null 2>&1
systemctl restart radiuscontrol-firewall.service
sleep 4
systemctl is-active radiuscontrol-firewall.service
ufw status | grep -E '1812|Status' || true
PANEL_ABIERTO=0
ufw show added 2>/dev/null | grep -q -E 'port 443 |^ufw allow 443' && PANEL_ABIERTO=1

echo "== 6b. Actualizaciones"
install -m 0755 "$DIR/actualizar/radiuscontrol-actualizar.sh" /usr/local/sbin/radiuscontrol-actualizar.sh
install -m 0644 "$DIR/actualizar/radiuscontrol-actualizar.service" /etc/systemd/system/radiuscontrol-actualizar.service
systemctl daemon-reload
systemctl enable radiuscontrol-actualizar.service >/dev/null 2>&1
systemctl restart radiuscontrol-actualizar.service
sleep 3
systemctl is-active radiuscontrol-actualizar.service

echo "== 7. Contraseña inicial"
# La contraseña inicial solo hace falta en el primer arranque. Después se
# muestra una vez y se borra del disco: en la base queda únicamente su hash.
CLAVE_INICIAL="$(cat "$DIR/secrets/admin_clave")"
if [ "$CLAVE_INICIAL" != "consumida" ]; then
    for _ in $(seq 1 60); do
        docker logs radiuscontrol-api 2>&1 | grep -q "API de RadiusControl escuchando" && break
        sleep 1
    done
    printf 'consumida\n' > "$DIR/secrets/admin_clave"
    echo "retirada del disco"
else
    CLAVE_INICIAL=""
    echo "ya se había retirado"
fi

echo
echo "Panel:    https://$IP"
echo "Usuario:  admin"
if [ -n "$CLAVE_INICIAL" ]; then
    echo "Clave:    $CLAVE_INICIAL"
    echo "          Se muestra solo esta vez. Cámbiala al entrar (Seguridad, Mi cuenta)."
else
    echo "Clave:    la que definiste en el panel."
fi
if [ "$PANEL_ABIERTO" -eq 0 ]; then
    echo
    echo "IMPORTANTE: el firewall todavía no deja entrar a nadie al panel (puerto 443)."
    echo "Ábrelo con tu propia regla, por ejemplo:"
    echo "    ufw allow from <tu red o tu IP> to any port 443 proto tcp"
fi
if [ "$FW_NUEVO" -eq 1 ]; then
    echo
    echo "UFW quedó activo: todo lo que no tenga regla se rechaza. Carga las reglas"
    echo "que necesite tu servidor. Las de 1812/udp las gestiona RadiusControl: no"
    echo "las añadas ni las borres a mano."
fi
echo
echo "Si pierdes el acceso: docker exec radiuscontrol-api radiuscontrol operador-emergencia admin"
echo "Si tu IP queda bloqueada: docker exec radiuscontrol-api radiuscontrol desbloquear-ip todas"
echo "Pruebas:  ./probar.sh"
