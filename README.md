# Abux

Klien SSH desktop profesional untuk mengelola server Anda sendiri: terminal, SFTP, GitHub, Deploy beranimasi, dan pengelola database. Dibangun dengan Electron, ssh2, dan xterm.js.

**Developer:** ABUL MAHASIN · **Lisensi:** [MIT](LICENSE)

## Fitur

- **Terminal tabbed** (xterm.js, 256 warna, scrollback, cari teks, tautan bisa diklik)
- **Salin & tempel lengkap**
  - Windows/Linux: `Ctrl+Shift+C` salin, `Ctrl+C` menyalin bila ada seleksi (tanpa seleksi tetap SIGINT), `Ctrl+V` / `Ctrl+Shift+V` / `Shift+Insert` tempel
  - macOS: `⌘C` / `⌘V`
  - Klik kanan: salin jika ada seleksi, selain itu tempel (`Shift`+klik kanan membuka menu)
  - Konfirmasi saat menempel teks multi-baris (bisa dimatikan)
- **Host manager**: tombol **Uji koneksi** di form (cek IP, port, login sebelum disimpan), grup, warna tab (mis. merah untuk produksi), duplikat, perintah awal, jump host (ProxyJump)
- **Autentikasi**: password, SSH key (dengan passphrase), SSH agent
- **Vault SSH key**: buat Ed25519/RSA, impor key lama, pasang public key ke server dengan satu klik
- **SFTP**: jelajah, unggah, unduh, buat folder, ganti nama, hapus
- **GitHub**: login Device Flow (tanpa menyimpan password), daftar repo, `git clone` ke terminal aktif, tambah SSH key akun, tambah deploy key per repo
- **Deploy (CI/CD mini)**: pipeline per host dengan template Laravel, Node + PM2, dan Docker Compose. Progres tiap langkah beranimasi (spinner, centang, log langsung), berhenti di langkah yang gagal, bisa dibatalkan, riwayat 100 run terakhir, dan **rollback** ke versi git sebelum deploy. Host bertanda merah (produksi) meminta Anda mengetik nama host dulu.
- **Database (MySQL/MariaDB)**: koneksi lewat terowongan SSH (port database tidak perlu dibuka), penjelajah tabel, edit data langsung di grid, struktur tabel, editor SQL dengan riwayat, ekspor CSV/JSON. Mode **hanya baca** per koneksi, konfirmasi untuk `DELETE`/`UPDATE` tanpa `WHERE`, `DROP`, dan `TRUNCATE`.
- **Deploy otomatis saat `git push`**: Abux membuat workflow GitHub Actions (tes dulu, deploy ke server lewat SSH bila lulus), membuat kunci CI khusus, memasangnya di server, dan menyimpan secret terenkripsi di GitHub. Host key server dipin, tanpa `StrictHostKeyChecking=no`.
- **Server**: pemantau CPU/RAM/disk/beban dengan grafik dan daftar proses; panel **Docker** (daftar container, start/stop/restart, log langsung, `docker compose` per proyek); **penampil log** Laravel/Nginx/syslog/journalctl dengan pencarian, filter level, dan mode live.
- **Editor berkas SFTP**: ubah berkas teks di server langsung dari panel berkas, dengan deteksi konflik.
- **Redis**: jelajah key (SCAN), nilai per tipe, konsol; mode hanya baca; perintah berbahaya diblokir.
- **Cadangan & sinkronisasi**: ekspor/impor pengaturan (opsional dienkripsi passphrase), tanpa rahasia.
- **Cek pembaruan**: memeriksa rilis terbaru di GitHub dan menawarkan unduhan (pemasangan manual selama aplikasi belum ditandatangani Apple).
- **Bantuan**: tutorial lengkap beserta contoh di dalam aplikasi (ikon `?` atau tombol `F1`), dengan daftar isi dan pencarian.
- **Snippet**: simpan perintah favorit, kirim ke terminal dengan satu klik
- **Keamanan**
  - Password, private key, passphrase, dan token GitHub dienkripsi dengan Keychain (macOS) / DPAPI (Windows) / libsecret (Linux) lewat `safeStorage`
  - Renderer terisolasi (`contextIsolation`, `sandbox`, CSP ketat) dan tidak pernah menerima rahasia
  - Verifikasi host key ala TOFU, dengan **peringatan keras bila host key berubah**

## Menjalankan

```bash
npm install
npm start
```

Butuh Node.js 18+.

## Membuat installer

```bash
./scripts/build-mac.sh   # macOS: .dmg + .zip sesuai chip Anda (Apple Silicon / Intel)
npm run dist:win         # .exe (NSIS)
npm run dist:linux       # AppImage + deb
```

Hasil ada di folder `dist/`. `.dmg` hanya bisa dibuat di macOS. Rilis otomatis: push tag `v*` dan workflow **Release** mengunggah installer macOS/Windows/Linux ke GitHub Releases.

### Membuka di macOS (aplikasi belum ditandatangani Apple)

Karena belum memakai Apple Developer ID, macOS akan menolak saat pertama dibuka. Cara membukanya: seret Abux ke **Applications**, klik kanan → **Open** → **Open**. Atau lewat Terminal:

```bash
xattr -cr /Applications/Abux.app
```

Jika muncul "app is damaged" pada Apple Silicon: `codesign --force --deep --sign - /Applications/Abux.app`.

## Menyiapkan login GitHub

1. Buka https://github.com/settings/developers, lalu **New OAuth App**.
2. Isi nama bebas dan Homepage URL bebas. Callback URL boleh `http://localhost`.
3. Setelah dibuat, centang **Enable Device Flow**.
4. Salin **Client ID** (bukan secret) ke panel GitHub di Abux, lalu klik **Masuk dengan GitHub**.
5. Masukkan kode yang tampil di halaman GitHub yang terbuka.

Scope yang diminta: `repo`, `read:user`, `admin:public_key`, `workflow` (untuk membuat berkas workflow deploy otomatis).

## Alur umum: deploy dari GitHub ke server

1. Panel **SSH Keys** → buat key baru.
2. Sambungkan ke server, lalu klik ikon unggah pada key untuk memasangnya ke `authorized_keys`. Setelah itu ubah autentikasi host menjadi **SSH Key**.
3. Untuk repo privat: panel **GitHub** → ikon kunci pada repo → **Tambah deploy key**. Key yang sama bisa dipakai di server.
4. Ikon terminal pada repo mengetik `git clone git@github.com:...` di sesi aktif.

## Catatan Linux

Tanpa keyring (gnome-keyring / kwallet), Electron hanya menyamarkan rahasia, bukan mengenkripsinya. Abux menampilkan peringatan di sidebar dan, bila penyimpanan aman benar-benar tidak tersedia, menolak menyimpan rahasia (Anda diminta memasukkan password setiap koneksi).

## Pengujian

```bash
npm run check   # sintaks semua berkas JS
npm test        # e2e + database (MariaDB/MySQL sungguhan bila ada di PATH) + server (monitor, Docker shim, log, SFTP editor, workflow, backup, Redis sungguhan bila ada)
```

Tes berjalan terhadap server SSH tiruan: vault, TOFU host key, deteksi host key berubah, autentikasi, shell, exec, SFTP, jump host, uji koneksi, alur GitHub, dan seluruh mesin deploy (sukses, gagal, batal, timeout, rollback, riwayat).

## Struktur

```
src/main/        proses utama: store (vault), keys, ssh-manager, github, deploy, db-manager, redis-*, server-tools, workflow, ci-setup, backup, updater, IPC
src/preload.js   jembatan terbatas ke renderer
src/renderer/    UI (index.html, styles.css, ui.js, app.js, deploy.js, templates.js, db.js, server.js, redis.js, editor.js, cicd.js, logview.js, help.js, help-content.js)
test/e2e.js      tes backend
test/db.js       tes database (MariaDB asli)
test/server.js   tes fitur server, CI, backup, Redis
build/           ikon aplikasi
scripts/         build-mac.sh, check.js
.github/         CI, release, Dependabot, template issue/PR
```

## Kontribusi & lisensi

Lihat [CONTRIBUTING.md](CONTRIBUTING.md) dan [SECURITY.md](SECURITY.md). Dikembangkan oleh **ABUL MAHASIN**. Lisensi [MIT](LICENSE), Copyright (c) 2026 Abul Mahasin.
