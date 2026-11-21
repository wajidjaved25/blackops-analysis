// PM2 process file for a non-Docker server (Apache in front). Start: pm2 start ecosystem.config.js
// Backend settings live in backend/.env; only bind addresses/ports are set here.
// Ports: WEB_PORT / API_PORT in the shell env (deploy.sh reads them from deploy.env if present).
const WEB = process.env.WEB_PORT || '3000';
const API = process.env.API_PORT || '4000';
module.exports = {
  apps: [
    {
      name: 'tracera-api',
      cwd: './backend',
      script: 'dist/main.js',
      env: { NODE_ENV: 'production', HOST: '127.0.0.1', PORT: API },
      max_memory_restart: '1G',
      kill_timeout: 10000, // let in-flight jobs finish on reload
    },
    {
      name: 'tracera-web',
      cwd: './frontend/.next/standalone',
      script: 'server.js',
      env: { NODE_ENV: 'production', HOSTNAME: '127.0.0.1', PORT: WEB },
      max_memory_restart: '512M',
    },
  ],
};
