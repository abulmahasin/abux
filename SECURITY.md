# Kebijakan Keamanan

Aplikasi ini menangani kredensial server, jadi laporan keamanan sangat kami hargai.

**Jangan membuka issue publik untuk celah keamanan.** Gunakan *Security → Report a vulnerability* (GitHub private vulnerability reporting) di repo ini. Sertakan langkah reproduksi dan versi yang terdampak. Kami berusaha menanggapi dalam 7 hari.

## Model keamanan singkat
- Password, passphrase, private key, dan token GitHub dienkripsi dengan `safeStorage` OS (Keychain di macOS) dan tidak pernah sampai ke proses renderer.
- Host key diverifikasi dengan TOFU; perubahan sidik jari memblokir koneksi.
- Perintah deploy dijalankan di server dengan quoting aman; langkah yang ditulis pengguna dieksekusi apa adanya di server milik pengguna, jadi periksa pipeline sebelum menjalankannya.
