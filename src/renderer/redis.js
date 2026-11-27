'use strict';

/* Panel Redis: koneksi lewat terowongan SSH, penjelajah key (SCAN), nilai per tipe, konsol perintah. */
(() => {
  const { h, icon, toast, field, modal, confirmDialog, promptDialog } = window.UI;
  const api = window.api;
  const App = window.AbuxApp;
  const errMsg = (e) => (e && e.message ? e.message : String(e));
  const R = { conns: [], sessions: new Map(), pane: null };
  const hostOf = (id) => App.state.hosts.find((x) => x.id === id);
  const live = (id) => R.sessions.get(id);
  async function reload() { R.conns = await api.redis.conns(); }
  const refreshSidebar = () => { if (App.state.view === 'redis') App.renderBody(); };
  async function init() { await reload(); }

  function renderSidebar(body) {
    const q = App.state.filter.toLowerCase();
    if (!App.state.hosts.length) { body.append(h('div', { class: 'empty' }, h('b', {}, 'Belum ada host'), 'Tambahkan host SSH dulu. Redis diakses lewat terowongan SSH, tanpa membuka port 6379 ke internet.')); return; }
    if (!R.conns.length) { body.append(h('div', { class: 'empty' }, h('b', {}, 'Belum ada koneksi Redis'), 'Jelajahi key cache/queue/session di server Anda.', h('div', { style: { marginTop: '12px' } }, h('button', { class: 'btn primary', onclick: () => editConn() }, 'Tambah koneksi')))); return; }
    for (const c of R.conns.filter((c) => !q || c.name.toLowerCase().includes(q))) {
      const host = hostOf(c.hostId);
      body.append(h('div', { class: 'item', tabindex: '0', role: 'button', onclick: () => openConn(c), onkeydown: (e) => { if (e.key === 'Enter') openConn(c); } },
        h('span', { class: 'icon', style: { color: live(c.id) ? 'var(--ok)' : '#ef4444' } }, icon('redis')),
        h('div', { class: 'grow' }, h('div', { class: 'title' }, c.name, ' ', h('span', { class: 'badge' + (c.readOnly ? '' : ' priv') }, c.readOnly ? 'baca' : 'baca-tulis')), h('div', { class: 'sub mono' }, `${host ? host.name : 'Host dihapus'} · ${c.redisHost}:${c.redisPort} · db${c.dbIndex}`)),
        h('div', { class: 'actions' },
          window.UI.iconButton('edit', 'Ubah', (e) => { e.stopPropagation(); editConn(c); }),
          window.UI.iconButton('trash', 'Hapus', async (e) => { e.stopPropagation(); if (await confirmDialog({ title: 'Hapus koneksi?', message: c.name, confirmLabel: 'Hapus', danger: true })) { await api.redis.removeConn(c.id); R.sessions.delete(c.id); await reload(); refreshSidebar(); } }))));
    }
  }

  function editConn(c) {
    const name = h('input', { value: c ? c.name : '', placeholder: 'Redis produksi' });
    const hostSel = h('select', {}, App.state.hosts.map((x) => h('option', { value: x.id, selected: c && c.hostId === x.id }, x.name)));
    const rh = h('input', { value: c ? c.redisHost : '127.0.0.1', class: 'mono' });
    const rp = h('input', { type: 'number', value: c ? c.redisPort : 6379 });
    const dbi = h('input', { type: 'number', value: c ? c.dbIndex : 0, min: 0, max: 255 });
    const pw = h('input', { type: 'password', placeholder: c && c.hasPassword ? '•••••• (kosongkan agar tetap)' : 'Kosongkan bila Redis tanpa password', autocomplete: 'off' });
    const ro = h('input', { type: 'checkbox', checked: c ? c.readOnly : true });
    const result = h('div', { class: 'db-note', hidden: true });
    const show = (ok, t) => { result.hidden = false; result.className = 'db-note' + (ok ? ' ok' : ' err'); result.textContent = t; };
    const payload = () => ({ id: c && c.id, name: name.value, hostId: hostSel.value, redisHost: rh.value, redisPort: Number(rp.value), dbIndex: Number(dbi.value), readOnly: ro.checked });
    async function test(pwOverride) {
      show(true, 'Menguji…');
      try {
        const host = hostOf(hostSel.value);
        const ssh = await window.Deploy.ensureSession(host);
        const p = { sshSessionId: ssh.id, redisHost: rh.value, redisPort: Number(rp.value), dbIndex: Number(dbi.value) };
        const pass = pwOverride !== undefined ? pwOverride : pw.value;
        if (pass) p.password = pass; else if (c && c.hasPassword) p.connId = c.id;
        const r = await api.redis.test(p);
        show(true, `Koneksi berhasil (${r.ms} ms) · Redis ${r.version}`);
      } catch (e) {
        if (e.code === 'NEEDS_SECRET') { const v = await promptDialog({ title: 'Password Redis diperlukan', message: 'Hanya untuk uji ini, tidak disimpan.', label: 'Password Redis', type: 'password', confirmLabel: 'Uji' }); if (v !== null) return test(v); }
        show(false, errMsg(e));
      }
    }
    modal({
      title: c ? 'Ubah koneksi Redis' : 'Koneksi Redis baru', width: 520,
      body: h('div', {}, field('Nama', name), field('Host SSH', hostSel, 'Redis dijangkau lewat terowongan dari host ini.'),
        h('div', { class: 'row' }, field('Alamat Redis di server', rh), h('div', { class: 'narrow field' }, h('label', {}, 'Port'), rp), h('div', { class: 'narrow field' }, h('label', {}, 'DB'), dbi)),
        field('Password Redis', pw), h('label', { class: 'check' }, ro, 'Hanya baca (disarankan untuk produksi)'), result),
      buttons: [{ label: 'Batal' }, { label: 'Uji koneksi', onClick: () => { test(); return false; } }, { label: 'Simpan', kind: 'primary', onClick: async () => { const p = payload(); if (pw.value) p.password = pw.value; await api.redis.saveConn(p); await reload(); refreshSidebar(); } }],
    });
  }

  async function openConn(c) {
    try {
      const host = hostOf(c.hostId); if (!host) throw new Error('Host koneksi ini sudah dihapus.');
      const ex = live(c.id);
      if (ex) { try { await api.redis.info(ex.id); return mount(c, ex); } catch (_) { R.sessions.delete(c.id); } }
      const ssh = await window.Deploy.ensureSession(host);
      let s;
      try { s = await api.redis.connect({ connId: c.id, sshSessionId: ssh.id }); } catch (e) {
        if (e.code !== 'NEEDS_SECRET') throw e;
        const pw = await promptDialog({ title: 'Password Redis diperlukan', message: c.name, label: 'Password Redis', type: 'password', confirmLabel: 'Sambungkan' });
        if (pw === null) return;
        s = await api.redis.connect({ connId: c.id, sshSessionId: ssh.id, password: pw });
      }
      R.sessions.set(c.id, s); refreshSidebar(); mount(c, s);
    } catch (e) { toast(errMsg(e), 'err'); }
  }

  function unmount() { if (R.pane) { R.pane.el.remove(); R.pane = null; } }
  async function disconnect(c, s) { unmount(); R.sessions.delete(c.id); await api.redis.disconnect(s.id).catch(() => {}); refreshSidebar(); }

  function mount(conn, sess) {
    unmount();
    const W = { conn, sess, keys: [], cursor: '0', done: false, match: '*', sel: null, tab: 'keys', detail: null, hist: [] };
    const el = h('section', { id: 'redis-pane', class: 'db-pane', 'aria-label': 'Panel Redis' });
    document.getElementById('main').append(el);
    R.pane = { el, W };
    paint(W);
    loadKeys(W, true); loadInfo(W);
  }

  function paint(W) {
    const el = R.pane.el;
    const tabs = [['keys', 'Key'], ['console', 'Konsol']];
    W.infoEl = h('span', { class: 'sub mono' });
    el.replaceChildren(
      h('header', { class: 'db-head' }, h('button', { class: 'btn small', onclick: unmount }, '← Terminal'),
        h('div', { class: 'db-title' }, icon('redis'), h('b', {}, W.conn.name), W.infoEl, h('span', { class: 'badge' + (W.sess.readOnly ? '' : ' priv') }, W.sess.readOnly ? 'HANYA BACA' : 'BACA-TULIS')),
        h('div', { class: 'db-tabs', style: { border: 0, background: 'transparent' } }, tabs.map(([id, l]) => h('button', { class: W.tab === id ? 'on' : '', onclick: () => { W.tab = id; paint(W); if (id === 'keys') loadKeys(W, true); } }, l))),
        h('div', { class: 'grow' }), h('button', { class: 'btn small', onclick: () => disconnect(W.conn, W.sess) }, 'Putuskan')),
      W.tab === 'keys' ? keysView(W) : consoleView(W));
    if (W.info) setInfo(W);
  }

  async function loadInfo(W) { try { W.info = await api.redis.info(W.sess.id); setInfo(W); } catch (_) { /* abaikan */ } }
  function setInfo(W) { if (W.infoEl && W.info) W.infoEl.textContent = `v${W.info.version} · ${W.info.keys} key · ${W.info.usedMemory} · ${W.info.clients} klien`; }

  async function loadKeys(W, reset) {
    if (reset) { W.keys = []; W.cursor = '0'; W.done = false; }
    try {
      let guardN = 0;
      do {
        const r = await api.redis.scan({ id: W.sess.id, cursor: W.cursor, match: W.match, count: 300 });
        W.cursor = r.cursor; W.keys.push(...r.keys); W.done = r.cursor === '0';
      } while (!W.done && W.keys.length < 100 && ++guardN < 40);
      if (R.pane && R.pane.W === W && W.tab === 'keys') { paintList(W); }
    } catch (e) { toast(errMsg(e), 'err'); }
  }

  function keysView(W) {
    const search = h('input', { type: 'search', value: W.match, placeholder: 'Pola, mis. user:* (SCAN, aman untuk produksi)', onkeydown: (e) => { if (e.key === 'Enter') { W.match = search.value.trim() || '*'; loadKeys(W, true); } } });
    W.listEl = h('div', { class: 'db-tables' });
    W.detailEl = h('div', { class: 'redis-detail' });
    const tree = h('aside', { class: 'db-tree' }, h('div', { class: 'db-tree-head' }, 'Key'), h('div', { style: { padding: '0 10px' } }, search), W.listEl);
    const wrap = h('div', { class: 'db-body' }, tree, W.detailEl);
    queueMicrotask(() => { paintList(W); paintDetail(W); });
    return wrap;
  }

  const TYPE_COLOR = { string: '#3b82f6', hash: '#a855f7', list: '#22c55e', set: '#f59e0b', zset: '#ec4899', stream: '#14b8a6' };
  function paintList(W) {
    if (!W.listEl) return;
    W.listEl.replaceChildren(...[...W.keys.map((k) => h('button', { type: 'button', class: 'db-table' + (W.sel === k.key ? ' on' : ''), onclick: () => select(W, k.key) },
      h('span', { class: 'tchip', style: { background: TYPE_COLOR[k.type] || '#64748b' } }, k.type.slice(0, 3)), h('span', { class: 'nm mono' }, k.key))),
      W.keys.length ? null : h('div', { class: 'sub', style: { padding: '10px' } }, 'Tidak ada key yang cocok.'),
      !W.done ? h('button', { class: 'btn small', style: { margin: '8px' }, onclick: () => loadKeys(W, false) }, 'Muat lebih banyak') : null].filter(Boolean));
  }

  async function select(W, key) {
    W.sel = key; paintList(W);
    try { W.detail = await api.redis.get({ id: W.sess.id, key }); } catch (e) { W.detail = { error: errMsg(e), key }; }
    paintDetail(W);
  }

  function paintDetail(W) {
    const d = W.detail; const box = W.detailEl; if (!box) return;
    if (!d) { box.replaceChildren(h('div', { class: 'empty' }, h('b', {}, 'Pilih sebuah key'), 'Nilainya tampil di sini.')); return; }
    if (d.error) { box.replaceChildren(h('div', { class: 'db-note err', style: { margin: '12px' } }, d.error)); return; }
    const ro = W.sess.readOnly;
    const body = h('div', { class: 'redis-val' });
    if (d.type === 'string') {
      const ta = h('textarea', { class: 'mono', spellcheck: 'false', readonly: ro, rows: 14 }, d.value);
      ta.value = d.value;
      body.append(ta, ro ? null : h('button', { class: 'btn primary small', disabled: d.truncated, onclick: async () => { try { await api.redis.set({ id: W.sess.id, key: d.key, value: ta.value, ttl: d.ttl > 0 ? d.ttl : 0 }); toast('Tersimpan', 'ok'); select(W, d.key); } catch (e) { toast(errMsg(e), 'err'); } } }, 'Simpan nilai'));
    } else if (d.type === 'hash') body.append(table(['Field', 'Nilai'], d.value.map((x) => [x.field, x.value])));
    else if (d.type === 'zset') body.append(table(['Member', 'Skor'], d.value.map((x) => [x.member, x.score])));
    else if (d.type === 'list' || d.type === 'set') body.append(table(['#', 'Nilai'], d.value.map((x, i) => [String(i), x])));
    else body.append(h('div', { class: 'db-note' }, `Tipe ${d.type} belum bisa ditampilkan; gunakan tab Konsol.`));
    box.replaceChildren(
      h('div', { class: 'srv-bar' }, h('b', { class: 'mono' }, d.key), h('span', { class: 'badge' }, d.type), h('span', { class: 'sub' }, d.ttl === -1 ? 'tanpa kedaluwarsa' : `kedaluwarsa ${d.ttl} dtk`), h('span', { class: 'sub' }, d.size != null ? `${d.size} item/byte` : ''), h('span', { class: 'grow' }),
        ro ? null : h('button', { class: 'btn small', onclick: async () => { const v = await promptDialog({ title: 'Atur TTL', message: 'Detik sampai kedaluwarsa. Isi 0 untuk menghapus kedaluwarsa.', label: 'TTL (detik)', value: d.ttl > 0 ? String(d.ttl) : '0', confirmLabel: 'Atur' }); if (v !== null) { try { await api.redis.expire({ id: W.sess.id, key: d.key, ttl: Number(v) || 0 }); select(W, d.key); } catch (e) { toast(errMsg(e), 'err'); } } } }, 'TTL'),
        ro ? null : h('button', { class: 'btn small danger', onclick: async () => { if (await confirmDialog({ title: 'Hapus key?', message: d.key, confirmLabel: 'Hapus', danger: true })) { try { await api.redis.del({ id: W.sess.id, key: d.key, confirmed: true }); W.sel = null; W.detail = null; loadKeys(W, true); paintDetail(W); } catch (e) { toast(errMsg(e), 'err'); } } } }, 'Hapus')),
      d.truncated ? h('div', { class: 'db-note', style: { margin: '0 12px' } }, 'Nilai dipotong (terlalu besar); hanya sebagian ditampilkan, penyimpanan dinonaktifkan.') : null, body);
  }
  const table = (head, rows) => h('table', { class: 'srv-table' }, h('thead', {}, h('tr', {}, head.map((x) => h('th', {}, x)))), h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c) => h('td', { class: 'mono' }, String(c)))))));

  function fmtResult(v) {
    if (v === null) return '(nil)';
    if (Array.isArray(v)) return v.length ? v.map((x, i) => `${i + 1}) ${typeof x === 'string' ? JSON.stringify(x) : fmtResult(x)}`).join('\n') : '(kosong)';
    if (typeof v === 'number') return `(integer) ${v}`;
    return String(v);
  }
  function consoleView(W) {
    const out = h('pre', { class: 'log-out mono', style: { flex: '1', margin: '0 12px' } }, W.hist.join('\n'));
    const input = h('input', { type: 'text', class: 'mono', placeholder: W.sess.readOnly ? 'Mode hanya-baca: GET, SCAN, TTL, INFO …' : 'Perintah Redis, mis. GET kunci', style: { flex: '1' } });
    const run = async (confirmed) => {
      const line = input.value.trim(); if (!line) return;
      W.hist.push('> ' + line);
      try { const r = await api.redis.command({ id: W.sess.id, line, confirmed }); W.hist.push(fmtResult(r.result)); input.value = ''; }
      catch (e) {
        if (e.code === 'NEEDS_CONFIRM' && await confirmDialog({ title: 'Perintah mengubah data', message: line, confirmLabel: 'Jalankan', danger: true })) { W.hist.pop(); return run(true); }
        W.hist.push('(error) ' + errMsg(e));
      }
      out.textContent = W.hist.join('\n'); out.scrollTop = out.scrollHeight;
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(false); });
    return h('div', { class: 'redis-console' }, out, h('div', { class: 'db-bar', style: { padding: '10px 12px' } }, input, h('button', { class: 'btn primary small', onclick: () => run(false) }, 'Jalankan')));
  }

  window.Redis = { init, renderSidebar, editConn };
})();
