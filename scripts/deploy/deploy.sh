#!/usr/bin/env bash
set -euo pipefail

# Zero-downtime style deploy for this app.
# Run on server as app user from anywhere:
#   bash /var/www/demori/app/scripts/deploy/deploy.sh

APP_DIR="/var/www/demori/app"

if [[ ! -d "${APP_DIR}" ]]; then
  echo "App directory not found: ${APP_DIR}"
  exit 1
fi

cd "${APP_DIR}"

echo "==> Pulling latest code"
git fetch --all --prune
git pull --ff-only

echo "==> Installing dependencies"
npm ci

echo "==> Building frontend"
npm run build

echo "==> Restarting API"
pm2 reload demori-api --update-env

echo "==> Reloading Nginx"
sudo systemctl reload nginx

echo "Deploy complete"
