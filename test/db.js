'use strict';

/**
 * Tes fitur Database terhadap MariaDB/MySQL sungguhan lewat terowongan SSH tiruan.
 * Dilewati otomatis bila mariadbd/mysqld tidak ada di PATH.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { Server, utils } = require('ssh2');
const { Store } = require('../src/main/store');
const { SSHManager } = require('../src/main/ssh-manager');
const { DbManager } = require('../src/main/db-manager');
const { splitStatements, classify } = require('../src/main/sql-util');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n      ' + (e.stack || e)); process.exitCode = 1; }
}
const which = (b) => { const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [b], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fakeCrypto = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from(Buffer.from(s).toString('hex').split('').reverse().join('')),
  decrypt: (b) => Buffer.from(b.toString().split('').reverse().join(''), 'hex').toString(),
};

(async () => {
  // ---------- util SQL (murni, selalu jalan) ----------
  await test('sql: pemecah pernyataan menghormati string, komentar, dan titik koma di dalamnya', () => {
    assert.deepStrictEqual(splitStatements("SELECT 'a;b'; -- komentar; x\nSELECT `t;1`; /* ; */ SELECT 3;"), ["SELECT 'a;b'", '-- komentar; x\nSELECT `t;1`', '/* ; */ SELECT 3']);
    assert.deepStrictEqual(splitStatements("  ;; SELECT 1 ;  "), ['SELECT 1']);
    assert.deepStrictEqual(splitStatements("SELECT 'it''s; ok'"), ["SELECT 'it''s; ok'"]);
    assert.deepStrictEqual(splitStatements(''), []);
  });

  await test('sql: klasifikasi hanya-baca dan deteksi perintah berbahaya', () => {
    const c = (s) => classify(s);
    for (const s of ['SELECT 1', ' select * from t', '-- x\nSHOW TABLES', 'DESCRIBE t', 'EXPLAIN SELECT 1', 'USE db', 'WITH x AS (SELECT 1) SELECT * FROM x']) assert.ok(c(s).readOnlyOk, s);
    for (const s of ['INSERT INTO t VALUES (1)', 'UPDATE t SET a=1 WHERE id=1', 'DELETE FROM t WHERE id=1', 'DROP TABLE t', 'SET GLOBAL x=1', 'SELECT * FROM t INTO OUTFILE "/tmp/x"', 'SELECT * FROM t FOR UPDATE', 'WITH x AS (SELECT 1) DELETE FROM t', 'CREATE TABLE a (b int)', 'GRANT ALL ON *.* TO x']) assert.ok(!c(s).readOnlyOk, s);
    assert.ok(c('DELETE FROM t').danger);
    assert.ok(c('UPDATE t SET a=1').danger);
    assert.ok(!c('DELETE FROM t WHERE id=1').danger);
    assert.ok(!c("SELECT 'DELETE FROM t'").danger);
    assert.ok(c("UPDATE t SET a='where'").danger, '"where" di dalam string bukan klausa WHERE');
    assert.ok(c('DROP DATABASE x').danger && c('TRUNCATE t').danger && c('ALTER TABLE t ADD c int').danger);
    assert.strictEqual(c('/* DROP */ SELECT 1').danger, null);
  });

  const bin = which('mariadbd') || which('mysqld');
  if (!bin) {
    console.log('  --  tes MySQL dilewati (mariadbd/mysqld tidak ditemukan di PATH)');
    console.log(`\n${passed} tes lulus.`);
    return;
  }

  // ---------- MariaDB sementara ----------
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'abux-db-'));
  const dbPort = 34000 + Math.floor(Math.random() * 1000);
  const sock = path.join(tmp, 'sock');
  const isMaria = /maria/i.test(bin) || !!which('mariadb-install-db');
  const install = which('mariadb-install-db') || which('mysql_install_db');
  let proc;
  const cli = which('mariadb') || which('mysql');
  const cleanup = () => { try { if (proc) proc.kill('SIGTERM'); } catch (_) { /* abaikan */ } };
  process.on('exit', cleanup);
  try {
    if (install) spawnSync(install, ['--user=' + (os.userInfo().username), `--datadir=${tmp}/data`, '--auth-root-authentication-method=normal'], { stdio: 'ignore' });
    else spawnSync(bin, ['--initialize-insecure', `--datadir=${tmp}/data`, '--user=' + os.userInfo().username], { stdio: 'ignore' });
    proc = spawn(bin, [`--datadir=${tmp}/data`, `--socket=${sock}`, `--port=${dbPort}`, '--bind-address=127.0.0.1', `--pid-file=${tmp}/pid`, '--user=' + os.userInfo().username, '--skip-networking=0'], { stdio: 'ignore' });
    for (let i = 0; i < 120; i++) { if (fs.existsSync(sock) && spawnSync(cli, ['-S', sock, '-uroot', '-e', 'select 1'], { stdio: 'ignore' }).status === 0) break; await sleep(250); }
    const sql = (q) => { const r = spawnSync(cli, ['-S', sock, '-uroot', '-e', q], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); };
    sql("CREATE DATABASE shop CHARACTER SET utf8mb4");
    sql("CREATE USER 'app'@'127.0.0.1' IDENTIFIED BY 'dbpass'; CREATE USER 'app'@'localhost' IDENTIFIED BY 'dbpass'; GRANT ALL ON shop.* TO 'app'@'127.0.0.1'; GRANT ALL ON shop.* TO 'app'@'localhost'");
    sql("USE shop; CREATE TABLE customers (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(50) NOT NULL, email VARCHAR(80) NULL, balance DECIMAL(12,2) DEFAULT 0, big BIGINT, note TEXT, created DATETIME, photo BLOB, UNIQUE KEY uq_email (email)); " +
      "INSERT INTO customers (name,email,balance,big,note,created,photo) VALUES ('Budi','budi@x.id',10.50,9007199254740993,'halo; dunia','2026-01-02 03:04:05',0x0102), ('Siti',NULL,0,NULL,NULL,NULL,NULL), ('=CMD()','c@x.id',-3,1,'x',NULL,NULL); " +
      "CREATE TABLE nopk (a INT, b INT); INSERT INTO nopk VALUES (1,2); CREATE VIEW v_rich AS SELECT name FROM customers WHERE balance > 5;");

    // SSH tiruan dengan direct-tcpip (terowongan sungguhan ke MariaDB)
    const sshSrv = await new Promise((res) => {
      const srv = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (client) => {
        client.on('authentication', (ctx) => ctx.accept());
        client.on('ready', () => {
          client.on('session', (accept) => { const s = accept(); s.on('pty', (a) => a()); s.on('shell', (a) => { a(); }); });
          client.on('tcpip', (accept, reject, info) => {
            if (info.destPort !== dbPort) return reject();
            const up = net.connect(info.destPort, '127.0.0.1');
            up.on('connect', () => { const ch = accept(); ch.pipe(up); up.pipe(ch); ch.on('close', () => up.destroy()); up.on('close', () => ch.close()); });
            up.on('error', () => { try { reject(); } catch (_) { /* abaikan */ } });
          });
        });
        client.on('error', () => {});
      });
      srv.listen(0, '127.0.0.1', () => res(srv));
    });

    const events = [];
    const store = new Store({ filePath: path.join(tmp, 'store.json'), crypto: fakeCrypto });
    const ssh = new SSHManager({ store, emit: (c, p) => { if (c === 'ssh:hostkey-prompt') setImmediate(() => ssh.answerHostKey(p.promptId, true)); }, hostKeyTimeoutMs: 3000 });
    const host = store.saveHost({ name: 'DB Host', hostname: '127.0.0.1', port: sshSrv.address().port, username: 'u', authType: 'password', password: 'x' });
    await ssh.connect({ sessionId: 'ssh1', hostId: host.id });
    const dbm = new DbManager({ store, ssh, emit: (c, p) => events.push([c, p]) });
    const mk = (extra = {}) => store.saveDbConn({ name: 'Toko', hostId: host.id, dbHost: '127.0.0.1', dbPort, user: 'app', database: 'shop', readOnly: false, password: 'dbpass', ...extra });
    const rw = mk();
    const ro = mk({ name: 'Toko RO', readOnly: true });

    await test('simpan koneksi: password terenkripsi, validasi input, hapus host ikut menghapus koneksi', () => {
      const raw = fs.readFileSync(path.join(tmp, 'store.json'), 'utf8');
      assert.ok(!raw.includes('dbpass'));
      assert.strictEqual(rw.hasPassword, true);
      assert.ok(!('passwordEnc' in rw));
      assert.throws(() => store.saveDbConn({ name: '', hostId: host.id, user: 'x' }), /Nama/);
      assert.throws(() => store.saveDbConn({ name: 'x', hostId: 'nope', user: 'x' }), /host SSH/);
      assert.throws(() => store.saveDbConn({ name: 'x', hostId: host.id, user: '' }), /User/);
      assert.throws(() => store.saveDbConn({ name: 'x', hostId: host.id, user: 'x', dbPort: 70000 }), /Port/);
      const h2 = store.saveHost({ name: 'Tmp', hostname: 'z', username: 'u', authType: 'agent' });
      store.saveDbConn({ name: 'T', hostId: h2.id, user: 'u', emptyPassword: true });
      store.removeHost(h2.id);
      assert.ok(!store.listDbConns().some((c) => c.hostId === h2.id));
    });

    await test('uji koneksi: berhasil menampilkan versi; password salah dan port salah memberi pesan jelas', async () => {
      const ok = await dbm.testConnection({ connId: rw.id, sshSessionId: 'ssh1' });
      assert.ok(ok.ok && /\d/.test(ok.version));
      await assert.rejects(dbm.testConnection({ connId: rw.id, sshSessionId: 'ssh1', password: 'salah' }), (e) => e.code === 'DB_AUTH' && /Login database ditolak/.test(e.message));
      await assert.rejects(dbm.testConnection({ user: 'app', password: 'x', dbPort: dbPort + 1, sshSessionId: 'ssh1' }), (e) => e.code === 'DB_REFUSED' && /host\/port database/.test(e.message));
      await assert.rejects(dbm.testConnection({ user: 'app', sshSessionId: 'ssh1', dbPort }), (e) => e.code === 'NEEDS_SECRET');
      assert.strictEqual(dbm.active().length, 0, 'uji koneksi tidak boleh meninggalkan sesi');
    });

    const s = await dbm.connect({ connId: rw.id, sshSessionId: 'ssh1' });
    const sro = await dbm.connect({ connId: ro.id, sshSessionId: 'ssh1' });

    await test('skema: database, tabel (tabel vs view), kolom dengan tipe/kunci, index, DDL', async () => {
      const dbs = await dbm.databases(s.id);
      assert.ok(dbs.includes('shop'));
      const t = await dbm.tables(s.id, 'shop');
      assert.deepStrictEqual(t.map((x) => x.name), ['customers', 'nopk', 'v_rich']);
      assert.strictEqual(t.find((x) => x.name === 'v_rich').type, 'view');
      const d = await dbm.describe(s.id, 'shop', 'customers');
      assert.deepStrictEqual(d.columns.map((c) => c.name), ['id', 'name', 'email', 'balance', 'big', 'note', 'created', 'photo']);
      const id = d.columns[0];
      assert.ok(id.key === 'PRI' && id.auto && !id.nullable);
      assert.ok(d.columns.find((c) => c.name === 'photo').binary);
      assert.ok(d.indexes.some((i) => i.name === 'PRIMARY' && i.unique) && d.indexes.some((i) => i.name === 'uq_email' && i.unique && i.columns[0] === 'email'));
      assert.match(d.ddl, /CREATE TABLE/);
      await assert.rejects(dbm.describe(s.id, 'shop', 'tidak_ada'), (e) => e.code === 'NO_TABLE');
    });

    await test('baca data: paginasi, urut, filter, BIGINT tidak kehilangan presisi, NULL/biner aman', async () => {
      const r = await dbm.rows(s.id, { db: 'shop', table: 'customers', pageSize: 2, orderBy: 'id' });
      assert.strictEqual(r.total, 3); assert.strictEqual(r.rows.length, 2);
      assert.strictEqual(r.rows[0][1], 'Budi');
      assert.strictEqual(r.rows[0][4], '9007199254740993', 'BIGINT harus string utuh');
      assert.strictEqual(r.rows[0][6], '2026-01-02 03:04:05');
      assert.strictEqual(r.rows[0][7], '0x0102');
      assert.strictEqual(r.rows[1][2], null);
      const p2 = await dbm.rows(s.id, { db: 'shop', table: 'customers', pageSize: 2, page: 2, orderBy: 'id' });
      assert.strictEqual(p2.rows.length, 1);
      const desc = await dbm.rows(s.id, { db: 'shop', table: 'customers', orderBy: 'name', dir: 'desc' });
      assert.strictEqual(desc.rows[0][1], 'Siti');
      const f = await dbm.rows(s.id, { db: 'shop', table: 'customers', filter: { column: 'name', op: 'like', value: 'B%' } });
      assert.strictEqual(f.total, 1);
      const fn = await dbm.rows(s.id, { db: 'shop', table: 'customers', filter: { column: 'email', op: 'null' } });
      assert.strictEqual(fn.total, 1);
      await assert.rejects(dbm.rows(s.id, { db: 'shop', table: 'customers', orderBy: 'id; DROP TABLE customers' }), (e) => e.code === 'BAD_INPUT');
      await assert.rejects(dbm.rows(s.id, { db: 'shop', table: 'customers', filter: { column: 'name', op: 'OR 1=1 --', value: 'x' } }), (e) => e.code === 'BAD_INPUT');
      const inj = await dbm.rows(s.id, { db: 'shop', table: 'customers', filter: { column: 'name', op: '=', value: "x' OR '1'='1" } });
      assert.strictEqual(inj.total, 0, 'nilai filter harus diparameterkan');
    });

    await test('edit baris: ubah, set NULL, tambah, hapus; ditolak tanpa primary key dan pada kolom biner', async () => {
      const u = await dbm.updateRow(s.id, { db: 'shop', table: 'customers', key: { id: 1 }, changes: { name: 'Budi S', email: null } });
      assert.strictEqual(u.affectedRows, 1);
      let r = await dbm.rows(s.id, { db: 'shop', table: 'customers', orderBy: 'id' });
      assert.strictEqual(r.rows[0][1], 'Budi S'); assert.strictEqual(r.rows[0][2], null);
      const ins = await dbm.insertRow(s.id, { db: 'shop', table: 'customers', values: { name: 'Dewi', balance: '7.25' } });
      assert.ok(Number(ins.insertId) > 3);
      await dbm.insertRow(s.id, { db: 'shop', table: 'nopk', values: { a: 5 } });
      await dbm.deleteRow(s.id, { db: 'shop', table: 'customers', key: { id: Number(ins.insertId) } });
      await assert.rejects(dbm.deleteRow(s.id, { db: 'shop', table: 'customers', key: { id: 9999 } }), (e) => e.code === 'NO_ROW');
      await assert.rejects(dbm.updateRow(s.id, { db: 'shop', table: 'nopk', key: { a: 1 }, changes: { b: 3 } }), (e) => e.code === 'NO_PK');
      await assert.rejects(dbm.updateRow(s.id, { db: 'shop', table: 'customers', key: { id: 1 }, changes: { photo: 'x' } }), /biner/);
      await assert.rejects(dbm.updateRow(s.id, { db: 'shop', table: 'customers', key: { name: 'Budi S' }, changes: { note: 'x' } }), (e) => e.code === 'BAD_INPUT');
      await assert.rejects(dbm.updateRow(s.id, { db: 'shop', table: 'customers', key: { id: 1 }, changes: { 'x`; DROP TABLE customers; --': 1 } }), (e) => e.code === 'BAD_INPUT');
      await assert.rejects(dbm.updateRow(s.id, { db: 'shop', table: 'customers', key: { id: 1 }, changes: {} }), (e) => e.code === 'BAD_INPUT');
      r = await dbm.rows(s.id, { db: 'shop', table: 'customers' });
      assert.strictEqual(r.total, 3);
    });

    await test('editor SQL: SELECT, banyak pernyataan, ringkasan OK, error SQL jelas, hasil dipotong 1000 baris', async () => {
      const a = await dbm.query(s.id, 'SELECT id, name FROM customers ORDER BY id', { database: 'shop' });
      assert.strictEqual(a.type, 'rows'); assert.deepStrictEqual(a.columns, ['id', 'name']); assert.strictEqual(a.rows.length, 3);
      const m = await dbm.query(s.id, "USE shop; INSERT INTO nopk VALUES (7,8); SELECT COUNT(*) AS n FROM nopk;");
      assert.strictEqual(m.type, 'rows'); assert.strictEqual(m.statements, 3); assert.strictEqual(m.rows[0][0], '3');
      const ok = await dbm.query(s.id, "UPDATE nopk SET b = 9 WHERE a = 7");
      assert.strictEqual(ok.type, 'ok'); assert.strictEqual(ok.affectedRows, 1);
      await assert.rejects(dbm.query(s.id, 'SELEC 1'), (e) => e.code === 'SQL_ERROR' && /syntax/i.test(e.message));
      await assert.rejects(dbm.query(s.id, "SELECT 1; SELEC 2"), (e) => /Pernyataan 2 dari 2 gagal/.test(e.message));
      await assert.rejects(dbm.query(s.id, '   ;  '), (e) => e.code === 'BAD_INPUT');
      const nums = Array.from({ length: 40 }, (_, i) => `SELECT ${i} AS n`).join(' UNION ALL ');
      const big = await dbm.query(s.id, `SELECT a.n FROM (${nums}) a CROSS JOIN (${nums}) b`, { database: 'shop' });
      assert.strictEqual(big.rows.length, 1000); assert.ok(big.truncated); assert.strictEqual(big.total, 1600);
    });

    await test('pengaman: DELETE/UPDATE tanpa WHERE, DROP, TRUNCATE butuh konfirmasi; dengan konfirmasi berjalan', async () => {
      for (const q of ['DELETE FROM nopk', 'UPDATE nopk SET b = 0', 'TRUNCATE nopk', 'DROP TABLE nopk', 'ALTER TABLE nopk ADD c INT']) {
        await assert.rejects(dbm.query(s.id, q, { database: 'shop' }), (e) => e.code === 'NEEDS_CONFIRM', q);
      }
      assert.strictEqual((await dbm.query(s.id, 'SELECT COUNT(*) FROM nopk', { database: 'shop' })).rows[0][0], '3', 'tidak ada yang berubah sebelum konfirmasi');
      const r = await dbm.query(s.id, 'DELETE FROM nopk', { database: 'shop', confirmed: true });
      assert.ok(r.affectedRows >= 1);
      // terjebak di dalam string/komentar bukan "tanpa WHERE"
      await dbm.query(s.id, "UPDATE customers SET note='x where y' WHERE id=2", { database: 'shop' });
    });

    await test('mode hanya-baca: SELECT jalan; INSERT/UPDATE/DDL/SET ditolak (klien dan server)', async () => {
      const r = await dbm.query(sro.id, 'SELECT COUNT(*) FROM customers', { database: 'shop' });
      assert.strictEqual(r.rows[0][0], '3');
      for (const q of ["INSERT INTO nopk VALUES (1,1)", "UPDATE customers SET name='x' WHERE id=1", 'CREATE TABLE zz (a int)', 'SET SESSION TRANSACTION READ WRITE', 'DROP TABLE nopk', 'SELECT 1; DELETE FROM nopk WHERE a=1']) {
        await assert.rejects(dbm.query(sro.id, q, { database: 'shop', confirmed: true }), (e) => e.code === 'READ_ONLY', q);
      }
      await assert.rejects(dbm.updateRow(sro.id, { db: 'shop', table: 'customers', key: { id: 1 }, changes: { name: 'x' } }), (e) => e.code === 'READ_ONLY');
      await assert.rejects(dbm.insertRow(sro.id, { db: 'shop', table: 'customers', values: { name: 'x' } }), (e) => e.code === 'READ_ONLY');
      await assert.rejects(dbm.deleteRow(sro.id, { db: 'shop', table: 'customers', key: { id: 1 } }), (e) => e.code === 'READ_ONLY');
      // pertahanan lapis kedua: server sendiri menolak tulis di sesi READ ONLY
      const raw = dbm.sessions.get(sro.id).conn;
      await assert.rejects(raw.query('INSERT INTO shop.nopk VALUES (1,1)'), (e) => /READ ONLY/i.test(e.message));
    });

    await test('ekspor CSV dan JSON: header, escape koma/kutip/baris baru, NULL kosong, rumus dinetralkan', async () => {
      const f = path.join(tmp, 'out.csv');
      const r = await dbm.exportTo(s.id, { sql: 'SELECT id, name, email, note FROM shop.customers ORDER BY id', format: 'csv', filePath: f });
      assert.strictEqual(r.rows, 3);
      const csv = fs.readFileSync(f, 'utf8');
      assert.ok(csv.startsWith('﻿id,name,email,note\r\n'));
      assert.ok(csv.includes("'=CMD()"), 'rumus harus dinetralkan');
      assert.ok(csv.includes('2,Siti,,'), 'NULL jadi kosong');
      await dbm.query(s.id, "UPDATE customers SET note = 'a \"b\", c\nd' WHERE id = 3", { database: 'shop' });
      await dbm.exportTo(s.id, { sql: 'SELECT note FROM shop.customers WHERE id = 3', format: 'csv', filePath: f });
      assert.ok(fs.readFileSync(f, 'utf8').includes('"a ""b"", c\nd"'));
      const j = path.join(tmp, 'out.json');
      await dbm.exportTo(s.id, { sql: 'SELECT id, id FROM shop.customers LIMIT 1', format: 'json', filePath: j });
      assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(j, 'utf8'))[0]), ['id', 'id_2']);
      await assert.rejects(dbm.exportTo(s.id, { sql: 'DELETE FROM shop.nopk WHERE a=1', format: 'csv', filePath: f }), /SELECT/);
    });

    await test('sesi: satu sesi per koneksi, putus SSH menutup sesi DB dan mengirim event', async () => {
      const again = await dbm.connect({ connId: rw.id, sshSessionId: 'ssh1' });
      assert.strictEqual(again.id, s.id);
      await assert.rejects(dbm.databases('tidak-ada'), (e) => e.code === 'NO_DB_SESSION');
      dbm.disconnect(sro.id);
      await assert.rejects(dbm.databases(sro.id), (e) => e.code === 'NO_DB_SESSION');
      ssh.close('ssh1');
      await sleep(200);
      assert.strictEqual(dbm.active().length, 0);
      assert.ok(events.some(([c, p]) => c === 'db:event' && p.type === 'closed' && p.dbSessionId === s.id));
      await assert.rejects(dbm.connect({ connId: rw.id, sshSessionId: 'ssh1' }), (e) => /tidak aktif|Sesi/i.test(e.message));
    });

    ssh.closeAll();
    sshSrv.close();
  } finally {
    cleanup();
    await sleep(300);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* abaikan */ }
  }
  console.log(`\n${passed} tes lulus.`);
  setTimeout(() => process.exit(process.exitCode || 0), 100);
})().catch((e) => { console.error(e); process.exit(1); });
