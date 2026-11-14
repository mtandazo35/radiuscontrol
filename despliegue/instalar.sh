#!/usr/bin/env bash
# Instala o actualiza RadiusControl en este servidor. Se ejecuta como root desde
# la carpeta despliegue/ del repositorio.
#
# Variables opcionales:
#   IP_PUBLICA    dirección por la que se llega al servidor (se detecta sola)
#   RED_GESTION   red que puede abrir el panel; si se indica, se abre el 443 en UFW
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
if ! command -v curl >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
    apt-get update -q
    apt-get install -y -q curl ca-certificates jq
fi
if ! command -v docker >/dev/null 2>&1; then
    curl -fsSL https://get.docker.com -o /root/get-docker.sh
    sh /root/get-docker.sh
fi
docker --version
docker compose version

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

echo "== 6. Firewall"
if command -v ufw >/dev/null 2>&1; then
    mkdir -p /root/backups
    tar czf "/root/backups/ufw-antes-radiuscontrol-$(date +%Y%m%d-%H%M%S).tar.gz" /etc/ufw 2>/dev/null
    if [ -n "${RED_GESTION:-}" ]; then
        ufw allow from "$RED_GESTION" to any port 443 proto tcp comment 'Panel RadiusControl'
    else
        echo "sin RED_GESTION: no se cambia el acceso al panel"
    fi
    # Agente que abre 1812/udp solo a las redes de los routers aplicados.
    install -m 0755 "$DIR/firewall/radiuscontrol-firewall.sh" /usr/local/sbin/radiuscontrol-firewall.sh
    install -m 0644 "$DIR/firewall/radiuscontrol-firewall.service" /etc/systemd/system/radiuscontrol-firewall.service
    systemctl daemon-reload
    systemctl enable radiuscontrol-firewall.service >/dev/null 2>&1
    systemctl restart radiuscontrol-firewall.service
    sleep 4
    systemctl is-active radiuscontrol-firewall.service
    ufw status | grep -E '1812|Status'
else
    echo "UFW no está instalado: el agente de firewall no se instala"
fi

echo
echo "Panel:    https://$IP"
echo "Usuario:  admin"
echo "Clave:    en $DIR/secrets/admin_clave"
echo "Pruebas:  ./probar.sh"
