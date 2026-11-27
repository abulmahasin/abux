# Changelog

Semua perubahan penting pada Abux dicatat di sini.

## 1.1.0

- Deploy otomatis saat `git push` lewat GitHub Actions (tes dulu, lalu deploy via SSH; kunci CI khusus, host key dipin, secret terenkripsi).
- Panel Server: monitor CPU/RAM/disk/beban + proses, Docker (container, compose, log langsung), penampil log Laravel/Nginx/sistem dengan filter level dan pencarian.
- Editor berkas SFTP dengan deteksi konflik.
- Panel Redis (SCAN, nilai per tipe, konsol, mode hanya baca).
- Cadangan/impor pengaturan (opsional terenkripsi) dan pemeriksa pembaruan rilis GitHub.
- Izin GitHub `workflow` ditambahkan; login ulang diperlukan untuk fitur deploy otomatis.

## 1.0.0

Rilis pertama oleh ABUL MAHASIN.

- Terminal bertab dengan salin/tempel, pencarian, dan tema.
- Manajer host: uji koneksi, grup, warna tab, jump host, verifikasi host key.
- Vault SSH key (Ed25519/RSA), impor key, pasang public key ke server.
- SFTP: jelajah, unggah, unduh, buat folder, ganti nama, hapus.
- Integrasi GitHub (Device Flow): repo, clone, SSH key akun, deploy key.
- Deploy: pipeline, template Laravel / Node + PM2 / Docker Compose, progres beranimasi, batal, riwayat, rollback.
- Database MySQL/MariaDB lewat terowongan SSH: penjelajah tabel, edit data, struktur, editor SQL, ekspor, mode hanya baca.
- Menu Bantuan dengan tutorial lengkap (F1).
- Installer macOS, CI GitHub Actions, workflow rilis otomatis.
