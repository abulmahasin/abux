'use strict';

/*
 * Template pipeline deploy. Sengaja berupa data murni (UMD) supaya dipakai UI
 * dan divalidasi oleh tes backend dengan aturan yang sama dengan penyimpanan nyata.
 * Semua perintah bisa diubah di editor pipeline; ini hanya titik awal.
 */
(function (root, factory) {
  const t = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = t;
  else root.DEPLOY_TEMPLATES = t;
})(typeof self !== 'undefined' ? self : this, function () {
  const step = (name, command, continueOnError) => ({ name, command, continueOnError: !!continueOnError });

  return [
    {
      id: 'laravel',
      label: 'Laravel (PHP)',
      cwd: '/var/www/app',
      note: 'Rollback mengembalikan kode ke versi git sebelumnya. Migrasi database TIDAK ikut dibatalkan; tangani manual bila perlu.',
      steps: [
        step('Ambil kode', 'git pull --ff-only'),
        step('Pasang dependensi', 'composer install --no-dev --optimize-autoloader --no-interaction'),
        step('Migrasi database', 'php artisan migrate --force'),
        step('Cache konfigurasi', 'php artisan config:cache && php artisan route:cache && php artisan view:cache'),
        step('Restart queue', 'php artisan queue:restart'),
      ],
      rollbackSteps: [
        step('Kembalikan kode', 'git reset --hard {{PREVIOUS_REF}}'),
        step('Pasang dependensi', 'composer install --no-dev --optimize-autoloader --no-interaction'),
        step('Cache konfigurasi', 'php artisan config:cache && php artisan route:cache && php artisan view:cache'),
        step('Restart queue', 'php artisan queue:restart'),
      ],
    },
    {
      id: 'node-pm2',
      label: 'Node.js + PM2',
      cwd: '/var/www/app',
      note: 'Sesuaikan perintah build dan nama proses PM2 dengan aplikasi Anda.',
      steps: [
        step('Ambil kode', 'git pull --ff-only'),
        step('Pasang dependensi', 'npm ci'),
        step('Build', 'npm run build --if-present'),
        step('Reload PM2', 'pm2 reload all'),
      ],
      rollbackSteps: [
        step('Kembalikan kode', 'git reset --hard {{PREVIOUS_REF}}'),
        step('Pasang dependensi', 'npm ci'),
        step('Build', 'npm run build --if-present'),
        step('Reload PM2', 'pm2 reload all'),
      ],
    },
    {
      id: 'docker-compose',
      label: 'Docker Compose',
      cwd: '/srv/app',
      note: 'Pengguna SSH harus boleh menjalankan docker tanpa sudo (grup docker).',
      steps: [
        step('Ambil kode', 'git pull --ff-only'),
        step('Tarik image', 'docker compose pull'),
        step('Naikkan layanan', 'docker compose up -d --build'),
        step('Status layanan', 'docker compose ps', true),
      ],
      rollbackSteps: [
        step('Kembalikan kode', 'git reset --hard {{PREVIOUS_REF}}'),
        step('Naikkan layanan', 'docker compose up -d --build'),
        step('Status layanan', 'docker compose ps', true),
      ],
    },
  ];
});
