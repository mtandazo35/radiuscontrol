#!/usr/bin/env bash
# Instalación rápida de RadiusControl.
#
#   curl -fsSL https://raw.githubusercontent.com/mtandazo35/radiuscontrol/main/install.sh -o /root/install-radiuscontrol.sh && bash /root/install-radiuscontrol.sh
#
# Descarga el repositorio en /root/radiuscontrol y ejecuta su instalador. En un
# servidor que ya lo tiene, lo pone al día y vuelve a ejecutar el instalador,
# que no regenera secretos ni credenciales.
#
# Variables opcionales:
#   RED_GESTION   red que podrá abrir el panel (puerto 443). Si no se indica, el
#                 instalador no abre el panel: lo abre el operador con su regla.
#   RC_DESTINO    carpeta de instalación (por omisión, /root/radiuscontrol)
#   RC_REPO_URL   repositorio de origen
set -euo pipefail

REPO_URL="${RC_REPO_URL:-https://github.com/mtandazo35/radiuscontrol.git}"
DESTINO="${RC_DESTINO:-/root/radiuscontrol}"

decir() { printf '\n== %s\n' "$*"; }
fallar() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fallar "ejecuta este instalador como root."

if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    case "${ID:-}" in
        debian|ubuntu) ;;
        *) echo "Aviso: probado en Debian y Ubuntu; este sistema es ${PRETTY_NAME:-desconocido}." ;;
    esac
fi
command -v apt-get >/dev/null 2>&1 || fallar "hace falta un sistema con apt (Debian o Ubuntu)."

decir "Herramientas básicas"
if ! command -v git >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
    apt-get update -q
    apt-get install -y -q git curl ca-certificates
fi
git --version

decir "Repositorio en $DESTINO"
if [ -d "$DESTINO/.git" ]; then
    if [ -n "$(git -C "$DESTINO" status --porcelain --untracked-files=no)" ]; then
        fallar "hay archivos modificados a mano en $DESTINO. Revísalos antes de actualizar."
    fi
    git -C "$DESTINO" pull --quiet --ff-only
    echo "puesto al día: $(git -C "$DESTINO" rev-parse --short HEAD)"
elif [ -e "$DESTINO" ] && [ -n "$(ls -A "$DESTINO" 2>/dev/null)" ]; then
    fallar "$DESTINO ya existe y no es una copia de git de RadiusControl."
else
    git clone --quiet "$REPO_URL" "$DESTINO"
    echo "descargado: $(git -C "$DESTINO" rev-parse --short HEAD)"
fi

# La seguridad del servidor la decide el operador: sin RED_GESTION, el
# instalador no abre el panel a nadie y lo indica al terminar.
export RED_GESTION="${RED_GESTION:-}"

decir "Instalador"
cd "$DESTINO/despliegue"
exec bash ./instalar.sh
