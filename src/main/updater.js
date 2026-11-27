'use strict';

const https = require('https');

/** Bandingkan versi semver sederhana (abaikan prerelease). 1 jika a>b, -1 jika a<b. */
function compareVersions(a, b) {
  const p = (v) => String(v).replace(/^v/i, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const x = p(a); const y = p(b);
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1; }
  return 0;
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Pilih aset unduhan yang cocok dengan platform/arsitektur. */
function pickAsset(assets, platform, arch) {
  const list = (assets || []).map((a) => ({ name: String(a.name || ''), url: a.browser_download_url }));
  const has = (re) => list.find((a) => re.test(a.name.toLowerCase()));
  if (platform === 'darwin') return (arch === 'arm64' ? has(/arm64.*\.dmg$/) : has(/(x64|x86_64|intel).*\.dmg$/) || list.find((a) => /\.dmg$/i.test(a.name) && !/arm64/i.test(a.name))) || has(/\.dmg$/) || null;
  if (platform === 'win32') return has(/\.exe$/) || null;
  return has(/\.appimage$/) || has(/\.deb$/) || null;
}

/**
 * Cek rilis terbaru di GitHub. Hanya BERBICARA ke api.github.com dan hanya mengembalikan tautan
 * halaman rilis (https) — tidak mengunduh atau menjalankan apa pun.
 */
async function checkForUpdate({ repo, current, platform, arch, fetchImpl }) {
  if (!REPO_RE.test(String(repo || '')) || /^OWNER\//.test(repo)) {
    const e = new Error('Repositori rilis belum diatur. Isi di Pengaturan > Pembaruan (contoh: akunmu/abux).'); e.code = 'NO_REPO'; throw e;
  }
  const f = fetchImpl || ((...a) => fetch(...a));
  const res = await f(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Abux' } });
  if (res.status === 404) return { upToDate: true, current, latest: null, note: 'Belum ada rilis di repositori ini.' };
  if (!res.ok) throw new Error(`GitHub menjawab ${res.status}.`);
  const rel = await res.json();
  const latest = String(rel.tag_name || '').replace(/^v/i, '');
  if (!latest) throw new Error('Data rilis tidak valid.');
  const newer = compareVersions(latest, current) > 0;
  const asset = newer ? pickAsset(rel.assets, platform, arch) : null;
  const page = typeof rel.html_url === 'string' && rel.html_url.startsWith('https://github.com/') ? rel.html_url : `https://github.com/${repo}/releases/latest`;
  return { upToDate: !newer, current, latest, page, asset: asset && asset.url && asset.url.startsWith('https://github.com/') ? asset : null, notes: String(rel.body || '').slice(0, 4000), publishedAt: rel.published_at || null };
}

module.exports = { compareVersions, pickAsset, checkForUpdate };
