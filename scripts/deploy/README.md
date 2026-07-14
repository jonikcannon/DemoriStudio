Demori VPS Deployment Kit

This folder includes a low-cost single-VPS deployment setup for this project.

Files
- bootstrap-vps.sh: one-time server bootstrap and app setup
- deploy.sh: repeatable deploy script for updates
- nginx.demori.conf: Nginx site template used by bootstrap
- ecosystem.config.cjs: PM2 process config

Quick start
1) Push this repository to GitHub.
2) Provision an Ubuntu VPS.
3) Copy repo to server, then run:
   sudo bash scripts/deploy/bootstrap-vps.sh demori.studio https://github.com/your-user/demoriPhotos.git hello@demori.studio
4) Edit /var/www/demori/app/.env with real secrets.
5) Restart API:
   pm2 restart demori-api

Deploy updates
- On server:
  bash /var/www/demori/app/scripts/deploy/deploy.sh

Notes
- This app writes uploads, inquiries, and gallery edits to persistent paths under /var/www/demori/data.
- Production env template lives at scripts/deploy/.env.production.template.
- Ensure DNS A record for root and www point to the VPS before TLS step.
- If your default branch is not main, edit deploy.sh accordingly.

Helpful commands
- Generate JWT secret:
   openssl rand -hex 48
- Generate admin password hash:
   node -e "console.log(require('bcryptjs').hashSync('choose-a-strong-password', 12))"
