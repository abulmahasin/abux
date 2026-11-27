'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Hasil dikirim apa adanya sebagai objek {ok, data|error, code, kind, label}.
// contextBridge membuang properti kustom pada Error, jadi error dibentuk ulang di renderer (bridge.js).
const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

function listen(channel, cb) {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('native', {
  app: {
    info: () => call('app:info'),
    openExternal: (url) => call('app:open-external', url),
  },
  clipboard: {
    read: () => call('clipboard:read'),
    write: (text) => call('clipboard:write', text),
  },
  settings: {
    get: () => call('settings:get'),
    set: (partial) => call('settings:set', partial),
  },
  knownHosts: {
    list: () => call('knownhosts:list'),
    remove: (id) => call('knownhosts:remove', id),
  },
  hosts: {
    list: () => call('hosts:list'),
    save: (h) => call('hosts:save', h),
    remove: (id) => call('hosts:remove', id),
  },
  snippets: {
    list: () => call('snippets:list'),
    save: (s) => call('snippets:save', s),
    remove: (id) => call('snippets:remove', id),
  },
  keys: {
    list: () => call('keys:list'),
    generate: (o) => call('keys:generate', o),
    pickFile: () => call('keys:pick-file'),
    importFile: (o) => call('keys:import-file', o || {}),
    publicKey: (id) => call('keys:public', id),
    remove: (id) => call('keys:remove', id),
    installOnServer: (o) => call('keys:install', o),
  },
  ssh: {
    connect: (o) => call('ssh:connect', o),
    testHost: (host, secrets) => call('ssh:test', { host, secrets }),
    write: (sessionId, data) => ipcRenderer.send('ssh:write', { sessionId, data }),
    resize: (sessionId, cols, rows) => ipcRenderer.send('ssh:resize', { sessionId, cols, rows }),
    close: (sessionId) => call('ssh:close', sessionId),
    answerHostKey: (promptId, accepted) => call('ssh:hostkey-answer', { promptId, accepted }),
    onData: (cb) => listen('ssh:data', cb),
    onClosed: (cb) => listen('ssh:closed', cb),
    onHostKeyPrompt: (cb) => listen('ssh:hostkey-prompt', cb),
  },
  pipelines: {
    list: () => call('pipelines:list'),
    save: (p) => call('pipelines:save', p),
    remove: (id) => call('pipelines:remove', id),
  },
  db: {
    conns: () => call('db:conns-list'),
    saveConn: (o) => call('db:conns-save', o),
    removeConn: (id) => call('db:conns-remove', id),
    test: (o) => call('db:test', o),
    connect: (o) => call('db:connect', o),
    disconnect: (id) => call('db:disconnect', id),
    active: () => call('db:active'),
    databases: (id) => call('db:databases', id),
    tables: (id, db) => call('db:tables', { id, db }),
    describe: (id, db, table) => call('db:describe', { id, db, table }),
    rows: (o) => call('db:rows', o),
    query: (o) => call('db:query', o),
    updateRow: (o) => call('db:row-update', o),
    insertRow: (o) => call('db:row-insert', o),
    deleteRow: (o) => call('db:row-delete', o),
    exportResult: (o) => call('db:export', o),
    onEvent: (cb) => listen('db:event', cb),
  },
  server: {
    monitor: (sessionId) => call('srv:monitor', { sessionId }),
    dockerPs: (sessionId, sudo) => call('srv:docker-ps', { sessionId, sudo }),
    dockerAction: (o) => call('srv:docker-action', o),
    composePs: (sessionId, dir, sudo) => call('srv:compose-ps', { sessionId, dir, sudo }),
    logFetch: (o) => call('srv:log-fetch', o),
    streamStart: (o) => call('stream:start', o),
    streamStop: (id) => call('stream:stop', id),
    onStreamData: (cb) => listen('stream:data', cb),
    onStreamEnd: (cb) => listen('stream:end', cb),
  },
  ci: {
    stacks: () => call('ci:stacks'),
    preview: (o) => call('ci:preview', o),
    provision: (o) => call('ci:provision', o),
  },
  backup: {
    exportTo: (passphrase) => call('backup:export', { passphrase }),
    importFrom: (passphrase) => call('backup:import', { passphrase }),
  },
  update: { check: () => call('update:check') },
  redis: {
    conns: () => call('redis:conns-list'),
    saveConn: (o) => call('redis:conns-save', o),
    removeConn: (id) => call('redis:conns-remove', id),
    test: (o) => call('redis:test', o),
    connect: (o) => call('redis:connect', o),
    disconnect: (id) => call('redis:disconnect', id),
    info: (id) => call('redis:info', id),
    scan: (o) => call('redis:scan', o),
    get: (o) => call('redis:get', o),
    del: (o) => call('redis:del', o),
    set: (o) => call('redis:set', o),
    expire: (o) => call('redis:expire', o),
    command: (o) => call('redis:command', o),
  },
  deploy: {
    start: (o) => call('deploy:start', o),
    cancel: (runId) => call('deploy:cancel', runId),
    active: () => call('deploy:active'),
    runs: (pipelineId) => call('deploy:runs', pipelineId),
    getRun: (id) => call('deploy:run-get', id),
    onEvent: (cb) => listen('deploy:event', cb),
  },
  sftp: {
    home: (sessionId) => call('sftp:home', sessionId),
    list: (sessionId, dir) => call('sftp:list', { sessionId, dir }),
    mkdir: (sessionId, path) => call('sftp:mkdir', { sessionId, path }),
    rename: (sessionId, from, to) => call('sftp:rename', { sessionId, from, to }),
    remove: (sessionId, path, isDir) => call('sftp:remove', { sessionId, path, isDir }),
    download: (sessionId, remotePath) => call('sftp:download', { sessionId, remotePath }),
    upload: (sessionId, remoteDir) => call('sftp:upload', { sessionId, remoteDir }),
    readText: (sessionId, path) => call('sftp:read-text', { sessionId, path }),
    writeText: (o) => call('sftp:write-text', o),
    onProgress: (cb) => listen('sftp:progress', cb),
  },
  github: {
    status: () => call('github:status'),
    setClientId: (id) => call('github:set-client-id', id),
    login: () => call('github:login'),
    cancelLogin: () => call('github:cancel-login'),
    logout: () => call('github:logout'),
    repos: () => call('github:repos'),
    addAccountKey: (o) => call('github:add-account-key', o),
    addDeployKey: (o) => call('github:add-deploy-key', o),
    onLoginResult: (cb) => listen('github:login-result', cb),
  },
});
