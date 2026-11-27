'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, clipboard, Menu, session } = require('electron');
const { Store } = require('./store');
const keysLib = require('./keys');
const { SSHManager } = require('./ssh-manager');
const { GitHub } = require('./github');
const { DbManager } = require('./db-manager');
const { DeployManager } = require('./deploy');
const tools = require('./server-tools');
const { StreamManager } = require('./stream-manager');
const { RedisManager } = require('./redis-manager');
const { provisionCi } = require('./ci-setup');
const { generateWorkflow, STACKS } = require('./workflow');
const backup = require('./backup');
const { checkForUpdate } = require('./updater');

let win = null;
let store;
let ssh;
let github;
let deploy;
let dbm;
let streams;
let redis;

const emit = (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

function openExternalSafe(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') shell.openExternal(u.toString());
  } catch (_) { /* abaikan */ }
}

/** Semua handler dibungkus agar error sampai ke renderer sebagai pesan yang bersih. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (e) {
      return { ok: false, error: e.message || String(e), code: e.code, kind: e.kind, label: e.label };
    }
  });
}

function registerIpc() {
  // --- app ---
  handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    secureStorage: {
      available: safeStorage.isEncryptionAvailable(),
      weak: process.platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function' && safeStorage.getSelectedStorageBackend() === 'basic_text',
    },
  }));
  handle('app:open-external', (url) => openExternalSafe(url));
  handle('clipboard:read', () => clipboard.readText());
  handle('clipboard:write', (text) => clipboard.writeText(String(text)));

  // --- settings ---
  handle('settings:get', () => store.getSettings());
  handle('settings:set', (partial) => store.setSettings(partial));
  handle('knownhosts:list', () => store.listKnownHosts());
  handle('knownhosts:remove', (id) => store.removeKnownHost(id));

  // --- hosts ---
  handle('hosts:list', () => store.listHosts());
  handle('hosts:save', (input) => store.saveHost(input));
  handle('hosts:remove', (id) => store.removeHost(id));

  // --- snippets ---
  handle('snippets:list', () => store.listSnippets());
  handle('snippets:save', (input) => store.saveSnippet(input));
  handle('snippets:remove', (id) => store.removeSnippet(id));

  // --- keys ---
  handle('keys:list', () => store.listKeys());
  handle('keys:generate', ({ name, type, passphrase, remember, bits }) => {
    const k = keysLib.generate({ type, passphrase, bits, comment: name || 'abux' });
    return store.addKey({ ...k, name, passphrase, remember });
  });
  handle('keys:pick-file', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Impor private key',
      properties: ['openFile', 'showHiddenFiles'],
      defaultPath: path.join(app.getPath('home'), '.ssh'),
    });
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  });
  handle('keys:import-file', async ({ passphrase, remember, name, filePath }) => {
    const fp = filePath;
    if (!fp || typeof fp !== 'string') throw new Error('Pilih file key terlebih dahulu.');
    const stat = fs.statSync(fp);
    if (stat.size > 64 * 1024) throw new Error('File terlalu besar untuk sebuah private key.');
    const info = keysLib.inspectPrivateKey(fs.readFileSync(fp, 'utf8'), passphrase);
    const k = store.addKey({ ...info, name: name || path.basename(fp), passphrase, remember });
    return { key: k, filePath: fp };
  });
  handle('keys:public', (id) => store.getKeyPublic(id));
  handle('keys:remove', (id) => store.removeKey(id));
  handle('keys:install', ({ sessionId, keyId }) => {
    const pub = store.getKeyPublic(keyId);
    if (!pub) throw new Error('Key tidak ditemukan.');
    return ssh.installPublicKey(sessionId, pub);
  });

  // --- ssh ---
  handle('ssh:connect', (opts) => ssh.connect(opts));
  handle('ssh:test', ({ host, secrets }) => ssh.testConnection(host, secrets));
  handle('ssh:hostkey-answer', ({ promptId, accepted }) => ssh.answerHostKey(promptId, accepted));
  ipcMain.on('ssh:write', (_e, { sessionId, data }) => ssh.write(sessionId, data));
  ipcMain.on('ssh:resize', (_e, { sessionId, cols, rows }) => ssh.resize(sessionId, cols, rows));
  handle('ssh:close', (sessionId) => ssh.close(sessionId));

  // --- deploy ---
  handle('pipelines:list', () => store.listPipelines());
  handle('pipelines:save', (input) => store.savePipeline(input));
  handle('pipelines:remove', (id) => {
    if ([...deploy.active.values()].some((r) => r.pipelineId === id)) throw new Error('Pipeline sedang berjalan, tunggu atau batalkan dulu.');
    store.removePipeline(id);
  });
  handle('deploy:start', (opts) => deploy.start(opts));
  handle('deploy:cancel', (runId) => deploy.cancel(runId));
  handle('deploy:active', () => deploy.activeRuns());
  handle('deploy:runs', (pipelineId) => store.listRuns(pipelineId));
  handle('deploy:run-get', (id) => store.getRun(id));

  // --- database ---
  handle('db:conns-list', () => store.listDbConns());
  handle('db:conns-save', (input) => store.saveDbConn(input));
  handle('db:conns-remove', (id) => {
    for (const a of dbm.active()) if (a.connId === id) dbm.disconnect(a.id);
    store.removeDbConn(id);
  });
  handle('db:test', (input) => dbm.testConnection(input));
  handle('db:connect', (opts) => dbm.connect(opts));
  handle('db:disconnect', (id) => dbm.disconnect(id));
  handle('db:active', () => dbm.active());
  handle('db:databases', (id) => dbm.databases(id));
  handle('db:tables', ({ id, db }) => dbm.tables(id, db));
  handle('db:describe', ({ id, db, table }) => dbm.describe(id, db, table));
  handle('db:rows', ({ id, ...rest }) => dbm.rows(id, rest));
  handle('db:query', ({ id, sql, confirmed, database }) => dbm.query(id, sql, { confirmed, database }));
  handle('db:row-update', ({ id, ...rest }) => dbm.updateRow(id, rest));
  handle('db:row-insert', ({ id, ...rest }) => dbm.insertRow(id, rest));
  handle('db:row-delete', ({ id, ...rest }) => dbm.deleteRow(id, rest));
  handle('db:export', async ({ id, sql, format, name }) => {
    const ext = format === 'json' ? 'json' : 'csv';
    const r = await dialog.showSaveDialog(win, {
      title: 'Ekspor hasil',
      defaultPath: path.join(app.getPath('downloads'), `${String(name || 'hasil').replace(/[^\w.-]+/g, '_')}.${ext}`),
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (r.canceled || !r.filePath) return null;
    return dbm.exportTo(id, { sql, format: ext, filePath: r.filePath });
  });

  // --- sftp ---
  handle('sftp:home', (sessionId) => ssh.sftpHome(sessionId));
  handle('sftp:list', ({ sessionId, dir }) => ssh.sftpList(sessionId, dir));
  handle('sftp:mkdir', ({ sessionId, path: p }) => ssh.sftpMkdir(sessionId, p));
  handle('sftp:rename', ({ sessionId, from, to }) => ssh.sftpRename(sessionId, from, to));
  handle('sftp:remove', ({ sessionId, path: p, isDir }) => ssh.sftpRemove(sessionId, p, isDir));
  handle('sftp:download', async ({ sessionId, remotePath }) => {
    const r = await dialog.showSaveDialog(win, {
      title: 'Simpan file',
      defaultPath: path.join(app.getPath('downloads'), path.posix.basename(remotePath)),
    });
    if (r.canceled || !r.filePath) return null;
    await ssh.sftpDownload(sessionId, remotePath, r.filePath);
    return r.filePath;
  });
  handle('sftp:upload', async ({ sessionId, remoteDir }) => {
    const r = await dialog.showOpenDialog(win, { title: 'Pilih file untuk diunggah', properties: ['openFile', 'multiSelections'] });
    if (r.canceled) return 0;
    for (const f of r.filePaths) await ssh.sftpUpload(sessionId, f, remoteDir);
    return r.filePaths.length;
  });

  // --- server: monitor, docker, log ---
  handle('srv:monitor', async ({ sessionId }) => {
    const r = await ssh.exec(sessionId, tools.MONITOR_SCRIPT);
    return tools.parseMonitor(r.stdout);
  });
  const dockerErr = (r) => {
    if (r.code === 0) return;
    const m = (r.stderr || r.stdout || '').trim();
    if (/permission denied/i.test(m)) { const e = new Error('Izin ditolak untuk Docker. Aktifkan opsi "sudo" atau tambahkan user ke grup docker.'); e.code = 'DOCKER_PERM'; throw e; }
    if (/not found|no such file/i.test(m) && /docker/i.test(m)) { const e = new Error('Docker tidak terpasang di server ini.'); e.code = 'NO_DOCKER'; throw e; }
    throw new Error(m || `Perintah gagal (kode ${r.code}).`);
  };
  handle('srv:docker-ps', async ({ sessionId, sudo }) => {
    const r = await ssh.exec(sessionId, tools.dockerPsCmd(!!sudo)); dockerErr(r);
    return tools.parseDockerPs(r.stdout);
  });
  handle('srv:docker-action', async ({ sessionId, action, id, sudo }) => {
    const r = await ssh.exec(sessionId, tools.dockerActionCmd(action, id, !!sudo)); dockerErr(r);
    return true;
  });
  handle('srv:compose-ps', async ({ sessionId, dir, sudo }) => {
    const r = await ssh.exec(sessionId, tools.composePsCmd(dir, !!sudo)); dockerErr(r);
    return tools.parseComposePs(r.stdout);
  });
  handle('srv:log-fetch', async ({ sessionId, source, lines, sudo }) => {
    const r = await ssh.exec(sessionId, tools.logFetchCmd(source, { lines, sudo: !!sudo }));
    if (r.code !== 0 && !r.stdout) throw new Error((r.stdout + r.stderr).trim() || `Gagal membaca log (kode ${r.code}).`);
    return { text: r.stdout.slice(-2 * 1024 * 1024) };
  });
  handle('stream:start', ({ sessionId, kind, ...o }) => {
    let cmd;
    if (kind === 'docker-logs') cmd = tools.dockerLogsCmd(o.id, { tail: o.tail, follow: true, sudo: !!o.sudo });
    else if (kind === 'compose-logs') cmd = tools.composeLogsCmd(o.dir, { tail: o.tail, follow: true, sudo: !!o.sudo });
    else if (kind === 'compose-action') cmd = tools.composeCmd(o.dir, o.action, !!o.sudo);
    else if (kind === 'log-follow') cmd = tools.logFollowCmd(o.source, { sudo: !!o.sudo });
    else throw new Error('Jenis aliran tidak dikenal.');
    return streams.start(sessionId, cmd);
  });
  handle('stream:stop', (id) => streams.stop(id));

  // --- CI/CD (workflow GitHub Actions) ---
  handle('ci:stacks', () => STACKS);
  handle('ci:preview', (o) => ({ yaml: generateWorkflow(o) }));
  handle('ci:provision', (o) => provisionCi({ ssh, store, github }, o));

  // --- editor SFTP ---
  handle('sftp:read-text', ({ sessionId, path: p }) => ssh.sftpReadText(sessionId, p));
  handle('sftp:write-text', ({ sessionId, path: p, content, expectedMtime, overwrite }) => ssh.sftpWriteText(sessionId, p, content, { expectedMtime, overwrite }));

  // --- cadangan & pembaruan ---
  handle('backup:export', async ({ passphrase }) => {
    const r = await dialog.showSaveDialog(win, { title: 'Simpan cadangan', defaultPath: path.join(app.getPath('downloads'), `abux-cadangan-${new Date().toISOString().slice(0, 10)}.json`), filters: [{ name: 'Cadangan Abux', extensions: ['json'] }] });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, backup.serialize(store, passphrase || ''), { mode: 0o600 });
    return r.filePath;
  });
  handle('backup:import', async ({ passphrase }) => {
    const r = await dialog.showOpenDialog(win, { title: 'Pilih berkas cadangan', properties: ['openFile'], filters: [{ name: 'Cadangan Abux', extensions: ['json'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    const st = fs.statSync(r.filePaths[0]);
    if (st.size > 8 * 1024 * 1024) throw new Error('Berkas terlalu besar.');
    const parsed = backup.parseBackup(fs.readFileSync(r.filePaths[0], 'utf8'), passphrase);
    return backup.applyBackup(store, parsed);
  });
  handle('update:check', () => checkForUpdate({ repo: store.getSettings().updateRepo, current: app.getVersion(), platform: process.platform, arch: process.arch }));

  // --- redis ---
  handle('redis:conns-list', () => store.listRedisConns());
  handle('redis:conns-save', (i) => store.saveRedisConn(i));
  handle('redis:conns-remove', (id) => { for (const a of redis.active()) if (a.connId === id) redis.disconnect(a.id); store.removeRedisConn(id); });
  handle('redis:test', (o) => redis.testConnection(o));
  handle('redis:connect', (o) => redis.connect(o));
  handle('redis:disconnect', (id) => redis.disconnect(id));
  handle('redis:info', (id) => redis.info(id));
  handle('redis:scan', ({ id, ...o }) => redis.scan(id, o));
  handle('redis:get', ({ id, key }) => redis.get(id, key));
  handle('redis:del', ({ id, key, confirmed }) => redis.del(id, key, confirmed));
  handle('redis:set', ({ id, key, value, ttl }) => redis.setString(id, key, value, ttl));
  handle('redis:expire', ({ id, key, ttl }) => redis.expire(id, key, ttl));
  handle('redis:command', ({ id, line, confirmed }) => redis.command(id, line, { confirmed }));

  // --- github ---
  handle('github:status', () => github.status());
  handle('github:set-client-id', (id) => store.setGithubClientId(id));
  handle('github:login', () => github.startLogin());
  handle('github:cancel-login', () => github.cancelLogin());
  handle('github:logout', () => github.logout());
  handle('github:repos', () => github.repos());
  handle('github:add-account-key', ({ keyId, title }) => {
    const pub = store.getKeyPublic(keyId);
    if (!pub) throw new Error('Key tidak ditemukan.');
    return github.addAccountKey(title, pub);
  });
  handle('github:add-deploy-key', ({ fullName, keyId, title, readOnly }) => {
    const pub = store.getKeyPublic(keyId);
    if (!pub) throw new Error('Key tidak ditemukan.');
    return github.addDeployKey(fullName, title, pub, readOnly);
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 600,
    backgroundColor: '#0b0f14',
    title: 'Abux',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('closed', () => {
    win = null;
  });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [isMac ? { role: 'close' } : { role: 'quit' }] },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-navigate', (e) => e.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      openExternalSafe(url);
      return { action: 'deny' };
    });
  });

  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    store = new Store({
      filePath: path.join(app.getPath('userData'), 'abux-data.json'),
      crypto: {
        isAvailable: () => safeStorage.isEncryptionAvailable(),
        encrypt: (s) => safeStorage.encryptString(s),
        decrypt: (b) => safeStorage.decryptString(b),
      },
    });
    ssh = new SSHManager({ store, emit });
    deploy = new DeployManager({ store, ssh, emit });
    dbm = new DbManager({ store, ssh, emit });
    streams = new StreamManager({ ssh, emit });
    redis = new RedisManager({ store, ssh });
    github = new GitHub({ store, onLoginResult: (r) => emit('github:login-result', r) });
    registerIpc();
    buildMenu();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => { if (dbm) dbm.closeAll(); if (redis) redis.closeAll(); if (streams) streams.stopAll(); if (ssh) ssh.closeAll(); });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
