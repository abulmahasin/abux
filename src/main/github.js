'use strict';

const API = 'https://api.github.com';
const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
// repo: daftar repo privat + deploy key; admin:public_key: tambah SSH key akun.
const SCOPE = 'repo read:user admin:public_key workflow';
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class GitHub {
  /**
   * @param {{store: import('./store').Store, fetchImpl?: typeof fetch, onLoginResult?: (r: any) => void}} opts
   */
  constructor({ store, fetchImpl, onLoginResult }) {
    this.store = store;
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.onLoginResult = onLoginResult || (() => {});
    this.loginToken = 0;
  }

  status() {
    return this.store.getGithub();
  }

  async _json(res) {
    const text = await res.text();
    try { return JSON.parse(text); } catch (_) { return { message: text }; }
  }

  /** Mulai Device Flow. Mengembalikan kode yang harus dimasukkan pengguna di github.com/login/device. */
  async startLogin() {
    const { clientId } = this.store.getGithub();
    if (!clientId) throw new Error('Client ID GitHub belum diisi di panel GitHub.');
    const res = await this.fetch(DEVICE_CODE_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, scope: SCOPE }),
    });
    const data = await this._json(res);
    if (!res.ok || data.error || !data.device_code) {
      throw new Error(data.error_description || data.message || 'Gagal memulai login GitHub. Pastikan Device Flow aktif di OAuth App.');
    }
    const token = ++this.loginToken;
    this._poll(clientId, data, token);
    return {
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      expiresIn: data.expires_in,
    };
  }

  cancelLogin() {
    this.loginToken++;
  }

  async _poll(clientId, dev, token) {
    let interval = Math.max(Number(dev.interval) || 5, 1);
    const deadline = Date.now() + (Number(dev.expires_in) || 900) * 1000;
    while (token === this.loginToken && Date.now() < deadline) {
      await sleep(interval * 1000);
      if (token !== this.loginToken) return;
      let data;
      try {
        const res = await this.fetch(TOKEN_URL, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: clientId,
            device_code: dev.device_code,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          }),
        });
        data = await this._json(res);
      } catch (e) {
        continue; // gangguan jaringan sementara
      }
      if (data.access_token) {
        try {
          const user = await this._userWith(data.access_token);
          this.store.setGithubAuth({ token: data.access_token, user });
          this.onLoginResult({ ok: true, user });
        } catch (e) {
          this.onLoginResult({ ok: false, error: e.message });
        }
        return;
      }
      if (data.error === 'authorization_pending') continue;
      if (data.error === 'slow_down') { interval = Number(data.interval) || interval + 5; continue; }
      const msg = data.error === 'access_denied' ? 'Otorisasi ditolak.' : data.error === 'expired_token' ? 'Kode kedaluwarsa.' : data.error_description || data.error || 'Login gagal.';
      this.onLoginResult({ ok: false, error: msg });
      return;
    }
    if (token === this.loginToken) this.onLoginResult({ ok: false, error: 'Kode kedaluwarsa. Coba login ulang.' });
  }

  async _userWith(token) {
    const res = await this.fetch(API + '/user', { headers: this._headers(token) });
    const data = await this._json(res);
    if (!res.ok) throw new Error(data.message || 'Gagal mengambil profil GitHub.');
    return { login: data.login, name: data.name || '', avatarUrl: data.avatar_url };
  }

  _headers(token) {
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Abux',
      'Content-Type': 'application/json',
    };
  }

  async _api(method, path, body) {
    const token = this.store.getGithubToken();
    if (!token) throw new Error('Belum login ke GitHub.');
    const res = await this.fetch(API + path, {
      method,
      headers: this._headers(token),
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await this._json(res);
    if (res.status === 401) {
      this.store.clearGithubAuth();
      throw new Error('Sesi GitHub kedaluwarsa, silakan login ulang.');
    }
    if (!res.ok) {
      const detail = Array.isArray(data.errors) && data.errors[0] ? ' (' + (data.errors[0].message || data.errors[0].code) + ')' : '';
      throw new Error((data.message || 'Permintaan GitHub gagal') + detail);
    }
    return data;
  }

  logout() {
    this.cancelLogin();
    this.store.clearGithubAuth();
  }

  async repos() {
    const out = [];
    for (let page = 1; page <= 3; page++) {
      const list = await this._api('GET', `/user/repos?per_page=100&sort=pushed&page=${page}&affiliation=owner,collaborator,organization_member`);
      for (const r of list) {
        out.push({
          id: r.id,
          fullName: r.full_name,
          private: r.private,
          description: r.description || '',
          sshUrl: r.ssh_url,
          pushedAt: r.pushed_at,
          admin: !!(r.permissions && r.permissions.admin),
        });
      }
      if (list.length < 100) break;
    }
    return out;
  }

  async addAccountKey(title, key) {
    const r = await this._api('POST', '/user/keys', { title: String(title || 'Abux').slice(0, 100), key });
    return { id: r.id };
  }

  async addDeployKey(fullName, title, key, readOnly = true) {
    if (!REPO_RE.test(fullName) || fullName.split('/').some((p) => p === '.' || p === '..')) {
      throw new Error('Nama repo tidak valid.');
    }
    const r = await this._api('POST', `/repos/${fullName}/keys`, {
      title: String(title || 'Abux').slice(0, 100),
      key,
      read_only: !!readOnly,
    });
    return { id: r.id };
  }
  _checkRepo(fullName) {
    if (!REPO_RE.test(fullName) || fullName.split('/').some((p) => p === '.' || p === '..')) throw new Error('Nama repo tidak valid.');
  }

  /** Simpan secret Actions (dienkripsi sealed-box dengan public key repo, seperti yang diwajibkan GitHub). */
  async setRepoSecret(fullName, name, value) {
    this._checkRepo(fullName);
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) throw new Error('Nama secret tidak valid.');
    const sodium = require('libsodium-wrappers');
    await sodium.ready;
    const pk = await this._api('GET', `/repos/${fullName}/actions/secrets/public-key`);
    const enc = sodium.crypto_box_seal(sodium.from_string(String(value)), sodium.from_base64(pk.key, sodium.base64_variants.ORIGINAL));
    await this._api('PUT', `/repos/${fullName}/actions/secrets/${name}`, {
      encrypted_value: sodium.to_base64(enc, sodium.base64_variants.ORIGINAL),
      key_id: pk.key_id,
    });
  }

  /** Buat/perbarui berkas di repo (dipakai untuk workflow). Butuh scope `workflow` untuk .github/workflows. */
  async putFile(fullName, filePath, content, message, branch) {
    this._checkRepo(fullName);
    if (!/^[\w.\/-]+$/.test(filePath) || filePath.includes('..')) throw new Error('Path berkas tidak valid.');
    const q = branch ? `?ref=${encodeURIComponent(branch)}` : '';
    let sha;
    try {
      const cur = await this._api('GET', `/repos/${fullName}/contents/${filePath}${q}`);
      sha = cur.sha;
    } catch (e) { if (!/not found/i.test(e.message)) throw e; }
    try {
      const r = await this._api('PUT', `/repos/${fullName}/contents/${filePath}`, {
        message, content: Buffer.from(content, 'utf8').toString('base64'), ...(sha ? { sha } : {}), ...(branch ? { branch } : {}),
      });
      return { updated: !!sha, url: r.content && r.content.html_url };
    } catch (e) {
      if (/workflow/i.test(e.message)) throw new Error('Izin "workflow" belum ada pada login GitHub Anda. Keluar lalu login ulang di panel GitHub.');
      throw e;
    }
  }
}

module.exports = { GitHub, SCOPE };
