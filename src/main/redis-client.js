'use strict';

/**
 * Klien Redis minimal (RESP2) di atas stream apa pun (mis. kanal SSH forwardOut).
 * Tanpa dependensi. Mendukung AUTH, SELECT, dan perintah umum; menolak perintah berbahaya
 * saat mode hanya-baca.
 */

class RedisError extends Error { constructor(m, code) { super(m); this.code = code; } }

const READ_OK = new Set(['get', 'mget', 'exists', 'type', 'ttl', 'pttl', 'strlen', 'scan', 'dbsize', 'info', 'ping', 'hget', 'hgetall', 'hlen', 'hkeys', 'hmget',
  'lrange', 'llen', 'lindex', 'smembers', 'scard', 'sismember', 'zrange', 'zcard', 'zscore', 'zrevrange', 'xlen', 'xrange', 'sscan', 'hscan', 'zscan', 'select', 'time', 'memory', 'object']);
const DANGER = new Set(['flushall', 'flushdb', 'shutdown', 'config', 'debug', 'slaveof', 'replicaof', 'migrate', 'script', 'eval', 'evalsha', 'function', 'module', 'acl', 'save', 'bgsave', 'bgrewriteaof', 'cluster', 'monitor', 'subscribe', 'psubscribe', 'sync', 'psync']);

/** Pecah baris perintah ala redis-cli (mendukung tanda kutip). */
function tokenize(line) {
  const out = [];
  let cur = ''; let q = null; let has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '\\' && i + 1 < line.length) { const n = line[++i]; cur += n === 'n' ? '\n' : n === 't' ? '\t' : n; } else if (c === q) q = null; else cur += c;
    } else if (c === '"' || c === "'") { q = c; has = true; } else if (/\s/.test(c)) { if (cur || has) { out.push(cur); cur = ''; has = false; } } else cur += c;
  }
  if (q) throw new RedisError('Tanda kutip tidak berpasangan.', 'SYNTAX');
  if (cur || has) out.push(cur);
  return out;
}

function encode(args) {
  const parts = [`*${args.length}\r\n`];
  for (const a of args) { const b = Buffer.from(String(a), 'utf8'); parts.push(`$${b.length}\r\n`, b, '\r\n'); }
  return Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
}

/** Parser RESP inkremental. Mengembalikan {value, rest} atau null bila belum lengkap. */
function parseOne(buf, off = 0) {
  if (off >= buf.length) return null;
  const nl = buf.indexOf('\r\n', off);
  if (nl < 0) return null;
  const t = String.fromCharCode(buf[off]);
  const line = buf.toString('utf8', off + 1, nl);
  const next = nl + 2;
  switch (t) {
    case '+': return { value: line, end: next };
    case '-': return { value: new RedisError(line, 'REDIS_ERR'), end: next };
    case ':': return { value: Number(line), end: next };
    case '$': {
      const n = Number(line);
      if (n < 0) return { value: null, end: next };
      if (buf.length < next + n + 2) return null;
      return { value: buf.toString('utf8', next, next + n), end: next + n + 2 };
    }
    case '*': {
      const n = Number(line);
      if (n < 0) return { value: null, end: next };
      const arr = []; let p = next;
      for (let i = 0; i < n; i++) { const r = parseOne(buf, p); if (!r) return null; arr.push(r.value); p = r.end; }
      return { value: arr, end: p };
    }
    default: throw new RedisError('Respons Redis tidak dikenali.', 'PROTOCOL');
  }
}

class RedisClient {
  constructor(stream) {
    this.stream = stream;
    this.buf = Buffer.alloc(0);
    this.queue = [];
    this.closed = false;
    stream.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this._drain(); });
    const onEnd = () => { this.closed = true; for (const q of this.queue.splice(0)) q.reject(new RedisError('Koneksi Redis terputus.', 'CLOSED')); };
    stream.on('close', onEnd); stream.on('end', onEnd); stream.on('error', onEnd);
  }

  _drain() {
    for (;;) {
      let r;
      try { r = parseOne(this.buf); } catch (e) { const q = this.queue.shift(); if (q) q.reject(e); this.buf = Buffer.alloc(0); return; }
      if (!r) return;
      this.buf = this.buf.slice(r.end);
      const q = this.queue.shift();
      if (!q) continue;
      if (r.value instanceof RedisError) q.reject(r.value); else q.resolve(r.value);
    }
  }

  send(args, timeoutMs = 15000) {
    if (this.closed) return Promise.reject(new RedisError('Koneksi Redis terputus.', 'CLOSED'));
    return new Promise((resolve, reject) => {
      const item = { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } };
      const t = setTimeout(() => { const i = this.queue.indexOf(item); if (i >= 0) this.queue.splice(i, 1); reject(new RedisError('Redis tidak menjawab (timeout).', 'TIMEOUT')); }, timeoutMs);
      this.queue.push(item);
      this.stream.write(encode(args));
    });
  }

  close() { this.closed = true; try { this.stream.end(); } catch (_) { /* abaikan */ } try { this.stream.destroy(); } catch (_) { /* abaikan */ } }
}

/** Periksa perintah mentah dari editor. Mengembalikan args atau melempar RedisError. */
function checkCommand(line, { readOnly, confirmed }) {
  const args = tokenize(line);
  if (!args.length) throw new RedisError('Perintah kosong.', 'SYNTAX');
  const cmd = args[0].toLowerCase();
  if (readOnly && !READ_OK.has(cmd)) throw new RedisError(`Mode hanya-baca: perintah ${cmd.toUpperCase()} diblokir.`, 'READ_ONLY');
  if (DANGER.has(cmd)) throw new RedisError(`Perintah ${cmd.toUpperCase()} diblokir di Abux karena berbahaya. Jalankan lewat terminal bila memang perlu.`, 'BLOCKED');
  if (['del', 'unlink', 'expire', 'persist', 'rename'].includes(cmd) && !confirmed) { const e = new RedisError(`Perintah ${cmd.toUpperCase()} mengubah data. Konfirmasi untuk melanjutkan.`, 'NEEDS_CONFIRM'); throw e; }
  return args;
}

module.exports = { RedisClient, RedisError, tokenize, encode, parseOne, checkCommand };
