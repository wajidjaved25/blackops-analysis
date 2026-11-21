# Staging deploy — PM2 + Apache (Virtualmin) + PostgreSQL

Target: `https://analysis.publicvm.com`. Apache terminates HTTPS and proxies everything to the Next.js server (127.0.0.1:3000), which proxies `/api` to the NestJS API (127.0.0.1:4000). Neither port is exposed.

## 1. One-time server prep (as root)
```bash
# Node 22+ (Node 20.12+ minimum; NestJS 11 + process.loadEnvFile)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs   # RHEL: rpm.nodesource.com
npm i -g pm2
a2enmod proxy proxy_http headers && systemctl reload apache2                              # RHEL: modules are on by default
# Redis is optional (cache + rate limits; falls back to memory). Recommended:
apt-get install -y redis-server
```

## 2. Virtualmin
1. Create virtual server `analysis.publicvm.com` (with website + SSL; database optional).
2. **Database:** Edit Databases → create PostgreSQL db `usdt_trace` (or use psql: `CREATE DATABASE usdt_trace OWNER <user>;`). Note the user/password.
3. **SSL:** Server Configuration → SSL Certificate → Let's Encrypt → request for `analysis.publicvm.com`. Do this *before* adding the proxy (or keep the `ProxyPass /.well-known !` line).
4. **Proxy:** Web Configuration → Edit Directives — paste [apache-proxy.conf](apache-proxy.conf) into **both** the port 80 and port 443 vhosts, then Save (Apache reloads). Optionally redirect HTTP→HTTPS: Website Redirects → "Redirect all requests to SSL site".

## 3. App (as the virtual server's user, e.g. `su - analysis`)
```bash
cd ~ && git clone https://github.com/wajidjaved25/blackops-analysis.git app && cd app
cp backend/.env.example backend/.env && nano backend/.env
```
Set in `backend/.env`:
```
DATABASE_URL=postgresql://<dbuser>:<dbpass>@localhost:5432/usdt_trace
TRUST_PROXY=loopback
COOKIE_SECURE=true
ALLOWED_ORIGINS=https://analysis.publicvm.com
APP_SECRET=<output of: openssl rand -hex 32>     # encrypts 2FA secrets — never change after users enrol
UPLOAD_DIR=/home/analysis/app-uploads            # outside the repo; back it up
REDIS_URL=redis://localhost:6379
TRONGRID_API_KEY=<free key from trongrid.io>      # strongly recommended
ETHERSCAN_API_KEY=<key>                           # needed for Ethereum / BNB Chain
SMTP_HOST=localhost                               # Virtualmin's Postfix, or your SMTP relay
SMTP_PORT=25
SMTP_FROM=Tracera <alerts@analysis.publicvm.com>
```
Then:
```bash
bash scripts/deploy.sh          # install, migrate, build, start under PM2
pm2 startup                     # prints one command — run it as root so PM2 starts on boot
pm2 save
```

## 4. First login
Open `https://analysis.publicvm.com/setup` and create the organisation + Owner account (setup only works while there are no users). Then Admin → Organisation: consider "Require 2FA". Label sync (OFAC, Tether, Circle) starts on its own within a few minutes.

## 5. Updates
```bash
cd ~/app && bash scripts/deploy.sh
```

## 6. Checks / troubleshooting
- `pm2 status`, `pm2 logs tracera-api --lines 100`
- `curl -s http://127.0.0.1:4000/api/health` on the server
- Admin → Sessions should show your real IP, not 127.0.0.1 (if it shows 127.0.0.1, `TRUST_PROXY` is wrong).
- 502 from Apache = PM2 app down; 403 "Cross-origin" on login = `ALLOWED_ORIGINS` doesn't match the URL exactly.
- Backups: `pg_dump usdt_trace | gzip > usdt_trace-$(date +%F).sql.gz` daily via cron, plus the `UPLOAD_DIR` folder. (`scripts/backup.sh` is for the Docker stack.)
