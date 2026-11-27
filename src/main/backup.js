'use strict';

const crypto = require('crypto');

const FORMAT = 'abux-backup';
const VERSION = 1;
const MAX_BYTES = 8 * 1024 * 1024;

const pick = (o, keys) => { const r = {}; for (const k of keys) if (o[k] !== undefined) r[k] = o[k]; return r; };
const HOST_KEYS = ['id', 'name', 'group', 'hostname', 'port', 'username', 'authType', 'keyId', 'jumpHostId', 'startupCommand', 'color', 'createdAt'];
const DB_KEYS = ['id', 'name', 'hostId', 'dbHost', 'dbPort', 'user', 'database', 'readOnly', 'emptyPassword', 'createdAt'];
const PIPE_KEYS = ['id', 'name', 'hostId', 'cwd', 'steps', 'rollbackSteps', 'captureRef', 'createdAt'];

/**
 * Bangun cadangan. Rahasia (password, private key, passphrase, token GitHub) TIDAK PERNAH ikut:
 * di-enkripsi dengan kunci OS yang terikat ke mesin ini, jadi tidak berguna di mesin lain.
 */
function buildBackup(store) {
  const d = store.data;
  return {
    format: FORMAT, version: VERSION, createdAt: new Date().toISOString(),
    data: {
      hosts: d.hosts.map((h) => pick(h, HOST_KEYS)),
      snippets: d.snippets.map((s) => pick(s, ['id', 'name', 'command', 'autoRun'])),
      pipelines: d.pipelines.map((p) => pick(p, PIPE_KEYS)),
      dbConns: (d.dbConns || []).map((c) => pick(c, DB_KEYS)),
      settings: store.getSettings(),
      knownHosts: d.knownHosts,
    },
  };
}

function encryptBackup(obj, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(String(passphrase), salt, 32);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return JSON.stringify({ format: FORMAT, version: VERSION, encrypted: true, kdf: 'scrypt', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: ct.toString('base64') }, null, 2);
}

function serialize(store, passphrase) {
  const b = buildBackup(store);
  return passphrase ? encryptBackup(b, passphrase) : JSON.stringify(b, null, 2);
}

function parseBackup(text, passphrase) {
  if (Buffer.byteLength(String(text)) > MAX_BYTES) throw new Error('Berkas cadangan terlalu besar.');
  let j;
  try { j = JSON.parse(text); } catch (_) { throw new Error('Berkas bukan cadangan Abux yang valid (bukan JSON).'); }
  if (!j || j.format !== FORMAT) throw new Error('Berkas bukan cadangan Abux.');
  if (j.version > VERSION) throw new Error('Cadangan dibuat oleh versi Abux yang lebih baru. Perbarui aplikasi dulu.');
  if (j.encrypted) {
    if (!passphrase) { const e = new Error('Cadangan ini terenkripsi, masukkan passphrase.'); e.code = 'NEEDS_PASSPHRASE'; throw e; }
    try {
      const key = crypto.scryptSync(String(passphrase), Buffer.from(j.salt, 'base64'), 32);
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(j.iv, 'base64'));
      d.setAuthTag(Buffer.from(j.tag, 'base64'));
      const pt = Buffer.concat([d.update(Buffer.from(j.data, 'base64')), d.final()]).toString('utf8');
      j = JSON.parse(pt);
    } catch (_) { const e = new Error('Passphrase salah atau berkas rusak.'); e.code = 'BAD_PASSPHRASE'; throw e; }
  }
  if (!j.data || typeof j.data !== 'object') throw new Error('Isi cadangan tidak valid.');
  return j;
}

/**
 * Gabungkan cadangan ke store. Item dengan id yang sudah ada dilewati (tidak menimpa data lokal).
 * Referensi ke key yang tidak ada dibersihkan. Mengembalikan jumlah yang ditambahkan/dilewati.
 */
function applyBackup(store, backup) {
  const d = store.data;
  const b = backup.data;
  const arr = (x) => (Array.isArray(x) ? x : []);
  const res = { hosts: 0, snippets: 0, pipelines: 0, dbConns: 0, skipped: 0, settings: false };
  const str = (v, n = 500) => String(v == null ? '' : v).slice(0, n);

  for (const h of arr(b.hosts)) {
    if (!h || typeof h.id !== 'string' || d.hosts.some((x) => x.id === h.id)) { res.skipped++; continue; }
    const port = Number(h.port || 22);
    if (!str(h.hostname) || !str(h.username) || !Number.isInteger(port) || port < 1 || port > 65535) { res.skipped++; continue; }
    const keyOk = h.keyId && d.keys.some((k) => k.id === h.keyId);
    let authType = ['password', 'key', 'agent'].includes(h.authType) ? h.authType : 'password';
    if (authType === 'key' && !keyOk) authType = 'password';
    d.hosts.push({
      id: h.id, name: str(h.name, 120) || str(h.hostname), group: str(h.group, 80), hostname: str(h.hostname, 255), port, username: str(h.username, 128),
      authType, keyId: authType === 'key' ? h.keyId : null, jumpHostId: null, _jump: typeof h.jumpHostId === 'string' ? h.jumpHostId : null,
      startupCommand: str(h.startupCommand, 2000), color: str(h.color, 20), passwordEnc: null, createdAt: Number(h.createdAt) || Date.now(), updatedAt: Date.now(),
    });
    res.hosts++;
  }
  for (const h of d.hosts) {
    if (h._jump !== undefined) {
      if (h._jump && h._jump !== h.id && d.hosts.some((x) => x.id === h._jump)) h.jumpHostId = h._jump;
      delete h._jump;
    }
  }
  for (const s of arr(b.snippets)) {
    if (!s || typeof s.id !== 'string' || d.snippets.some((x) => x.id === s.id) || !str(s.name) || !str(s.command, 20000).trim()) { res.skipped++; continue; }
    d.snippets.push({ id: s.id, name: str(s.name, 120), command: str(s.command, 20000), autoRun: !!s.autoRun });
    res.snippets++;
  }
  for (const p of arr(b.pipelines)) {
    if (!p || typeof p.id !== 'string' || d.pipelines.some((x) => x.id === p.id) || !d.hosts.some((x) => x.id === p.hostId)) { res.skipped++; continue; }
    try {
      const steps = store._cleanSteps(p.steps, 'langkah deploy', true, false);
      const rollbackSteps = store._cleanSteps(p.rollbackSteps, 'langkah rollback', false, true);
      const cwd = str(p.cwd);
      if (!(cwd.startsWith('/') || cwd === '~' || cwd.startsWith('~/')) || /[\0\r\n]/.test(cwd)) throw new Error('cwd');
      d.pipelines.push({ id: p.id, name: str(p.name, 80) || 'Pipeline', hostId: p.hostId, cwd, steps, rollbackSteps, captureRef: p.captureRef !== false, createdAt: Number(p.createdAt) || Date.now(), updatedAt: Date.now() });
      res.pipelines++;
    } catch (_) { res.skipped++; }
  }
  if (!d.dbConns) d.dbConns = [];
  for (const c of arr(b.dbConns)) {
    const port = Number(c && c.dbPort);
    if (!c || typeof c.id !== 'string' || d.dbConns.some((x) => x.id === c.id) || !d.hosts.some((x) => x.id === c.hostId) || !str(c.user) || !Number.isInteger(port) || port < 1 || port > 65535) { res.skipped++; continue; }
    d.dbConns.push({ id: c.id, name: str(c.name, 80) || 'Database', hostId: c.hostId, dbHost: str(c.dbHost, 255) || '127.0.0.1', dbPort: port, user: str(c.user, 128), database: str(c.database, 128), readOnly: c.readOnly !== false, emptyPassword: !!c.emptyPassword, passwordEnc: null, createdAt: Number(c.createdAt) || Date.now(), updatedAt: Date.now() });
    res.dbConns++;
  }
  if (b.settings && typeof b.settings === 'object') { store.setSettings({ ...store.getSettings(), ...b.settings }); res.settings = true; }
  if (b.knownHosts && typeof b.knownHosts === 'object') {
    for (const [id, v] of Object.entries(b.knownHosts)) {
      if (!d.knownHosts[id] && v && typeof v.fingerprint === 'string' && /^SHA256:[A-Za-z0-9+/]+$/.test(v.fingerprint)) d.knownHosts[id] = { fingerprint: v.fingerprint, addedAt: Number(v.addedAt) || Date.now() };
    }
  }
  store.save();
  return res;
}

module.exports = { buildBackup, serialize, parseBackup, applyBackup };
