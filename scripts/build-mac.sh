#!/usr/bin/env bash
# Membuat installer macOS (.dmg + .zip). Jalankan di MacBook:  ./scripts/build-mac.sh
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(uname)" == "Darwin" ]] || { echo "Jalankan skrip ini di macOS."; exit 1; }
command -v node >/dev/null || { echo "Node.js belum terpasang. Pasang dari https://nodejs.org (LTS) lalu ulangi."; exit 1; }

case "$(uname -m)" in
  arm64) TARGET="--arm64"; LABEL="Apple Silicon (M1/M2/M3/M4)" ;;
  *)     TARGET="--x64";   LABEL="Intel" ;;
esac
[[ "${1:-}" == "--universal" ]] && { TARGET="--universal"; LABEL="Universal"; }

echo "==> Pasang dependensi"; npm ci
echo "==> Tes";               npm test
echo "==> Bangun installer untuk $LABEL"
npx electron-builder --mac $TARGET --publish never
echo; echo "Selesai. Hasil ada di folder dist/:"; ls -1 dist/*.dmg dist/*.zip 2>/dev/null
echo "Buka .dmg lalu seret Abux ke Applications."
