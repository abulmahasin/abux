'use strict';

const crypto = require('crypto');
const fs = require('fs');
const posix = require('path').posix;
const { Client } = require('ssh2');
const { sha256Fingerprint, isValidPublicKey } = require('./keys');

class AppError extends Error {
  constructor(message, code, extra) {
    super(message);
    this.code = code;
    Object.assign(this, extra || {});
  }
}

const needSecret = (kind, label) =>
  new AppError(kind === 'password' ? 'Password diperlukan.' : 'Passphrase key diperlukan.', 'NEEDS_SECRET', { kind, label });

class SSHManager {
  /**
   * @param {{store: import('./store').Store, emit: (channel: string, payload: any) => void, hostKeyTimeoutMs?: number}} opts
   */
  constructor({ store, emit, hostKeyTimeoutMs = 120000 }) {
    this.store = store;
    this.emit = emit;
    this._closeListeners = [];
    this.hostKeyTimeoutMs = hostKeyTimeoutMs;
    this.sessions = new Map();
    this.prompts = new Map();
  }

  // ---------- host key (TOFU) ----------
  answerHostKey(promptId, accepted) {
    const p = this.prompts.get(promptId);
    if (p) {
      this.prompts.delete(promptId);
      clearTimeout(p.timer);
      p.resolve(!!accepted);
    }
  }

  _verifier(hostname, port, label, state) {
    return (key, verify) => {
      const fp = sha256Fingerprint(key);
      const id = `${hostname}:${port}`;
      const known = this.store.getKnownHost(id);
      if (known) {
        if (known.fingerprint === fp) return verify(true);
        state.reason = new AppError(
          `PERINGATAN: host key ${id} berubah! Kemungkinan server diganti atau ada serangan man-in-the-middle.\n` +
            `Tersimpan: ${known.fingerprint}\nDiterima: ${fp}\n` +
            'Jika perubahan ini sah, hapus entri di Pengaturan > Known hosts lalu sambungkan ulang.',
          'HOSTKEY_CHANGED'
        );
        return verify(false);
      }
      const promptId = crypto.randomUUID();
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.prompts.delete(promptId);
          resolve(false);
        }, this.hostKeyTimeoutMs);
        this.prompts.set(promptId, { resolve, timer });
        this.emit('ssh:hostkey-prompt', { promptId, host: hostname, port, label, fingerprint: fp });
      }).then((accepted) => {
        if (accepted) {
          this.store.addKnownHost(id, { fingerprint: fp, addedAt: Date.now() });
          verify(true);
        } else {
          state.reason = new AppError('Host key ditolak.', 'HOSTKEY_REJECTED');
          verify(false);
        }
      });
    };
  }

  // ---------- connection ----------
  _buildCfg(host, secrets = {}) {
    const cfg = {
      host: host.hostname,
      port: host.port || 22,
      username: host.username,
      readyTimeout: 20000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 4,
      tryKeyboard: true,
    };
    if (host.authType === 'password') {
      const pw = secrets.password != null && secrets.password !== '' ? secrets.password : this.store.getHostPassword(host.id);
      if (!pw) throw needSecret('password', host.name);
      cfg.password = pw;
    } else if (host.authType === 'key') {
      const k = host.keyId ? this.store.getKeyPrivate(host.keyId) : null;
      if (!k || !k.privateKey) throw new AppError('SSH key untuk host ini tidak ditemukan di vault.', 'NO_KEY');
      cfg.privateKey = k.privateKey;
      const pass = secrets.passphrase || k.passphrase;
      if (k.encrypted && !pass) throw needSecret('passphrase', host.name);
      if (pass) cfg.passphrase = pass;
    } else if (host.authType === 'agent') {
      const agent = process.platform === 'win32' ? 'pageant' : process.env.SSH_AUTH_SOCK;
      if (!agent) throw new AppError('SSH agent tidak berjalan (SSH_AUTH_SOCK kosong).', 'NO_AGENT');
      cfg.agent = agent;
    }
    return cfg;
  }

  _openClient(host, cfg, sock, verifierOverride) {
    const client = new Client();
    const state = { reason: null };
    return new Promise((resolve, reject) => {
      client.once('ready', () => resolve(client));
      client.once('error', (e) => {
        client.end();
        reject(state.reason || e);
      });
      client.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => {
        finish(prompts.map(() => cfg.password || ''));
      });
      client.connect({
        ...cfg,
        ...(sock ? { sock } : {}),
        hostVerifier: verifierOverride ? verifierOverride(state) : this._verifier(cfg.host, cfg.port, host.name, state),
      });
    });
  }

  /**
   * Uji koneksi dari isian form (belum disimpan). Tidak membuka shell, tidak menyimpan
   * host key, dan tidak mengubah data apa pun. Selalu mengembalikan hasil terstruktur
   * kecuali bila rahasia (password/passphrase) masih diperlukan (NEEDS_SECRET).
   */
  async testConnection(input, secrets = {}) {
    const hostname = String((input && input.hostname) || '').trim();
    const username = String((input && input.username) || '').trim();
    const port = Number((input && input.port) || 22);
    if (!hostname) return { ok: false, stage: 'input', message: 'Isi hostname / IP terlebih dahulu.' };
    if (!username) return { ok: false, stage: 'input', message: 'Isi username terlebih dahulu.' };
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, stage: 'input', message: 'Port tidak valid (1-65535).' };
    const authType = ['password', 'key', 'agent'].includes(input.authType) ? input.authType : 'password';
    const host = {
      id: input.id || null,
      name: String(input.name || hostname),
      hostname,
      port,
      username,
      authType,
      keyId: input.keyId || null,
      jumpHostId: input.jumpHostId || null,
    };

    const target = `${hostname}:${port}`;
    const started = Date.now();
    let fingerprint = null;
    let known = false;
    const verifier = (state) => (key, verify) => {
      fingerprint = sha256Fingerprint(key);
      const saved = this.store.getKnownHost(target);
      known = !!saved;
      if (saved && saved.fingerprint !== fingerprint) {
        state.reason = new AppError(
          `Host key ${target} berbeda dari yang tersimpan (kemungkinan server diganti atau ada serangan man-in-the-middle).\n` +
            `Tersimpan: ${saved.fingerprint}\nDiterima: ${fingerprint}`,
          'HOSTKEY_CHANGED'
        );
        return verify(false);
      }
      verify(true); // hanya untuk tes; tidak disimpan
    };

    let cfg;
    try {
      cfg = this._buildCfg(host, secrets);
    } catch (e) {
      if (e.code === 'NEEDS_SECRET') throw e;
      return { ok: false, stage: 'config', code: e.code, message: e.message };
    }
    cfg.readyTimeout = 10000;

    let jump = null;
    let sock = null;
    let client = null;
    try {
      if (host.jumpHostId) {
        const jh = this.store.getHostRaw(host.jumpHostId);
        if (!jh) return { ok: false, stage: 'config', message: 'Jump host tidak ditemukan.' };
        const jcfg = this._buildCfg(jh);
        jcfg.readyTimeout = 10000;
        jump = await this._openClient(jh, jcfg, null, verifier);
        sock = await new Promise((res, rej) => jump.forwardOut('127.0.0.1', 0, hostname, port, (e, s) => (e ? rej(e) : res(s))));
      }
      client = await this._openClient(host, cfg, sock, verifier);
      return { ok: true, fingerprint, known, latencyMs: Date.now() - started, message: 'Koneksi berhasil.' };
    } catch (e) {
      if (e && e.code === 'NEEDS_SECRET') throw e;
      const f = this._friendly(e);
      let message = f.message;
      if (f.code === 'TIMEOUT') message = `Waktu koneksi habis ke ${target}. Periksa IP, port (${port}), firewall, dan pastikan server menyala.`;
      else if (f.code === 'REFUSED') message = `Koneksi ditolak oleh ${target}. Port ${port} tertutup atau layanan SSH tidak berjalan di port itu.`;
      else if (f.code === 'DNS') message = `Hostname "${hostname}" tidak ditemukan.`;
      return { ok: false, stage: fingerprint ? 'auth' : 'connect', code: f.code, message, fingerprint };
    } finally {
      try { if (client) client.end(); } catch (_) { /* abaikan */ }
      try { if (jump) jump.end(); } catch (_) { /* abaikan */ }
    }
  }

  /**
   * Membuka sesi shell interaktif. Resolve setelah shell siap.
   */
  async connect({ sessionId, hostId, cols = 80, rows = 24, secrets = {} }) {
    const host = this.store.getHostRaw(hostId);
    if (!host) throw new AppError('Host tidak ditemukan.', 'NO_HOST');
    if (this.sessions.has(sessionId)) throw new AppError('Sesi sudah ada.', 'DUP');

    const cfg = this._buildCfg(host, secrets);
    let jump = null;
    let sock = null;
    let client;
    try {
      if (host.jumpHostId) {
        const jh = this.store.getHostRaw(host.jumpHostId);
        if (!jh) throw new AppError('Jump host tidak ditemukan.', 'NO_HOST');
        jump = await this._openClient(jh, this._buildCfg(jh));
        sock = await new Promise((res, rej) =>
          jump.forwardOut('127.0.0.1', 0, host.hostname, host.port || 22, (e, s) => (e ? rej(e) : res(s)))
        );
      }
      client = await this._openClient(host, cfg, sock);
    } catch (e) {
      if (jump) jump.end();
      throw this._friendly(e);
    }

    let stream;
    try {
      stream = await new Promise((res, rej) =>
        client.shell({ term: 'xterm-256color', cols, rows }, (e, s) => (e ? rej(e) : res(s)))
      );
    } catch (e) {
      client.end();
      if (jump) jump.end();
      throw this._friendly(e);
    }

    const session = { id: sessionId, hostId, client, jump, stream, sftp: null, closed: false };
    this.sessions.set(sessionId, session);

    const finish = (reason) => {
      if (session.closed) return;
      session.closed = true;
      this.sessions.delete(sessionId);
      try { client.end(); } catch (_) { /* abaikan */ }
      if (jump) { try { jump.end(); } catch (_) { /* abaikan */ } }
      this.emit('ssh:closed', { sessionId, reason });
      for (const fn of this._closeListeners) { try { fn(sessionId, reason); } catch (_) { /* abaikan */ } }
    };
    session.finish = finish;

    stream.on('data', (d) => this.emit('ssh:data', { sessionId, data: d }));
    stream.stderr.on('data', (d) => this.emit('ssh:data', { sessionId, data: d }));
    stream.on('close', () => finish('Sesi berakhir.'));
    client.on('error', (e) => finish('Koneksi terputus: ' + e.message));
    client.on('close', () => finish('Koneksi ditutup.'));
    client.on('end', () => finish('Koneksi ditutup oleh server.'));
    if (jump) jump.on('close', () => finish('Jump host terputus.'));

    if (host.startupCommand && host.startupCommand.trim()) stream.write(host.startupCommand.replace(/\r?\n$/, '') + '\n');
    return { sessionId };
  }

  _friendly(e) {
    if (e instanceof AppError) return e;
    const m = e && e.message ? e.message : String(e);
    if (/All configured authentication methods failed/i.test(m)) return new AppError('Autentikasi gagal. Periksa username, password, atau key.', 'AUTH_FAILED');
    if (/ENOTFOUND|EAI_AGAIN/.test(m)) return new AppError('Hostname tidak ditemukan. Periksa alamat server.', 'DNS');
    if (/ECONNREFUSED/.test(m)) return new AppError('Koneksi ditolak. Pastikan SSH berjalan dan port benar.', 'REFUSED');
    if (/Timed out|ETIMEDOUT/i.test(m)) return new AppError('Waktu koneksi habis. Server tidak merespons.', 'TIMEOUT');
    if (/Cannot parse privateKey|passphrase/i.test(m)) return new AppError('Private key tidak dapat dibaca atau passphrase salah.', 'BAD_KEY');
    return new AppError(m, 'SSH_ERROR');
  }

  /** Daftarkan callback yang dipanggil saat sesi SSH ditutup. */
  onSessionClosed(fn) { this._closeListeners.push(fn); }

  /** Buka terowongan TCP dari server ke host:port (mis. MySQL di 127.0.0.1:3306). */
  forwardOut(sessionId, host, port) {
    const s = this._get(sessionId);
    return new Promise((resolve, reject) => {
      s.client.forwardOut('127.0.0.1', 0, host, port, (e, stream) => (e ? reject(e) : resolve(stream)));
    });
  }

  _get(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s || s.closed) throw new AppError('Sesi tidak aktif.', 'NO_SESSION');
    return s;
  }

  write(sessionId, data) {
    const s = this.sessions.get(sessionId);
    if (s && !s.closed) s.stream.write(data);
  }

  resize(sessionId, cols, rows) {
    const s = this.sessions.get(sessionId);
    if (s && !s.closed && cols > 0 && rows > 0) s.stream.setWindow(rows, cols, 0, 0);
  }

  close(sessionId) {
    const s = this.sessions.get(sessionId);
    if (s) s.finish('Ditutup oleh pengguna.');
  }

  closeAll() {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }

  // ---------- exec ----------
  exec(sessionId, command) {
    const s = this._get(sessionId);
    return new Promise((resolve, reject) => {
      s.client.exec(command, (err, stream) => {
        if (err) return reject(this._friendly(err));
        let stdout = '';
        let stderr = '';
        stream.on('data', (d) => { stdout += d; });
        stream.stderr.on('data', (d) => { stderr += d; });
        stream.on('close', (code) => resolve({ code, stdout, stderr }));
      });
    });
  }

  /**
   * Jalankan perintah dengan output streaming (untuk deploy). Memakai PTY agar pembatalan
   * (Ctrl+C) benar-benar menghentikan proses di server. Selalu resolve; tidak pernah reject
   * kecuali sesi tidak aktif / channel gagal dibuka.
   * @returns {{promise: Promise<{code:number|null, signal:string|null, canceled:boolean, timedOut:boolean, disconnected:boolean}>, cancel: () => void}}
   */
  execStream(sessionId, command, { onData, timeoutMs = 0 } = {}) {
    const s = this._get(sessionId);
    let stream = null;
    let timer = null;
    let canceled = false;
    let timedOut = false;
    let disconnected = false;
    let done = false;
    let resolveFn;
    const promise = new Promise((resolve, reject) => {
      resolveFn = resolve;
      const settle = (r) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        s.client.removeListener('close', onClientClose);
        resolve({ canceled, timedOut, disconnected, ...r });
      };
      const onClientClose = () => { disconnected = true; settle({ code: null, signal: null }); };
      s.client.once('close', onClientClose);
      s.client.exec(command, { pty: { term: 'dumb', cols: 120, rows: 40 } }, (err, st) => {
        if (err) { done = true; s.client.removeListener('close', onClientClose); return reject(this._friendly(err)); }
        stream = st;
        st.on('data', (d) => onData && onData(d.toString('utf8').replace(/\r\n/g, '\n')));
        st.on('close', (code, signal) => settle({ code: code == null ? null : code, signal: signal || null }));
        if (canceled) kill();
        else if (timeoutMs > 0) timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
      });
    });
    function kill() {
      if (!stream) return;
      try { stream.write('\x03'); } catch (_) { /* abaikan */ }
      setTimeout(() => { try { stream.close(); } catch (_) { /* abaikan */ } }, 1500);
    }
    return { promise, cancel: () => { canceled = true; kill(); } };
  }

  /** Pasang public key ke ~/.ssh/authorized_keys server (idempoten). */
  async installPublicKey(sessionId, publicKey) {
    const pub = String(publicKey || '').trim();
    if (!isValidPublicKey(pub)) throw new AppError('Format public key tidak valid.', 'BAD_PUBKEY');
    const cmd =
      'umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys && ' +
      `(grep -qxF '${pub}' ~/.ssh/authorized_keys && echo __EXISTS__ || (printf '%s\\n' '${pub}' >> ~/.ssh/authorized_keys && echo __ADDED__))`;
    const r = await this.exec(sessionId, cmd);
    if (r.code !== 0) throw new AppError('Gagal memasang key: ' + (r.stderr.trim() || 'kode ' + r.code), 'INSTALL_FAILED');
    return { added: r.stdout.includes('__ADDED__'), existed: r.stdout.includes('__EXISTS__') };
  }

  // ---------- SFTP ----------
  async _sftp(sessionId) {
    const s = this._get(sessionId);
    if (s.sftp) return s.sftp;
    s.sftp = await new Promise((res, rej) => s.client.sftp((e, sftp) => (e ? rej(this._friendly(e)) : res(sftp))));
    s.sftp.on('close', () => { s.sftp = null; });
    return s.sftp;
  }

  async sftpHome(sessionId) {
    const sftp = await this._sftp(sessionId);
    return new Promise((res, rej) => sftp.realpath('.', (e, p) => (e ? rej(this._friendly(e)) : res(p))));
  }

  async sftpList(sessionId, dir) {
    const sftp = await this._sftp(sessionId);
    const target = String(dir || '.');
    const resolved = await new Promise((res, rej) => sftp.realpath(target, (e, p) => (e ? rej(this._friendly(e)) : res(p))));
    const list = await new Promise((res, rej) => sftp.readdir(resolved, (e, l) => (e ? rej(this._friendly(e)) : res(l))));
    const entries = list
      .filter((i) => i.filename !== '.' && i.filename !== '..')
      .map((i) => ({
        name: i.filename,
        size: i.attrs.size,
        mtime: (i.attrs.mtime || 0) * 1000,
        mode: i.attrs.mode,
        isDir: typeof i.attrs.isDirectory === 'function' ? i.attrs.isDirectory() : (i.attrs.mode & 0o170000) === 0o040000,
        isLink: typeof i.attrs.isSymbolicLink === 'function' ? i.attrs.isSymbolicLink() : (i.attrs.mode & 0o170000) === 0o120000,
      }))
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    return { path: resolved, entries };
  }

  /** Baca berkas teks (UTF-8) untuk editor. Menolak berkas biner/terlalu besar. */
  async sftpReadText(sessionId, remotePath, maxBytes = 2 * 1024 * 1024) {
    const sftp = await this._sftp(sessionId);
    const st = await new Promise((res, rej) => sftp.stat(remotePath, (e, a) => (e ? rej(this._friendly(e)) : res(a))));
    if (st.size > maxBytes) throw new AppError(`Berkas ${(st.size / 1048576).toFixed(1)} MB terlalu besar untuk editor (maks ${(maxBytes / 1048576).toFixed(0)} MB). Unduh saja.`, 'TOO_BIG');
    const buf = await new Promise((res, rej) => sftp.readFile(remotePath, (e, b) => (e ? rej(this._friendly(e)) : res(b))));
    const text = buf.toString('utf8');
    if (buf.includes(0) || !Buffer.from(text, 'utf8').equals(buf)) throw new AppError('Berkas ini bukan teks UTF-8 (biner), tidak dapat dibuka di editor.', 'BINARY');
    return { content: text, mtime: st.mtime, size: buf.length, mode: st.mode };
  }

  /** Simpan berkas teks. Jika mtime di server berubah sejak dibuka, tolak (CONFLICT) kecuali overwrite. */
  async sftpWriteText(sessionId, remotePath, content, { expectedMtime, overwrite = false } = {}) {
    const sftp = await this._sftp(sessionId);
    if (!overwrite && expectedMtime != null) {
      const st = await new Promise((res) => sftp.stat(remotePath, (e, a) => res(e ? null : a)));
      if (st && st.mtime !== expectedMtime) throw new AppError('Berkas di server berubah sejak Anda membukanya. Muat ulang, atau timpa dengan sengaja.', 'CONFLICT');
    }
    const buf = Buffer.from(String(content), 'utf8');
    if (buf.length > 4 * 1024 * 1024) throw new AppError('Isi terlalu besar.', 'TOO_BIG');
    await new Promise((res, rej) => sftp.writeFile(remotePath, buf, { flag: 'w' }, (e) => (e ? rej(this._friendly(e)) : res())));
    const st = await new Promise((res) => sftp.stat(remotePath, (e, a) => res(e ? null : a)));
    return { mtime: st ? st.mtime : null, size: buf.length };
  }

  async sftpMkdir(sessionId, p) {
    const sftp = await this._sftp(sessionId);
    return new Promise((res, rej) => sftp.mkdir(p, (e) => (e ? rej(this._friendly(e)) : res(true))));
  }

  async sftpRename(sessionId, from, to) {
    const sftp = await this._sftp(sessionId);
    return new Promise((res, rej) => sftp.rename(from, to, (e) => (e ? rej(this._friendly(e)) : res(true))));
  }

  async sftpRemove(sessionId, p, isDir) {
    const sftp = await this._sftp(sessionId);
    if (['/', '', '.', '..'].includes(posix.normalize(p))) throw new AppError('Path tidak boleh dihapus.', 'FORBIDDEN');
    const rmFile = (f) => new Promise((res, rej) => sftp.unlink(f, (e) => (e ? rej(this._friendly(e)) : res())));
    const rmDir = (d) => new Promise((res, rej) => sftp.rmdir(d, (e) => (e ? rej(this._friendly(e)) : res())));
    const walk = async (dir) => {
      const list = await new Promise((res, rej) => sftp.readdir(dir, (e, l) => (e ? rej(this._friendly(e)) : res(l))));
      for (const i of list) {
        if (i.filename === '.' || i.filename === '..') continue;
        const full = posix.join(dir, i.filename);
        const isD = (i.attrs.mode & 0o170000) === 0o040000;
        if (isD) await walk(full);
        else await rmFile(full);
      }
      await rmDir(dir);
    };
    if (isDir) await walk(p);
    else await rmFile(p);
    return true;
  }

  async sftpDownload(sessionId, remotePath, localPath) {
    const sftp = await this._sftp(sessionId);
    const name = posix.basename(remotePath);
    return new Promise((res, rej) =>
      sftp.fastGet(
        remotePath,
        localPath,
        { step: (transferred, _c, total) => this.emit('sftp:progress', { sessionId, name, transferred, total }) },
        (e) => (e ? rej(this._friendly(e)) : res(true))
      )
    );
  }

  async sftpUpload(sessionId, localPath, remoteDir) {
    const sftp = await this._sftp(sessionId);
    const name = require('path').basename(localPath);
    const remote = posix.join(remoteDir, name);
    if (!fs.statSync(localPath).isFile()) throw new AppError('Hanya file yang dapat diunggah.', 'NOT_FILE');
    return new Promise((res, rej) =>
      sftp.fastPut(
        localPath,
        remote,
        { step: (transferred, _c, total) => this.emit('sftp:progress', { sessionId, name, transferred, total }) },
        (e) => (e ? rej(this._friendly(e)) : res(true))
      )
    );
  }
}

module.exports = { SSHManager, AppError };
