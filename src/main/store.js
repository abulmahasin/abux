'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_SETTINGS = {
  fontSize: 14,
  fontFamily: 'JetBrains Mono, Cascadia Code, Fira Code, Menlo, Consolas, monospace',
  theme: 'midnight',
  cursorStyle: 'block',
  cursorBlink: true,
  scrollback: 10000,
  copyOnSelect: false,
  rightClickPaste: true,
  ctrlCCopiesSelection: true,
  confirmMultilinePaste: true,
  updateRepo: '',
};

class SecureStorageError extends Error {
  constructor() {
    super('Penyimpanan aman OS tidak tersedia, rahasia tidak dapat disimpan.');
    this.code = 'NO_SECURE_STORAGE';
  }
}

/**
 * Penyimpanan JSON lokal. Semua rahasia (password, private key, passphrase,
 * token GitHub) dienkripsi lewat `crypto` yang disuntikkan (Electron safeStorage
 * -> Keychain / DPAPI / libsecret). Renderer tidak pernah menerima rahasia.
 */
class Store {
  /**
   * @param {{filePath: string, crypto: {isAvailable():boolean, encrypt(s:string):Buffer, decrypt(b:Buffer):string}}} opts
   */
  constructor({ filePath, crypto: secure }) {
    this.filePath = filePath;
    this.secure = secure;
    this.data = this._load();
  }

  // ---------- persistence ----------
  _empty() {
    return {
      version: 1,
      hosts: [],
      keys: [],
      snippets: [],
      knownHosts: {},
      settings: {},
      pipelines: [],
      deployRuns: [],
      dbConns: [],
      redisConns: [],
      github: { clientId: '', user: null, tokenEnc: null },
    };
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      return { ...this._empty(), ...JSON.parse(raw) };
    } catch (e) {
      if (e.code !== 'ENOENT') {
        // File rusak: simpan salinan agar tidak hilang, lalu mulai baru.
        try { fs.copyFileSync(this.filePath, this.filePath + '.corrupt-' + Date.now()); } catch (_) { /* abaikan */ }
      }
      return this._empty();
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }

  // ---------- secrets ----------
  _enc(plain) {
    if (!this.secure.isAvailable()) throw new SecureStorageError();
    return 'v1:' + this.secure.encrypt(String(plain)).toString('base64');
  }

  _dec(token) {
    if (!token) return null;
    if (!token.startsWith('v1:')) return null;
    return this.secure.decrypt(Buffer.from(token.slice(3), 'base64'));
  }

  _id() {
    return crypto.randomUUID();
  }

  // ---------- hosts ----------
  _publicHost(h) {
    const { passwordEnc, ...rest } = h;
    return { ...rest, hasPassword: !!passwordEnc };
  }

  listHosts() {
    return this.data.hosts.map((h) => this._publicHost(h));
  }

  getHostRaw(id) {
    return this.data.hosts.find((h) => h.id === id) || null;
  }

  getHostPassword(id) {
    const h = this.getHostRaw(id);
    return h ? this._dec(h.passwordEnc) : null;
  }

  saveHost(input) {
    const hostname = String(input.hostname || '').trim();
    const username = String(input.username || '').trim();
    const port = Number(input.port || 22);
    if (!hostname) throw new Error('Hostname wajib diisi.');
    if (!username) throw new Error('Username wajib diisi.');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port tidak valid.');
    const authType = ['password', 'key', 'agent'].includes(input.authType) ? input.authType : 'password';
    if (authType === 'key' && !input.keyId) throw new Error('Pilih SSH key untuk metode autentikasi key.');
    if (input.jumpHostId && input.jumpHostId === input.id) throw new Error('Jump host tidak boleh host itu sendiri.');

    const existing = input.id ? this.getHostRaw(input.id) : null;
    const host = existing || { id: this._id(), createdAt: Date.now(), passwordEnc: null };
    Object.assign(host, {
      name: String(input.name || '').trim() || hostname,
      group: String(input.group || '').trim(),
      hostname,
      port,
      username,
      authType,
      keyId: authType === 'key' ? input.keyId : null,
      jumpHostId: input.jumpHostId || null,
      startupCommand: String(input.startupCommand || ''),
      color: input.color || '',
      updatedAt: Date.now(),
    });
    if (authType !== 'password') host.passwordEnc = null;
    else if (input.clearPassword) host.passwordEnc = null;
    else if (typeof input.password === 'string' && input.password !== '') host.passwordEnc = this._enc(input.password);

    if (!existing) this.data.hosts.push(host);
    this.save();
    return this._publicHost(host);
  }

  removeHost(id) {
    this.data.hosts = this.data.hosts.filter((h) => h.id !== id);
    for (const h of this.data.hosts) if (h.jumpHostId === id) h.jumpHostId = null;
    const gone = new Set(this.data.pipelines.filter((p) => p.hostId === id).map((p) => p.id));
    this.data.pipelines = this.data.pipelines.filter((p) => p.hostId !== id);
    this.data.deployRuns = this.data.deployRuns.filter((r) => !gone.has(r.pipelineId));
    this.data.dbConns = (this.data.dbConns || []).filter((c) => c.hostId !== id);
    this.data.redisConns = (this.data.redisConns || []).filter((c) => c.hostId !== id);
    this.save();
  }

  // ---------- koneksi database ----------
  _publicDb(c) {
    const { passwordEnc, ...rest } = c;
    return { ...rest, hasPassword: !!passwordEnc };
  }

  listDbConns() {
    return (this.data.dbConns || []).map((c) => this._publicDb(c));
  }

  getDbConnRaw(id) {
    return (this.data.dbConns || []).find((c) => c.id === id) || null;
  }

  getDbPassword(id) {
    const c = this.getDbConnRaw(id);
    return c ? this._dec(c.passwordEnc) : null;
  }

  saveDbConn(input) {
    const name = String(input.name || '').trim();
    if (!name) throw new Error('Nama koneksi wajib diisi.');
    if (name.length > 80) throw new Error('Nama koneksi maksimal 80 karakter.');
    if (!input.hostId || !this.getHostRaw(input.hostId)) throw new Error('Pilih host SSH yang valid.');
    const dbHost = String(input.dbHost || '127.0.0.1').trim();
    if (!dbHost || /\s/.test(dbHost) || dbHost.length > 255) throw new Error('Host database tidak valid.');
    const dbPort = Number(input.dbPort || 3306);
    if (!Number.isInteger(dbPort) || dbPort < 1 || dbPort > 65535) throw new Error('Port database tidak valid.');
    const user = String(input.user || '').trim();
    if (!user) throw new Error('User database wajib diisi.');
    const database = String(input.database || '').trim();
    if (database.length > 128) throw new Error('Nama database terlalu panjang.');

    if (!this.data.dbConns) this.data.dbConns = [];
    const existing = input.id ? this.getDbConnRaw(input.id) : null;
    const c = existing || { id: this._id(), createdAt: Date.now(), passwordEnc: null };
    Object.assign(c, {
      name, hostId: input.hostId, dbHost, dbPort, user, database,
      readOnly: input.readOnly !== false,
      emptyPassword: !!input.emptyPassword,
      updatedAt: Date.now(),
    });
    if (input.clearPassword || c.emptyPassword) c.passwordEnc = null;
    else if (typeof input.password === 'string' && input.password !== '') c.passwordEnc = this._enc(input.password);
    if (!existing) this.data.dbConns.push(c);
    this.save();
    return this._publicDb(c);
  }

  removeDbConn(id) {
    this.data.dbConns = (this.data.dbConns || []).filter((c) => c.id !== id);
    this.save();
  }

  // ---------- koneksi Redis ----------
  _publicRedis(c) { const { passwordEnc, ...rest } = c; return { ...rest, hasPassword: !!passwordEnc }; }
  listRedisConns() { return (this.data.redisConns || []).map((c) => this._publicRedis(c)); }
  getRedisConnRaw(id) { return (this.data.redisConns || []).find((c) => c.id === id) || null; }
  getRedisPassword(id) { const c = this.getRedisConnRaw(id); return c ? this._dec(c.passwordEnc) : null; }
  saveRedisConn(input) {
    const name = String(input.name || '').trim();
    if (!name || name.length > 80) throw new Error('Nama koneksi wajib diisi (maks 80 karakter).');
    if (!input.hostId || !this.getHostRaw(input.hostId)) throw new Error('Pilih host SSH yang valid.');
    const redisHost = String(input.redisHost || '127.0.0.1').trim();
    if (!redisHost || /\s/.test(redisHost) || redisHost.length > 255) throw new Error('Host Redis tidak valid.');
    const redisPort = Number(input.redisPort || 6379);
    if (!Number.isInteger(redisPort) || redisPort < 1 || redisPort > 65535) throw new Error('Port Redis tidak valid.');
    const dbIndex = Number(input.dbIndex || 0);
    if (!Number.isInteger(dbIndex) || dbIndex < 0 || dbIndex > 255) throw new Error('Nomor database Redis harus 0-255.');
    if (!this.data.redisConns) this.data.redisConns = [];
    const existing = input.id ? this.getRedisConnRaw(input.id) : null;
    const c = existing || { id: this._id(), createdAt: Date.now(), passwordEnc: null };
    Object.assign(c, { name, hostId: input.hostId, redisHost, redisPort, dbIndex, readOnly: input.readOnly !== false, updatedAt: Date.now() });
    if (input.clearPassword) c.passwordEnc = null;
    else if (typeof input.password === 'string' && input.password !== '') c.passwordEnc = this._enc(input.password);
    if (!existing) this.data.redisConns.push(c);
    this.save();
    return this._publicRedis(c);
  }
  removeRedisConn(id) { this.data.redisConns = (this.data.redisConns || []).filter((c) => c.id !== id); this.save(); }

  // ---------- pipelines (deploy) ----------
  _cleanSteps(list, label, required, allowRef) {
    if (!Array.isArray(list)) list = [];
    if (required && list.length === 0) throw new Error(`Tambahkan minimal satu ${label}.`);
    if (list.length > 30) throw new Error(`Maksimal 30 ${label}.`);
    return list.map((raw, i) => {
      const command = String((raw && raw.command) || '').trim();
      const name = String((raw && raw.name) || '').trim() || `Langkah ${i + 1}`;
      if (!command) throw new Error(`${label[0].toUpperCase() + label.slice(1)} ${i + 1}: perintah kosong.`);
      if (command.length > 2000) throw new Error(`${label[0].toUpperCase() + label.slice(1)} ${i + 1}: perintah terlalu panjang (maks 2000 karakter).`);
      if (command.includes('\0')) throw new Error(`${label[0].toUpperCase() + label.slice(1)} ${i + 1}: karakter tidak valid.`);
      if (name.length > 80) throw new Error(`${label[0].toUpperCase() + label.slice(1)} ${i + 1}: nama maksimal 80 karakter.`);
      if (!allowRef && command.includes('{{PREVIOUS_REF}}')) throw new Error('{{PREVIOUS_REF}} hanya boleh dipakai pada langkah rollback.');
      return { id: (raw && raw.id) || this._id(), name, command, continueOnError: !!(raw && raw.continueOnError) };
    });
  }

  listPipelines() {
    return this.data.pipelines;
  }

  getPipeline(id) {
    return this.data.pipelines.find((p) => p.id === id) || null;
  }

  savePipeline(input) {
    const name = String(input.name || '').trim();
    if (!name || name.length > 80) throw new Error('Nama pipeline wajib diisi (maksimal 80 karakter).');
    if (!this.getHostRaw(input.hostId)) throw new Error('Pilih host tujuan.');
    const cwd = String(input.cwd || '').trim();
    if (!cwd || cwd.length > 500 || /[\0\r\n]/.test(cwd)) throw new Error('Folder kerja wajib diisi dengan path server yang valid.');
    if (!(cwd.startsWith('/') || cwd === '~' || cwd.startsWith('~/'))) throw new Error('Folder kerja harus path absolut (diawali / atau ~/).');
    const steps = this._cleanSteps(input.steps, 'langkah deploy', true, false);
    const rollbackSteps = this._cleanSteps(input.rollbackSteps, 'langkah rollback', false, true);
    const existing = input.id ? this.getPipeline(input.id) : null;
    const p = existing || { id: this._id(), createdAt: Date.now() };
    Object.assign(p, { name, hostId: input.hostId, cwd, steps, rollbackSteps, captureRef: input.captureRef !== false, updatedAt: Date.now() });
    if (!existing) this.data.pipelines.push(p);
    this.save();
    return p;
  }

  removePipeline(id) {
    this.data.pipelines = this.data.pipelines.filter((p) => p.id !== id);
    this.data.deployRuns = this.data.deployRuns.filter((r) => r.pipelineId !== id);
    this.save();
  }

  // ---------- riwayat deploy ----------
  addRun(run) {
    this.data.deployRuns.push(run);
    if (this.data.deployRuns.length > 100) this.data.deployRuns = this.data.deployRuns.slice(-100);
    this.save();
  }

  getRun(id) {
    return this.data.deployRuns.find((r) => r.id === id) || null;
  }

  listRuns(pipelineId) {
    return this.data.deployRuns
      .filter((r) => !pipelineId || r.pipelineId === pipelineId)
      .map(({ steps, ...r }) => ({ ...r, steps: steps.map(({ output, ...s }) => s) }))
      .reverse();
  }

  // ---------- keys ----------
  _publicKey(k) {
    const { privateEnc, passphraseEnc, ...rest } = k;
    return { ...rest, hasStoredPassphrase: !!passphraseEnc };
  }

  listKeys() {
    return this.data.keys.map((k) => this._publicKey(k));
  }

  addKey({ name, type, publicKey, fingerprint, privateKey, passphrase, encrypted, remember }) {
    if (!privateKey) throw new Error('Private key kosong.');
    const key = {
      id: this._id(),
      name: String(name || '').trim() || 'key-' + Date.now(),
      type,
      publicKey,
      fingerprint,
      encrypted: !!encrypted,
      privateEnc: this._enc(privateKey),
      passphraseEnc: encrypted && remember && passphrase ? this._enc(passphrase) : null,
      createdAt: Date.now(),
    };
    this.data.keys.push(key);
    this.save();
    return this._publicKey(key);
  }

  getKeyPrivate(id) {
    const k = this.data.keys.find((x) => x.id === id);
    if (!k) return null;
    return {
      privateKey: this._dec(k.privateEnc),
      passphrase: this._dec(k.passphraseEnc),
      encrypted: k.encrypted,
    };
  }

  getKeyPublic(id) {
    const k = this.data.keys.find((x) => x.id === id);
    return k ? k.publicKey : null;
  }

  removeKey(id) {
    const used = this.data.hosts.filter((h) => h.keyId === id).map((h) => h.name);
    if (used.length) throw new Error('Key masih dipakai oleh host: ' + used.join(', '));
    this.data.keys = this.data.keys.filter((k) => k.id !== id);
    this.save();
  }

  // ---------- snippets ----------
  listSnippets() {
    return this.data.snippets;
  }

  saveSnippet(input) {
    const name = String(input.name || '').trim();
    const command = String(input.command || '');
    if (!name || !command.trim()) throw new Error('Nama dan perintah snippet wajib diisi.');
    let s = input.id ? this.data.snippets.find((x) => x.id === input.id) : null;
    if (!s) {
      s = { id: this._id() };
      this.data.snippets.push(s);
    }
    Object.assign(s, { name, command, autoRun: !!input.autoRun });
    this.save();
    return s;
  }

  removeSnippet(id) {
    this.data.snippets = this.data.snippets.filter((s) => s.id !== id);
    this.save();
  }

  // ---------- settings ----------
  getSettings() {
    return { ...DEFAULT_SETTINGS, ...this.data.settings };
  }

  setSettings(partial) {
    const next = { ...this.data.settings };
    for (const [k, v] of Object.entries(partial || {})) {
      if (k in DEFAULT_SETTINGS && typeof v === typeof DEFAULT_SETTINGS[k]) next[k] = v;
    }
    this.data.settings = next;
    this.save();
    return this.getSettings();
  }

  // ---------- known hosts ----------
  getKnownHost(id) {
    return this.data.knownHosts[id] || null;
  }

  addKnownHost(id, entry) {
    this.data.knownHosts[id] = entry;
    this.save();
  }

  removeKnownHost(id) {
    delete this.data.knownHosts[id];
    this.save();
  }

  listKnownHosts() {
    return Object.entries(this.data.knownHosts).map(([id, v]) => ({ id, ...v }));
  }

  // ---------- github ----------
  getGithub() {
    const g = this.data.github;
    return { clientId: g.clientId || '', user: g.user || null, loggedIn: !!g.tokenEnc };
  }

  setGithubClientId(clientId) {
    this.data.github.clientId = String(clientId || '').trim();
    this.save();
  }

  setGithubAuth({ token, user }) {
    this.data.github.tokenEnc = this._enc(token);
    this.data.github.user = user;
    this.save();
  }

  getGithubToken() {
    return this._dec(this.data.github.tokenEnc);
  }

  clearGithubAuth() {
    this.data.github.tokenEnc = null;
    this.data.github.user = null;
    this.save();
  }
}

module.exports = { Store, DEFAULT_SETTINGS, SecureStorageError };
