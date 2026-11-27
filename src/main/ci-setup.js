'use strict';

const keysLib = require('./keys');
const { generateWorkflow, WORKFLOW_PATH, SECRET_NAMES } = require('./workflow');

/** Baris known_hosts yang di-pin ke host key asli server, diverifikasi terhadap sidik jari TOFU Abux. */
async function pinnedKnownHosts({ ssh, store, sessionId, host }) {
  const id = `${host.hostname}:${host.port}`;
  const known = store.getKnownHost(id);
  if (!known) throw new Error('Host key server belum tersimpan di Abux. Sambungkan ke host ini sekali dulu.');
  const r = await ssh.exec(sessionId, 'cat /etc/ssh/ssh_host_*_key.pub 2>/dev/null');
  const lines = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const l of lines) {
    const [type, b64] = l.split(/\s+/);
    if (!type || !b64 || !/^[A-Za-z0-9+/]+=*$/.test(b64)) continue;
    if (keysLib.sha256Fingerprint(Buffer.from(b64, 'base64')) === known.fingerprint) {
      return `${host.port === 22 ? host.hostname : `[${host.hostname}]:${host.port}`} ${type} ${b64}`;
    }
  }
  throw new Error('Tidak ada host key di /etc/ssh yang cocok dengan sidik jari yang Anda percayai (server memakai tipe key lain, atau izin baca ditolak).');
}

/**
 * Siapkan deploy otomatis: kunci CI baru -> dipasang di server -> secret GitHub -> berkas workflow.
 * Private key CI hanya ada di memori proses ini lalu dikirim ke GitHub; tidak disimpan di Abux.
 * @returns {Promise<{steps: {name:string, ok:boolean, detail?:string}[], yaml:string}>}
 */
async function provisionCi({ ssh, store, github }, o) {
  const yaml = generateWorkflow(o); // validasi dulu sebelum menyentuh server/GitHub
  const host = store.getHostRaw(o.hostId);
  if (!host) throw new Error('Host tidak ditemukan.');
  if (host.jumpHostId) throw new Error('Host ini memakai jump host; runner GitHub tidak bisa menjangkaunya langsung. Gunakan host yang dapat diakses publik.');
  const steps = [];
  const step = async (name, fn) => {
    try { const detail = await fn(); steps.push({ name, ok: true, detail }); } catch (e) { steps.push({ name, ok: false, detail: e.message }); const err = new Error(`${name}: ${e.message}`); err.steps = steps; throw err; }
  };
  let knownHosts; let key;
  await step('Verifikasi host key server', async () => { knownHosts = await pinnedKnownHosts({ ssh, store, sessionId: o.sessionId, host }); return 'Cocok dengan sidik jari tepercaya'; });
  await step('Buat kunci khusus CI', async () => { key = keysLib.generate({ type: 'ed25519', comment: `abux-ci-${o.fullName}` }); return key.fingerprint; });
  await step('Pasang kunci publik di server', async () => { const r = await ssh.installPublicKey(o.sessionId, key.publicKey); return r.added ? 'Ditambahkan ke authorized_keys' : 'Sudah ada'; });
  const secrets = { ABUX_SSH_KEY: key.privateKey, ABUX_KNOWN_HOSTS: knownHosts, ABUX_SSH_HOST: host.hostname, ABUX_SSH_USER: host.username, ABUX_SSH_PORT: String(host.port) };
  for (const n of SECRET_NAMES) await step(`Simpan secret ${n}`, async () => { await github.setRepoSecret(o.fullName, n, secrets[n]); return 'Tersimpan terenkripsi di GitHub'; });
  await step('Commit workflow', async () => {
    const r = await github.putFile(o.fullName, WORKFLOW_PATH, yaml, 'ci: tambah workflow deploy Abux', o.branch);
    return r.updated ? 'Berkas diperbarui' : 'Berkas dibuat';
  });
  return { steps, yaml };
}

module.exports = { provisionCi, pinnedKnownHosts };
