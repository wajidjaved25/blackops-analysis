#!/usr/bin/env bash
# Build and (re)start USDT Trace under PM2. Run on the server from the repo root:  bash scripts/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

git pull --ff-only

cd backend
npm ci
npx prisma generate
npx prisma migrate deploy
npm run build
cd ..

cd frontend
npm ci
API_URL=http://127.0.0.1:4000 npm run build # /api proxy target is baked in at build time; 127.0.0.1 not localhost (may resolve to ::1)
# standalone server needs the static assets copied next to it
cp -r .next/static .next/standalone/.next/
[ -d public ] && cp -r public .next/standalone/
cd ..

pm2 startOrReload ecosystem.config.js --update-env
pm2 save
echo "deployed: $(git log --oneline -1)"
