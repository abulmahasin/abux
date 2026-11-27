'use strict';

/* Pengelola database (MySQL/MariaDB lewat terowongan SSH): koneksi, penjelajah tabel, data, struktur, editor SQL. */
(() => {
  const { h, icon, iconButton, toast, field, modal, confirmDialog, promptDialog } = window.UI;
  const api = window.api;
  const App = window.AbuxApp;
  const errMsg = (e) => (e && e.message ? e.message : String(e));
  const SYSTEM_DBS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

  const D = {
    conns: [],
    sessions: new Map(), // connId -> { id, connId, readOnly, version, ... }
    ws: new Map(), // dbSessionId -> state workspace
    pane: null, // { sid, el }
  };
  const hostOf = (id) => App.state.hosts.find((x) => x.id === id);
  const connOf = (id) => D.conns.find((x) => x.id === id);
  const live = (connId) => D.sessions.get(connId);

  async function reload() { D.conns = await api.db.conns(); }
  const refreshSidebar = () => { if (App.state.view === 'db') App.renderBody(); };

  // ---------- util tampilan ----------
  const fmtNum = (n) => Number(n).toLocaleString('id-ID');
  function fmtBytes(n) {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0; let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
  }
  const readHist = (connId) => { try { return JSON.parse(localStorage.getItem('abux.dbhist.' + connId) || '[]'); } catch (_) { return []; } };
  const writeHist = (connId, list) => { try { localStorage.setItem('abux.dbhist.' + connId, JSON.stringify(list.slice(0, 30))); } catch (_) { /* abaikan */ } };

  // ---------- sidebar ----------
  function renderSidebar(body) {
    const q = App.state.filter.toLowerCase();
    if (!App.state.hosts.length) { body.append(emptyBox('Belum ada host', 'Tambahkan host SSH dulu. Database diakses lewat terowongan SSH ke server Anda, jadi tidak perlu membuka port database ke internet.')); return; }
    if (!D.conns.length) {
      body.append(emptyBox('Belum ada koneksi database', 'Kelola MySQL/MariaDB di server Anda: lihat tabel, edit data, dan jalankan query, semua lewat SSH.', h('button', { class: 'btn primary', onclick: () => editConn() }, 'Tambah koneksi')));
      return;
    }
    const list = D.conns.filter((c) => !q || c.name.toLowerCase().includes(q) || c.user.toLowerCase().includes(q) || (c.database || '').toLowerCase().includes(q));
    if (!list.length) { body.append(emptyBox('Tidak ditemukan', 'Coba kata kunci lain.')); return; }
    const groups = new Map();
    for (const c of list) {
      const n = (hostOf(c.hostId) || { name: 'Host dihapus' }).name;
      if (!groups.has(n)) groups.set(n, []);
      groups.get(n).push(c);
    }
    for (const [hostName, items] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
      body.append(h('div', { class: 'group-label' }, hostName));
      for (const c of items.sort((a, b) => a.name.localeCompare(b.name))) {
        const isLive = !!live(c.id);
        body.append(h('div', { class: 'item', tabindex: '0', role: 'button', title: 'Klik untuk membuka', onclick: () => openConn(c), onkeydown: (e) => { if (e.key === 'Enter') openConn(c); } },
          h('span', { class: 'icon', style: { color: isLive ? 'var(--ok)' : 'var(--accent)' } }, icon('database')),
          h('div', { class: 'grow' },
            h('div', { class: 'title' }, c.name, ' ', h('span', { class: 'badge' + (c.readOnly ? '' : ' priv') }, c.readOnly ? 'baca' : 'baca-tulis')),
            h('div', { class: 'sub mono' }, `${c.user}@${c.dbHost}:${c.dbPort}${c.database ? '/' + c.database : ''}`)),
          h('div', { class: 'actions' },
            iconButton('edit', 'Ubah', () => editConn(c)),
            iconButton('trash', 'Hapus', () => removeConn(c), 'danger'))));
      }
    }
  }

  const emptyBox = (title, text, action) => h('div', { class: 'empty' }, h('b', {}, title), text, action ? h('div', { style: { marginTop: '12px' } }, action) : null);

  async function removeConn(c) {
    if (!(await confirmDialog({ title: 'Hapus koneksi database?', message: `"${c.name}" akan dihapus dari Abux. Database di server tidak terpengaruh.`, confirmLabel: 'Hapus', danger: true }))) return;
    try { await api.db.removeConn(c.id); D.sessions.delete(c.id); await reload(); refreshSidebar(); } catch (e) { toast(errMsg(e), 'err'); }
  }

  // ---------- editor koneksi ----------
  function editConn(c) {
    if (!App.state.hosts.length) { toast('Tambahkan host SSH dulu.', 'err'); return; }
    const v = c || { name: '', hostId: App.state.hosts[0].id, dbHost: '127.0.0.1', dbPort: 3306, user: '', database: '', readOnly: true, emptyPassword: false };
    const name = h('input', { type: 'text', value: v.name, placeholder: 'mis. AKARIS produksi' });
    const hostSel = h('select', {}, App.state.hosts.map((x) => h('option', { value: x.id, selected: x.id === v.hostId }, x.name)));
    const dbHost = h('input', { type: 'text', class: 'mono', value: v.dbHost, spellcheck: 'false' });
    const dbPort = h('input', { type: 'number', value: v.dbPort, min: '1', max: '65535' });
    const user = h('input', { type: 'text', value: v.user, placeholder: 'mis. akaris', spellcheck: 'false', autocapitalize: 'off' });
    const password = h('input', { type: 'password', autocomplete: 'new-password', placeholder: c && c.hasPassword ? 'Tersimpan. Kosongkan jika tidak diubah' : 'Kosongkan untuk ditanya saat membuka' });
    const noPw = h('input', { type: 'checkbox', checked: !!v.emptyPassword });
    const database = h('input', { type: 'text', value: v.database, placeholder: 'Opsional, mis. akaris', spellcheck: 'false' });
    const ro = h('input', { type: 'checkbox', checked: v.readOnly !== false });
    const result = h('div', { class: 'test-result', hidden: true, role: 'status', 'aria-live': 'polite' });
    const show = (kind, title, detail) => {
      result.hidden = false;
      result.className = 'test-result ' + kind;
      result.replaceChildren(h('b', {}, title), detail ? h('div', {}, detail) : '');
      result.scrollIntoView({ block: 'nearest' });
    };
    const collect = () => ({ id: c && c.id, name: name.value, hostId: hostSel.value, dbHost: dbHost.value, dbPort: Number(dbPort.value), user: user.value, database: database.value, readOnly: ro.checked, emptyPassword: noPw.checked, password: password.value, clearPassword: noPw.checked });

    async function runTest(pw) {
      const input = collect();
      const host = hostOf(input.hostId);
      show('busy', 'Menguji koneksi…', `lewat SSH ke ${host.name}`);
      try {
        const ssh = await window.Deploy.ensureSession(host);
        const payload = { user: input.user, dbHost: input.dbHost, dbPort: input.dbPort, database: input.database, emptyPassword: input.emptyPassword, sshSessionId: ssh.id };
        if (pw !== undefined) payload.password = pw;
        else if (input.password) payload.password = input.password;
        else if (c && c.hasPassword) { payload.connId = c.id; payload.useStoredPassword = true; }
        const r = await api.db.test(payload);
        show('ok', `Koneksi database berhasil (${r.ms} ms)`, `Versi server: ${r.version}\nLogin sebagai: ${r.user}`);
      } catch (e) {
        if (e.code === 'NEEDS_SECRET') {
          const val = await promptDialog({ title: 'Password database diperlukan', message: 'Hanya untuk uji koneksi ini, tidak disimpan.', label: 'Password database', type: 'password', confirmLabel: 'Uji' });
          if (val !== null) return runTest(val);
          return show('err', 'Uji dibatalkan', 'Isi password di form atau masukkan saat diminta.');
        }
        show('err', 'Koneksi database gagal', errMsg(e));
      }
    }

    const body = h('div', {},
      field('Nama koneksi', name),
      field('Host SSH (server tempat database berada)', hostSel, 'Koneksi dibuat lewat terowongan SSH dari host ini.'),
      h('div', { class: 'row' }, field('Alamat database di server', dbHost, '127.0.0.1 bila MySQL berjalan di server itu sendiri.'), h('div', { class: 'narrow field' }, h('label', {}, 'Port'), dbPort)),
      h('div', { class: 'row' }, field('User database', user), field('Database awal', database)),
      field('Password database', password, 'Ini password MySQL, bukan password SSH.'),
      h('label', { class: 'check' }, noPw, 'User ini memang tanpa password'),
      h('label', { class: 'check' }, ro, 'Hanya baca (disarankan untuk produksi)'),
      result);
    modal({
      title: c ? 'Ubah koneksi database' : 'Koneksi database baru',
      subtitle: 'MySQL / MariaDB',
      body, width: '600px',
      buttons: [
        { label: 'Batal' },
        { label: 'Uji koneksi', onClick: async () => { await runTest(); return false; } },
        { label: 'Simpan', kind: 'primary', onClick: async () => { await api.db.saveConn(collect()); await reload(); refreshSidebar(); toast('Koneksi disimpan', 'ok'); } },
      ],
    });
  }

  // ---------- membuka koneksi ----------
  async function openConn(c) {
    const ex = live(c.id);
    if (ex && D.ws.has(ex.id)) { mountPane(ex.id); return; }
    const host = hostOf(c.hostId);
    if (!host) { toast('Host SSH untuk koneksi ini sudah dihapus.', 'err'); return; }
    try {
      const ssh = await window.Deploy.ensureSession(host);
      let sess;
      try {
        sess = await api.db.connect({ connId: c.id, sshSessionId: ssh.id });
      } catch (e) {
        if (e.code !== 'NEEDS_SECRET') throw e;
        const pw = await promptDialog({ title: 'Password database diperlukan', message: `${c.name} (${c.user})`, label: 'Password database', type: 'password', confirmLabel: 'Sambungkan' });
        if (pw === null) return;
        sess = await api.db.connect({ connId: c.id, sshSessionId: ssh.id, password: pw });
      }
      D.sessions.set(c.id, sess);
      D.ws.set(sess.id, newState(c, sess));
      refreshSidebar();
      mountPane(sess.id);
    } catch (e) { toast(errMsg(e), 'err'); }
  }

  function newState(conn, sess) {
    return {
      conn, sess, dbs: [], db: conn.database || '', tables: [], tableFilter: '', table: null, desc: null,
      tab: 'data', data: { page: 1, pageSize: 100, orderBy: null, dir: 'asc', filter: null, result: null, selected: null },
      query: { sql: '', result: null, error: null, running: false }, hist: readHist(conn.id), loaded: false,
    };
  }

  // ---------- panel kerja ----------
  function unmountPane() { if (D.pane) { D.pane.el.remove(); D.pane = null; } }

  async function mountPane(sid) {
    unmountPane();
    const W = D.ws.get(sid);
    if (!W) return;
    const el = h('section', { id: 'db-pane', class: 'db-pane', 'aria-label': 'Pengelola database' });
    document.getElementById('main').append(el);
    D.pane = { sid, el };
    W.el = el;
    paint(W);
    if (!W.loaded) await loadDbs(W);
  }

  function paint(W) {
    const host = hostOf(W.conn.hostId);
    const head = h('header', { class: 'db-head' },
      h('button', { class: 'btn small', onclick: unmountPane, title: 'Kembali ke terminal' }, '← Terminal'),
      h('div', { class: 'db-title' }, icon('database'), h('b', {}, W.conn.name), h('span', { class: 'mono sub' }, `${host ? host.name : ''} · ${W.sess.version}`),
        h('span', { class: 'badge' + (W.sess.readOnly ? '' : ' priv') }, W.sess.readOnly ? 'HANYA BACA' : 'BACA-TULIS')),
      h('div', { class: 'grow' }),
      (() => {
        const sel = h('select', { class: 'db-select', 'aria-label': 'Database' }, W.dbs.length ? W.dbs.map((d) => h('option', { value: d, selected: d === W.db }, d)) : h('option', { value: '' }, 'Memuat…'));
        sel.addEventListener('change', () => switchDb(W, sel.value));
        return sel;
      })(),
      h('button', { class: 'btn small', onclick: () => disconnect(W) }, 'Putuskan'));
    const tree = h('aside', { class: 'db-tree' });
    const main = h('div', { class: 'db-main' });
    W.refs = { tree, main };
    W.el.replaceChildren(head, h('div', { class: 'db-body' }, tree, main));
    paintTree(W);
    paintMain(W);
  }

  async function loadDbs(W) {
    try {
      W.dbs = await api.db.databases(W.sess.id);
      if (!W.db || !W.dbs.includes(W.db)) W.db = W.dbs.find((d) => !SYSTEM_DBS.has(d)) || W.dbs[0] || '';
      W.loaded = true;
      if (W.db) W.tables = await api.db.tables(W.sess.id, W.db);
      if (D.pane && D.pane.sid === W.sess.id) paint(W);
    } catch (e) { toast(errMsg(e), 'err'); }
  }

  async function switchDb(W, db) {
    W.db = db; W.table = null; W.desc = null; W.data.result = null; W.data.page = 1; W.data.filter = null; W.data.orderBy = null; W.data.selected = null;
    try { W.tables = await api.db.tables(W.sess.id, db); } catch (e) { toast(errMsg(e), 'err'); W.tables = []; }
    paint(W);
  }

  async function disconnect(W) {
    try { await api.db.disconnect(W.sess.id); } catch (_) { /* abaikan */ }
    D.sessions.delete(W.conn.id); D.ws.delete(W.sess.id);
    unmountPane(); refreshSidebar();
  }

  function paintTree(W) {
    const { tree } = W.refs;
    const search = h('input', { type: 'search', placeholder: 'Cari tabel…', value: W.tableFilter, 'aria-label': 'Cari tabel', spellcheck: 'false' });
    const list = h('div', { class: 'db-tables' });
    const fill = () => {
      list.replaceChildren();
      const q = W.tableFilter.toLowerCase();
      const items = W.tables.filter((t) => !q || t.name.toLowerCase().includes(q));
      if (!items.length) list.append(h('div', { class: 'empty' }, W.tables.length ? 'Tidak ditemukan' : 'Tidak ada tabel'));
      for (const t of items) {
        list.append(h('button', { type: 'button', class: 'db-table' + (W.table === t.name ? ' on' : ''), title: t.type === 'view' ? 'View' : `${t.rows == null ? '?' : fmtNum(t.rows)} baris · ${fmtBytes(t.size)}`, onclick: () => selectTable(W, t.name) },
          icon(t.type === 'view' ? 'files' : 'table'), h('span', { class: 'nm' }, t.name), t.rows != null && t.type !== 'view' ? h('span', { class: 'cnt' }, fmtCompact(t.rows)) : null));
      }
    };
    search.addEventListener('input', () => { W.tableFilter = search.value; fill(); });
    fill();
    tree.replaceChildren(h('div', { class: 'db-tree-head' }, h('span', {}, `Tabel (${W.tables.length})`), iconButton('refresh', 'Muat ulang daftar tabel', async () => { try { W.tables = await api.db.tables(W.sess.id, W.db); paintTree(W); } catch (e) { toast(errMsg(e), 'err'); } })), search, list);
  }
  const fmtCompact = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'jt' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'rb' : String(n));

  async function selectTable(W, name) {
    W.table = name; W.desc = null; W.data = { ...W.data, page: 1, orderBy: null, dir: 'asc', filter: null, result: null, selected: null };
    if (W.tab === 'query') W.tab = 'data';
    paintTree(W);
    paintMain(W);
    await loadDesc(W);
    if (W.table === name) { await loadData(W); }
  }

  async function loadDesc(W) {
    try { W.desc = await api.db.describe(W.sess.id, W.db, W.table); } catch (e) { toast(errMsg(e), 'err'); W.desc = null; }
  }

  async function loadData(W) {
    if (!W.table) return;
    const d = W.data;
    try {
      d.result = await api.db.rows({ id: W.sess.id, db: W.db, table: W.table, page: d.page, pageSize: d.pageSize, orderBy: d.orderBy, dir: d.dir, filter: d.filter });
      d.selected = null;
    } catch (e) { d.result = null; toast(errMsg(e), 'err'); }
    if (W.tab === 'data') paintMain(W);
  }

  // ---------- area utama ----------
  function paintMain(W) {
    const { main } = W.refs;
    const tabs = h('div', { class: 'db-tabs', role: 'tablist' }, [['data', 'Data'], ['struct', 'Struktur'], ['query', 'Query SQL']].map(([id, label]) =>
      h('button', { type: 'button', role: 'tab', class: W.tab === id ? 'on' : '', onclick: () => { W.tab = id; paintMain(W); } }, label)),
      h('div', { class: 'grow' }), W.table ? h('span', { class: 'mono sub' }, `${W.db}.${W.table}`) : null);
    const body = h('div', { class: 'db-tabbody' });
    main.replaceChildren(tabs, body);
    if (W.tab === 'query') return paintQuery(W, body);
    if (!W.table) { body.append(emptyBox('Pilih tabel', 'Klik nama tabel di kiri, atau buka tab Query SQL untuk menjalankan perintah sendiri.')); return null; }
    return W.tab === 'struct' ? paintStruct(W, body) : paintData(W, body);
  }

  // ---------- grid ----------
  function grid({ columns, rows, sort, onSort, selected, onSelect, editable, onEdit }) {
    const wrap = h('div', { class: 'grid-wrap' });
    const table = h('table', { class: 'grid' });
    const head = h('tr', {}, h('th', { class: 'rn' }, '#'), columns.map((c) => {
      const name = c.name || c;
      const sorted = sort && sort.by === name;
      return h('th', { title: c.type ? `${name} · ${c.type}${c.key === 'PRI' ? ' · primary key' : ''}` : name, class: onSort ? 'sortable' : '', onclick: onSort ? () => onSort(name) : null },
        c.key === 'PRI' ? h('span', { class: 'pk' }, '🔑') : null, name, sorted ? h('span', { class: 'arrow' }, sort.dir === 'desc' ? ' ▼' : ' ▲') : null);
    }));
    const tbody = h('tbody');
    rows.forEach((r, ri) => {
      const tr = h('tr', { class: selected === ri ? 'sel' : '', onclick: () => onSelect && onSelect(ri) }, h('td', { class: 'rn' }, String(ri + 1)));
      r.forEach((v, ci) => {
        const col = columns[ci];
        const td = h('td', { class: v === null ? 'nul' : (typeof v === 'number' || (col.type && /int|decimal|float|double/i.test(col.type)) ? 'num' : ''), title: v === null ? 'NULL' : String(v).slice(0, 500) }, v === null ? 'NULL' : String(v));
        if (editable && onEdit && !col.binary) td.addEventListener('dblclick', () => beginEdit(td, v, col, (nv) => onEdit(ri, ci, nv)));
        tr.append(td);
      });
      tbody.append(tr);
    });
    table.append(h('thead', {}, head), tbody);
    wrap.append(table);
    return wrap;
  }

  function beginEdit(td, value, col, commit) {
    if (td.querySelector('input')) return;
    const original = td.textContent;
    const input = h('input', { type: 'text', value: value === null ? '' : String(value), class: 'cell-edit mono', spellcheck: 'false' });
    let done = false;
    const finish = (save, nullValue) => {
      if (done) return;
      done = true;
      if (!save) { td.textContent = original; if (value === null) td.className = 'nul'; return; }
      commit(nullValue ? null : input.value);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => setTimeout(() => finish(false), 120));
    const nullBtn = col.nullable ? h('button', { type: 'button', class: 'btn small', title: 'Set NULL', onmousedown: (e) => { e.preventDefault(); finish(true, true); } }, 'NULL') : null;
    td.replaceChildren(h('div', { class: 'cell-edit-wrap' }, input, nullBtn));
    input.focus(); input.select();
  }

  // ---------- tab Data ----------
  function paintData(W, body) {
    const d = W.data;
    const cols = W.desc ? W.desc.columns : [];
    const canEdit = !W.sess.readOnly && W.desc && cols.some((c) => c.key === 'PRI') && W.tables.find((t) => t.name === W.table)?.type !== 'view';

    const fCol = h('select', { 'aria-label': 'Kolom filter' }, cols.map((c) => h('option', { value: c.name, selected: d.filter && d.filter.column === c.name }, c.name)));
    const fOp = h('select', { 'aria-label': 'Operator' }, [['=', '='], ['!=', '≠'], ['like', 'mengandung (LIKE)'], ['>', '>'], ['<', '<'], ['>=', '≥'], ['<=', '≤'], ['null', 'kosong (NULL)'], ['not null', 'tidak kosong']].map(([v, l]) => h('option', { value: v, selected: d.filter && d.filter.op === v }, l)));
    const fVal = h('input', { type: 'text', placeholder: 'nilai (pakai % untuk LIKE)', value: d.filter ? d.filter.value || '' : '', spellcheck: 'false' });
    const apply = () => {
      const op = fOp.value;
      d.filter = fVal.value === '' && !/null/.test(op) ? null : { column: fCol.value, op, value: fVal.value };
      d.page = 1; loadData(W);
    };
    fVal.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
    const bar = h('div', { class: 'db-bar' }, fCol, fOp, fVal,
      h('button', { class: 'btn small', onclick: apply }, 'Terapkan'),
      d.filter ? h('button', { class: 'btn small', onclick: () => { d.filter = null; d.page = 1; loadData(W); } }, 'Hapus filter') : null,
      h('div', { class: 'grow' }),
      iconButton('refresh', 'Muat ulang', () => loadData(W)),
      canEdit ? h('button', { class: 'btn small', onclick: () => insertDialog(W) }, icon('plus'), 'Tambah baris') : null,
      canEdit ? h('button', { class: 'btn small danger', disabled: d.selected == null, onclick: () => deleteSelected(W) }, icon('trash'), 'Hapus baris') : null,
      h('button', { class: 'btn small', onclick: () => exportSql(W, `SELECT * FROM ${q(W.db)}.${q(W.table)}`, W.table, 'csv') }, 'Ekspor CSV'));
    body.append(bar);

    if (!d.result) { body.append(emptyBox('Memuat…', '')); return; }
    const r = d.result;
    if (W.sess.readOnly) body.append(h('div', { class: 'db-note' }, 'Mode hanya-baca: data tidak bisa diubah. Aktifkan baca-tulis di pengaturan koneksi bila perlu.'));
    else if (!canEdit && W.desc) body.append(h('div', { class: 'db-note' }, W.tables.find((t) => t.name === W.table)?.type === 'view' ? 'View tidak bisa diedit.' : 'Tabel ini tidak punya primary key, jadi tidak bisa diedit di sini. Gunakan Query SQL.'));
    else if (canEdit) body.append(h('div', { class: 'db-note ok' }, 'Klik dua kali pada sel untuk mengubah. Tekan Enter untuk menyimpan, Esc untuk batal.'));
    body.append(grid({
      columns: r.columns, rows: r.rows, sort: d.orderBy ? { by: d.orderBy, dir: d.dir } : null,
      onSort: (name) => { if (d.orderBy !== name) { d.orderBy = name; d.dir = 'asc'; } else if (d.dir === 'asc') d.dir = 'desc'; else { d.orderBy = null; d.dir = 'asc'; } loadData(W); },
      selected: d.selected, onSelect: (i) => { d.selected = i; body.querySelectorAll('tbody tr').forEach((tr, k) => tr.classList.toggle('sel', k === i)); const del = body.querySelector('.db-bar .btn.danger'); if (del) del.disabled = false; },
      editable: canEdit,
      onEdit: (ri, ci, nv) => saveCell(W, ri, ci, nv),
    }));
    const pages = Math.max(1, Math.ceil(r.total / r.pageSize));
    const go = (p) => { d.page = Math.min(pages, Math.max(1, p)); loadData(W); };
    const size = h('select', { 'aria-label': 'Baris per halaman' }, [50, 100, 200, 500].map((n) => h('option', { value: n, selected: n === d.pageSize }, `${n} / halaman`)));
    size.addEventListener('change', () => { d.pageSize = Number(size.value); d.page = 1; loadData(W); });
    body.append(h('div', { class: 'db-pager' },
      h('button', { class: 'btn small', disabled: d.page <= 1, onclick: () => go(1) }, '«'), h('button', { class: 'btn small', disabled: d.page <= 1, onclick: () => go(d.page - 1) }, '‹'),
      h('span', {}, `Halaman ${fmtNum(d.page)} / ${fmtNum(pages)}`),
      h('button', { class: 'btn small', disabled: d.page >= pages, onclick: () => go(d.page + 1) }, '›'), h('button', { class: 'btn small', disabled: d.page >= pages, onclick: () => go(pages) }, '»'),
      size, h('span', { class: 'grow sub' }, `${fmtNum(r.total)} baris${d.filter ? ' (terfilter)' : ''} · ${r.ms} ms`)));
  }

  const q = (id) => '`' + String(id).replace(/`/g, '``') + '`';

  function keyOf(W, row) {
    const key = {};
    W.desc.columns.forEach((c, i) => { if (c.key === 'PRI') key[c.name] = row[i]; });
    return key;
  }

  async function saveCell(W, ri, ci, nv) {
    const row = W.data.result.rows[ri];
    const col = W.desc.columns[ci];
    if ((row[ci] === null && nv === null) || (row[ci] !== null && String(row[ci]) === nv)) { paintMain(W); return; }
    try {
      await api.db.updateRow({ id: W.sess.id, db: W.db, table: W.table, key: keyOf(W, row), changes: { [col.name]: nv } });
      toast('Tersimpan', 'ok');
    } catch (e) { toast(errMsg(e), 'err'); }
    await loadData(W);
  }

  async function deleteSelected(W) {
    const d = W.data;
    if (d.selected == null) return;
    const row = d.result.rows[d.selected];
    const key = keyOf(W, row);
    const label = Object.entries(key).map(([k, v]) => `${k} = ${v}`).join(', ');
    if (!(await confirmDialog({ title: 'Hapus baris ini?', message: `${W.db}.${W.table} · ${label}\nPenghapusan tidak bisa dibatalkan.`, confirmLabel: 'Hapus baris', danger: true }))) return;
    try { await api.db.deleteRow({ id: W.sess.id, db: W.db, table: W.table, key }); toast('Baris dihapus', 'ok'); } catch (e) { toast(errMsg(e), 'err'); }
    await loadData(W);
  }

  function insertDialog(W) {
    const rows = W.desc.columns.map((c) => {
      const input = h('input', { type: 'text', class: 'mono', spellcheck: 'false', placeholder: c.auto ? '(otomatis)' : c.default !== null ? `default: ${c.default}` : c.nullable ? '(kosong = default/NULL)' : '', disabled: c.binary });
      const nul = c.nullable && !c.binary ? h('input', { type: 'checkbox' }) : null;
      if (nul) nul.addEventListener('change', () => { input.disabled = nul.checked; });
      return { c, input, nul, el: h('div', { class: 'ins-row' }, h('label', {}, c.name, h('span', { class: 'sub' }, ` ${c.type}${c.key === 'PRI' ? ' · PK' : ''}`)), input, nul ? h('label', { class: 'check small' }, nul, 'NULL') : h('span')) };
    });
    modal({
      title: 'Tambah baris', subtitle: `${W.db}.${W.table}`, width: '620px',
      body: h('div', { class: 'ins-form' }, h('p', { class: 'hint' }, 'Kolom yang dikosongkan memakai nilai default atau otomatis dari database.'), rows.map((r) => r.el)),
      buttons: [{ label: 'Batal' }, { label: 'Tambahkan', kind: 'primary', onClick: async () => {
        const values = {};
        for (const r of rows) { if (r.nul && r.nul.checked) values[r.c.name] = null; else if (r.input.value !== '' && !r.c.binary) values[r.c.name] = r.input.value; }
        await api.db.insertRow({ id: W.sess.id, db: W.db, table: W.table, values });
        toast('Baris ditambahkan', 'ok');
        W.data.page = 1; await loadData(W);
        try { W.tables = await api.db.tables(W.sess.id, W.db); paintTree(W); } catch (_) { /* abaikan */ }
      } }],
    });
  }

  // ---------- tab Struktur ----------
  function paintStruct(W, body) {
    if (!W.desc) { body.append(emptyBox('Memuat…', '')); loadDesc(W).then(() => { if (W.tab === 'struct') paintMain(W); }); return; }
    const { columns, indexes, ddl } = W.desc;
    body.append(h('div', { class: 'struct' },
      h('h4', {}, 'Kolom'),
      h('div', { class: 'grid-wrap' }, h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, ['Nama', 'Tipe', 'Null', 'Kunci', 'Default', 'Extra', 'Komentar'].map((x) => h('th', {}, x)))),
        h('tbody', {}, columns.map((c) => h('tr', {}, h('td', { class: 'mono' }, c.name), h('td', { class: 'mono' }, c.type), h('td', {}, c.nullable ? 'YA' : 'tidak'), h('td', {}, c.key), h('td', { class: c.default === null ? 'nul' : '' }, c.default === null ? 'NULL' : c.default), h('td', {}, c.extra), h('td', {}, c.comment)))))),
      h('h4', {}, 'Index'),
      indexes.length ? h('div', { class: 'grid-wrap' }, h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, ['Nama', 'Unik', 'Kolom'].map((x) => h('th', {}, x)))),
        h('tbody', {}, indexes.map((i) => h('tr', {}, h('td', { class: 'mono' }, i.name), h('td', {}, i.unique ? 'ya' : 'tidak'), h('td', { class: 'mono' }, i.columns.join(', ')))))))
        : h('div', { class: 'sub' }, 'Tidak ada index.'),
      ddl ? [h('h4', {}, 'DDL (CREATE)'), h('div', { class: 'help-code' }, h('div', { class: 'help-code-bar' }, h('span', {}, 'SQL'), h('button', { class: 'btn small', onclick: async () => { await api.clipboard.write(ddl); toast('DDL disalin', 'ok'); } }, 'Salin')), h('pre', { class: 'mono' }, ddl))] : null));
  }

  // ---------- tab Query ----------
  function paintQuery(W, body) {
    const Q = W.query;
    const ta = h('textarea', { class: 'sql-editor mono', spellcheck: 'false', rows: '8', placeholder: `-- contoh\nSELECT * FROM ${W.table || 'nama_tabel'} LIMIT 50;`, 'aria-label': 'Editor SQL' }, Q.sql);
    ta.addEventListener('input', () => { Q.sql = ta.value; });
    const run = async (confirmed) => {
      const text = ta.selectionStart !== ta.selectionEnd ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : ta.value;
      if (!text.trim()) { toast('Tulis perintah SQL dulu.', 'err'); return; }
      Q.running = true; Q.error = null; paintResult();
      try {
        Q.result = await api.db.query({ id: W.sess.id, sql: text, confirmed: !!confirmed, database: W.db });
        Q.sql = ta.value;
        W.hist = [text.trim(), ...W.hist.filter((x) => x !== text.trim())].slice(0, 30);
        writeHist(W.conn.id, W.hist);
        if (Q.result.type === 'ok' && /\b(create|drop|alter|rename|truncate)\b/i.test(text)) { try { W.tables = await api.db.tables(W.sess.id, W.db); paintTree(W); } catch (_) { /* abaikan */ } }
      } catch (e) {
        Q.result = null;
        if (e.code === 'NEEDS_CONFIRM') {
          Q.running = false; paintResult();
          if (await confirmDialog({ title: 'Perintah berisiko', message: `${e.message}\n\nLanjutkan?`, confirmLabel: 'Ya, jalankan', danger: true })) return run(true);
          return;
        }
        Q.error = errMsg(e);
      }
      Q.running = false; paintResult();
    };
    ta.addEventListener('keydown', (ev) => { if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); run(false); } });
    const histBtn = h('button', { class: 'btn small', disabled: !W.hist.length, onclick: (ev) => {
      const r = ev.currentTarget.getBoundingClientRect();
      window.UI.contextMenu(r.left, r.bottom + 4, W.hist.slice(0, 15).map((s) => ({ label: s.replace(/\s+/g, ' ').slice(0, 70), onClick: () => { ta.value = s; Q.sql = s; ta.focus(); } })));
    } }, 'Riwayat');
    const out = h('div', { class: 'db-result' });
    const paintResult = () => {
      out.replaceChildren();
      if (Q.running) { out.append(h('div', { class: 'db-note' }, h('span', { class: 'spinner small' }), ' Menjalankan…')); return; }
      if (Q.error) { out.append(h('div', { class: 'test-result err' }, h('b', {}, 'Query gagal'), Q.error)); return; }
      const r = Q.result;
      if (!r) { out.append(h('div', { class: 'sub', style: { padding: '12px' } }, 'Hasil muncul di sini. Blok sebagian teks untuk menjalankan bagian itu saja. Beberapa pernyataan dipisah titik koma.')); return; }
      if (r.type === 'ok') {
        out.append(h('div', { class: 'test-result ok' }, h('b', {}, 'Berhasil'), `${fmtNum(r.affectedTotal)} baris terpengaruh${r.insertId && r.insertId !== '0' ? ` · insert id ${r.insertId}` : ''}${r.statements > 1 ? ` · ${r.statements} pernyataan` : ''} · ${r.ms} ms${r.info ? `\n${r.info}` : ''}`));
        return;
      }
      out.append(grid({ columns: r.columns.map((n) => ({ name: n })), rows: r.rows }),
        h('div', { class: 'db-pager' }, h('span', { class: 'grow sub' }, `${fmtNum(r.total)} baris${r.truncated ? ` (ditampilkan 1.000 pertama; ekspor untuk data lengkap)` : ''}${r.statements > 1 ? ` · ${r.statements} pernyataan` : ''} · ${r.ms} ms`),
          h('button', { class: 'btn small', onclick: () => exportSql(W, selectedText(ta), 'hasil', 'csv') }, 'Ekspor CSV'), h('button', { class: 'btn small', onclick: () => exportSql(W, selectedText(ta), 'hasil', 'json') }, 'Ekspor JSON')));
    };
    body.append(
      ta,
      h('div', { class: 'db-bar' }, h('button', { class: 'btn primary small', onclick: () => run(false) }, icon('play'), 'Jalankan'), h('span', { class: 'sub' }, (navigator.platform || '').toLowerCase().includes('mac') ? '⌘+Enter' : 'Ctrl+Enter'),
        h('div', { class: 'grow' }), histBtn, h('button', { class: 'btn small', onclick: () => { ta.value = ''; Q.sql = ''; Q.result = null; Q.error = null; paintResult(); ta.focus(); } }, 'Bersihkan')),
      out);
    paintResult();
  }

  const selectedText = (ta) => (ta.selectionStart !== ta.selectionEnd ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : ta.value);

  async function exportSql(W, sql, name, format) {
    try {
      const r = await api.db.exportResult({ id: W.sess.id, sql, format, name });
      if (r) toast(`${fmtNum(r.rows)} baris diekspor${r.truncated ? ' (dipotong 200.000)' : ''}`, 'ok');
    } catch (e) { toast(errMsg(e), 'err'); }
  }

  async function init() {
    await reload();
    api.db.onEvent((ev) => {
      if (ev.type !== 'closed') return;
      const W = D.ws.get(ev.dbSessionId);
      if (!W) return;
      D.sessions.delete(W.conn.id); D.ws.delete(ev.dbSessionId);
      if (D.pane && D.pane.sid === ev.dbSessionId) unmountPane();
      toast(`Koneksi database "${W.conn.name}" terputus: ${ev.reason || ''}`, 'err');
      refreshSidebar();
    });
  }

  window.Db = { init, renderSidebar, editConn };
})();
