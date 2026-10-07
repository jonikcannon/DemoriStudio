#!/usr/bin/env bash
set -euo pipefail

# Set up the LAN print share: a Samba folder every device on the home network
# can open with one shared login, plus an inbox that auto-unpacks downloaded
# 3D models (see print-inbox-extract.py).
#
#   Windows : \\<server-ip>\prints   (map it as a drive; tick "remember")
#   macOS   : smb://<server-ip>/prints
#   phones  : any SMB file app, same address
#
# Run ON the server, from the app checkout:
#   sudo bash scripts/deploy/setup-print-share.sh
# It asks for the share password (or reads SMB_PASSWORD / ~/.prints-smb-pass).
#
# Not reachable from the internet: Samba only answers LAN_CIDR, UFW only opens
# its ports to LAN_CIDR, and the Cloudflare Tunnel only routes to nginx.
#
# Idempotent: re-running updates the config, password, and units in place.

SHARE_DIR="${SHARE_DIR:-/srv/prints}"
SHARE_NAME="${SHARE_NAME:-prints}"
SMB_USER="${SMB_USER:-prints}"
LAN_CIDR="${LAN_CIDR:-192.168.4.0/24}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHARE_CONF="/etc/samba/${SHARE_NAME}-share.conf"
EXTRACTOR="/usr/local/bin/print-inbox-extract"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo." >&2
  exit 1
fi
# The admin who ran sudo also gets group access to the files over SSH.
ADMIN_USER="${SUDO_USER:-}"

# Password: env var, then a mode-600 file, then an interactive prompt. Never a
# command-line argument, where it would land in shell history.
PASS_FILE="$(getent passwd "${ADMIN_USER:-root}" | cut -d: -f6)/.prints-smb-pass"
if [[ -z "${SMB_PASSWORD:-}" && -r "${PASS_FILE}" ]]; then
  SMB_PASSWORD="$(tr -d '\r\n' < "${PASS_FILE}")"
fi
if [[ -z "${SMB_PASSWORD:-}" ]]; then
  read -r -s -p "Password for the '${SMB_USER}' share login: " SMB_PASSWORD; echo
  read -r -s -p "Repeat it: " CONFIRM; echo
  [[ "${SMB_PASSWORD}" == "${CONFIRM}" ]] || { echo "Passwords don't match." >&2; exit 1; }
fi
[[ ${#SMB_PASSWORD} -ge 8 ]] || { echo "Use at least 8 characters." >&2; exit 1; }

echo "==> Installing Samba and network discovery"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq samba python3 >/dev/null
# wsdd makes the server show up under "Network" in Windows Explorer. Optional:
# the \\<ip>\prints address works without it. On Ubuntu the systemd service
# ships in wsdd-server; plain "wsdd" is only the program.
apt-get install -y -qq wsdd-server >/dev/null 2>&1 || apt-get install -y -qq wsdd2 >/dev/null 2>&1 \
  || echo "    (no wsdd package available; use \\\\<server-ip>\\${SHARE_NAME} directly)"

echo "==> Creating the '${SMB_USER}' account (no shell, Samba-only)"
getent group "${SMB_USER}" >/dev/null || groupadd --system "${SMB_USER}"
if ! id "${SMB_USER}" >/dev/null 2>&1; then
  useradd --system --gid "${SMB_USER}" --no-create-home --home-dir "${SHARE_DIR}" \
          --shell /usr/sbin/nologin "${SMB_USER}"
fi
[[ -n "${ADMIN_USER}" ]] && usermod -aG "${SMB_USER}" "${ADMIN_USER}"
printf '%s\n%s\n' "${SMB_PASSWORD}" "${SMB_PASSWORD}" | smbpasswd -s -a "${SMB_USER}" >/dev/null
smbpasswd -e "${SMB_USER}" >/dev/null

echo "==> Preparing ${SHARE_DIR}"
install -d -o "${SMB_USER}" -g "${SMB_USER}" -m 2775 \
  "${SHARE_DIR}" "${SHARE_DIR}/_inbox" "${SHARE_DIR}/_processed" "${SHARE_DIR}/_failed"

echo "==> Writing ${SHARE_CONF}"
cat > "${SHARE_CONF}" <<EOF
# Managed by scripts/deploy/setup-print-share.sh -- edits are overwritten.
[${SHARE_NAME}]
   comment = 3D print files
   path = ${SHARE_DIR}
   browseable = yes
   read only = no
   guest ok = no
   valid users = ${SMB_USER}
   force user = ${SMB_USER}
   force group = ${SMB_USER}
   create mask = 0664
   directory mask = 2775
   hosts allow = ${LAN_CIDR} 127.0.0.1
   hosts deny = 0.0.0.0/0
   # Windows/macOS junk files that would otherwise trigger the inbox.
   veto files = /._*/.DS_Store/Thumbs.db/desktop.ini/
   delete veto files = yes
EOF
# Ubuntu's smb.conf has no include directory, so append one include line
# (once) after the stock shares.
grep -qxF "include = ${SHARE_CONF}" /etc/samba/smb.conf \
  || printf '\ninclude = %s\n' "${SHARE_CONF}" >> /etc/samba/smb.conf
# Directory leases let Windows cache a folder listing until Samba says it
# changed -- but Samba never sees folders the inbox extractor creates directly
# on disk, so unpacked models stayed invisible in Explorer. It's a global-only
# setting, hence [global] rather than the share section.
grep -qE '^\s*smb3 directory leases\s*=' /etc/samba/smb.conf \
  || sed -i '/^\[global\]/a\   smb3 directory leases = no' /etc/samba/smb.conf
testparm -s >/dev/null 2>&1 || { testparm -s; echo "smb.conf is invalid." >&2; exit 1; }

echo "==> Installing the inbox extractor"
install -m 755 "${SCRIPT_DIR}/print-inbox-extract.py" "${EXTRACTOR}"
cat > /etc/systemd/system/prints-inbox.service <<EOF
[Unit]
Description=Unpack 3D model downloads in ${SHARE_DIR}/_inbox

[Service]
Type=oneshot
User=${SMB_USER}
Group=${SMB_USER}
UMask=0002
Environment=PRINT_SHARE_DIR=${SHARE_DIR}
ExecStart=${EXTRACTOR}
# Only the share is writable; everything else on the server is read-only.
ProtectSystem=strict
ReadWritePaths=${SHARE_DIR}
ProtectHome=yes
PrivateTmp=yes
NoNewPrivileges=yes
EOF
cat > /etc/systemd/system/prints-inbox.path <<EOF
[Unit]
Description=Watch ${SHARE_DIR}/_inbox for new downloads

[Path]
PathChanged=${SHARE_DIR}/_inbox
Unit=prints-inbox.service

[Install]
WantedBy=multi-user.target
EOF

echo "==> Starting services"
systemctl daemon-reload
systemctl enable --now smbd >/dev/null
systemctl restart smbd
systemctl enable --now prints-inbox.path >/dev/null
for unit in wsdd-server wsdd2 wsdd; do
  systemctl list-unit-files "${unit}.service" >/dev/null 2>&1 && systemctl enable --now "${unit}" >/dev/null 2>&1 || true
done

echo "==> Opening the firewall to ${LAN_CIDR} only"
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow from "${LAN_CIDR}" to any port 445 proto tcp comment 'print share (SMB)' >/dev/null
  ufw allow from "${LAN_CIDR}" to any port 5357 proto tcp comment 'print share discovery (wsdd)' >/dev/null
  ufw allow from "${LAN_CIDR}" to any port 3702 proto udp comment 'print share discovery (wsdd)' >/dev/null
else
  echo "    UFW is not active; nothing to open."
fi

IP="$(hostname -I | awk '{print $1}')"
cat <<EOF

Done. On each device, connect once and save the login:
  Windows : \\\\${IP}\\${SHARE_NAME}
  macOS   : smb://${IP}/${SHARE_NAME}
  user    : ${SMB_USER}
Drop downloaded .zip/.stl/.3mf files into _inbox; unpacked models appear as
folders in the share. Log: ${SHARE_DIR}/_processed/extract.log
EOF
