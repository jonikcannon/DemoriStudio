#!/usr/bin/env bash
set -euo pipefail

# Deploy from a workstation on the same LAN as the server.
#
#   bash scripts/deploy/deploy-remote.sh
#   DEPLOY_TARGET=utctigers@192.168.4.60 bash scripts/deploy/deploy-remote.sh
#   DEPLOY_TARGET=demori bash scripts/deploy/deploy-remote.sh    # via ~/.ssh/config
#   bash scripts/deploy/deploy-remote.sh --restart               # npm run restart
#
# --restart skips the pull, install and build and only restarts the API under
# PM2, then runs the same health check. A flag rather than an env var because
# npm runs scripts through cmd.exe on Windows, where VAR=x cmd does not work.
#
# This is the manual path. It needs no GitHub runner and works today, which
# makes it useful both before the runner is installed and as a fallback when
# CI is unavailable. It runs exactly the same deploy.sh the CI job runs, so the
# two cannot drift apart.
#
# It deploys what is on the server's tracked branch, not your working copy:
# deploy.sh does a git pull. Push your commits first.

DEPLOY_TARGET="${DEPLOY_TARGET:-utctigers@192.168.4.60}"
KEY_NAME="${KEY_NAME:-demori_oracle}"
APP_DIR="${APP_DIR:-/var/www/demori/app}"

# Offer the deploy key explicitly. ssh only tries default key names by default
# (id_rsa, id_ed25519, ...), so a key called demori_oracle is never presented
# unless ~/.ssh/config names it -- which makes the deploy depend on the operator
# having that config. Passing -i here keeps the script self-contained.
DEPLOY_KEY="${DEPLOY_KEY:-$HOME/.ssh/${KEY_NAME}}"
SSH_OPTS=(-o ConnectTimeout=10)
if [[ -f "${DEPLOY_KEY}" ]]; then
  SSH_OPTS+=(-i "${DEPLOY_KEY}" -o IdentitiesOnly=yes)
fi

DEPLOY_FRONTEND="${DEPLOY_FRONTEND:-true}"
RELOAD_NGINX="${RELOAD_NGINX:-true}"
RESTART_ONLY="${RESTART_ONLY:-false}"
if [[ "${1:-}" == "--restart" ]]; then
  RESTART_ONLY=true
fi

ssh_run() {
  ssh "${SSH_OPTS[@]}" "${DEPLOY_TARGET}" "$@"
}

echo "==> Deploying to ${DEPLOY_TARGET}:${APP_DIR}"

check_bootstrapped() {
  ssh_run "test -f '${APP_DIR}/scripts/deploy/deploy.sh'" 2>/dev/null
}

if ! ssh "${SSH_OPTS[@]}" -o BatchMode=yes "${DEPLOY_TARGET}" true 2>/dev/null; then
  cat <<EOF

Cannot log in to ${DEPLOY_TARGET} with a key yet.

Installing the public key is the one step that needs the account password, so
it has to be run interactively, by you, in your own terminal:

  Windows PowerShell (ssh-copy-id does not exist on Windows):
    type \$env:USERPROFILE\\.ssh\\${KEY_NAME}.pub | ssh ${DEPLOY_TARGET} "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"

  macOS / Linux:
    ssh-copy-id -i ~/.ssh/${KEY_NAME}.pub ${DEPLOY_TARGET}

No key yet? Create one first:
    ssh-keygen -t ed25519 -f \$env:USERPROFILE\\.ssh\\${KEY_NAME} -C "deploy to demori"

Then re-run:  npm run deploy

EOF
  exit 1
fi

if ! check_bootstrapped; then
  cat <<EOF

The server has not been bootstrapped yet: ${APP_DIR}/scripts/deploy/deploy.sh does not exist.

Run this ON THE SERVER first. It installs Node, PM2 and Nginx and clones the
app, so it needs root -- which means your password, interactively:

  ssh ${DEPLOY_TARGET}
  git clone https://github.com/jonikcannon/DemoriStudio.git ~/demori-src
  sudo bash ~/demori-src/scripts/deploy/bootstrap-vps.sh demori.studio https://github.com/jonikcannon/DemoriStudio.git you@example.com

Certbot will fail at the end -- Lets Encrypt cannot validate a domain that
points at a private LAN address. That call is guarded, so bootstrap still
completes and the site works over HTTP on the LAN.

Then fill in ${APP_DIR}/.env and re-run:  npm run deploy

EOF
  exit 1
fi

if [[ "${RESTART_ONLY}" == "true" ]]; then
  echo "==> Restarting API (no pull or build)"
  ssh_run "pm2 restart demori-api --update-env"
else
  ssh_run \
    "APP_DIR='${APP_DIR}' DEPLOY_FRONTEND='${DEPLOY_FRONTEND}' RELOAD_NGINX='${RELOAD_NGINX}' bash '${APP_DIR}/scripts/deploy/deploy.sh'"
fi

echo
echo "==> Verifying the API responds"
# Poll rather than check once: right after a restart PM2 reports the process
# online for a few seconds before it has bound :3000.
API_CODE=""
for attempt in $(seq 1 15); do
  API_CODE="$(ssh_run "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/products || true")"
  [[ "${API_CODE}" == "200" ]] && break
  sleep 2
done
if [[ "${API_CODE}" == "200" ]]; then
  echo "    API healthy (HTTP ${API_CODE})"
else
  echo "    API returned HTTP ${API_CODE:-no response}"
  ssh_run "pm2 logs demori-api --lines 30 --nostream" || true
  exit 1
fi

SITE_CODE="$(ssh_run "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/ || true")"
echo "    Site returned HTTP ${SITE_CODE:-no response}"

echo
if [[ "${RESTART_ONLY}" == "true" ]]; then
  echo "Restart complete."
else
  echo "Deploy complete."
fi
