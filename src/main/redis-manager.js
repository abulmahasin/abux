'use strict';

const crypto = require('crypto');
const { RedisClient, RedisError, checkCommand } = require('./redis-client');

const MAX_ITEMS = 500;

class RedisManager {
  constructor({ store, ssh }) {
    this.store = store; this.ssh = ssh; this.sessions = new Map();
    ssh.onSessionClosed((sid) => { for (const [id, s] of this.sessions) if (s.sshSessionId === sid) this.disconnect(id); });
  }

  async _open({ sshSessionId, redisHost, redisPort, password, dbIndex }) {
    const stream = await this.ssh.forwardOut(sshSessionId, redisHost, redisPort);
    const c = new RedisClient(stream);
    try {
      if (password) {
        try { await c.send(['AUTH', password]); } catch (e) { throw new RedisError('Autentikasi Redis gagal: ' + e.message, 'REDIS_AUTH'); }
      }
      if (dbIndex) await c.send(['SELECT', String(dbIndex)]);
      const pong = await c.send(['PING']);
      if (pong !== 'PONG') throw new RedisError('Server tidak menjawab seperti Redis.', 'PROTOCOL');
    } catch (e) {
      c.close();
      if (/NOAUTH|Authentication required/i.test(e.message)) throw new RedisError('Redis meminta password.', 'NEEDS_SECRET');
      throw e;
    }
    return c;
  }

  _params(input) {
    const c = input.connId ? this.store.getRedisConnRaw(input.connId) : null;
    if (input.connId && !c) throw new RedisError('Koneksi tidak ditemukan.', 'NOT_FOUND');
    const password = input.password !== undefined ? input.password : c ? this.store.getRedisPassword(c.id) : null;
    return {
      sshSessionId: input.sshSessionId,
      redisHost: c ? c.redisHost : String(input.redisHost || '127.0.0.1'),
      redisPort: c ? c.redisPort : Number(input.redisPort || 6379),
      dbIndex: c ? c.dbIndex : Number(input.dbIndex || 0),
      readOnly: c ? c.readOnly : input.readOnly !== false,
      password: password || null,
    };
  }

  async testConnection(input) {
    const p = this._params(input);
    const t = Date.now();
    const c = await this._open(p);
    try {
      const info = await c.send(['INFO', 'server']);
      const ver = /redis_version:([^\r\n]+)/.exec(info || '');
      return { ms: Date.now() - t, version: ver ? ver[1] : '?' };
    } finally { c.close(); }
  }

  async connect(input) {
    const p = this._params(input);
    const client = await this._open(p);
    const id = crypto.randomUUID();
    this.sessions.set(id, { id, client, connId: input.connId || null, sshSessionId: p.sshSessionId, readOnly: p.readOnly, dbIndex: p.dbIndex });
    client.stream.on('close', () => this.sessions.delete(id));
    return { id, readOnly: p.readOnly, dbIndex: p.dbIndex };
  }

  _s(id) { const s = this.sessions.get(id); if (!s) throw new RedisError('Sesi Redis tidak aktif.', 'NO_SESSION'); return s; }
  disconnect(id) { const s = this.sessions.get(id); if (s) { s.client.close(); this.sessions.delete(id); } }
  closeAll() { for (const id of [...this.sessions.keys()]) this.disconnect(id); }
  active() { return [...this.sessions.values()].map((s) => ({ id: s.id, connId: s.connId, readOnly: s.readOnly })); }

  async info(id) {
    const s = this._s(id);
    const raw = String(await s.client.send(['INFO']));
    const m = {};
    for (const l of raw.split('\r\n')) { const x = /^([a-z_0-9]+):(.*)$/.exec(l); if (x) m[x[1]] = x[2]; }
    const db = await s.client.send(['DBSIZE']);
    return { version: m.redis_version, mode: m.redis_mode, uptime: Number(m.uptime_in_seconds), clients: Number(m.connected_clients), usedMemory: m.used_memory_human, peakMemory: m.used_memory_peak_human, opsPerSec: Number(m.instantaneous_ops_per_sec), hits: Number(m.keyspace_hits), misses: Number(m.keyspace_misses), keys: db };
  }

  /** Pindai key bertahap (SCAN, tidak pernah KEYS). */
  async scan(id, { cursor = '0', match = '*', count = 200 } = {}) {
    const s = this._s(id);
    const pat = String(match || '*').slice(0, 200);
    const r = await s.client.send(['SCAN', String(cursor), 'MATCH', pat, 'COUNT', String(Math.min(1000, Math.max(10, Number(count) || 200)))]);
    const keys = r[1];
    const types = [];
    if (keys.length) { for (const k of keys.slice(0, MAX_ITEMS)) types.push(await s.client.send(['TYPE', k])); }
    return { cursor: String(r[0]), keys: keys.slice(0, MAX_ITEMS).map((k, i) => ({ key: k, type: types[i] })) };
  }

  async get(id, key) {
    const s = this._s(id); const c = s.client; const k = String(key);
    const type = await c.send(['TYPE', k]);
    if (type === 'none') throw new RedisError('Key tidak ada (mungkin sudah kedaluwarsa).', 'NO_KEY');
    const ttl = await c.send(['TTL', k]);
    let value; let size = null; let truncated = false;
    if (type === 'string') { size = await c.send(['STRLEN', k]); value = size > 100000 ? (await c.send(['GETRANGE', k, '0', '99999'])) : await c.send(['GET', k]); truncated = size > 100000; }
    else if (type === 'list') { size = await c.send(['LLEN', k]); value = await c.send(['LRANGE', k, '0', String(MAX_ITEMS - 1)]); truncated = size > MAX_ITEMS; }
    else if (type === 'set') { size = await c.send(['SCARD', k]); const r = await c.send(['SSCAN', k, '0', 'COUNT', String(MAX_ITEMS)]); value = r[1].slice(0, MAX_ITEMS); truncated = size > value.length; }
    else if (type === 'zset') { size = await c.send(['ZCARD', k]); const r = await c.send(['ZRANGE', k, '0', String(MAX_ITEMS - 1), 'WITHSCORES']); value = []; for (let i = 0; i < r.length; i += 2) value.push({ member: r[i], score: r[i + 1] }); truncated = size > MAX_ITEMS; }
    else if (type === 'hash') { size = await c.send(['HLEN', k]); const r = await c.send(['HSCAN', k, '0', 'COUNT', String(MAX_ITEMS)]); value = []; for (let i = 0; i < r[1].length; i += 2) value.push({ field: r[1][i], value: r[1][i + 1] }); truncated = size > value.length; }
    else { value = null; }
    return { key: k, type, ttl, size, value, truncated };
  }

  _write(s) { if (s.readOnly) throw new RedisError('Koneksi ini hanya-baca.', 'READ_ONLY'); }

  async del(id, key, confirmed) {
    const s = this._s(id); this._write(s);
    if (!confirmed) throw new RedisError('Hapus key perlu konfirmasi.', 'NEEDS_CONFIRM');
    return s.client.send(['DEL', String(key)]);
  }
  async setString(id, key, value, ttl) {
    const s = this._s(id); this._write(s);
    const a = ['SET', String(key), String(value)];
    if (ttl && Number(ttl) > 0) a.push('EX', String(Math.floor(Number(ttl))));
    return s.client.send(a);
  }
  async expire(id, key, ttl) {
    const s = this._s(id); this._write(s);
    return Number(ttl) > 0 ? s.client.send(['EXPIRE', String(key), String(Math.floor(Number(ttl)))]) : s.client.send(['PERSIST', String(key)]);
  }

  async command(id, line, { confirmed } = {}) {
    const s = this._s(id);
    const args = checkCommand(line, { readOnly: s.readOnly, confirmed });
    return { result: await s.client.send(args) };
  }
}

module.exports = { RedisManager };
