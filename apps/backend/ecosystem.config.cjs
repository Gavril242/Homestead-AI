module.exports = {
  apps: [
    {
      name: 'gavirila-backend',
      script: './src/server.js',
      interpreter: 'node',
      interpreter_args: '--experimental-sqlite --import tsx/esm',
      cwd: __dirname,
      watch: false,               // Manual reload only — not file watch
      max_memory_restart: '800M', // Ryzen laptop safety net
      env: {
        NODE_ENV: 'production',
        PORT: 8765,
      },
      env_development: {
        NODE_ENV: 'development',
      },
      // Graceful reload: PM2 waits for new process to respond before killing old one
      wait_ready: true,
      listen_timeout: 15000,
      kill_timeout: 5000,
      instances: 1,
      autorestart: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
