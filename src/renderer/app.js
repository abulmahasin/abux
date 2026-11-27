'use strict';

(() => {
  const { h, icon, iconButton, toast, field, modal, confirmDialog, promptDialog, contextMenu, fmtSize, fmtDate } = window.UI;
  const api = window.api;
  const plat = (navigator.platform || '').toLowerCase();
  const isMac = plat.includes('mac');
  const $ = (id) => document.getElementById(id);

  // ---------- konstanta ----------
  const THEMES = {
    midnight: { label: 'Midnight', background: '#0b0f14', foreground: '#e6edf3', cursor: '#3b82f6', cursorAccent: '#0b0f14', selectionBackground: 'rgba(59,130,246,0.35)', black: '#1b2430', red: '#f87171', green: '#4ade80', yellow: '#fbbf24', blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#d1d9e3', brightBlack: '#5b6b80', brightRed: '#fca5a5', brightGreen: '#86efac', brightYellow: '#fde68a', brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#67e8f9', brightWhite: '#ffffff' },
    dracula: { label: 'Dracula', background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', cursorAccent: '#282a36', selectionBackground: 'rgba(98,114,164,0.5)', black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2', brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff' },
    light: { label: 'Solarized Light', background: '#fdf6e3', foreground: '#586e75', cursor: '#586e75', cursorAccent: '#fdf6e3', selectionBackground: 'rgba(7,54,66,0.2)', black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5', brightBlack: '#002b36', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3' },
  };
  const COLORS = { '': ['Tanpa warna', ''], red: ['Merah (produksi)', '#ef4444'], orange: ['Oranye', '#f59e0b'], green: ['Hijau', '#22c55e'], blue: ['Biru', '#3b82f6'], purple: ['Ungu', '#a855f7'], pink: ['Pink', '#ec4899'] };
  const VIEWS = [
    { id: 'hosts', title: 'Host', icon: 'server' },
    { id: 'snippets', title: 'Snippet', icon: 'snippet' },
    { id: 'keys', title: 'SSH Keys', icon: 'key' },
    { id: 'github', title: 'GitHub', icon: 'github' },
    { id: 'deploy', title: 'Deploy', icon: 'rocket' },
    { id: 'db', title: 'Database', icon: 'database' },
    { id: 'server', title: 'Server (monitor, Docker, log)', icon: 'activity' },
    { id: 'redis', title: 'Redis', icon: 'redis' },
  ];

  const state = {
    view: 'hosts',
    filter: '',
    hosts: [],
    keys: [],
    snippets: [],
    settings: {},
    github: { clientId: '', user: null, loggedIn: false },
    info: { secureStorage: { available: true, weak: false } },
    repos: null,
    reposLoading: false,
    sessions: new Map(),
    activeId: null,
    sftp: { open: false, sessionId: null, path: '', entries: [], loading: false, progress: null, error: '' },
  };

  // Titik kait untuk modul lain (deploy.js)
  window.AbuxApp = { state, renderBody: () => renderBody(), createSession: (host) => createSession(host) };

  const clean = (s) => String(s).replace(/[\u0000-\u001f\u007f]/g, '');
  const activeSession = () => state.sessions.get(state.activeId) || null;
  const connectedSession = () => {
    const s = activeSession();
    return s && s.status === 'connected' ? s : null;
  };
  const errMsg = (e) => (e && e.message ? e.message : String(e));
  const guard = (fn) => async (...a) => {
    try { return await fn(...a); } catch (e) { toast(errMsg(e), 'err'); }
  };

  // ---------- data ----------
  async function reloadHosts() { state.hosts = await api.hosts.list(); }
  async function reloadKeys() { state.keys = await api.keys.list(); }
  async function reloadSnippets() { state.snippets = await api.snippets.list(); }
  async function reloadGithub() { state.github = await api.github.status(); }

  // ---------- clipboard ----------
  async function copyText(text, silent) {
    await api.clipboard.write(text);
    if (!silent) toast('Disalin ke clipboard', 'ok');
  }

  // ---------- activity bar & sidebar ----------
  function renderActivity() {
    const bar = $('activity');
    bar.replaceChildren();
    for (const v of VIEWS) {
      bar.append(h('button', { class: 'act-btn' + (state.view === v.id ? ' active' : ''), title: v.title, 'aria-label': v.title, onclick: () => setView(v.id) }, icon(v.icon)));
    }
    bar.append(h('div', { class: 'spacer' }));
    bar.append(h('button', { class: 'act-btn' + (state.view === 'help' ? ' active' : ''), title: 'Bantuan (F1)', 'aria-label': 'Bantuan', onclick: () => setView('help') }, icon('help')));
    bar.append(h('button', { class: 'act-btn' + (state.view === 'settings' ? ' active' : ''), title: 'Pengaturan', 'aria-label': 'Pengaturan', onclick: () => setView('settings') }, icon('settings')));
  }

  function setView(v) {
    state.view = v;
    state.filter = '';
    $('side-search').value = '';
    renderActivity();
    renderSidebar();
    if (v === 'github' && state.github.loggedIn && !state.repos) loadRepos();
  }

  function renderSidebar() {
    const titles = { hosts: 'Host', snippets: 'Snippet', keys: 'SSH Keys', github: 'GitHub', deploy: 'Deploy', db: 'Database', server: 'Server', redis: 'Redis', help: 'Bantuan', settings: 'Pengaturan' };
    $('side-title').textContent = titles[state.view];
    const act = $('side-actions');
    act.replaceChildren();
    if (state.view === 'hosts') act.append(iconButton('plus', 'Host baru', () => hostEditor()));
    if (state.view === 'snippets') act.append(iconButton('plus', 'Snippet baru', () => snippetEditor()));
    if (state.view === 'keys') {
      act.append(iconButton('download', 'Impor private key', importKeyDialog));
      act.append(iconButton('plus', 'Buat key baru', generateKeyDialog));
    }
    if (state.view === 'github' && state.github.loggedIn) act.append(iconButton('refresh', 'Muat ulang repo', () => loadRepos(true)));
    if (state.view === 'db') act.append(iconButton('plus', 'Koneksi database baru', () => window.Db.editConn()));
    if (state.view === 'redis') act.append(iconButton('plus', 'Koneksi Redis baru', () => window.Redis.editConn()));
    if (state.view === 'deploy') act.append(iconButton('github', 'Deploy otomatis saat git push (GitHub Actions)', () => window.Cicd.open()));
    if (state.view === 'deploy') act.append(iconButton('plus', 'Pipeline baru', () => window.Deploy.editPipeline()));

    $('side-search-wrap').hidden = !['hosts', 'snippets', 'keys', 'deploy', 'db', 'server', 'redis', 'help'].includes(state.view) && !(state.view === 'github' && state.github.loggedIn);
    const banner = $('side-banner');
    const ss = state.info.secureStorage || {};
    if (!ss.available) {
      banner.hidden = false;
      banner.textContent = 'Penyimpanan aman OS tidak tersedia. Password dan private key tidak dapat disimpan; Anda akan diminta memasukkannya setiap koneksi.';
    } else if (ss.weak) {
      banner.hidden = false;
      banner.textContent = 'Linux tanpa keyring (libsecret/kwallet): rahasia hanya disamarkan, tidak benar-benar terenkripsi. Pasang gnome-keyring atau kwallet untuk keamanan penuh.';
    } else banner.hidden = true;
    renderBody();
  }

  function renderBody() {
    const body = $('side-body');
    body.replaceChildren();
    const views = { hosts: viewHosts, snippets: viewSnippets, keys: viewKeys, github: viewGithub, deploy: (b) => window.Deploy.renderSidebar(b), db: (b) => window.Db.renderSidebar(b), server: (b) => window.Srv.renderSidebar(b), redis: (b) => window.Redis.renderSidebar(b), help: (b) => window.Help.renderSidebar(b), settings: viewSettings };
    views[state.view](body);
  }

  const matches = (q, ...fields) => !q || fields.some((f) => String(f || '').toLowerCase().includes(q));
  const emptyState = (title, text, action) => h('div', { class: 'empty' }, h('b', {}, title), text, action ? h('div', { style: { marginTop: '12px' } }, action) : null);

  // ---------- host view ----------
  function viewHosts(body) {
    const q = state.filter.toLowerCase();
    const list = state.hosts.filter((x) => matches(q, x.name, x.hostname, x.username, x.group));
    if (!state.hosts.length) {
      body.append(emptyState('Belum ada host', 'Tambahkan server pertama Anda untuk mulai.', h('button', { class: 'btn primary', onclick: () => hostEditor() }, 'Tambah host')));
      return;
    }
    if (!list.length) { body.append(emptyState('Tidak ditemukan', 'Coba kata kunci lain.')); return; }
    const groups = new Map();
    for (const x of list) {
      const g = x.group || '';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(x);
    }
    const names = [...groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
    for (const g of names) {
      body.append(h('div', { class: 'group-label' }, g || 'Tanpa grup'));
      for (const x of groups.get(g).sort((a, b) => a.name.localeCompare(b.name))) {
        const live = [...state.sessions.values()].some((s) => s.host.id === x.id && s.status === 'connected');
        body.append(h('div', { class: 'item', tabindex: '0', role: 'button', title: 'Klik untuk menyambung', onclick: () => openHost(x), onkeydown: (e) => { if (e.key === 'Enter') openHost(x); } },
          h('span', { class: 'swatch', style: { background: live ? 'var(--ok)' : COLORS[x.color] ? COLORS[x.color][1] || '' : '' } }),
          h('div', { class: 'grow' }, h('div', { class: 'title' }, x.name), h('div', { class: 'sub mono' }, `${x.username}@${x.hostname}${x.port !== 22 ? ':' + x.port : ''}`)),
          h('div', { class: 'actions' },
            iconButton('edit', 'Ubah', () => hostEditor(x)),
            iconButton('copy', 'Duplikat', guard(async () => { const { id, createdAt, updatedAt, hasPassword, ...rest } = x; await api.hosts.save({ ...rest, name: x.name + ' (salinan)' }); await reloadHosts(); renderBody(); })),
            iconButton('trash', 'Hapus', () => deleteHost(x), 'danger'))));
      }
    }
  }

  async function deleteHost(x) {
    const ok = await confirmDialog({ title: 'Hapus host?', message: `"${x.name}" akan dihapus beserta password tersimpan. Sesi yang sedang terbuka tidak terpengaruh.`, confirmLabel: 'Hapus', danger: true });
    if (!ok) return;
    await guard(async () => { await api.hosts.remove(x.id); await reloadHosts(); renderBody(); })();
  }

  function hostEditor(host) {
    const editing = !!host;
    const v = host || { name: '', group: '', hostname: '', port: 22, username: '', authType: 'password', keyId: '', jumpHostId: '', startupCommand: '', color: '' };
    let authType = v.authType;
    const name = h('input', { type: 'text', value: v.name, placeholder: 'mis. Produksi - Web 1' });
    const group = h('input', { type: 'text', value: v.group, list: 'group-list', placeholder: 'mis. Produksi' });
    const groupList = h('datalist', { id: 'group-list' }, [...new Set(state.hosts.map((x) => x.group).filter(Boolean))].map((g) => h('option', { value: g })));
    const hostname = h('input', { type: 'text', value: v.hostname, placeholder: 'IP atau domain', spellcheck: 'false', autocapitalize: 'off' });
    const port = h('input', { type: 'number', value: v.port, min: '1', max: '65535' });
    const username = h('input', { type: 'text', value: v.username, placeholder: 'root', spellcheck: 'false', autocapitalize: 'off' });
    const password = h('input', { type: 'password', autocomplete: 'new-password', placeholder: editing && v.hasPassword ? 'Tersimpan. Kosongkan jika tidak diubah' : 'Kosongkan untuk ditanya saat koneksi' });
    const clearPw = h('input', { type: 'checkbox' });
    const keySel = h('select', {}, h('option', { value: '' }, state.keys.length ? 'Pilih key…' : 'Belum ada key'), state.keys.map((k) => h('option', { value: k.id, selected: k.id === v.keyId }, `${k.name} (${k.type})`)));
    const jump = h('select', {}, h('option', { value: '' }, 'Tanpa jump host'), state.hosts.filter((x) => !host || x.id !== host.id).map((x) => h('option', { value: x.id, selected: x.id === v.jumpHostId }, x.name)));
    const startup = h('input', { type: 'text', value: v.startupCommand, placeholder: 'mis. cd /var/www && exec $SHELL -l', spellcheck: 'false' });
    const color = h('select', {}, Object.entries(COLORS).map(([k, [label]]) => h('option', { value: k, selected: k === v.color }, label)));
    const testResult = h('div', { class: 'test-result', hidden: true, role: 'status', 'aria-live': 'polite' });

    const pwBox = h('div', {}, field('Password', password), editing && v.hasPassword ? h('label', { class: 'check' }, clearPw, 'Hapus password tersimpan') : null);
    const keyBox = h('div', {}, field('SSH key', keySel, 'Kelola key di panel SSH Keys.'));
    const agentBox = h('div', { class: 'hint', style: { marginBottom: '12px', color: 'var(--muted)' } }, 'Menggunakan SSH agent sistem (ssh-agent / Pageant).');
    const seg = h('div', { class: 'seg', role: 'tablist' });
    const refreshAuth = () => {
      seg.replaceChildren(...[['password', 'Password'], ['key', 'SSH Key'], ['agent', 'Agent']].map(([id, label]) =>
        h('button', { type: 'button', class: authType === id ? 'on' : '', onclick: () => { authType = id; refreshAuth(); } }, label)));
      pwBox.hidden = authType !== 'password';
      keyBox.hidden = authType !== 'key';
      agentBox.hidden = authType !== 'agent';
    };
    refreshAuth();

    const body = h('div', {},
      field('Nama', name),
      h('div', { class: 'row' }, field('Grup', group), field('Warna tab', color)),
      groupList,
      h('div', { class: 'row' }, field('Hostname / IP', hostname), h('div', { class: 'narrow field' }, h('label', {}, 'Port'), port)),
      field('Username', username),
      h('div', { class: 'field' }, h('div', { class: 'lbl' }, 'Autentikasi'), seg),
      pwBox, keyBox, agentBox,
      field('Jump host (opsional)', jump, 'Sambungan diteruskan lewat host ini (ProxyJump).'),
      field('Perintah awal (opsional)', startup, 'Dijalankan otomatis setelah login.'),
      testResult);

    const collect = () => ({
      id: host && host.id, name: name.value, hostname: hostname.value, port: Number(port.value), username: username.value,
      authType, keyId: authType === 'key' ? keySel.value : '', jumpHostId: jump.value,
    });

    const showTest = (kind, title, detail) => {
      testResult.hidden = false;
      testResult.className = 'test-result ' + kind;
      testResult.replaceChildren(h('b', {}, title), detail ? h('div', {}, detail) : '');
      testResult.scrollIntoView({ block: 'nearest' }); // form bisa di-scroll; pastikan hasil terlihat
    };

    async function runTest(secrets = {}) {
      showTest('busy', 'Menguji koneksi…', `${hostname.value.trim()}:${port.value}`);
      try {
        const base = collect();
        if (authType === 'password' && password.value && !secrets.password) secrets = { ...secrets, password: password.value };
        const r = await api.ssh.testHost(base, secrets);
        if (r.ok) {
          showTest('ok', `Koneksi berhasil (${r.latencyMs} ms)`, r.known
            ? 'Sidik jari server cocok dengan yang sudah Anda percayai.'
            : `Server belum pernah dipercaya. Sidik jari: ${r.fingerprint}`);
        } else {
          showTest('err', 'Koneksi gagal', r.message + (r.fingerprint && r.code === 'AUTH_FAILED' ? '\nServer terjangkau, hanya login yang ditolak.' : ''));
        }
      } catch (e) {
        if (e.code === 'NEEDS_SECRET') {
          if (e.kind === 'password' && authType === 'password') {
            const val = await promptDialog({ title: 'Password diperlukan', message: 'Hanya untuk uji koneksi ini, tidak disimpan.', label: 'Password', type: 'password', confirmLabel: 'Uji' });
            if (val) return runTest({ ...secrets, password: val });
            return showTest('err', 'Uji dibatalkan', 'Isi password di form atau masukkan saat diminta.');
          }
          if (e.kind === 'passphrase') {
            const val = await promptDialog({ title: 'Passphrase key diperlukan', message: 'Hanya untuk uji koneksi ini, tidak disimpan.', label: 'Passphrase', type: 'password', confirmLabel: 'Uji' });
            if (val) return runTest({ ...secrets, passphrase: val });
            return showTest('err', 'Uji dibatalkan', 'Passphrase key diperlukan.');
          }
        }
        showTest('err', 'Koneksi gagal', errMsg(e));
      }
    }

    modal({
      title: editing ? 'Ubah host' : 'Host baru',
      body,
      buttons: [
        { label: 'Batal' },
        { label: 'Uji koneksi', onClick: async () => { await runTest(); return false; } },
        {
          label: 'Simpan', kind: 'primary',
          onClick: async () => {
            const saved = await api.hosts.save({
              id: host && host.id, name: name.value, group: group.value, hostname: hostname.value, port: Number(port.value), username: username.value,
              authType, password: authType === 'password' ? password.value : '', clearPassword: clearPw.checked,
              keyId: authType === 'key' ? keySel.value : '', jumpHostId: jump.value, startupCommand: startup.value, color: color.value,
            });
            await reloadHosts();
            renderBody();
            toast(`Host "${saved.name}" disimpan`, 'ok');
          },
        },
      ],
    });
  }

  // ---------- snippets ----------
  function viewSnippets(body) {
    const q = state.filter.toLowerCase();
    if (!state.snippets.length) {
      body.append(emptyState('Belum ada snippet', 'Simpan perintah yang sering dipakai, lalu jalankan dengan satu klik.', h('button', { class: 'btn primary', onclick: () => snippetEditor() }, 'Buat snippet')));
      return;
    }
    for (const s of state.snippets.filter((x) => matches(q, x.name, x.command))) {
      body.append(h('div', { class: 'item', tabindex: '0', role: 'button', title: s.autoRun ? 'Klik untuk mengetik dan menjalankan' : 'Klik untuk mengetik ke terminal aktif', onclick: () => sendSnippet(s), onkeydown: (e) => { if (e.key === 'Enter') sendSnippet(s); } },
        h('span', { class: 'icon', style: { color: 'var(--muted)' } }, icon('terminal')),
        h('div', { class: 'grow' }, h('div', { class: 'title' }, s.name), h('div', { class: 'sub mono' }, s.command.split('\n')[0])),
        h('div', { class: 'actions' }, iconButton('edit', 'Ubah', () => snippetEditor(s)), iconButton('trash', 'Hapus', guard(async () => {
          if (await confirmDialog({ title: 'Hapus snippet?', message: `"${s.name}" akan dihapus.`, confirmLabel: 'Hapus', danger: true })) { await api.snippets.remove(s.id); await reloadSnippets(); renderBody(); }
        }), 'danger'))));
    }
  }

  async function sendSnippet(s) {
    if (s.autoRun) {
      const ok = await confirmDialog({ title: 'Jalankan snippet?', message: s.command, confirmLabel: 'Jalankan' });
      if (!ok) return;
    }
    sendToActive(s.command, s.autoRun);
  }

  function sendToActive(text, run) {
    const s = connectedSession();
    if (!s) { toast('Buka sesi yang terhubung terlebih dahulu.', 'err'); return; }
    s.term.paste(text);
    if (run) api.ssh.write(s.id, '\r');
    s.term.focus();
  }

  function snippetEditor(s) {
    const name = h('input', { type: 'text', value: s ? s.name : '', placeholder: 'mis. Restart Nginx' });
    const cmd = h('textarea', { spellcheck: 'false', placeholder: 'sudo systemctl restart nginx' }, s ? s.command : '');
    const auto = h('input', { type: 'checkbox', checked: s ? s.autoRun : false });
    modal({
      title: s ? 'Ubah snippet' : 'Snippet baru',
      body: h('div', {}, field('Nama', name), field('Perintah', cmd), h('label', { class: 'check' }, auto, 'Jalankan otomatis (tekan Enter setelah mengetik, dengan konfirmasi)')),
      buttons: [{ label: 'Batal' }, { label: 'Simpan', kind: 'primary', onClick: async () => { await api.snippets.save({ id: s && s.id, name: name.value, command: cmd.value, autoRun: auto.checked }); await reloadSnippets(); renderBody(); } }],
    });
  }

  // ---------- keys ----------
  function viewKeys(body) {
    const q = state.filter.toLowerCase();
    if (!state.keys.length) {
      body.append(emptyState('Vault key kosong', 'Buat key baru atau impor key yang sudah ada. Private key disimpan terenkripsi oleh sistem operasi.', h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'center' } }, h('button', { class: 'btn primary', onclick: generateKeyDialog }, 'Buat key'), h('button', { class: 'btn', onclick: importKeyDialog }, 'Impor'))));
      return;
    }
    for (const k of state.keys.filter((x) => matches(q, x.name, x.type, x.fingerprint))) {
      body.append(h('div', { class: 'item', style: { cursor: 'default' } },
        h('span', { class: 'icon', style: { color: 'var(--muted)' } }, icon('key')),
        h('div', { class: 'grow' },
          h('div', { class: 'title' }, k.name, ' ', h('span', { class: 'badge' }, k.type), k.encrypted ? [' ', h('span', { class: 'badge priv' }, 'passphrase')] : null),
          h('div', { class: 'sub mono', title: k.fingerprint }, k.fingerprint)),
        h('div', { class: 'actions' },
          iconButton('copy', 'Salin public key', guard(async () => copyText(await api.keys.publicKey(k.id)))),
          iconButton('upload', 'Pasang ke server aktif', () => installKey(k)),
          state.github.loggedIn ? iconButton('github', 'Tambahkan ke akun GitHub', () => addKeyToGithub(k)) : null,
          iconButton('trash', 'Hapus', guard(async () => {
            if (await confirmDialog({ title: 'Hapus key?', message: `"${k.name}" akan dihapus permanen dari vault. Pastikan Anda masih punya akses ke server lewat cara lain.`, confirmLabel: 'Hapus', danger: true })) { await api.keys.remove(k.id); await reloadKeys(); renderBody(); }
          }), 'danger'))));
    }
  }

  async function installKey(k) {
    const s = connectedSession();
    if (!s) { toast('Buka sesi yang terhubung ke server tujuan terlebih dahulu.', 'err'); return; }
    const ok = await confirmDialog({ title: 'Pasang key ke server?', message: `Public key "${k.name}" akan ditambahkan ke ~/.ssh/authorized_keys pada ${s.host.name} (${s.host.hostname}).`, confirmLabel: 'Pasang' });
    if (!ok) return;
    await guard(async () => {
      const r = await api.keys.installOnServer({ sessionId: s.id, keyId: k.id });
      toast(r.existed ? 'Key sudah terpasang di server.' : 'Key berhasil dipasang. Anda dapat beralih ke autentikasi key.', 'ok');
    })();
  }

  async function addKeyToGithub(k) {
    const title = await promptDialog({ title: 'Tambahkan ke akun GitHub', message: 'Public key akan didaftarkan sebagai SSH key akun Anda.', label: 'Judul key di GitHub', value: `Abux - ${k.name}`, confirmLabel: 'Tambahkan' });
    if (!title) return;
    await guard(async () => { await api.github.addAccountKey({ keyId: k.id, title }); toast('Key ditambahkan ke GitHub', 'ok'); })();
  }

  function showPublicKey(k) {
    const body = h('div', {}, h('p', { style: { margin: '0 0 8px', color: 'var(--muted)' } }, 'Public key aman dibagikan. Private key tetap di vault terenkripsi.'), h('div', { class: 'code' }, k.publicKey), h('p', { style: { color: 'var(--muted)', fontSize: '12px' } }, 'Sidik jari: ', h('span', { class: 'mono' }, k.fingerprint)));
    modal({ title: `Key "${k.name}" siap`, body, buttons: [{ label: 'Tutup' }, { label: 'Salin public key', kind: 'primary', onClick: async () => { await copyText(k.publicKey); return false; } }] });
  }

  function generateKeyDialog() {
    const name = h('input', { type: 'text', value: 'abux-' + new Date().toISOString().slice(0, 10), spellcheck: 'false' });
    let type = 'ed25519';
    const seg = h('div', { class: 'seg' });
    const refresh = () => seg.replaceChildren(...[['ed25519', 'Ed25519 (disarankan)'], ['rsa', 'RSA 4096']].map(([id, l]) => h('button', { type: 'button', class: type === id ? 'on' : '', onclick: () => { type = id; refresh(); } }, l)));
    refresh();
    const pass = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Opsional, sangat disarankan' });
    const remember = h('input', { type: 'checkbox', checked: true });
    modal({
      title: 'Buat SSH key baru',
      body: h('div', {}, field('Nama', name), h('div', { class: 'field' }, h('div', { class: 'lbl' }, 'Tipe'), seg), field('Passphrase', pass), h('label', { class: 'check' }, remember, 'Simpan passphrase di vault (tidak perlu mengetik setiap koneksi)')),
      buttons: [{ label: 'Batal' }, {
        label: 'Buat key', kind: 'primary',
        onClick: async (m) => {
          const k = await api.keys.generate({ name: name.value, type, passphrase: pass.value, remember: remember.checked });
          await reloadKeys(); renderBody();
          setTimeout(() => showPublicKey(k), 0);
        },
      }],
    });
  }

  async function importKeyDialog() {
    let filePath;
    try { filePath = await api.keys.pickFile(); } catch (e) { toast(errMsg(e), 'err'); return; }
    if (!filePath) return;
    const name = h('input', { type: 'text', value: filePath.split(/[\\/]/).pop() });
    const pass = h('input', { type: 'password', autocomplete: 'off', placeholder: 'Isi hanya jika key dienkripsi' });
    const remember = h('input', { type: 'checkbox' });
    modal({
      title: 'Impor private key',
      subtitle: filePath,
      body: h('div', {}, field('Nama di vault', name), field('Passphrase', pass), h('label', { class: 'check' }, remember, 'Simpan passphrase di vault'),
        h('p', { class: 'hint', style: { color: 'var(--muted)', fontSize: '12px' } }, 'File asli tidak diubah. Salinan terenkripsi disimpan di vault Abux.')),
      buttons: [{ label: 'Batal' }, {
        label: 'Impor', kind: 'primary',
        onClick: async () => {
          await api.keys.importFile({ filePath, name: name.value, passphrase: pass.value, remember: remember.checked });
          await reloadKeys(); renderBody(); toast('Key diimpor', 'ok');
        },
      }],
    });
  }

  // ---------- GitHub ----------
  async function loadRepos(force) {
    if (state.reposLoading) return;
    if (state.repos && !force) return;
    state.reposLoading = true;
    renderBody();
    try { state.repos = await api.github.repos(); } catch (e) { toast(errMsg(e), 'err'); state.repos = null; await reloadGithub(); }
    state.reposLoading = false;
    renderSidebar();
  }

  function viewGithub(body) {
    const g = state.github;
    if (!g.loggedIn) {
      const cid = h('input', { type: 'text', value: g.clientId, placeholder: 'Client ID, mis. Iv1.abc123…', spellcheck: 'false' });
      body.append(h('div', { class: 'card' },
        h('b', {}, 'Hubungkan GitHub'),
        h('p', { style: { color: 'var(--muted)', margin: '6px 0 10px' } }, 'Masuk tanpa menyimpan password: Abux memakai Device Flow resmi GitHub. Buat sebuah OAuth App (aktifkan "Device Flow"), lalu tempel Client ID-nya.'),
        field('Client ID', cid),
        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
          h('button', { class: 'btn', onclick: guard(async () => { await api.github.setClientId(cid.value); await reloadGithub(); toast('Client ID disimpan', 'ok'); renderBody(); }) }, 'Simpan ID'),
          h('button', { class: 'btn primary', onclick: guard(async () => { await api.github.setClientId(cid.value); await reloadGithub(); startGithubLogin(); }) }, 'Masuk dengan GitHub')),
        h('p', { style: { marginTop: '10px' } }, h('a', { href: '#', style: { color: '#93c5fd' }, onclick: (e) => { e.preventDefault(); api.app.openExternal('https://github.com/settings/developers'); } }, 'Buka pengaturan OAuth Apps GitHub'))));
      return;
    }
    const u = g.user || {};
    body.append(h('div', { class: 'card user-card' },
      u.avatarUrl ? h('img', { src: u.avatarUrl, alt: '' }) : h('span', { class: 'swatch' }),
      h('div', { class: 'grow', style: { flex: 1, minWidth: 0 } }, h('div', { class: 'title', style: { fontWeight: 600 } }, u.name || u.login), h('div', { class: 'sub', style: { color: 'var(--muted)' } }, '@' + u.login)),
      h('button', { class: 'btn small', onclick: guard(async () => { await api.github.logout(); state.repos = null; await reloadGithub(); renderSidebar(); toast('Keluar dari GitHub'); }) }, 'Keluar')));
    if (state.reposLoading) { body.append(emptyState('Memuat repositori…', '')); return; }
    if (!state.repos) { body.append(emptyState('Repositori belum dimuat', '', h('button', { class: 'btn', onclick: () => loadRepos(true) }, 'Muat'))); return; }
    const q = state.filter.toLowerCase();
    const list = state.repos.filter((r) => matches(q, r.fullName, r.description));
    if (!list.length) { body.append(emptyState('Tidak ada repositori', 'Tidak ada yang cocok.')); return; }
    for (const r of list) {
      body.append(h('div', { class: 'item', style: { cursor: 'default' } },
        h('span', { class: 'icon', style: { color: 'var(--muted)' } }, icon(r.private ? 'key' : 'cloud')),
        h('div', { class: 'grow' }, h('div', { class: 'title' }, r.fullName, r.private ? [' ', h('span', { class: 'badge priv' }, 'privat')] : null), h('div', { class: 'sub' }, r.description || r.sshUrl)),
        h('div', { class: 'actions' },
          iconButton('terminal', 'Ketik perintah git clone di terminal aktif', () => sendToActive(`git clone ${r.sshUrl}`, false)),
          iconButton('copy', 'Salin URL SSH', guard(() => copyText(r.sshUrl))),
          iconButton('key', 'Tambah deploy key', () => deployKeyDialog(r)),
          iconButton('link', 'Buka di GitHub', () => api.app.openExternal('https://github.com/' + r.fullName)))));
    }
  }

  let loginModal = null;
  async function startGithubLogin() {
    let dev;
    try { dev = await api.github.login(); } catch (e) { toast(errMsg(e), 'err'); return; }
    api.app.openExternal(dev.verificationUri);
    loginModal = modal({
      title: 'Masuk ke GitHub',
      subtitle: 'Masukkan kode berikut di halaman GitHub yang terbuka di browser Anda.',
      body: h('div', {}, h('div', { class: 'bigcode' }, dev.userCode),
        h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'center' } },
          h('button', { class: 'btn', onclick: guard(() => copyText(dev.userCode)) }, 'Salin kode'),
          h('button', { class: 'btn', onclick: () => api.app.openExternal(dev.verificationUri) }, 'Buka GitHub')),
        h('p', { style: { color: 'var(--muted)', textAlign: 'center', marginTop: '14px' } }, 'Menunggu otorisasi…')),
      buttons: [{ label: 'Batal' }],
      onClose: () => { if (loginModal) { api.github.cancelLogin().catch(() => {}); loginModal = null; } },
    });
  }

  function deployKeyDialog(repo) {
    if (!state.keys.length) { toast('Buat atau impor SSH key dulu di panel SSH Keys.', 'err'); return; }
    const keySel = h('select', {}, state.keys.map((k) => h('option', { value: k.id }, `${k.name} (${k.type})`)));
    const title = h('input', { type: 'text', value: 'Abux deploy key' });
    const ro = h('input', { type: 'checkbox', checked: true });
    modal({
      title: 'Tambah deploy key',
      subtitle: repo.fullName,
      body: h('div', {}, !repo.admin ? h('div', { class: 'warn' }, 'Anda bukan admin repo ini; GitHub kemungkinan menolak permintaan.') : null,
        field('SSH key', keySel, 'Key ini nantinya dipasang juga di server agar bisa git pull.'), field('Judul', title), h('label', { class: 'check' }, ro, 'Hanya baca (disarankan untuk deployment)')),
      buttons: [{ label: 'Batal' }, { label: 'Tambahkan', kind: 'primary', onClick: async () => { await api.github.addDeployKey({ fullName: repo.fullName, keyId: keySel.value, title: title.value, readOnly: ro.checked }); toast('Deploy key ditambahkan', 'ok'); } }],
    });
  }

  // ---------- settings ----------
  let settingsTimer = null;
  function saveSettings(partial) {
    Object.assign(state.settings, partial);
    applySettings();
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => api.settings.set(partial).catch((e) => toast(errMsg(e), 'err')), 250);
  }

  // ---------- cadangan & pembaruan ----------
  async function backupExport() {
    const pass = await promptDialog({ title: 'Ekspor cadangan', message: 'Opsional: isi passphrase untuk mengenkripsi berkas. Kosongkan untuk JSON biasa (tetap tanpa rahasia).', label: 'Passphrase (opsional)', type: 'password', confirmLabel: 'Pilih lokasi' });
    if (pass === null) return;
    try { const f = await api.backup.exportTo(pass); if (f) toast('Cadangan disimpan: ' + f, 'ok'); } catch (e) { toast(errMsg(e), 'err'); }
  }
  async function backupImport() {
    try {
      let r;
      try { r = await api.backup.importFrom(''); } catch (e) {
        if (e.code !== 'NEEDS_PASSPHRASE') throw e;
        const p = await promptDialog({ title: 'Cadangan terenkripsi', label: 'Passphrase', type: 'password', confirmLabel: 'Impor' });
        if (p === null) return;
        r = await api.backup.importFrom(p);
      }
      if (!r) return;
      await Promise.all([reloadHosts(), reloadKeys(), reloadSnippets()]);
      state.settings = await api.settings.get();
      try { await window.Deploy.reload(); await window.Db.init(); await window.Redis.init(); } catch (_) { /* abaikan */ }
      renderBody();
      toast(`Diimpor: ${r.hosts} host, ${r.snippets} snippet, ${r.pipelines} pipeline, ${r.dbConns} koneksi DB (${r.skipped} dilewati). Password perlu diisi ulang.`, 'ok');
    } catch (e) { toast(errMsg(e), 'err'); }
  }
  function updateSection() {
    const repo = h('input', { class: 'mono', placeholder: 'akunmu/abux', value: state.settings.updateRepo || '' });
    const out = h('div', { class: 'db-note', hidden: true });
    repo.addEventListener('change', () => saveSettings({ updateRepo: repo.value.trim() }));
    const check = async () => {
      state.settings.updateRepo = repo.value.trim();
      try { await api.settings.set({ updateRepo: state.settings.updateRepo }); } catch (e) { toast(errMsg(e), 'err'); return; }
      out.hidden = false; out.className = 'db-note'; out.textContent = 'Memeriksa…';
      try {
        const r = await api.update.check();
        out.replaceChildren();
        if (r.upToDate) { out.className = 'db-note ok'; out.textContent = r.latest ? `Anda sudah memakai versi terbaru (v${r.current}).` : (r.note || 'Tidak ada rilis.'); return; }
        out.className = 'db-note'; out.append(h('div', {}, h('b', {}, `Versi baru tersedia: v${r.latest}`), ` (Anda: v${r.current})`), r.notes ? h('pre', { class: 'mono', style: { whiteSpace: 'pre-wrap', maxHeight: '140px', overflow: 'auto', margin: '6px 0' } }, r.notes) : null,
          h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, r.asset ? h('button', { class: 'btn primary small', onclick: () => api.app.openExternal(r.asset.url) }, 'Unduh ' + r.asset.name) : null, h('button', { class: 'btn small', onclick: () => api.app.openExternal(r.page) }, 'Halaman rilis')),
          h('div', { class: 'sub', style: { marginTop: '6px' } }, 'Aplikasi belum ditandatangani Apple, jadi pembaruan dipasang manual: unduh, buka, seret ke Applications (lihat panduan).'));
      } catch (e) { out.className = 'db-note err'; out.textContent = errMsg(e); }
    };
    return h('div', {}, h('div', { style: { color: 'var(--muted)', lineHeight: '1.6', marginBottom: '8px' } }, 'Abux memeriksa rilis terbaru di repositori GitHub Anda (hanya membaca halaman rilis; tidak mengunduh atau menjalankan apa pun otomatis).'),
      field('Repositori rilis', repo, 'Format pemilik/nama, mis. abulmahasin/abux'), h('button', { class: 'btn', onclick: check }, icon('refresh'), 'Periksa pembaruan'), out);
  }

  function viewSettings(body) {
    const s = state.settings;
    const num = (key, min, max, label) => {
      const i = h('input', { type: 'number', min, max, value: s[key] });
      i.addEventListener('change', () => { const n = Math.min(max, Math.max(min, Number(i.value) || s[key])); i.value = n; saveSettings({ [key]: n }); });
      return field(label, i);
    };
    const chk = (key, label) => {
      const c = h('input', { type: 'checkbox', checked: !!s[key] });
      c.addEventListener('change', () => saveSettings({ [key]: c.checked }));
      return h('label', { class: 'check' }, c, label);
    };
    const theme = h('select', {}, Object.entries(THEMES).map(([k, t]) => h('option', { value: k, selected: k === s.theme }, t.label)));
    theme.addEventListener('change', () => saveSettings({ theme: theme.value }));
    const cursor = h('select', {}, [['block', 'Blok'], ['bar', 'Garis'], ['underline', 'Garis bawah']].map(([k, l]) => h('option', { value: k, selected: k === s.cursorStyle }, l)));
    cursor.addEventListener('change', () => saveSettings({ cursorStyle: cursor.value }));
    const ff = h('input', { type: 'text', value: s.fontFamily, spellcheck: 'false' });
    ff.addEventListener('change', () => saveSettings({ fontFamily: ff.value.trim() || 'monospace' }));

    body.append(
      h('div', { class: 'settings-sec' }, h('h4', {}, 'Terminal'), field('Tema', theme), num('fontSize', 9, 28, 'Ukuran font'), field('Font', ff, 'Daftar dipisah koma; font harus terpasang di komputer Anda.'), field('Bentuk kursor', cursor), chk('cursorBlink', 'Kursor berkedip'), num('scrollback', 1000, 100000, 'Baris scrollback')),
      h('div', { class: 'settings-sec' }, h('h4', {}, 'Salin & tempel'),
        chk('copyOnSelect', 'Salin otomatis saat teks dipilih'),
        chk('rightClickPaste', 'Klik kanan: salin jika ada seleksi, selain itu tempel (Shift+klik kanan membuka menu)'),
        chk('ctrlCCopiesSelection', 'Ctrl+C menyalin bila ada seleksi (tanpa seleksi tetap Ctrl+C / SIGINT)'),
        chk('confirmMultilinePaste', 'Minta konfirmasi saat menempel teks multi-baris')),
      h('div', { class: 'settings-sec', id: 'bk-sec' }, h('h4', {}, 'Cadangan & sinkronisasi'),
        h('div', { style: { color: 'var(--muted)', lineHeight: '1.6', marginBottom: '8px' } }, 'Ekspor host, snippet, pipeline, koneksi database/Redis, dan pengaturan ke satu berkas. Password, private key, dan token GitHub TIDAK ikut (terikat ke mesin ini). Untuk sinkronisasi, simpan berkas di folder iCloud/Dropbox/Git Anda lalu impor di komputer lain.'),
        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, h('button', { class: 'btn', onclick: backupExport }, icon('upload'), 'Ekspor cadangan…'), h('button', { class: 'btn', onclick: backupImport }, icon('download'), 'Impor cadangan…'))),
      h('div', { class: 'settings-sec', id: 'up-sec' }, h('h4', {}, 'Pembaruan aplikasi'), updateSection()),
      h('div', { class: 'settings-sec', id: 'kh-sec' }, h('h4', {}, 'Known hosts')),
      h('div', { class: 'settings-sec' }, h('h4', {}, 'Tentang'), h('div', { style: { color: 'var(--muted)', lineHeight: '1.7' } }, h('b', { style: { color: 'var(--text)' } }, `Abux v${state.info.version || ''}`), h('br'), 'Klien SSH profesional: terminal, SFTP, GitHub, Deploy, dan database.', h('br'), 'Developer: ABUL MAHASIN', h('br'), 'Lisensi: MIT', h('br'), 'Data disimpan lokal. Rahasia dienkripsi oleh Keychain / DPAPI / libsecret.')));
    loadKnownHosts();
  }

  async function loadKnownHosts() {
    const sec = document.getElementById('kh-sec');
    if (!sec) return;
    let list = [];
    try { list = await api.knownHosts.list(); } catch (e) { toast(errMsg(e), 'err'); }
    if (!list.length) { sec.append(h('div', { style: { color: 'var(--muted)' } }, 'Belum ada host yang dipercaya.')); return; }
    for (const k of list) {
      sec.append(h('div', { class: 'item', style: { cursor: 'default' } },
        h('div', { class: 'grow' }, h('div', { class: 'title' }, k.id), h('div', { class: 'sub mono', title: k.fingerprint }, k.fingerprint)),
        h('div', { class: 'actions', style: { display: 'flex' } }, iconButton('trash', 'Lupakan host ini', guard(async () => {
          if (await confirmDialog({ title: 'Lupakan host key?', message: `Sidik jari untuk ${k.id} dihapus. Anda akan diminta memverifikasi ulang saat koneksi berikutnya.`, confirmLabel: 'Hapus', danger: true })) { await api.knownHosts.remove(k.id); renderBody(); }
        }), 'danger'))));
    }
  }

  // ---------- terminal sessions ----------
  const termOptions = () => ({
    fontFamily: state.settings.fontFamily,
    fontSize: state.settings.fontSize,
    cursorStyle: state.settings.cursorStyle,
    cursorBlink: state.settings.cursorBlink,
    scrollback: state.settings.scrollback,
    theme: THEMES[state.settings.theme] || THEMES.midnight,
  });

  function applySettings() {
    const o = termOptions();
    for (const s of state.sessions.values()) {
      Object.assign(s.term.options, o);
      s.wrap.style.background = o.theme.background;
      fitSession(s);
    }
    $('stage').style.background = o.theme.background;
  }

  function fitSession(s) {
    if (!s.wrap.classList.contains('active')) return;
    try { s.fit.fit(); } catch (_) { /* terminal belum terlihat */ }
  }

  async function pasteInto(s) {
    let text = '';
    try { text = await api.clipboard.read(); } catch (e) { toast(errMsg(e), 'err'); return; }
    if (!text) return;
    if (state.settings.confirmMultilinePaste && /[\r\n]/.test(text)) {
      const lines = text.split(/\r?\n/);
      const preview = h('pre', { class: 'code pre-preview' }, lines.slice(0, 8).join('\n') + (lines.length > 8 ? `\n… (+${lines.length - 8} baris)` : ''));
      const ok = await confirmDialog({ title: 'Tempel teks multi-baris?', message: `Teks berisi ${lines.length} baris dan dapat langsung menjalankan perintah di server.`, confirmLabel: 'Tempel', extra: preview });
      if (!ok) { s.term.focus(); return; }
    }
    s.term.paste(text);
    s.term.focus();
  }

  function copySelection(s, silent) {
    if (!s.term.hasSelection()) return false;
    copyText(s.term.getSelection(), silent).catch((e) => toast(errMsg(e), 'err'));
    return true;
  }

  function toggleSearch(s, force) {
    if (!s.searchBar) {
      const input = h('input', { type: 'text', placeholder: 'Cari di terminal…', spellcheck: 'false' });
      const next = () => s.search.findNext(input.value);
      const prev = () => s.search.findPrevious(input.value);
      input.addEventListener('input', () => s.search.findNext(input.value, { incremental: true }));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); (e.shiftKey ? prev : next)(); }
        if (e.key === 'Escape') { e.preventDefault(); toggleSearch(s, false); }
      });
      s.searchBar = h('div', { class: 'search-bar', hidden: true }, input, iconButton('up', 'Sebelumnya', prev), iconButton('refresh', 'Berikutnya', next), iconButton('x', 'Tutup', () => toggleSearch(s, false)));
      s.searchInput = input;
      s.wrap.append(s.searchBar);
    }
    const show = force != null ? force : s.searchBar.hidden;
    s.searchBar.hidden = !show;
    if (show) { s.searchInput.focus(); s.searchInput.select(); } else { s.search.clearDecorations && s.search.clearDecorations(); s.term.focus(); }
  }

  function showOverlay(s, { title, message, buttons }) {
    hideOverlay(s);
    s.overlay = h('div', { class: 'overlay' }, h('div', { class: 'box' }, h('h3', {}, title), h('p', {}, message), h('div', { class: 'btns' }, buttons.map((b) => h('button', { class: 'btn ' + (b.kind || ''), onclick: b.onClick }, b.label)))));
    s.wrap.append(s.overlay);
    s.overlay.querySelector('button.primary')?.focus();
  }

  function hideOverlay(s) {
    if (s.overlay) { s.overlay.remove(); s.overlay = null; }
  }

  function setStatus(s, status) {
    s.status = status;
    renderTabs();
    updateStatusBar();
    if (state.view === 'hosts') renderBody();
  }

  function createSession(host) {
    const id = crypto.randomUUID();
    const term = new Terminal({
      ...termOptions(),
      allowProposedApi: true,
      macOptionIsMeta: true,
      scrollOnUserInput: true,
      smoothScrollDuration: 0,
    });
    const fit = new FitAddon.FitAddon();
    const search = new SearchAddon.SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, uri) => api.app.openExternal(uri)));
    const wrap = h('div', { class: 'term-wrap' });
    wrap.style.background = termOptions().theme.background;
    $('terminals').append(wrap);
    term.open(wrap);

    const s = { id, host, term, fit, search, wrap, status: 'connecting', overlay: null, searchBar: null };
    state.sessions.set(id, s);

    term.onData((d) => api.ssh.write(id, d));
    term.onResize(({ cols, rows }) => { api.ssh.resize(id, cols, rows); updateStatusBar(); });
    term.onSelectionChange(() => { if (state.settings.copyOnSelect && term.hasSelection()) copySelection(s, true); });

    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true;
      const k = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
      const { ctrlKey: ctrl, shiftKey: shift, metaKey: meta, altKey: alt } = ev;
      const copyCombo = isMac ? meta && !shift && k === 'c' : ctrl && shift && k === 'c';
      const smartCopy = !isMac && ctrl && !shift && !alt && k === 'c' && state.settings.ctrlCCopiesSelection && term.hasSelection();
      if (copyCombo || smartCopy) {
        if (copySelection(s)) term.clearSelection();
        return false;
      }
      const pasteCombo = (isMac ? meta && k === 'v' : ctrl && k === 'v') || (shift && ev.key === 'Insert');
      if (pasteCombo) { ev.preventDefault(); pasteInto(s); return false; }
      if ((isMac && meta && k === 'f') || (!isMac && ctrl && shift && k === 'f')) { ev.preventDefault(); toggleSearch(s, true); return false; }
      if (ctrl && (ev.key === 'PageUp' || ev.key === 'PageDown' || ev.key === 'Tab')) return false;
      if ((isMac ? meta : alt) && /^[1-9]$/.test(ev.key)) return false;
      if (!isMac && ctrl && shift && k === 'w') return false;
      return true;
    });

    wrap.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (state.settings.rightClickPaste && !e.shiftKey) {
        if (term.hasSelection()) { copySelection(s); term.clearSelection(); } else pasteInto(s);
        return;
      }
      contextMenu(e.clientX, e.clientY, [
        { label: 'Salin', hint: isMac ? '⌘C' : 'Ctrl+Shift+C', onClick: () => { copySelection(s); } },
        { label: 'Tempel', hint: isMac ? '⌘V' : 'Ctrl+V', onClick: () => pasteInto(s) },
        { label: 'Pilih semua', onClick: () => term.selectAll() },
        '-',
        { label: 'Cari…', hint: isMac ? '⌘F' : 'Ctrl+Shift+F', onClick: () => toggleSearch(s, true) },
        { label: 'Bersihkan layar', onClick: () => term.clear() },
      ]);
    });

    activate(id);
    runConnect(s);
    return s;
  }

  async function runConnect(s, secrets = {}) {
    hideOverlay(s);
    setStatus(s, 'connecting');
    const label = clean(`${s.host.username}@${s.host.hostname}:${s.host.port}`);
    s.term.writeln(`\x1b[90mMenghubungkan ke ${label} …\x1b[0m`);
    fitSession(s);
    try {
      await api.ssh.connect({ sessionId: s.id, hostId: s.host.id, cols: s.term.cols, rows: s.term.rows, secrets });
      if (!state.sessions.has(s.id)) { api.ssh.close(s.id).catch(() => {}); return; } // tab ditutup saat menyambung
      setStatus(s, 'connected');
      if (state.activeId === s.id) s.term.focus();
      if (state.sftp.open) sftpLoad(s.id);
    } catch (e) {
      if (!state.sessions.has(s.id)) return;
      if (e.code === 'NEEDS_SECRET') {
        const isPw = e.kind === 'password';
        const val = await promptDialog({
          title: isPw ? 'Password diperlukan' : 'Passphrase key diperlukan',
          message: `Untuk ${e.label || s.host.name}. Tidak disimpan.`,
          label: isPw ? 'Password' : 'Passphrase', type: 'password', confirmLabel: 'Sambungkan',
        });
        if (val) return runConnect(s, isPw ? { ...secrets, password: val } : { ...secrets, passphrase: val });
      }
      s.term.writeln(`\r\n\x1b[31m${clean(errMsg(e)).replace(/\n/g, ' ')}\x1b[0m`);
      setStatus(s, 'closed');
      showOverlay(s, {
        title: 'Gagal menyambung', message: errMsg(e),
        buttons: [{ label: 'Tutup tab', onClick: () => closeSession(s.id) }, { label: 'Coba lagi', kind: 'primary', onClick: () => runConnect(s) }],
      });
    }
  }

  function openHost(host) {
    createSession(host);
  }

  function closeSession(id) {
    const s = state.sessions.get(id);
    if (!s) return;
    state.sessions.delete(id);
    api.ssh.close(id).catch(() => {});
    s.term.dispose();
    s.wrap.remove();
    if (state.activeId === id) {
      const rest = [...state.sessions.keys()];
      state.activeId = null;
      if (rest.length) activate(rest[rest.length - 1]); else afterActiveChange();
    }
    renderTabs();
    if (state.view === 'hosts') renderBody();
  }

  function activate(id) {
    state.activeId = id;
    for (const s of state.sessions.values()) s.wrap.classList.toggle('active', s.id === id);
    afterActiveChange();
    const s = activeSession();
    if (s) requestAnimationFrame(() => { fitSession(s); s.term.focus(); });
  }

  function afterActiveChange() {
    $('welcome').hidden = state.sessions.size > 0;
    renderTabs();
    updateStatusBar();
    if (state.sftp.open) sftpLoad(state.activeId);
  }

  function renderTabs() {
    const tabs = $('tabs');
    tabs.replaceChildren();
    for (const s of state.sessions.values()) {
      const color = COLORS[s.host.color] && COLORS[s.host.color][1];
      const tab = h('div', { class: 'tab' + (s.id === state.activeId ? ' active' : ''), role: 'tab', 'aria-selected': String(s.id === state.activeId), title: `${s.host.username}@${s.host.hostname}`,
        style: color ? { '--tab-color': color } : null,
        onclick: () => activate(s.id),
        onauxclick: (e) => { if (e.button === 1) { e.preventDefault(); closeSession(s.id); } },
        oncontextmenu: (e) => {
          e.preventDefault();
          contextMenu(e.clientX, e.clientY, [
            { label: 'Duplikat sesi', onClick: () => createSession(s.host) },
            { label: 'Sambung ulang', onClick: () => { api.ssh.close(s.id).catch(() => {}); runConnect(s); } },
            '-',
            { label: 'Tutup', onClick: () => closeSession(s.id) },
            { label: 'Tutup tab lain', onClick: () => { for (const o of [...state.sessions.keys()]) if (o !== s.id) closeSession(o); } },
          ]);
        } },
        h('i', { class: 'dot ' + s.status }), h('span', { class: 'tname' }, s.host.name),
        h('button', { class: 'icon-btn', title: 'Tutup tab', 'aria-label': 'Tutup tab', onclick: (e) => { e.stopPropagation(); closeSession(s.id); } }, icon('x')));
      tabs.append(tab);
    }
  }

  function updateStatusBar() {
    const s = activeSession();
    const dot = document.querySelector('#st-conn .dot');
    const label = { connecting: 'Menghubungkan…', connected: 'Terhubung', closed: 'Terputus', idle: '' };
    if (!s) {
      dot.className = 'dot idle';
      $('st-text').textContent = 'Tidak ada sesi';
      $('st-right').textContent = '';
      return;
    }
    dot.className = 'dot ' + s.status;
    $('st-text').textContent = `${s.host.username}@${s.host.hostname}:${s.host.port} · ${label[s.status]}`;
    $('st-right').textContent = `${s.term.cols}×${s.term.rows} · ${state.sessions.size} sesi`;
  }

  function cycleTab(delta) {
    const ids = [...state.sessions.keys()];
    if (ids.length < 2) return;
    const i = ids.indexOf(state.activeId);
    activate(ids[(i + delta + ids.length) % ids.length]);
  }

  // ---------- host key prompt ----------
  function hostKeyPrompt(p) {
    let answered = false;
    const answer = (ok) => { if (!answered) { answered = true; api.ssh.answerHostKey(p.promptId, ok).catch(() => {}); } };
    modal({
      title: 'Verifikasi server baru',
      subtitle: `Keaslian ${p.host}:${p.port} belum dapat dipastikan.`,
      body: h('div', {}, h('p', { style: { marginTop: 0 } }, 'Ini pertama kalinya Anda menyambung ke server ini. Pastikan sidik jari di bawah sama dengan yang ditampilkan penyedia server Anda (mis. lewat `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`).'), h('div', { class: 'code' }, p.fingerprint)),
      buttons: [{ label: 'Batalkan', onClick: () => answer(false) }, { label: 'Percayai & lanjutkan', kind: 'primary', onClick: () => answer(true) }],
      onClose: () => answer(false),
    });
  }

  // ---------- SFTP ----------
  const joinPath = (dir, name) => (dir.endsWith('/') ? dir : dir + '/') + name;
  const parentPath = (p) => (p === '/' ? '/' : p.replace(/\/[^/]*\/?$/, '') || '/');

  function toggleSftp(force) {
    state.sftp.open = force != null ? force : !state.sftp.open;
    $('sftp-panel').hidden = !state.sftp.open;
    renderToolButtons();
    if (state.sftp.open) sftpLoad(state.activeId, state.sftp.sessionId === state.activeId ? state.sftp.path : null);
    const s = activeSession();
    if (s) requestAnimationFrame(() => fitSession(s));
  }

  async function sftpLoad(sessionId, dir) {
    const f = state.sftp;
    f.sessionId = sessionId;
    f.error = '';
    const s = state.sessions.get(sessionId);
    if (!s || s.status !== 'connected') { f.entries = []; f.path = ''; f.error = s ? 'Sesi belum terhubung.' : 'Buka sesi untuk menjelajah berkas.'; renderSftp(); return; }
    f.loading = true;
    renderSftp();
    try {
      const r = await api.sftp.list(sessionId, dir || '.');
      if (state.sftp.sessionId !== sessionId) return;
      f.path = r.path; f.entries = r.entries;
    } catch (e) { f.error = errMsg(e); }
    f.loading = false;
    renderSftp();
  }

  function renderSftp() {
    const panel = $('sftp-panel');
    if (!state.sftp.open) return;
    const f = state.sftp;
    const sid = f.sessionId;
    const connected = !!(sid && state.sessions.get(sid) && state.sessions.get(sid).status === 'connected');
    const pathInput = h('input', { type: 'text', value: f.path, spellcheck: 'false', 'aria-label': 'Path remote', disabled: !connected });
    pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sftpLoad(sid, pathInput.value.trim() || '/'); });
    const doUpload = guard(async () => { const n = await api.sftp.upload(sid, f.path); if (n) { toast(`${n} berkas diunggah`, 'ok'); } state.sftp.progress = null; sftpLoad(sid, f.path); });
    const doMkdir = async () => {
      const name = await promptDialog({ title: 'Folder baru', label: 'Nama folder', confirmLabel: 'Buat' });
      if (name && name.trim()) await guard(async () => { await api.sftp.mkdir(sid, joinPath(f.path, name.trim())); sftpLoad(sid, f.path); })();
    };
    const head = h('div', { class: 'sftp-head' },
      h('div', { class: 'top' }, h('h3', {}, 'Berkas (SFTP)'), iconButton('x', 'Tutup panel', () => toggleSftp(false))),
      h('div', { class: 'sftp-path' }, iconButton('up', 'Folder induk', () => sftpLoad(sid, parentPath(f.path))), pathInput, iconButton('refresh', 'Muat ulang', () => sftpLoad(sid, f.path))),
      h('div', { style: { display: 'flex', gap: '6px' } }, h('button', { class: 'btn small', disabled: !connected, onclick: doUpload }, icon('upload'), 'Unggah'), h('button', { class: 'btn small', disabled: !connected, onclick: doMkdir }, icon('folderPlus'), 'Folder')));

    const list = h('div', { class: 'sftp-list' });
    if (f.loading) list.append(h('div', { class: 'empty' }, 'Memuat…'));
    else if (f.error) list.append(h('div', { class: 'empty' }, f.error));
    else if (!f.entries.length) list.append(h('div', { class: 'empty' }, 'Folder kosong'));
    for (const e of f.entries) {
      const full = joinPath(f.path, e.name);
      list.append(h('div', { class: 'sftp-row' + (e.isDir ? ' dir' : ''), ondblclick: () => (e.isDir ? sftpLoad(sid, full) : window.Editor.open(sid, full)) },
        h('span', { class: 'icon', style: { color: e.isDir ? '#93c5fd' : 'var(--muted)' } }, icon(e.isDir ? 'folder' : 'file')),
        h('span', { class: 'name', title: e.name, onclick: () => e.isDir && sftpLoad(sid, full) }, e.name),
        h('span', { class: 'meta' }, e.isDir ? '' : fmtSize(e.size)),
        h('span', { class: 'actions' },
          e.isDir ? null : iconButton('edit', 'Edit berkas teks', () => window.Editor.open(sid, full)),
          e.isDir ? null : iconButton('download', 'Unduh', guard(async () => { const p = await api.sftp.download(sid, full); state.sftp.progress = null; renderSftp(); if (p) toast('Tersimpan: ' + p, 'ok'); })),
          iconButton('rename', 'Ganti nama', async () => {
            const n = await promptDialog({ title: 'Ganti nama', label: 'Nama baru', value: e.name, confirmLabel: 'Simpan' });
            if (n && n.trim() && n !== e.name) await guard(async () => { await api.sftp.rename(sid, full, joinPath(f.path, n.trim())); sftpLoad(sid, f.path); })();
          }),
          iconButton('trash', 'Hapus', async () => {
            const ok = await confirmDialog({ title: e.isDir ? 'Hapus folder beserta isinya?' : 'Hapus berkas?', message: full, confirmLabel: 'Hapus', danger: true });
            if (ok) await guard(async () => { await api.sftp.remove(sid, full, e.isDir); sftpLoad(sid, f.path); })();
          }, 'danger'))));
    }
    const p = f.progress;
    const foot = h('div', { class: 'sftp-foot' }, p ? [`${p.name} · ${fmtSize(p.transferred)} / ${fmtSize(p.total)}`, h('div', { class: 'bar' }, h('i', { style: { width: (p.total ? Math.min(100, (p.transferred / p.total) * 100) : 0) + '%' } }))] : `${f.entries.length} item`);
    panel.replaceChildren(head, list, foot);
  }

  function renderToolButtons() {
    const tools = $('tab-tools');
    tools.replaceChildren(h('button', { class: 'btn small', title: 'Panel berkas SFTP', onclick: () => toggleSftp(), style: state.sftp.open ? { borderColor: 'var(--accent)' } : null }, icon('folder'), 'Berkas'));
  }

  // ---------- init ----------
  async function init() {
    document.querySelectorAll('.mod-copy').forEach((e) => { e.textContent = isMac ? '⌘C' : 'Ctrl+Shift+C / Ctrl+C (ada seleksi)'; });
    document.querySelectorAll('.mod-paste').forEach((e) => { e.textContent = isMac ? '⌘V' : 'Ctrl+V / Ctrl+Shift+V'; });
    document.querySelectorAll('.mod-find').forEach((e) => { e.textContent = isMac ? '⌘F' : 'Ctrl+Shift+F'; });

    try {
      [state.info, state.settings] = await Promise.all([api.app.info(), api.settings.get()]);
      await Promise.all([reloadHosts(), reloadKeys(), reloadSnippets(), reloadGithub()]);
    } catch (e) { toast('Gagal memuat data: ' + errMsg(e), 'err'); }
    try { await window.Deploy.init(); } catch (e) { toast('Gagal memuat Deploy: ' + errMsg(e), 'err'); }
    try { await window.Db.init(); } catch (e) { toast('Gagal memuat Database: ' + errMsg(e), 'err'); }
    try { await window.Redis.init(); } catch (e) { toast('Gagal memuat Redis: ' + errMsg(e), 'err'); }

    $('stage').style.background = (THEMES[state.settings.theme] || THEMES.midnight).background;
    $('side-search').addEventListener('input', (e) => { state.filter = e.target.value; renderBody(); });
    $('welcome-new-host').addEventListener('click', () => hostEditor());
    $('welcome-help').addEventListener('click', () => window.Help.open());
    $('welcome-gen-key').addEventListener('click', () => { setView('keys'); generateKeyDialog(); });

    api.ssh.onData(({ sessionId, data }) => { const s = state.sessions.get(sessionId); if (s) s.term.write(data); });
    api.ssh.onClosed(({ sessionId, reason }) => {
      const s = state.sessions.get(sessionId);
      if (!s || s.status === 'closed') return;
      s.term.writeln(`\r\n\x1b[33m[${clean(reason || 'Sesi berakhir')}]\x1b[0m`);
      setStatus(s, 'closed');
      if (state.sftp.open && state.sftp.sessionId === sessionId) sftpLoad(sessionId);
      showOverlay(s, { title: 'Sesi berakhir', message: reason || 'Koneksi ditutup.', buttons: [{ label: 'Tutup tab', onClick: () => closeSession(sessionId) }, { label: 'Sambung ulang', kind: 'primary', onClick: () => runConnect(s) }] });
    });
    api.ssh.onHostKeyPrompt(hostKeyPrompt);
    api.sftp.onProgress((p) => {
      if (p.sessionId !== state.sftp.sessionId || !state.sftp.open) return;
      state.sftp.progress = p;
      const bar = document.querySelector('.sftp-foot');
      if (bar) renderSftp();
    });
    api.github.onLoginResult(async (r) => {
      if (loginModal) { const m = loginModal; loginModal = null; m.close(); }
      await reloadGithub();
      if (r.ok) { toast(`Masuk sebagai @${r.user.login}`, 'ok'); state.repos = null; } else toast(r.error || 'Login GitHub gagal', 'err');
      renderSidebar();
      if (r.ok && state.view === 'github') loadRepos(true);
    });

    window.addEventListener('keydown', (e) => {
      const ctrl = e.ctrlKey;
      if (ctrl && (e.key === 'PageDown' || (e.key === 'Tab' && !e.shiftKey))) { e.preventDefault(); e.stopPropagation(); cycleTab(1); }
      else if (ctrl && (e.key === 'PageUp' || (e.key === 'Tab' && e.shiftKey))) { e.preventDefault(); e.stopPropagation(); cycleTab(-1); }
      else if ((isMac ? e.metaKey : e.altKey) && /^[1-9]$/.test(e.key) && !document.querySelector('#modal-root .backdrop')) {
        const id = [...state.sessions.keys()][Number(e.key) - 1];
        if (id) { e.preventDefault(); activate(id); }
      } else if (!isMac && ctrl && e.shiftKey && e.key.toLowerCase() === 'w' && state.activeId) { e.preventDefault(); closeSession(state.activeId); }
    }, true);

    const ro = new ResizeObserver(() => { const s = activeSession(); if (s) fitSession(s); });
    ro.observe($('stage'));

    renderActivity();
    renderToolButtons();
    renderTabs();
    updateStatusBar();
    renderSidebar();
  }

  window.addEventListener('DOMContentLoaded', init);
})();
