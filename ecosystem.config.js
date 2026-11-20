// PM2 process file for a non-Docker server (Apache in front). Start: pm2 start ecosystem.config.js
// Backend settings live in backend/.env; only the bind addresses are set here.
module.exports = {
  apps: [
    {
      name: 'usdt-api',
      cwd: './backend',
      script: 'dist/main.js',
      env: { NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '4000' },
      max_memory_restart: '1G',
      kill_timeout: 10000, // let in-flight jobs finish on reload
    },
    {
      name: 'usdt-web',
      cwd: './frontend/.next/standalone',
      script: 'server.js',
      env: { NODE_ENV: 'production', HOSTNAME: '127.0.0.1', PORT: '3000' },
      max_memory_restart: '512M',
    },
  ],
};
