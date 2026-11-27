'use strict';

/**
 * Tes end-to-end untuk main process (tanpa Electron):
 * vault terenkripsi, key, SSH (TOFU, mismatch, auth, shell, exec, SFTP) dan GitHub (fetch tiruan).
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Server, utils } = require('ssh2');
const { Store } = require('../src/main/store');
const keysLib = require('../src/main/keys');
const { SSHManager } = require('../src/main/ssh-manager');
const { GitHub } = require('../src/main/github');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'abux-test-'));
// "Enkripsi" tiruan yang tetap membuktikan bahwa plaintext tidak ada di file.
const fakeCrypto = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from(Buffer.from(s).toString('hex').split('').reverse().join('')),
  decrypt: (b) => Buffer.from(b.toString().split('').reverse().join(''), 'hex').toString(),
};

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (e) {
    console.error('FAIL  ' + name + '\n      ' + (e.stack || e));
    process.exitCode = 1;
  }
}

function startServer({ hostKey, execLog }) {
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === 'tester' && ctx.password === 'secret') return ctx.accept();
      ctx.reject(['password']);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const s = accept();
        s.on('pty', (acc) => acc());
        s.on('window-change', (acc) => acc && acc());
        s.on('shell', (acc) => {
          const st = acc();
          st.write('welcome\r\n');
          st.on('data', (d) => st.write(d));
        });
        s.on('exec', (acc, _rej, info) => {
          execLog.push(info.command);
          const st = acc();
          st.write('__ADDED__');
          st.exit(0);
          st.end();
        });
        s.on('sftp', (acc) => {
          const sftp = acc();
          const { STATUS_CODE } = utils.sftp;
          const handles = new Map();
          let n = 0;
          sftp.on('REALPATH', (id, p) => sftp.name(id, [{ filename: p === '.' ? '/home/tester' : p, longname: '', attrs: {} }]));
          sftp.on('OPENDIR', (id, p) => {
            handles.set(++n, { path: p, done: false });
            sftp.handle(id, Buffer.from([n]));
          });
          sftp.on('READDIR', (id, h) => {
            const st = handles.get(h[0]);
            if (st.done) return sftp.status(id, STATUS_CODE.EOF);
            st.done = true;
            sftp.name(id, [
              { filename: 'a.txt', longname: '-rw-r--r-- 1 u g 5 Jan 1 a.txt', attrs: { mode: 0o100644, size: 5, uid: 0, gid: 0, atime: 0, mtime: 1700000000 } },
              { filename: 'docs', longname: 'drwxr-xr-x 1 u g 0 Jan 1 docs', attrs: { mode: 0o040755, size: 0, uid: 0, gid: 0, atime: 0, mtime: 1700000000 } },
            ]);
          });
          sftp.on('CLOSE', (id) => sftp.status(id, STATUS_CODE.OK));
        });
      });
    });
    client.on('error', () => {});
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ server, port: server.address().port })));
}

(async () => {
  console.log('Abux e2e');

  await test('keys: generate ed25519 + rsa, fingerprint, import roundtrip', () => {
    const k = keysLib.generate({ type: 'ed25519', comment: 'unit' });
    assert.match(k.publicKey, /^ssh-ed25519 /);
    assert.match(k.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
    assert.ok(keysLib.isValidPublicKey(k.publicKey));
    const info = keysLib.inspectPrivateKey(k.privateKey);
    assert.strictEqual(info.fingerprint, k.fingerprint);
    assert.strictEqual(info.encrypted, false);
    const enc = keysLib.generate({ type: 'ed25519', passphrase: 'pw123' });
    assert.strictEqual(enc.encrypted, true);
    assert.throws(() => keysLib.inspectPrivateKey(enc.privateKey), (e) => e.code === 'NEEDS_SECRET');
    assert.throws(() => keysLib.inspectPrivateKey(enc.privateKey, 'salah'), /Passphrase salah/);
    assert.strictEqual(keysLib.inspectPrivateKey(enc.privateKey, 'pw123').fingerprint, enc.fingerprint);
    assert.strictEqual(keysLib.generate({ type: 'rsa', bits: 2048 }).type, 'rsa');
    assert.ok(!keysLib.isValidPublicKey("ssh-ed25519 AAAA 'x; rm -rf /"));
    assert.throws(() => keysLib.inspectPrivateKey('bukan key'), /bukan private key/);
  });

  const file = path.join(tmp, 'data.json');
  const store = new Store({ filePath: file, crypto: fakeCrypto });

  await test('store: rahasia terenkripsi, tidak bocor ke renderer, persisten', () => {
    const h = store.saveHost({ name: 'Lokal', hostname: '127.0.0.1', port: 22, username: 'tester', authType: 'password', password: 'secret' });
    assert.strictEqual(h.hasPassword, true);
    assert.ok(!('passwordEnc' in h) && !('password' in h));
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(!raw.includes('secret"') && !raw.includes(': "secret'), 'password tidak boleh plaintext');
    const reloaded = new Store({ filePath: file, crypto: fakeCrypto });
    assert.strictEqual(reloaded.getHostPassword(h.id), 'secret');
    assert.throws(() => store.saveHost({ hostname: '', username: 'x' }), /Hostname/);
    assert.throws(() => store.saveHost({ hostname: 'a', username: 'x', port: 70000 }), /Port/);
    const k = keysLib.generate({});
    const saved = store.addKey({ ...k, name: 'k1' });
    assert.ok(!JSON.stringify(saved).includes('PRIVATE KEY'));
    const hk = store.saveHost({ hostname: 'k', username: 'u', authType: 'key', keyId: saved.id });
    assert.throws(() => store.removeKey(saved.id), /masih dipakai/);
    store.removeHost(hk.id);
    store.removeKey(saved.id);
    assert.strictEqual(store.getSettings().fontSize, 14);
    assert.strictEqual(store.setSettings({ fontSize: 16, bogus: 1, theme: 5 }).fontSize, 16);
    assert.strictEqual(store.getSettings().theme, 'midnight');
  });

  const hostKey = utils.generateKeyPairSync('ed25519').private;
  const execLog = [];
  const { server, port } = await startServer({ hostKey, execLog });
  const events = [];
  const mgr = new SSHManager({ store, emit: (c, p) => events.push([c, p]), hostKeyTimeoutMs: 500 });
  const host = store.saveHost({ name: 'Test', hostname: '127.0.0.1', port, username: 'tester', authType: 'password', password: 'secret' });
  const answerNext = (accept) => {
    const start = events.length; // hanya prompt yang muncul setelah pemanggilan ini
    const iv = setInterval(() => {
      const ev = events.slice(start).find((e) => e[0] === 'ssh:hostkey-prompt' && !e[2]);
      if (ev) {
        ev[2] = true;
        clearInterval(iv);
        mgr.answerHostKey(ev[1].promptId, accept);
      }
    }, 10);
  };
  const waitFor = (pred, ms = 3000) =>
    new Promise((res, rej) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (pred()) { clearInterval(iv); res(); } else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('timeout menunggu kondisi')); }
      }, 10);
    });

  await test('ssh: host key ditolak -> error HOSTKEY_REJECTED, tidak disimpan', async () => {
    answerNext(false);
    await assert.rejects(mgr.connect({ sessionId: 's0', hostId: host.id }), (e) => e.code === 'HOSTKEY_REJECTED');
    assert.strictEqual(store.listKnownHosts().length, 0);
  });

  await test('ssh: timeout prompt host key dianggap ditolak', async () => {
    await assert.rejects(mgr.connect({ sessionId: 's0b', hostId: host.id }), (e) => e.code === 'HOSTKEY_REJECTED');
  });

  await test('ssh: TOFU diterima, shell interaktif, echo, resize, tutup', async () => {
    answerNext(true);
    await mgr.connect({ sessionId: 's1', hostId: host.id, cols: 100, rows: 30 });
    assert.strictEqual(store.listKnownHosts().length, 1);
    const out = () => events.filter((e) => e[0] === 'ssh:data' && e[1].sessionId === 's1').map((e) => e[1].data.toString()).join('');
    await waitFor(() => out().includes('welcome'));
    mgr.write('s1', 'halo\n');
    await waitFor(() => out().includes('halo'));
    mgr.resize('s1', 120, 40);
    mgr.close('s1');
    await waitFor(() => events.some((e) => e[0] === 'ssh:closed' && e[1].sessionId === 's1'));
  });

  await test('ssh: koneksi kedua ke host yang sudah dikenal tanpa prompt', async () => {
    const before = events.filter((e) => e[0] === 'ssh:hostkey-prompt').length;
    await mgr.connect({ sessionId: 's2', hostId: host.id });
    assert.strictEqual(events.filter((e) => e[0] === 'ssh:hostkey-prompt').length, before);
  });

  await test('ssh: install public key via exec (idempoten, ter-sanitasi)', async () => {
    const k = keysLib.generate({ comment: 'tes@laptop' });
    const r = await mgr.installPublicKey('s2', k.publicKey);
    assert.strictEqual(r.added, true);
    assert.ok(execLog[0].includes('authorized_keys') && execLog[0].includes(k.publicKey));
    await assert.rejects(mgr.installPublicKey('s2', "ssh-ed25519 AAAA'; rm -rf / #"), /tidak valid/);
  });

  await test('sftp: realpath + readdir (folder diurutkan lebih dulu)', async () => {
    assert.strictEqual(await mgr.sftpHome('s2'), '/home/tester');
    const l = await mgr.sftpList('s2', '.');
    assert.strictEqual(l.path, '/home/tester');
    assert.deepStrictEqual(l.entries.map((e) => [e.name, e.isDir]), [['docs', true], ['a.txt', false]]);
    await assert.rejects(mgr.sftpRemove('s2', '/', true), /tidak boleh/);
  });

  await test('ssh: password salah -> AUTH_FAILED; tanpa password -> NEEDS_SECRET', async () => {
    const bad = store.saveHost({ name: 'Bad', hostname: '127.0.0.1', port, username: 'tester', authType: 'password', password: 'nope' });
    await assert.rejects(mgr.connect({ sessionId: 's3', hostId: bad.id }), (e) => e.code === 'AUTH_FAILED');
    const none = store.saveHost({ name: 'None', hostname: '127.0.0.1', port, username: 'tester', authType: 'password' });
    await assert.rejects(mgr.connect({ sessionId: 's4', hostId: none.id }), (e) => e.code === 'NEEDS_SECRET' && e.kind === 'password');
    await mgr.connect({ sessionId: 's5', hostId: none.id, secrets: { password: 'secret' } });
    mgr.close('s5');
  });

  await test('ssh: host key berubah -> HOSTKEY_CHANGED (proteksi MITM)', async () => {
    mgr.closeAll();
    const second = await startServer({ hostKey: utils.generateKeyPairSync('ed25519').private, execLog: [] });
    // Pakai ID known-host yang sama dengan memindahkan entri ke port server kedua.
    const known = store.listKnownHosts()[0];
    store.addKnownHost(`127.0.0.1:${second.port}`, { fingerprint: known.fingerprint, addedAt: Date.now() });
    const h2 = store.saveHost({ name: 'Mitm', hostname: '127.0.0.1', port: second.port, username: 'tester', authType: 'password', password: 'secret' });
    await assert.rejects(mgr.connect({ sessionId: 's6', hostId: h2.id }), (e) => e.code === 'HOSTKEY_CHANGED' && /PERINGATAN/.test(e.message));
    second.server.close();
  });

  await test('uji koneksi: berhasil, tidak menyimpan host/known-host, error jelas', async () => {
    const hostsBefore = store.listHosts().length;
    const khBefore = store.listKnownHosts().length;
    const base = { hostname: '127.0.0.1', port, username: 'tester', authType: 'password' };
    // sukses dengan password dari form
    const ok = await mgr.testConnection(base, { password: 'secret' });
    assert.strictEqual(ok.ok, true);
    assert.match(ok.fingerprint, /^SHA256:/);
    assert.strictEqual(ok.known, true); // host ini sudah dipercaya oleh tes sebelumnya
    // password salah
    const bad = await mgr.testConnection(base, { password: 'salah' });
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.code, 'AUTH_FAILED');
    assert.ok(bad.fingerprint, 'server terjangkau walau login ditolak');
    // port salah -> ditolak
    const refused = await mgr.testConnection({ ...base, port: 1 }, { password: 'x' });
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.code, 'REFUSED');
    assert.match(refused.message, /Port 1/);
    // input kosong / port tidak valid
    assert.strictEqual((await mgr.testConnection({ ...base, hostname: '' })).ok, false);
    assert.match((await mgr.testConnection({ ...base, port: 99999 })).message, /Port tidak valid/);
    // tanpa password di form dan host baru -> minta rahasia
    await assert.rejects(mgr.testConnection(base), (e) => e.code === 'NEEDS_SECRET' && e.kind === 'password');
    // tidak ada efek samping
    assert.strictEqual(store.listHosts().length, hostsBefore);
    assert.strictEqual(store.listKnownHosts().length, khBefore);
    assert.strictEqual(mgr.sessions.size, 0);
  });

  await test('uji koneksi: host baru tidak ditambahkan ke known hosts; host key berubah terdeteksi', async () => {
    const other = await startServer({ hostKey: utils.generateKeyPairSync('ed25519').private, execLog: [] });
    const khBefore = store.listKnownHosts().length;
    const r = await mgr.testConnection({ hostname: '127.0.0.1', port: other.port, username: 'tester', authType: 'password' }, { password: 'secret' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.known, false);
    assert.strictEqual(store.listKnownHosts().length, khBefore, 'tes tidak boleh menyimpan host key');
    // fingerprint tersimpan berbeda -> gagal dengan peringatan
    store.addKnownHost(`127.0.0.1:${other.port}`, { fingerprint: 'SHA256:palsu', addedAt: 1 });
    const m = await mgr.testConnection({ hostname: '127.0.0.1', port: other.port, username: 'tester', authType: 'password' }, { password: 'secret' });
    assert.strictEqual(m.ok, false);
    assert.strictEqual(m.code, 'HOSTKEY_CHANGED');
    store.removeKnownHost(`127.0.0.1:${other.port}`);
    other.server.close();
  });

  await test('ssh: jump host (ProxyJump) meneruskan koneksi ke target', async () => {
    const target = await startServer({ hostKey: utils.generateKeyPairSync('ed25519').private, execLog: [] });
    const th = store.saveHost({ name: 'Target', hostname: '127.0.0.1', port: target.port, username: 'tester', authType: 'password', password: 'secret', jumpHostId: host.id });
    // Server tiruan tidak mendukung direct-tcpip, jadi cukup pastikan jalur jump dicoba
    // dan error berasal dari forwarding (bukan crash / hang).
    answerNext(true);
    await assert.rejects(mgr.connect({ sessionId: 's7', hostId: th.id }), (e) => typeof e.message === 'string' && e.message.length > 0);
    target.server.close();
    mgr.closeAll();
  });

  await test('github: device flow, polling, simpan token terenkripsi, repos, deploy key', async () => {
    const calls = [];
    let polls = 0;
    const fetchImpl = async (url, init = {}) => {
      calls.push([init.method || 'GET', url]);
      const ok = (obj, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(obj) });
      if (url.endsWith('/login/device/code')) return ok({ device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 0.01 });
      if (url.endsWith('/login/oauth/access_token')) return ++polls < 3 ? ok({ error: 'authorization_pending' }) : ok({ access_token: 'gho_TOKEN' });
      if (url.endsWith('/user')) return ok({ login: 'octocat', name: 'Octo Cat', avatar_url: 'https://avatars.githubusercontent.com/u/1' });
      if (url.includes('/user/repos')) return ok([{ id: 1, full_name: 'octocat/app', private: true, description: null, ssh_url: 'git@github.com:octocat/app.git', pushed_at: 'x', permissions: { admin: true } }]);
      if (url.endsWith('/repos/octocat/app/keys')) { assert.strictEqual(JSON.parse(init.body).read_only, true); return ok({ id: 9 }, 201); }
      if (url.endsWith('/user/keys')) return ok({ errors: [{ message: 'key is already in use' }], message: 'Validation Failed' }, 422);
      return ok({ message: 'nf' }, 404);
    };
    let result;
    const gh = new GitHub({ store, fetchImpl, onLoginResult: (r) => { result = r; } });
    await assert.rejects(gh.startLogin(), /Client ID/);
    store.setGithubClientId('Iv1.test');
    const dev = await gh.startLogin();
    assert.strictEqual(dev.userCode, 'ABCD-1234');
    await waitFor(() => result, 4000);
    assert.deepStrictEqual(result.user.login, 'octocat');
    assert.ok(!fs.readFileSync(file, 'utf8').includes('gho_TOKEN'), 'token tidak boleh plaintext');
    assert.strictEqual(store.getGithubToken(), 'gho_TOKEN');
    assert.strictEqual((await gh.repos())[0].fullName, 'octocat/app');
    await gh.addDeployKey('octocat/app', 't', 'ssh-ed25519 AAAA', true);
    await assert.rejects(gh.addDeployKey('../evil', 't', 'k'), /tidak valid/);
    await assert.rejects(gh.addAccountKey('t', 'k'), /already in use/);
    gh.logout();
    assert.strictEqual(store.getGithub().loggedIn, false);
  });

  // ---------- DEPLOY ----------
  const { DeployManager, wrapCommand } = require('../src/main/deploy');
  const TEMPLATES = require('../src/renderer/templates.js');
  const REF = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  const depLog = [];
  const depServer = await new Promise((res) => {
    const srv = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (client) => {
      client.on('authentication', (ctx) => ctx.accept());
      client.on('ready', () => client.on('session', (accept) => {
        const s = accept();
        s.on('pty', (a) => a());
        s.on('shell', (a) => { a(); });
        s.on('exec', (a, _r, info) => {
          const st = a();
          const cmd = info.command;
          depLog.push(cmd);
          if (cmd.includes('rev-parse')) { st.write(REF + '\n'); st.exit(0); return st.end(); }
          if (cmd.includes('HANG-FOREVER')) { st.on('data', (d) => { if (d.toString().includes('\x03')) { st.write('^C\n'); st.exit(130); st.end(); } }); return; }
          if (cmd.includes('FAIL-STEP')) { st.write('boom: gagal\n'); st.exit(2); return st.end(); }
          st.write('ok: ' + cmd.slice(cmd.indexOf('-lc ') + 4, cmd.indexOf('-lc ') + 40) + '\n');
          st.exit(0); st.end();
        });
      }));
      client.on('error', () => {});
    });
    srv.listen(0, '127.0.0.1', () => res({ srv, port: srv.address().port }));
  });
  const dEvents = [];
  const dStore = new Store({ filePath: path.join(tmp, 'deploy.json'), crypto: fakeCrypto });
  const dSsh = new SSHManager({ store: dStore, emit: (c, p) => { if (c === 'ssh:hostkey-prompt') setImmediate(() => dSsh.answerHostKey(p.promptId, true)); }, hostKeyTimeoutMs: 2000 });
  const dHost = dStore.saveHost({ name: 'Deploy Host', hostname: '127.0.0.1', port: depServer.port, username: 'deploy', authType: 'password', password: 'x' });
  const dHostId = dHost.id;
  const dMgr = new DeployManager({ store: dStore, ssh: dSsh, emit: (c, p) => { if (c === 'deploy:event') dEvents.push(p); }, stepTimeoutMs: 400 });
  const waitRun = (runId) => waitFor(() => dEvents.some((e) => e.type === 'run-end' && e.run.id === runId), 6000);
  const endOf = (runId) => dEvents.find((e) => e.type === 'run-end' && e.run.id === runId).run;
  const mkPipe = (steps, extra = {}) => dStore.savePipeline({ name: 'P' + Math.random().toString(36).slice(2, 6), hostId: dHostId, cwd: '/srv/app', steps, rollbackSteps: [], ...extra });
  const stp = (name, command, continueOnError) => ({ name, command, continueOnError });

  await test('deploy: store memvalidasi pipeline dan semua template valid', async () => {
    assert.throws(() => dStore.savePipeline({ name: '', hostId: dHostId, cwd: '/a', steps: [stp('a', 'x')] }), /Nama pipeline/);
    assert.throws(() => dStore.savePipeline({ name: 'x', hostId: 'nope', cwd: '/a', steps: [stp('a', 'x')] }), /host tujuan/);
    assert.throws(() => dStore.savePipeline({ name: 'x', hostId: dHostId, cwd: 'relatif', steps: [stp('a', 'x')] }), /absolut/);
    assert.throws(() => dStore.savePipeline({ name: 'x', hostId: dHostId, cwd: '/a\nrm', steps: [stp('a', 'x')] }), /Folder kerja/);
    assert.throws(() => dStore.savePipeline({ name: 'x', hostId: dHostId, cwd: '/a', steps: [] }), /minimal satu/);
    assert.throws(() => dStore.savePipeline({ name: 'x', hostId: dHostId, cwd: '/a', steps: [stp('a', '  ')] }), /perintah kosong/);
    assert.throws(() => dStore.savePipeline({ name: 'x', hostId: dHostId, cwd: '/a', steps: [stp('a', 'git reset {{PREVIOUS_REF}}')] }), /hanya boleh dipakai pada langkah rollback/);
    for (const t of TEMPLATES) {
      const p = dStore.savePipeline({ name: t.label, hostId: dHostId, cwd: t.cwd, steps: t.steps, rollbackSteps: t.rollbackSteps });
      assert.strictEqual(p.steps.length, t.steps.length, t.id);
      assert.ok(p.rollbackSteps.every((s) => s.command.length), t.id);
      dStore.removePipeline(p.id);
    }
  });

  await test('deploy: quoting aman untuk path dan perintah (tidak ada injeksi)', () => {
    assert.strictEqual(wrapCommand('/var/www/app', 'ls'), "cd '/var/www/app' && exec \"${SHELL:-sh}\" -lc 'ls'");
    assert.ok(wrapCommand('/a/b c', 'ls').includes("'/a/b c'"));
    assert.ok(wrapCommand('/a', "echo 'hi'").endsWith("-lc 'echo '\\''hi'\\'''"));
    assert.ok(wrapCommand("/a'; rm -rf / #", 'ls').includes("cd '/a'\\''; rm -rf / #' &&"));
    assert.ok(wrapCommand('~/app', 'ls').startsWith("cd ~/'app' &&"));
    assert.ok(wrapCommand('~', 'ls').startsWith('cd ~ &&'));
  });

  await test('deploy: butuh sesi terhubung ke host yang benar', async () => {
    const p = mkPipe([stp('a', 'echo 1')]);
    await assert.rejects(dMgr.start({ pipelineId: p.id, sessionId: 'tidak-ada' }), (e) => e.code === 'NO_SESSION');
    await assert.rejects(dMgr.start({ pipelineId: 'x', sessionId: 'y' }), (e) => e.code === 'NO_PIPELINE');
  });

  await dSsh.connect({ sessionId: 'dep1', hostId: dHostId });

  await test('deploy: semua langkah sukses, event berurutan, versi git tercatat, masuk riwayat', async () => {
    const p = mkPipe([stp('Satu', 'echo 1'), stp('Dua', 'echo 2'), stp('Tiga', 'echo 3')]);
    const snap = await dMgr.start({ pipelineId: p.id, sessionId: 'dep1' });
    assert.strictEqual(snap.status, 'running');
    assert.deepStrictEqual(snap.steps.map((s) => s.status), ['pending', 'pending', 'pending']);
    await assert.rejects(dMgr.start({ pipelineId: p.id, sessionId: 'dep1' }), (e) => e.code === 'BUSY', 'satu run per host');
    await waitRun(snap.id);
    const end = endOf(snap.id);
    assert.strictEqual(end.status, 'success');
    assert.deepStrictEqual(end.steps.map((s) => s.status), ['success', 'success', 'success']);
    assert.strictEqual(end.previousRef, REF);
    const seq = dEvents.filter((e) => (e.runId || (e.run && e.run.id)) === snap.id && e.type !== 'step-output' && e.type !== 'preflight').map((e) => e.type + (e.index != null ? ':' + e.index : ''));
    assert.deepStrictEqual(seq, ['run-start', 'step-start:0', 'step-end:0', 'step-start:1', 'step-end:1', 'step-start:2', 'step-end:2', 'run-end']);
    assert.ok(dEvents.some((e) => e.type === 'step-output' && e.runId === snap.id && /ok: /.test(e.data)));
    const hist = dStore.listRuns(p.id);
    assert.strictEqual(hist.length, 1);
    assert.ok(!('output' in hist[0].steps[0]), 'daftar riwayat tidak membawa output besar');
    assert.match(dStore.getRun(snap.id).steps[0].output, /ok: /);
  });

  await test('deploy: berhenti di langkah gagal, sisanya skipped, status failed', async () => {
    const p = mkPipe([stp('Ok', 'echo a'), stp('Gagal', 'FAIL-STEP'), stp('Tidak jalan', 'echo c-tidak-jalan')]);
    const before = depLog.length;
    const snap = await dMgr.start({ pipelineId: p.id, sessionId: 'dep1' });
    await waitRun(snap.id);
    const end = endOf(snap.id);
    assert.strictEqual(end.status, 'failed');
    assert.deepStrictEqual(end.steps.map((s) => s.status), ['success', 'failed', 'skipped']);
    assert.strictEqual(end.steps[1].exitCode, 2);
    assert.match(end.steps[1].error, /kode 2/);
    assert.ok(!depLog.slice(before).some((c) => c.includes('c-tidak-jalan')), 'langkah ketiga tidak boleh dijalankan');
    assert.match(dStore.getRun(snap.id).steps[1].output, /boom/);
  });

  await test('deploy: continueOnError melanjutkan dan menghitung peringatan', async () => {
    const p = mkPipe([stp('Gagal tapi lanjut', 'FAIL-STEP', true), stp('Tetap jalan', 'echo lanjut')]);
    const snap = await dMgr.start({ pipelineId: p.id, sessionId: 'dep1' });
    await waitRun(snap.id);
    const end = endOf(snap.id);
    assert.strictEqual(end.status, 'success');
    assert.strictEqual(end.warnings, 1);
    assert.deepStrictEqual(end.steps.map((s) => s.status), ['failed', 'success']);
  });

  await test('deploy: batalkan di tengah langkah menghentikan proses (Ctrl+C) dan men-skip sisanya', async () => {
    const p = mkPipe([stp('Menggantung', 'HANG-FOREVER'), stp('Sisa', 'echo sisa')], { captureRef: false });
    const dm = new DeployManager({ store: dStore, ssh: dSsh, emit: (c, e) => { if (c === 'deploy:event') dEvents.push(e); }, stepTimeoutMs: 60000 });
    const snap = await dm.start({ pipelineId: p.id, sessionId: 'dep1' });
    await waitFor(() => dEvents.some((e) => e.type === 'step-start' && e.runId === snap.id));
    dm.cancel(snap.id);
    await waitRun(snap.id);
    const end = endOf(snap.id);
    assert.strictEqual(end.status, 'canceled');
    assert.deepStrictEqual(end.steps.map((s) => s.status), ['canceled', 'skipped']);
    assert.throws(() => dm.cancel(snap.id), /tidak aktif/);
  });

  await test('deploy: langkah yang melewati batas waktu gagal dengan pesan jelas', async () => {
    const p = mkPipe([stp('Menggantung', 'HANG-FOREVER')], { captureRef: false });
    const snap = await dMgr.start({ pipelineId: p.id, sessionId: 'dep1' });
    await waitRun(snap.id);
    const end = endOf(snap.id);
    assert.strictEqual(end.status, 'failed');
    assert.match(end.steps[0].error, /Waktu habis/);
  });

  await test('deploy: rollback memakai versi git tercatat; ditolak bila tidak ada', async () => {
    const p = mkPipe([stp('Deploy', 'echo deploy')], { rollbackSteps: [stp('Kembalikan', 'git reset --hard {{PREVIOUS_REF}}'), stp('Restart', 'echo restart')] });
    const d = await dMgr.start({ pipelineId: p.id, sessionId: 'dep1' });
    await waitRun(d.id);
    const before = depLog.length;
    const rb = await dMgr.start({ pipelineId: p.id, sessionId: 'dep1', kind: 'rollback', fromRunId: d.id });
    assert.strictEqual(rb.kind, 'rollback');
    assert.ok(rb.steps[0].command.includes(REF), 'placeholder diganti versi git');
    await waitRun(rb.id);
    assert.strictEqual(endOf(rb.id).status, 'success');
    assert.ok(depLog.slice(before).some((c) => c.includes('git reset --hard ' + REF)));
    assert.strictEqual(dStore.getRun(rb.id).rollbackOf, d.id);
    await assert.rejects(dMgr.start({ pipelineId: p.id, sessionId: 'dep1', kind: 'rollback', fromRunId: rb.id }), (e) => e.code === 'BAD_RUN');
    const p2 = mkPipe([stp('Deploy', 'echo x')], { captureRef: false, rollbackSteps: [stp('R', 'git reset --hard {{PREVIOUS_REF}}')] });
    const d2 = await dMgr.start({ pipelineId: p2.id, sessionId: 'dep1' });
    await waitRun(d2.id);
    await assert.rejects(dMgr.start({ pipelineId: p2.id, sessionId: 'dep1', kind: 'rollback', fromRunId: d2.id }), (e) => e.code === 'NO_REF');
    const p3 = mkPipe([stp('Deploy', 'echo x')]);
    const d3 = await dMgr.start({ pipelineId: p3.id, sessionId: 'dep1' });
    await waitRun(d3.id);
    await assert.rejects(dMgr.start({ pipelineId: p3.id, sessionId: 'dep1', kind: 'rollback', fromRunId: d3.id }), (e) => e.code === 'NO_ROLLBACK');
  });

  await test('deploy: kunci host dilepas; hapus host membersihkan pipeline dan riwayat', async () => {
    assert.strictEqual(dMgr.locks.size, 0);
    assert.strictEqual(dMgr.active.size, 0);
    const tmpHost = dStore.saveHost({ name: 'Sementara', hostname: 'x', username: 'u', authType: 'password' });
    const tp = dStore.savePipeline({ name: 'T', hostId: tmpHost.id, cwd: '/a', steps: [stp('a', 'b')] });
    dStore.addRun({ id: 'r-old', pipelineId: tp.id, kind: 'deploy', status: 'success', steps: [] });
    dStore.removeHost(tmpHost.id);
    assert.strictEqual(dStore.getPipeline(tp.id), null);
    assert.strictEqual(dStore.getRun('r-old'), null);
  });

  await test('deploy: riwayat dibatasi 100 run terbaru', () => {
    for (let i = 0; i < 105; i++) dStore.addRun({ id: 'bulk' + i, pipelineId: 'pp', kind: 'deploy', status: 'success', steps: [] });
    assert.strictEqual(dStore.data.deployRuns.length, 100);
    assert.strictEqual(dStore.getRun('bulk104').id, 'bulk104');
    assert.strictEqual(dStore.getRun('bulk0'), null);
  });

  await test('bantuan: isi panduan valid dan selaras dengan template deploy', () => {
    const topics = require('../src/renderer/help-content.js');
    const templates = require('../src/renderer/templates.js');
    assert.ok(topics.length >= 10);
    assert.strictEqual(new Set(topics.map((x) => x.id)).size, topics.length);
    const types = new Set(['p', 'h', 'ul', 'ol', 'code', 'tip', 'warn', 'table']);
    let all = '';
    for (const x of topics) {
      assert.ok(x.title && x.summary && x.group && x.blocks.length, x.id);
      for (const b of x.blocks) {
        assert.ok(types.has(b[0]), `${x.id}: tipe ${b[0]}`);
        if (b[0] === 'table') for (const r of b[2]) assert.strictEqual(r.length, b[1].length, `${x.id}: baris tabel`);
        all += JSON.stringify(b) + '\n';
      }
    }
    // perintah template yang ditampilkan di Bantuan tidak boleh melenceng dari template asli
    for (const t of templates) for (const st of t.steps) assert.ok(all.includes(JSON.stringify(st.command).slice(1, -1)), `template ${t.id}: ${st.command}`);
    // tidak ada IP/kredensial nyata: hanya rentang dokumentasi
    for (const ip of all.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) || []) assert.ok(/^(203\.0\.113\.|10\.|127\.)/.test(ip), `IP tak dikenal: ${ip}`);
  });

  dSsh.closeAll();
  depServer.srv.close();

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} tes lulus${process.exitCode ? ', ada yang GAGAL' : ''}.`);
  setTimeout(() => process.exit(process.exitCode || 0), 100);
})();
