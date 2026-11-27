'use strict';

const fs = require('fs');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const { escapeId } = require('mysql2');
const { splitStatements, classify } = require('./sql-util');

class DbError extends Error {
  constructor(message, code, extra) {
    super(message);
    this.code = code;
    Object.assign(this, extra || {});
  }
}

const MAX_RESULT_ROWS = 1000;
const MAX_EXPORT_ROWS = 200000;
const QUERY_TIMEOUT_MS = 120000;
const FILTER_OPS = { '=': '=', '!=': '<>', '>': '>', '<': '<', '>=': '>=', '<=': '<=', like: 'LIKE', 'not like': 'NOT LIKE', null: 'IS NULL', 'not null': 'IS NOT NULL' };
const BINARY_TYPES = /(blob|binary|bit|geometry|point|polygon|linestring)/i;

/** Ubah nilai sel menjadi sesuatu yang aman dikirim ke UI (JSON). */
function cell(v) {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return v.length <= 32 ? '0x' + v.toString('hex') : `[BINER ${v.length} byte]`;
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch (_) { return String(v); } }
  return v;
}

class DbManager {
  /** @param {{store: any, ssh: any, emit: (c: string, p: any) => void}} opts */
  constructor({ store, ssh, emit }) {
    this.store = store;
    this.ssh = ssh;
    this.emit = emit;
    this.sessions = new Map();
    this._cols = new Map(); // cache "sid|db|table" -> kolom
    if (ssh.onSessionClosed) ssh.onSessionClosed((sshId) => this._onSshClosed(sshId));
  }

  _onSshClosed(sshId) {
    for (const s of [...this.sessions.values()]) if (s.sshSessionId === sshId) this._drop(s, 'Sesi SSH ditutup.');
  }

  _drop(s, reason) {
    if (s.closed) return;
    s.closed = true;
    this.sessions.delete(s.id);
    for (const k of [...this._cols.keys()]) if (k.startsWith(s.id + '|')) this._cols.delete(k);
    try { s.conn.destroy(); } catch (_) { /* abaikan */ }
    this.emit('db:event', { type: 'closed', dbSessionId: s.id, reason });
  }

  _friendly(e, params) {
    if (e instanceof DbError) return e;
    const m = (e && e.message) || String(e);
    const code = e && e.code;
    if (code === 'ER_ACCESS_DENIED_ERROR' || code === 'ER_DBACCESS_DENIED_ERROR') {
      return new DbError(`Login database ditolak untuk user "${params ? params.user : ''}". Periksa user dan password database (bukan password SSH).`, 'DB_AUTH');
    }
    if (code === 'ER_BAD_DB_ERROR') return new DbError('Database tidak ditemukan di server.', 'DB_NO_DB');
    if (/Connection refused|ECONNREFUSED|Channel open failure/i.test(m)) {
      return new DbError(`Tidak ada layanan database di ${params ? params.dbHost + ':' + params.dbPort : 'alamat itu'} pada server. Periksa host/port database (mis. MySQL di Docker mungkin memakai port lain).`, 'DB_REFUSED');
    }
    if (/ETIMEDOUT|timed out/i.test(m)) return new DbError('Waktu koneksi database habis.', 'DB_TIMEOUT');
    if (code === 'PROTOCOL_CONNECTION_LOST' || code === 'ECONNRESET' || /closed state|Can't add new command/i.test(m)) {
      return new DbError('Koneksi database terputus. Sambungkan ulang.', 'DB_LOST');
    }
    if (code === 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION' || code === 'ER_READ_ONLY_TRANSACTION') {
      return new DbError('Koneksi dalam mode hanya-baca. Matikan "Hanya baca" pada pengaturan koneksi untuk mengubah data.', 'READ_ONLY');
    }
    if (e && e.sqlMessage) return new DbError(e.sqlMessage, 'SQL_ERROR', { errno: e.errno, sqlState: e.sqlState });
    return new DbError(m, 'DB_ERROR');
  }

  async _open(params, sshSessionId) {
    let stream;
    try {
      stream = await this.ssh.forwardOut(sshSessionId, params.dbHost, params.dbPort);
    } catch (e) {
      throw this._friendly(e, params);
    }
    try {
      const conn = await mysql.createConnection({
        user: params.user,
        password: params.password,
        database: params.database || undefined,
        stream,
        connectTimeout: 15000,
        supportBigNumbers: true,
        bigNumberStrings: true,
        dateStrings: true,
        multipleStatements: false,
        charset: 'utf8mb4',
      });
      conn.on('error', () => { /* ditangani lewat _friendly pada perintah berikutnya */ });
      return conn;
    } catch (e) {
      try { stream.destroy(); } catch (_) { /* abaikan */ }
      throw this._friendly(e, params);
    }
  }

  _params(input) {
    const raw = input.connId ? this.store.getDbConnRaw(input.connId) : null;
    const useRaw = !!raw && input.user === undefined; // hanya connId: pakai pengaturan tersimpan
    const base = useRaw ? raw : input;
    const p = {
      user: String(base.user || '').trim(),
      dbHost: String(base.dbHost || '127.0.0.1').trim(),
      dbPort: Number(base.dbPort || 3306),
      database: String(base.database || '').trim(),
      readOnly: base.readOnly !== false,
      emptyPassword: !!base.emptyPassword,
    };
    if (!p.user) throw new DbError('User database wajib diisi.', 'BAD_INPUT');
    if (!Number.isInteger(p.dbPort) || p.dbPort < 1 || p.dbPort > 65535) throw new DbError('Port database tidak valid.', 'BAD_INPUT');
    let pw = typeof input.password === 'string' && input.password !== '' ? input.password : null;
    if (pw === null && typeof input.password === 'string' && input.emptyPassword) pw = '';
    if (pw === null && raw && (useRaw || input.useStoredPassword)) pw = this.store.getDbPassword(raw.id);
    if (pw === null && p.emptyPassword) pw = '';
    if (pw === null) throw new DbError('Password database diperlukan.', 'NEEDS_SECRET', { kind: 'password', label: 'Password database' });
    p.password = pw;
    return p;
  }

  async testConnection(input) {
    const p = this._params(input);
    const started = Date.now();
    const conn = await this._open(p, input.sshSessionId);
    try {
      const [[row]] = await conn.query('SELECT VERSION() AS v, CURRENT_USER() AS u');
      return { ok: true, version: row.v, user: row.u, ms: Date.now() - started };
    } catch (e) {
      throw this._friendly(e, p);
    } finally {
      try { conn.destroy(); } catch (_) { /* abaikan */ }
    }
  }

  async connect({ connId, sshSessionId, password }) {
    if (!this.store.getDbConnRaw(connId)) throw new DbError('Koneksi database tidak ditemukan.', 'NO_CONN');
    const existing = [...this.sessions.values()].find((s) => s.connId === connId && !s.closed);
    if (existing) return this._info(existing);
    const p = this._params({ connId, password });
    const conn = await this._open(p, sshSessionId);
    const s = { id: crypto.randomUUID(), connId, sshSessionId, conn, readOnly: p.readOnly, closed: false, user: p.user };
    try {
      if (p.readOnly) await conn.query('SET SESSION TRANSACTION READ ONLY');
      const [[row]] = await conn.query('SELECT VERSION() AS v');
      s.version = row.v;
    } catch (e) {
      try { conn.destroy(); } catch (_) { /* abaikan */ }
      throw this._friendly(e, p);
    }
    conn.on('end', () => this._drop(s, 'Koneksi database ditutup.'));
    this.sessions.set(s.id, s);
    return this._info(s);
  }

  _info(s) {
    return { id: s.id, connId: s.connId, readOnly: s.readOnly, version: s.version, user: s.user };
  }

  active() {
    return [...this.sessions.values()].map((s) => this._info(s));
  }

  disconnect(id) {
    const s = this.sessions.get(id);
    if (s) {
      s.closed = true;
      this.sessions.delete(id);
      try { s.conn.end(); } catch (_) { /* abaikan */ }
    }
  }

  closeAll() {
    for (const s of [...this.sessions.values()]) this.disconnect(s.id);
  }

  _get(id) {
    const s = this.sessions.get(id);
    if (!s || s.closed) throw new DbError('Koneksi database tidak aktif. Sambungkan ulang.', 'NO_DB_SESSION');
    return s;
  }

  async _run(s, fn) {
    try {
      return await fn(s.conn);
    } catch (e) {
      const fe = this._friendly(e);
      if (fe.code === 'DB_LOST') this._drop(s, fe.message);
      throw fe;
    }
  }

  // ---------- skema ----------
  async databases(id) {
    const s = this._get(id);
    return this._run(s, async (c) => {
      const [rows] = await c.query({ sql: 'SHOW DATABASES', rowsAsArray: true });
      return rows.map((r) => String(r[0]));
    });
  }

  async tables(id, db) {
    const s = this._get(id);
    return this._run(s, async (c) => {
      const [rows] = await c.query({
        sql: 'SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS, ENGINE, DATA_LENGTH, INDEX_LENGTH FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
        values: [db],
        rowsAsArray: true,
      });
      return rows.map((r) => ({ name: String(r[0]), type: r[1] === 'VIEW' ? 'view' : 'table', rows: r[2] == null ? null : Number(r[2]), engine: r[3], size: Number(r[4] || 0) + Number(r[5] || 0) }));
    });
  }

  async describe(id, db, table) {
    const s = this._get(id);
    return this._run(s, async (c) => {
      const [cols] = await c.query({
        sql: 'SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
        values: [db, table],
        rowsAsArray: true,
      });
      if (!cols.length) throw new DbError('Tabel tidak ditemukan.', 'NO_TABLE');
      const columns = cols.map((r) => ({
        name: String(r[0]), type: String(r[1]), nullable: r[2] === 'YES', key: r[3] || '',
        default: r[4] == null ? null : String(r[4]), extra: r[5] || '', comment: r[6] || '',
        binary: BINARY_TYPES.test(String(r[1])),
        auto: /auto_increment/i.test(r[5] || ''),
      }));
      this._cols.set(`${id}|${db}|${table}`, columns);
      let indexes = [];
      let ddl = '';
      try {
        const [idx] = await c.query({ sql: `SHOW INDEX FROM ${escapeId(table)} FROM ${escapeId(db)}`, rowsAsArray: true });
        const map = new Map();
        for (const r of idx) { // Table, Non_unique, Key_name, Seq_in_index, Column_name
          const name = String(r[2]);
          if (!map.has(name)) map.set(name, { name, unique: Number(r[1]) === 0, columns: [] });
          map.get(name).columns.push(String(r[4]));
        }
        indexes = [...map.values()];
        const [cr] = await c.query({ sql: `SHOW CREATE TABLE ${escapeId(db)}.${escapeId(table)}`, rowsAsArray: true });
        ddl = String((cr[0] && cr[0][1]) || '');
      } catch (_) { /* view atau hak akses terbatas */ }
      return { columns, indexes, ddl };
    });
  }

  async _columns(s, db, table) {
    const key = `${s.id}|${db}|${table}`;
    if (!this._cols.has(key)) await this.describe(s.id, db, table);
    return this._cols.get(key);
  }

  // ---------- data ----------
  async rows(id, { db, table, page = 1, pageSize = 100, orderBy, dir = 'asc', filter }) {
    const s = this._get(id);
    const cols = await this._columns(s, db, table);
    const names = cols.map((c) => c.name);
    pageSize = Math.min(500, Math.max(1, Number(pageSize) || 100));
    page = Math.max(1, Number(page) || 1);
    const from = `${escapeId(db)}.${escapeId(table)}`;
    let where = '';
    const vals = [];
    if (filter && filter.column) {
      if (!names.includes(filter.column)) throw new DbError('Kolom filter tidak dikenal.', 'BAD_INPUT');
      const op = FILTER_OPS[String(filter.op || '=').toLowerCase()];
      if (!op) throw new DbError('Operator filter tidak dikenal.', 'BAD_INPUT');
      where = ` WHERE ${escapeId(filter.column)} ${op}`;
      if (!/NULL$/.test(op)) { where += ' ?'; vals.push(String(filter.value ?? '')); }
    }
    let order = '';
    if (orderBy) {
      if (!names.includes(orderBy)) throw new DbError('Kolom urutan tidak dikenal.', 'BAD_INPUT');
      order = ` ORDER BY ${escapeId(orderBy)} ${String(dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC'}`;
    }
    return this._run(s, async (c) => {
      const t0 = Date.now();
      const [data] = await c.query({ sql: `SELECT * FROM ${from}${where}${order} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, values: vals, rowsAsArray: true });
      const [[cnt]] = await c.query({ sql: `SELECT COUNT(*) AS n FROM ${from}${where}`, values: vals });
      return { columns: cols, rows: data.map((r) => r.map(cell)), total: Number(cnt.n), page, pageSize, ms: Date.now() - t0 };
    });
  }

  _assertWritable(s) {
    if (s.readOnly) throw new DbError('Koneksi dalam mode hanya-baca. Matikan "Hanya baca" pada pengaturan koneksi untuk mengubah data.', 'READ_ONLY');
  }

  async _pk(s, db, table) {
    const cols = await this._columns(s, db, table);
    const pk = cols.filter((c) => c.key === 'PRI').map((c) => c.name);
    if (!pk.length) throw new DbError('Tabel ini tidak punya primary key, jadi baris tidak bisa diedit dengan aman. Gunakan editor SQL.', 'NO_PK');
    return { cols, pk };
  }

  _checkKey(pk, key) {
    if (!key || typeof key !== 'object') throw new DbError('Kunci baris tidak lengkap.', 'BAD_INPUT');
    for (const k of pk) if (!(k in key) || key[k] === null) throw new DbError('Kunci baris tidak lengkap.', 'BAD_INPUT');
    for (const k of Object.keys(key)) if (!pk.includes(k)) throw new DbError('Kunci baris tidak valid.', 'BAD_INPUT');
  }

  async updateRow(id, { db, table, key, changes }) {
    const s = this._get(id);
    this._assertWritable(s);
    const { cols, pk } = await this._pk(s, db, table);
    this._checkKey(pk, key);
    const names = cols.map((c) => c.name);
    const entries = Object.entries(changes || {});
    if (!entries.length) throw new DbError('Tidak ada perubahan.', 'BAD_INPUT');
    for (const [k] of entries) {
      if (!names.includes(k)) throw new DbError(`Kolom "${k}" tidak ada.`, 'BAD_INPUT');
      if (cols.find((c) => c.name === k).binary) throw new DbError(`Kolom biner "${k}" tidak bisa diedit di sini.`, 'BAD_INPUT');
    }
    const set = entries.map(([k]) => `${escapeId(k)} = ?`).join(', ');
    const w = pk.map((k) => `${escapeId(k)} = ?`).join(' AND ');
    return this._run(s, async (c) => {
      const [r] = await c.query(`UPDATE ${escapeId(db)}.${escapeId(table)} SET ${set} WHERE ${w} LIMIT 1`, [...entries.map(([, v]) => v), ...pk.map((k) => key[k])]);
      if (!r.affectedRows) throw new DbError('Baris tidak ditemukan (mungkin sudah berubah atau dihapus).', 'NO_ROW');
      return { affectedRows: r.affectedRows, changedRows: r.changedRows };
    });
  }

  async insertRow(id, { db, table, values }) {
    const s = this._get(id);
    this._assertWritable(s);
    const cols = await this._columns(s, db, table);
    const names = cols.map((c) => c.name);
    const entries = Object.entries(values || {});
    for (const [k] of entries) if (!names.includes(k)) throw new DbError(`Kolom "${k}" tidak ada.`, 'BAD_INPUT');
    return this._run(s, async (c) => {
      const sql = entries.length
        ? `INSERT INTO ${escapeId(db)}.${escapeId(table)} (${entries.map(([k]) => escapeId(k)).join(', ')}) VALUES (${entries.map(() => '?').join(', ')})`
        : `INSERT INTO ${escapeId(db)}.${escapeId(table)} () VALUES ()`;
      const [r] = await c.query(sql, entries.map(([, v]) => v));
      return { affectedRows: r.affectedRows, insertId: String(r.insertId || '') };
    });
  }

  async deleteRow(id, { db, table, key }) {
    const s = this._get(id);
    this._assertWritable(s);
    const { pk } = await this._pk(s, db, table);
    this._checkKey(pk, key);
    const w = pk.map((k) => `${escapeId(k)} = ?`).join(' AND ');
    return this._run(s, async (c) => {
      const [r] = await c.query(`DELETE FROM ${escapeId(db)}.${escapeId(table)} WHERE ${w} LIMIT 1`, pk.map((k) => key[k]));
      if (!r.affectedRows) throw new DbError('Baris tidak ditemukan (mungkin sudah dihapus).', 'NO_ROW');
      return { affectedRows: r.affectedRows };
    });
  }

  // ---------- SQL bebas ----------
  _prep(s, sql, confirmed) {
    const stmts = splitStatements(String(sql || ''));
    if (!stmts.length) throw new DbError('Tulis perintah SQL dulu.', 'BAD_INPUT');
    if (stmts.length > 200) throw new DbError('Terlalu banyak pernyataan sekaligus (maks 200).', 'BAD_INPUT');
    const infos = stmts.map(classify);
    if (s.readOnly) {
      const i = infos.findIndex((x) => !x.readOnlyOk);
      if (i >= 0) throw new DbError(`Pernyataan ${stmts.length > 1 ? (i + 1) + ' ' : ''}(${infos[i].kind.toUpperCase()}) ditolak: koneksi ini hanya-baca. Matikan "Hanya baca" pada pengaturan koneksi bila Anda memang ingin mengubah data.`, 'READ_ONLY');
    }
    if (!confirmed) {
      const i = infos.findIndex((x) => x.danger);
      if (i >= 0) throw new DbError(infos[i].danger, 'NEEDS_CONFIRM', { statement: stmts[i].slice(0, 300) });
    }
    return stmts;
  }

  /**
   * Jalankan satu atau beberapa pernyataan berurutan (berhenti di yang gagal).
   * Hasil: pernyataan terakhir yang menghasilkan baris, atau ringkasan OK.
   */
  async query(id, sql, { confirmed = false, database } = {}) {
    const s = this._get(id);
    const stmts = this._prep(s, sql, confirmed);
    return this._run(s, async (c) => {
      const t0 = Date.now();
      if (database) await c.query(`USE ${escapeId(database)}`);
      let shown = null;
      let affected = 0;
      for (let i = 0; i < stmts.length; i++) {
        let res; let fields;
        try {
          [res, fields] = await c.query({ sql: stmts[i], rowsAsArray: true, timeout: QUERY_TIMEOUT_MS });
        } catch (e) {
          const fe = this._friendly(e);
          if (stmts.length > 1 && fe.code === 'SQL_ERROR') fe.message = `Pernyataan ${i + 1} dari ${stmts.length} gagal: ${fe.message}`;
          throw fe;
        }
        if (Array.isArray(res)) {
          const truncated = res.length > MAX_RESULT_ROWS;
          shown = { type: 'rows', columns: (fields || []).map((f) => f.name), rows: res.slice(0, MAX_RESULT_ROWS).map((r) => r.map(cell)), total: res.length, truncated };
        } else {
          affected += Number(res.affectedRows || 0);
          if (!shown || shown.type === 'ok') shown = { type: 'ok', affectedRows: Number(res.affectedRows || 0), insertId: String(res.insertId || ''), info: res.info || '' };
        }
      }
      return { ...shown, statements: stmts.length, affectedTotal: affected, ms: Date.now() - t0 };
    });
  }

  /** Ekspor hasil satu SELECT ke berkas CSV/JSON. */
  async exportTo(id, { sql, format = 'csv', filePath }) {
    const s = this._get(id);
    const stmts = this._prep(s, sql, false);
    if (stmts.length !== 1 || !classify(stmts[0]).readOnlyOk) throw new DbError('Ekspor hanya untuk satu perintah SELECT.', 'BAD_INPUT');
    return this._run(s, async (c) => {
      const [res, fields] = await c.query({ sql: stmts[0], rowsAsArray: true, timeout: QUERY_TIMEOUT_MS });
      if (!Array.isArray(res)) throw new DbError('Perintah ini tidak menghasilkan baris.', 'BAD_INPUT');
      const rows = res.slice(0, MAX_EXPORT_ROWS).map((r) => r.map(cell));
      const names = fields.map((f) => f.name);
      let out;
      if (format === 'json') {
        const seen = new Map();
        const keys = names.map((n) => { const k = seen.get(n) || 0; seen.set(n, k + 1); return k ? `${n}_${k + 1}` : n; });
        out = JSON.stringify(rows.map((r) => Object.fromEntries(r.map((v, i) => [keys[i], v]))), null, 2);
      } else {
        const esc = (v) => {
          if (v === null) return '';
          let t = String(v);
          // cegah injeksi rumus saat dibuka di Excel/Sheets
          if (/^[=+\-@\t\r]/.test(t) && !/^-?\d+(\.\d+)?$/.test(t)) t = "'" + t;
          return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
        };
        out = '\uFEFF' + [names, ...rows].map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
      }
      fs.writeFileSync(filePath, out, { mode: 0o600 });
      return { rows: rows.length, truncated: res.length > MAX_EXPORT_ROWS, path: filePath };
    });
  }
}

module.exports = { DbManager, DbError, cell, MAX_RESULT_ROWS, MAX_EXPORT_ROWS };
