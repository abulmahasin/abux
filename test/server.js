'use strict';

/** Tes fitur server: monitor, Docker (shim), log, stream, editor SFTP, workflow CI, backup, update, Redis. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const { Store } = require('../src/main/store');
const { SSHManager } = require('../src/main/ssh-manager');
const tools = require('../src/main/server-tools');
const LogView = require('../src/renderer/logview');
const { generateWorkflow } = require('../src/main/workflow');
const backup = require('../src/main/backup');
const { compareVersions, pickAsset, checkForUpdate } = require('../src/main/updater');
const { provisionCi, pinnedKnownHosts } = require('../src/main/ci-setup');
const keysLib = require('../src/main/keys');
const { RedisManager } = require('../src/main/redis-manager');
const { tokenize, checkCommand, parseOne } = require('../src/main/redis-client');
const { StreamManager } = require('../src/main/stream-manager');
const { startLocalSsh } = require('./helpers/localssh');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'abux-srv-'));
const fakeCrypto = { isAvailable: () => true, encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString() };
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n      ' + (e.stack || e)); process.exitCode = 1; }
}
const waitFor = (pred, ms = 5000) => new Promise((res, rej) => { const t0 = Date.now(); const iv = setInterval(() => { if (pred()) { clearInterval(iv); res(); } else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('timeout')); } }, 20); });
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

(async () => {
  // ---------- murni ----------
  await test('monitor: parser /proc + df + ps, persen CPU dari dua sampel', () => {
    const out = '##cpu\ncpu  100 0 100 800 0 0 0 0\n##cores\n4\n##mem\nMemTotal: 1000 kB\nMemAvailable: 250 kB\nSwapTotal: 100 kB\nSwapFree: 100 kB\n##load\n0.5 0.4 0.3 1/100 5\n##up\n3600.55\n##disk\n/dev/vda1 1000 900 100 90% /\n##ps\n  PID USER %CPU %MEM COMMAND\n 12 root 5.5 1.0 nginx: worker\n';
    const m = tools.parseMonitor(out);
    assert.strictEqual(m.cores, 4); assert.strictEqual(m.mem.used, 750 * 1024); assert.deepStrictEqual(m.load, [0.5, 0.4, 0.3]);
    assert.strictEqual(m.disks[0].pct, 90); assert.strictEqual(m.procs[0].cmd, 'nginx: worker'); assert.strictEqual(m.uptime, 3600);
    assert.strictEqual(tools.cpuPercent({ total: 1000, idle: 800 }, { total: 1100, idle: 850 }), 50);
    assert.strictEqual(tools.cpuPercent(null, m.cpu), null);
  });

  await test('docker/log: perintah dibangun aman, input berbahaya ditolak', () => {
    assert.strictEqual(tools.dockerActionCmd('restart', 'web-1', false), "docker restart 'web-1'");
    assert.strictEqual(tools.dockerActionCmd('stop', 'web', true), "sudo -n docker stop 'web'");
    for (const bad of ['a; rm -rf /', '$(id)', '', '-v', 'a b', 'a`b`']) assert.throws(() => tools.dockerActionCmd('stop', bad), /tidak valid/);
    assert.throws(() => tools.dockerActionCmd('rm', 'x'), /tidak dikenal/);
    assert.throws(() => tools.composeCmd('relatif', 'up'), /absolut/);
    assert.throws(() => tools.composeCmd('/a\n/b', 'up'), /absolut/);
    assert.strictEqual(tools.composeCmd("/srv/it's", 'up'), "cd '/srv/it'\\''s' && docker compose up -d 2>&1");
    assert.ok(tools.dockerLogsCmd('web', { tail: 99999 }).includes('--tail 5000'));
    assert.strictEqual(tools.logFetchCmd({ kind: 'laravel', dir: '/var/www/app/' }, { lines: 50 }), "tail -n 50 -- '/var/www/app/storage/logs/laravel.log' 2>&1");
    assert.ok(tools.logFollowCmd({ kind: 'nginx_error' }).includes('tail -n 0 -F'));
    assert.ok(tools.logFetchCmd({ kind: 'journal' }).startsWith('journalctl'));
    assert.throws(() => tools.logFetchCmd({ kind: 'file', path: '../etc/passwd' }), /absolut/);
    assert.throws(() => tools.logFetchCmd({ kind: 'x' }), /tidak dikenal/);
  });

  await test('docker: parser ps & compose (NDJSON dan array)', () => {
    const ps = tools.parseDockerPs('{"ID":"abcdef1234567890","Names":"web","Image":"nginx","State":"running","Status":"Up 2h","Ports":"80/tcp"}\nnoise\n');
    assert.deepStrictEqual([ps[0].id, ps[0].name, ps[0].state], ['abcdef123456', 'web', 'running']);
    assert.strictEqual(tools.parseComposePs('[{"Name":"p-web-1","Service":"web","State":"exited"}]')[0].service, 'web');
    assert.strictEqual(tools.parseComposePs('{"Name":"a","Service":"b","State":"running"}\n{"Name":"c","Service":"d"}')[1].service, 'd');
  });

  await test('log: level, pengelompokan stack trace, filter + pencarian', () => {
    const lines = ['[2026-01-01 10:00:00] local.ERROR: Boom {"a":1}', '#0 /app/x.php(1): foo()', '#1 {main}', '[2026-01-01 10:00:01] local.INFO: ok', '[2026-01-01 10:00:02] local.WARNING: lambat', '2026/01/01 10:00:03 [error] 1#1: *1 gagal'];
    const g = LogView.group(lines);
    assert.strictEqual(g.length, 4); assert.ok(g[0].text.includes('#1 {main}'));
    assert.deepStrictEqual(g.map((e) => e.level), ['error', 'info', 'warning', 'error']);
    assert.strictEqual(LogView.filter(g, { lvl: 'error' }).length, 2);
    assert.strictEqual(LogView.filter(g, { lvl: 'warning' }).length, 3);
    assert.strictEqual(LogView.filter(g, { q: 'LAMBAT' }).length, 1);
  });

  await test('workflow: YAML valid, tanpa rahasia, input berbahaya ditolak', () => {
    const y = generateWorkflow({ stack: 'node', branch: 'main', appDir: '/var/www/app', deployCommands: 'git pull\nnpm ci\npm2 reload app' });
    const r = spawnSync('python3', ['-c', 'import sys,yaml;d=yaml.safe_load(sys.stdin);print(sorted(d["jobs"]), d["jobs"]["deploy"]["needs"])'], { input: y, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr); assert.ok(r.stdout.includes("['deploy', 'test'] test"));
    assert.ok(y.includes('secrets.ABUX_SSH_KEY') && y.includes('StrictHostKeyChecking=yes') && !y.includes('PRIVATE KEY'));
    assert.ok(generateWorkflow({ stack: 'php', branch: 'main', appDir: '~/app', deployCommands: 'php artisan migrate --force' }).includes('shivammathur/setup-php'));
    assert.throws(() => generateWorkflow({ stack: 'node', branch: 'main; rm', appDir: '/a', deployCommands: 'x' }), /branch/);
    assert.throws(() => generateWorkflow({ stack: 'node', branch: 'main', appDir: 'rel', deployCommands: 'x' }), /absolut/);
    assert.throws(() => generateWorkflow({ stack: 'node', branch: 'main', appDir: '/a', deployCommands: 'echo ${{ secrets.X }}' }), /\$\{\{/);
    assert.throws(() => generateWorkflow({ stack: 'node', branch: 'main', appDir: '/a', deployCommands: 'ABUX_DEPLOY_EOF' }), /terlarang/);
    assert.throws(() => generateWorkflow({ stack: 'node', branch: 'main', appDir: '/a', deployCommands: '  ' }), /minimal/);
  });

  await test('update: bandingkan versi, pilih aset, cek rilis (fetch tiruan)', async () => {
    assert.strictEqual(compareVersions('1.10.0', '1.9.9'), 1); assert.strictEqual(compareVersions('v1.0.0', '1.0.0'), 0); assert.strictEqual(compareVersions('0.9.9', '1.0.0'), -1);
    const assets = [{ name: 'Abux-1.1.0-arm64.dmg', browser_download_url: 'https://github.com/a/b/releases/download/v1/arm.dmg' }, { name: 'Abux-1.1.0.dmg', browser_download_url: 'https://github.com/a/b/releases/download/v1/x64.dmg' }, { name: 'Abux Setup.exe', browser_download_url: 'https://github.com/a/b/x.exe' }];
    assert.ok(pickAsset(assets, 'darwin', 'arm64').name.includes('arm64')); assert.ok(!pickAsset(assets, 'darwin', 'x64').name.includes('arm64')); assert.ok(pickAsset(assets, 'win32', 'x64').name.endsWith('.exe'));
    const mk = (status, body) => async () => ({ status, ok: status < 400, json: async () => body });
    const r = await checkForUpdate({ repo: 'a/b', current: '1.0.0', platform: 'darwin', arch: 'arm64', fetchImpl: mk(200, { tag_name: 'v1.1.0', html_url: 'https://github.com/a/b/releases/tag/v1.1.0', assets }) });
    assert.strictEqual(r.upToDate, false); assert.strictEqual(r.latest, '1.1.0'); assert.ok(r.asset.url.startsWith('https://github.com/'));
    assert.strictEqual((await checkForUpdate({ repo: 'a/b', current: '1.1.0', platform: 'linux', arch: 'x64', fetchImpl: mk(200, { tag_name: 'v1.1.0', assets: [] }) })).upToDate, true);
    assert.strictEqual((await checkForUpdate({ repo: 'a/b', current: '1.0.0', platform: 'linux', arch: 'x64', fetchImpl: mk(404, {}) })).upToDate, true);
    await assert.rejects(checkForUpdate({ repo: 'OWNER/abux', current: '1', platform: 'linux', arch: 'x64' }), (e) => e.code === 'NO_REPO');
    await assert.rejects(checkForUpdate({ repo: '', current: '1', platform: 'linux', arch: 'x64' }), (e) => e.code === 'NO_REPO');
    const evil = await checkForUpdate({ repo: 'a/b', current: '1.0.0', platform: 'win32', arch: 'x64', fetchImpl: mk(200, { tag_name: '2.0.0', html_url: 'http://evil', assets: [{ name: 'a.exe', browser_download_url: 'https://evil.com/a.exe' }] }) });
    assert.ok(evil.page.startsWith('https://github.com/') && evil.asset === null);
  });

  // ---------- store/backup ----------
  const store = new Store({ filePath: path.join(tmp, 'a.json'), crypto: fakeCrypto });
  const hostA = store.saveHost({ name: 'A', hostname: 'a.example.com', port: 22, username: 'u', authType: 'password', password: 'RAHASIA-A' });
  const hostB = store.saveHost({ name: 'B', hostname: 'b.example.com', port: 2200, username: 'u', authType: 'agent', jumpHostId: hostA.id });
  store.saveSnippet({ name: 's', command: 'ls' });
  store.savePipeline({ name: 'p', hostId: hostA.id, cwd: '/srv/app', steps: [{ name: 'x', command: 'git pull' }] });
  store.saveDbConn({ name: 'db', hostId: hostA.id, user: 'root', password: 'DBRAHASIA' });
  store.saveRedisConn({ name: 'r', hostId: hostA.id, password: 'REDISRAHASIA' });
  store.addKnownHost('a.example.com:22', { fingerprint: 'SHA256:abc', addedAt: 1 });
  store.setSettings({ fontSize: 18, updateRepo: 'me/abux' });

  await test('backup: tanpa rahasia, impor menggabung tanpa menimpa, referensi dijaga', () => {
    const text = backup.serialize(store, '');
    for (const secret of ['RAHASIA-A', 'DBRAHASIA', 'REDISRAHASIA', 'passwordEnc', 'tokenEnc']) assert.ok(!text.includes(secret), 'bocor: ' + secret);
    const s2 = new Store({ filePath: path.join(tmp, 'b.json'), crypto: fakeCrypto });
    const res = backup.applyBackup(s2, backup.parseBackup(text));
    assert.deepStrictEqual([res.hosts, res.snippets, res.pipelines, res.dbConns], [2, 1, 1, 1]);
    assert.strictEqual(s2.listHosts().find((h) => h.id === hostB.id).jumpHostId, hostA.id);
    assert.strictEqual(s2.listHosts()[0].hasPassword, false);
    assert.strictEqual(s2.getSettings().fontSize, 18); assert.strictEqual(s2.listKnownHosts().length, 1);
    const again = backup.applyBackup(s2, backup.parseBackup(text));
    assert.strictEqual(again.hosts + again.snippets + again.pipelines + again.dbConns, 0); assert.strictEqual(s2.listHosts().length, 2);
  });

  await test('backup: terenkripsi passphrase, salah passphrase & berkas bukan cadangan ditolak', () => {
    const enc = backup.serialize(store, 'rahasia-123');
    assert.ok(!enc.includes('a.example.com'));
    assert.throws(() => backup.parseBackup(enc), (e) => e.code === 'NEEDS_PASSPHRASE');
    assert.throws(() => backup.parseBackup(enc, 'salah'), (e) => e.code === 'BAD_PASSPHRASE');
    assert.strictEqual(backup.parseBackup(enc, 'rahasia-123').data.hosts.length, 2);
    assert.throws(() => backup.parseBackup('{"a":1}'), /bukan cadangan/);
    assert.throws(() => backup.parseBackup('bukan json'), /bukan JSON/);
  });

  await test('backup: item jahat (key/host tak dikenal, port salah) dilewati', () => {
    const s3 = new Store({ filePath: path.join(tmp, 'c.json'), crypto: fakeCrypto });
    const r = backup.applyBackup(s3, { format: 'abux-backup', version: 1, data: { hosts: [{ id: 'h1', hostname: 'x', username: 'u', port: 99999 }, { id: 'h2', hostname: 'x', username: 'u', authType: 'key', keyId: 'hilang' }], pipelines: [{ id: 'p', hostId: 'tidak-ada', cwd: '/a', steps: [{ command: 'x' }] }], dbConns: [{ id: 'd', hostId: 'tidak-ada', user: 'u', dbPort: 3306 }], settings: { fontSize: 'besar', evil: 1 } } });
    assert.strictEqual(r.hosts, 1); assert.strictEqual(r.skipped, 3); assert.strictEqual(s3.listHosts()[0].authType, 'password'); assert.strictEqual(s3.getSettings().fontSize, 14);
  });

  await test('store: validasi koneksi Redis', () => {
    assert.throws(() => store.saveRedisConn({ name: 'x', hostId: 'tidak-ada' }), /host SSH/);
    assert.throws(() => store.saveRedisConn({ name: 'x', hostId: hostA.id, redisPort: 70000 }), /Port/);
    assert.throws(() => store.saveRedisConn({ name: 'x', hostId: hostA.id, dbIndex: 999 }), /0-255/);
    const c = store.listRedisConns().find((x) => x.name === 'r');
    assert.strictEqual(c.hasPassword, true); assert.ok(!('passwordEnc' in c)); assert.strictEqual(c.readOnly, true);
    store.removeHost('nonexistent'); const before = store.listRedisConns().length;
    const tmpHost = store.saveHost({ name: 'T', hostname: 't', username: 'u', authType: 'agent' });
    store.saveRedisConn({ name: 'rt', hostId: tmpHost.id }); store.removeHost(tmpHost.id);
    assert.strictEqual(store.listRedisConns().length, before);
  });

  // ---------- CI ----------
  await test('ci: provisioning urut, host key di-pin, private key hanya ke GitHub', async () => {
    const k = keysLib.generate({ comment: 'hostkey' });
    const parsed = require('ssh2').utils.parseKey(k.publicKey);
    const b64 = parsed.getPublicSSH().toString('base64');
    const s = new Store({ filePath: path.join(tmp, 'd.json'), crypto: fakeCrypto });
    const h = s.saveHost({ name: 'H', hostname: 'srv.example.com', port: 2222, username: 'deploy', authType: 'agent' });
    s.addKnownHost('srv.example.com:2222', { fingerprint: k.fingerprint, addedAt: 1 });
    const calls = [];
    const fakeSsh = { exec: async () => ({ code: 0, stdout: `ssh-ed25519 ${b64} root@srv\nssh-rsa AAAAB3Nza root@srv\n` }), installPublicKey: async (sid, pub) => { calls.push(['install', pub]); return { added: true }; } };
    const secrets = {}; let committed;
    const fakeGh = { setRepoSecret: async (repo, n, v) => { secrets[n] = v; }, putFile: async (repo, p, c, m, br) => { committed = { repo, p, c, br }; return { updated: false }; } };
    const base = { sessionId: 'x', hostId: h.id, fullName: 'me/app', branch: 'main', stack: 'node', appDir: '/srv/app', deployCommands: 'git pull' };
    const r = await provisionCi({ ssh: fakeSsh, store: s, github: fakeGh }, base);
    assert.ok(r.steps.every((x) => x.ok)); assert.strictEqual(r.steps.length, 9);
    assert.strictEqual(secrets.ABUX_KNOWN_HOSTS, `[srv.example.com]:2222 ssh-ed25519 ${b64}`);
    assert.ok(secrets.ABUX_SSH_KEY.includes('BEGIN OPENSSH PRIVATE KEY')); assert.strictEqual(secrets.ABUX_SSH_PORT, '2222'); assert.strictEqual(secrets.ABUX_SSH_USER, 'deploy');
    assert.ok(calls[0][1].startsWith('ssh-ed25519 ')); assert.strictEqual(committed.p, '.github/workflows/abux-deploy.yml');
    assert.ok(!committed.c.includes('BEGIN OPENSSH') && !JSON.stringify(r).includes('BEGIN OPENSSH'));
    // host key tidak cocok -> berhenti sebelum menyentuh server/GitHub
    const bad = { ...fakeSsh, exec: async () => ({ code: 0, stdout: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOther root' }) };
    const before = Object.keys(secrets).length;
    await assert.rejects(provisionCi({ ssh: bad, store: s, github: fakeGh }, base), (e) => /cocok/.test(e.message) && e.steps[0].ok === false);
    assert.strictEqual(Object.keys(secrets).length, before); assert.strictEqual(calls.length, 1);
    await assert.rejects(provisionCi({ ssh: fakeSsh, store: s, github: fakeGh }, { ...base, appDir: 'x' }), /absolut/);
    const j = s.saveHost({ name: 'J', hostname: 'j', username: 'u', authType: 'agent', jumpHostId: h.id });
    await assert.rejects(provisionCi({ ssh: fakeSsh, store: s, github: fakeGh }, { ...base, hostId: j.id }), /jump host/);
  });

  await test('github: secret dienkripsi sealed-box yang bisa dibuka public key repo; putFile', async () => {
    const sodium = require('libsodium-wrappers'); await sodium.ready;
    const kp = sodium.crypto_box_keypair();
    const { GitHub } = require('../src/main/github');
    const s = new Store({ filePath: path.join(tmp, 'e.json'), crypto: fakeCrypto });
    s.setGithubAuth({ token: 'tok', user: { login: 'me' } });
    const reqs = [];
    const fetchImpl = async (url, o) => {
      reqs.push([o.method, url.replace('https://api.github.com', ''), o.body && JSON.parse(o.body)]);
      const reply = (status, b) => ({ status, ok: status < 400, text: async () => JSON.stringify(b) });
      if (url.endsWith('/actions/secrets/public-key')) return reply(200, { key_id: 'k1', key: sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL) });
      if (url.includes('/contents/') && o.method === 'GET') return reply(404, { message: 'Not Found' });
      return reply(200, { content: { html_url: 'https://github.com/x' } });
    };
    const gh = new GitHub({ store: s, fetchImpl });
    await gh.setRepoSecret('me/app', 'ABUX_SSH_KEY', 'nilai-rahasia');
    const put = reqs.find((r) => r[0] === 'PUT');
    assert.strictEqual(put[1], '/repos/me/app/actions/secrets/ABUX_SSH_KEY'); assert.strictEqual(put[2].key_id, 'k1');
    assert.strictEqual(sodium.to_string(sodium.crypto_box_seal_open(sodium.from_base64(put[2].encrypted_value, sodium.base64_variants.ORIGINAL), kp.publicKey, kp.privateKey)), 'nilai-rahasia');
    assert.ok(!JSON.stringify(reqs).includes('nilai-rahasia'));
    const r = await gh.putFile('me/app', '.github/workflows/x.yml', 'a: 1\n', 'msg', 'main');
    assert.strictEqual(r.updated, false);
    await assert.rejects(gh.setRepoSecret('bad repo', 'ABUX_X', 'v'), /tidak valid/);
    await assert.rejects(gh.setRepoSecret('me/app', 'lower', 'v'), /tidak valid/);
    await assert.rejects(gh.putFile('me/app', '../x', 'a', 'm'), /tidak valid/);
  });

  // ---------- SSH lokal sungguhan ----------
  const shim = path.join(tmp, 'bin'); fs.mkdirSync(shim);
  fs.writeFileSync(path.join(shim, 'docker'), `#!/bin/sh
case "$1" in
  ps) echo '{"ID":"aaaaaaaaaaaa1111","Names":"web","Image":"nginx:1","State":"running","Status":"Up 1h","Ports":"80/tcp"}'; echo '{"ID":"bbbbbbbbbbbb2222","Names":"db","Image":"mariadb","State":"exited","Status":"Exited (0)","Ports":""}';;
  restart|start|stop) echo "$1 $2" >> "${tmp}/docker.log";;
  logs) echo "2026-01-01T00:00:00Z log baris 1"; sleep 0.3; echo "2026-01-01T00:00:01Z log baris 2"; sleep 30;;
  compose) shift; case "$1" in ps) echo '[{"Name":"app-web-1","Service":"web","State":"running"}]';; *) echo "compose $*";; esac;;
esac
`, { mode: 0o755 });
  const logRoot = path.join(tmp, 'app'); fs.mkdirSync(path.join(logRoot, 'storage/logs'), { recursive: true });
  fs.writeFileSync(path.join(logRoot, 'storage/logs/laravel.log'), '[2026-01-01 10:00:00] local.ERROR: Boom\n#0 x\n[2026-01-01 10:00:01] local.INFO: ok\n');
  const srv = await startLocalSsh({ env: { ...process.env, PATH: shim + ':' + process.env.PATH } });
  const events = [];
  const store2 = new Store({ filePath: path.join(tmp, 'f.json'), crypto: fakeCrypto });
  const mgr = new SSHManager({ store: store2, emit: (c, p) => { events.push([c, p]); if (c === 'ssh:hostkey-prompt') setTimeout(() => mgr.answerHostKey(p.promptId, true), 0); } });
  const hostL = store2.saveHost({ name: 'L', hostname: '127.0.0.1', port: srv.port, username: 'x', authType: 'password', password: 'p' });
  await mgr.connect({ sessionId: 'S', hostId: hostL.id });
  const stream = new StreamManager({ ssh: mgr, emit: (c, p) => events.push([c, p]) });

  await test('monitor: server sungguhan (/proc, df, ps) menghasilkan data wajar', async () => {
    const r = await mgr.exec('S', tools.MONITOR_SCRIPT);
    const m = tools.parseMonitor(r.stdout);
    assert.ok(m.cpu && m.cpu.total > 0 && m.cores >= 1); assert.ok(m.mem && m.mem.total > 0 && m.mem.used <= m.mem.total); assert.ok(m.load && m.uptime > 0); assert.ok(m.disks.length >= 1);
    const r2 = tools.parseMonitor((await mgr.exec('S', tools.MONITOR_SCRIPT)).stdout);
    const pct = tools.cpuPercent(m.cpu, r2.cpu); assert.ok(pct === null || (pct >= 0 && pct <= 100));
  });

  await test('docker: daftar, aksi, compose lewat server (shim)', async () => {
    const ps = tools.parseDockerPs((await mgr.exec('S', tools.dockerPsCmd(false))).stdout);
    assert.deepStrictEqual(ps.map((c) => [c.name, c.state]), [['web', 'running'], ['db', 'exited']]);
    await mgr.exec('S', tools.dockerActionCmd('restart', 'web', false));
    assert.strictEqual(fs.readFileSync(path.join(tmp, 'docker.log'), 'utf8').trim(), 'restart web');
    assert.strictEqual(tools.parseComposePs((await mgr.exec('S', tools.composePsCmd(logRoot, false))).stdout)[0].service, 'web');
    assert.ok((await mgr.exec('S', tools.composeCmd(logRoot, 'up', false))).stdout.includes('compose up -d'));
  });

  await test('log: ambil log Laravel dari server + pengelompokan', async () => {
    const r = await mgr.exec('S', tools.logFetchCmd({ kind: 'laravel', dir: logRoot }, { lines: 100 }));
    const g = LogView.group(r.stdout.split('\n'));
    assert.strictEqual(g.length, 2); assert.strictEqual(g[0].level, 'error'); assert.ok(g[0].text.includes('#0 x'));
  });

  await test('stream: log langsung mengalir, bisa dihentikan, berhenti saat sesi putus', async () => {
    const { id } = await stream.start('S', tools.dockerLogsCmd('web', { follow: true }));
    const got = () => events.filter((e) => e[0] === 'stream:data' && e[1].id === id).map((e) => e[1].data).join('');
    await waitFor(() => got().includes('baris 2'));
    assert.strictEqual(stream.streams.size, 1);
    stream.stop(id);
    await waitFor(() => events.some((e) => e[0] === 'stream:end' && e[1].id === id), 6000);
    assert.strictEqual(stream.streams.size, 0);
    const s2 = await stream.start('S', tools.dockerLogsCmd('web', { follow: true }));
    stream.stopForSession('S');
    await waitFor(() => events.some((e) => e[0] === 'stream:end' && e[1].id === s2.id), 6000);
  });

  await test('sftp editor: baca, simpan, konflik mtime, biner & terlalu besar ditolak', async () => {
    const f = path.join(tmp, 'edit.txt'); fs.writeFileSync(f, 'halo dunia\nbaris 2\n');
    const r = await mgr.sftpReadText('S', f);
    assert.strictEqual(r.content, 'halo dunia\nbaris 2\n');
    const w = await mgr.sftpWriteText('S', f, 'diubah ✓\n', { expectedMtime: r.mtime });
    assert.strictEqual(fs.readFileSync(f, 'utf8'), 'diubah ✓\n'); assert.ok(w.size > 0);
    fs.writeFileSync(f, 'dari luar'); fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
    await assert.rejects(mgr.sftpWriteText('S', f, 'timpa', { expectedMtime: r.mtime }), (e) => e.code === 'CONFLICT');
    assert.strictEqual(fs.readFileSync(f, 'utf8'), 'dari luar');
    await mgr.sftpWriteText('S', f, 'timpa sengaja', { expectedMtime: r.mtime, overwrite: true });
    assert.strictEqual(fs.readFileSync(f, 'utf8'), 'timpa sengaja');
    const b = path.join(tmp, 'x.bin'); fs.writeFileSync(b, Buffer.from([1, 0, 2, 255]));
    await assert.rejects(mgr.sftpReadText('S', b), (e) => e.code === 'BINARY');
    const big = path.join(tmp, 'big.txt'); fs.writeFileSync(big, 'a'.repeat(3 * 1024 * 1024));
    await assert.rejects(mgr.sftpReadText('S', big), (e) => e.code === 'TOO_BIG');
    await assert.rejects(mgr.sftpReadText('S', path.join(tmp, 'tidak-ada')), /./);
    const nw = path.join(tmp, 'baru.txt'); await mgr.sftpWriteText('S', nw, 'baru');
    assert.strictEqual(fs.readFileSync(nw, 'utf8'), 'baru');
  });

  // ---------- Redis ----------
  await test('redis: tokenizer, pemeriksa perintah, parser RESP', () => {
    assert.deepStrictEqual(tokenize('SET k "a b" \'c d\''), ['SET', 'k', 'a b', 'c d']);
    assert.throws(() => tokenize('SET "x'), /kutip/);
    assert.throws(() => checkCommand('SET a b', { readOnly: true }), (e) => e.code === 'READ_ONLY');
    assert.throws(() => checkCommand('FLUSHALL', { readOnly: false }), (e) => e.code === 'BLOCKED');
    assert.throws(() => checkCommand('DEL a', { readOnly: false }), (e) => e.code === 'NEEDS_CONFIRM');
    assert.deepStrictEqual(checkCommand('DEL a', { readOnly: false, confirmed: true }), ['DEL', 'a']);
    assert.deepStrictEqual(checkCommand('get a', { readOnly: true }), ['get', 'a']);
    assert.strictEqual(parseOne(Buffer.from('$5\r\nab')), null);
    assert.deepStrictEqual(parseOne(Buffer.from('*2\r\n$1\r\na\r\n:5\r\n')).value, ['a', 5]);
  });

  const redisPort = await freePort();
  let rproc = null;
  if (spawnSync('which', ['redis-server']).status === 0) {
    rproc = spawn('redis-server', ['--port', String(redisPort), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no', '--requirepass', 'rpw'], { stdio: 'ignore' });
    await waitFor(() => { try { const s = net.connect(redisPort, '127.0.0.1'); s.on('error', () => {}); s.destroy(); return true; } catch (_) { return false; } });
    await new Promise((r) => setTimeout(r, 600));
  }
  if (rproc) {
    const rm = new RedisManager({ store: store2, ssh: mgr });
    const rc = store2.saveRedisConn({ name: 'real', hostId: hostL.id, redisPort, password: 'rpw', readOnly: false });
    await test('redis: uji koneksi, password salah/kosong, versi terbaca', async () => {
      const t = await rm.testConnection({ connId: rc.id, sshSessionId: 'S' });
      assert.ok(/^\d/.test(t.version));
      await assert.rejects(rm.testConnection({ sshSessionId: 'S', redisPort, password: 'salah' }), (e) => /Autentikasi|WRONGPASS|invalid/i.test(e.message));
      await assert.rejects(rm.testConnection({ sshSessionId: 'S', redisPort }), (e) => e.code === 'NEEDS_SECRET');
    });
    await test('redis: scan, baca semua tipe, ubah, hapus butuh konfirmasi, hanya-baca', async () => {
      const s = await rm.connect({ connId: rc.id, sshSessionId: 'S' });
      for (const a of [['SET', 'user:1', `'{"n":1}'`], ['RPUSH', 'q', 'a', 'b'], ['SADD', 'st', 'x', 'y'], ['ZADD', 'z', '1', 'm'], ['HSET', 'h', 'f', 'v']]) await rm.command(s.id, a.join(' '));
      const sc = await rm.scan(s.id, { match: '*' });
      assert.strictEqual(sc.keys.length, 5); assert.deepStrictEqual(sc.keys.find((k) => k.key === 'h').type, 'hash');
      assert.strictEqual((await rm.get(s.id, 'user:1')).value, '{"n":1}');
      assert.deepStrictEqual((await rm.get(s.id, 'q')).value, ['a', 'b']);
      assert.deepStrictEqual((await rm.get(s.id, 'h')).value, [{ field: 'f', value: 'v' }]);
      assert.deepStrictEqual((await rm.get(s.id, 'z')).value, [{ member: 'm', score: '1' }]);
      assert.strictEqual((await rm.get(s.id, 'st')).value.length, 2);
      await rm.setString(s.id, 'user:1', 'baru', 100); const g = await rm.get(s.id, 'user:1'); assert.strictEqual(g.value, 'baru'); assert.ok(g.ttl > 0 && g.ttl <= 100);
      await rm.expire(s.id, 'user:1', 0); assert.strictEqual((await rm.get(s.id, 'user:1')).ttl, -1);
      await assert.rejects(rm.del(s.id, 'q', false), (e) => e.code === 'NEEDS_CONFIRM');
      assert.strictEqual(await rm.del(s.id, 'q', true), 1);
      await assert.rejects(rm.get(s.id, 'q'), (e) => e.code === 'NO_KEY');
      await assert.rejects(rm.command(s.id, 'FLUSHALL'), (e) => e.code === 'BLOCKED');
      assert.ok((await rm.info(s.id)).version);
      assert.strictEqual((await rm.command(s.id, 'PING')).result, 'PONG');
      rm.disconnect(s.id);
      const ro = await rm.connect({ sshSessionId: 'S', redisPort, password: 'rpw', readOnly: true });
      await assert.rejects(rm.setString(ro.id, 'x', '1'), (e) => e.code === 'READ_ONLY');
      await assert.rejects(rm.command(ro.id, 'SET x 1'), (e) => e.code === 'READ_ONLY');
      assert.strictEqual((await rm.get(ro.id, 'h')).type, 'hash');
      rm.closeAll();
    });
  } else console.log('  --  tes Redis dilewati (redis-server tidak ada di PATH)');

  console.log(`\n${passed} tes lulus`);
  if (rproc) rproc.kill();
  mgr.closeAll(); srv.server.close();
  setTimeout(() => process.exit(process.exitCode || 0), 100);
})();
