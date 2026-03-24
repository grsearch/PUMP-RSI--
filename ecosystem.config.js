module.exports = {
  apps: [
    {
      name:               'rsi-monitor',
      script:             'src/server.js',
      instances:          1,
      autorestart:        true,
      watch:              false,
      max_memory_restart: '512M',
      node_args:          '--max-old-space-size=512',
      env: {
        NODE_ENV: 'production',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file:      'logs/pm2-error.log',
      out_file:        'logs/pm2-out.log',
      merge_logs:      true,
    },
  ],
};
