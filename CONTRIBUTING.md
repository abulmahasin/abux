# Berkontribusi ke Abux

Abux dikembangkan oleh ABUL MAHASIN.

Terima kasih sudah tertarik! Panduan singkat:

1. Fork repo, buat branch dari `main` (`fitur/nama-singkat` atau `perbaikan/nama-singkat`).
2. `npm ci` lalu `npm test` dan `npm run check` harus lulus sebelum membuka Pull Request.
3. Tambahkan tes di `test/e2e.js` untuk perilaku baru (server SSH palsu sudah tersedia di sana).
4. Deskripsikan perubahan dan alasannya di PR. Satu PR = satu topik.

## Prinsip yang dijaga
- **Keamanan dulu**: renderer tidak punya akses Node (`contextIsolation`, `sandbox`, CSP ketat). Rahasia (password, passphrase, token) hanya disimpan lewat `safeStorage` dan tidak pernah dikirim ke renderer.
- **Tanpa telemetri** dan tanpa koneksi keluar selain ke server yang dipilih pengguna dan `github.com` untuk fitur GitHub.
- Teks antarmuka berbahasa Indonesia; kode dan komentar boleh Indonesia atau Inggris.
- Jangan menempelkan IP, password, atau kunci asli ke issue, log, atau tes.

## Struktur
`src/main` proses utama (SSH, store, deploy, GitHub) · `src/preload.js` jembatan IPC · `src/renderer` antarmuka · `test` tes end-to-end.
