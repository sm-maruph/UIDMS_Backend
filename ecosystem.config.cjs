// Run from the backend folder: pm2 start ecosystem.config.cjs --only uidms-api
// Node reads the private .env file on each start; keep credentials out of this file.
module.exports = {
  apps: [{
    name: 'uidms-api',
    cwd: __dirname,
    script: './src/server.js',
    interpreter: 'node',
    node_args: ['--env-file=.env'],
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    restart_delay: 3000,
    watch: false,
    kill_timeout: 11000,
    time: true,
  }, {
    name: 'uidms-mail-worker',
    cwd: __dirname,
    script: './scripts/mail-worker.js',
    args: ['--continuous'],
    interpreter: 'node',
    node_args: ['--env-file=.env'],
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    restart_delay: 15000,
    watch: false,
    kill_timeout: 35000,
    time: true,
  }],
};
