'use strict';

/* Panel Server: Monitor (CPU/RAM/disk/beban/proses), Docker (container + compose), Penampil Log. */
(() => {
  const { h, icon, toast, confirmDialog, promptDialog } = window.UI;
  const api = window.api;
  const App = window.AbuxApp;
  const LV = window.LogView;
  const errMsg = (e) => (e && e.message ? e.message : String(e));
  const SVG = 'http://www.w3.org/2000/svg';
  const MAX_ENTRIES = 5000;

  const S = { pane: null, timers: new Set(), streams: new Map() };
  const hostOf = (id) => App.state.hosts.find((x) => x.id === id);
  const lsGet = (k, d) => { try { return localStorage.getItem(k) || d; } catch (_) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* abaikan */ } };

  function fmtBytes(n) {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
  }
  function fmtUptime(sec) {
    const d = Math.floor(sec / 86400); const hh = Math.floor((sec % 86400) / 3600); const m = Math.floor((sec % 3600) / 60);
    return d ? `${d}h ${hh}j` : hh ? `${hh}j ${m}m` : `${m}m`;
  }

  // ---------- sidebar ----------
  function renderSidebar(body) {
    const q = App.state.filter.toLowerCase();
    if (!App.state.hosts.length) { body.append(h('div', { class: 'empty' }, h('b', {}, 'Belum ada host'), 'Tambahkan host SSH dulu, lalu pantau server dan kelola Docker di sini.')); return; }
    body.append(h('div', { class: 'db-note', style: { margin: '8px 10px' } }, 'Pilih host untuk membuka Monitor, Docker, dan Log. Abux menyambung otomatis bila belum tersambung.'));
    for (const x of App.state.hosts.filter((x) => !q || x.name.toLowerCase().includes(q) || x.hostname.toLowerCase().includes(q))) {
      body.append(h('div', { class: 'item', tabindex: '0', role: 'button', onclick: () => openHost(x), onkeydown: (e) => { if (e.key === 'Enter') openHost(x); } },
        h('span', { class: 'icon', style: { color: 'var(--accent)' } }, icon('activity')),
        h('div', { class: 'grow' }, h('div', { class: 'title' }, x.name), h('div', { class: 'sub mono' }, `${x.username}@${x.hostname}`))));
    }
  }

  // ---------- pane ----------
  function stopAll() {
    for (const t of S.timers) clearInterval(t);
    S.timers.clear();
    for (const id of S.streams.keys()) api.server.streamStop(id).catch(() => {});
    S.streams.clear();
  }
  function unmount() { stopAll(); if (S.pane) { S.pane.el.remove(); S.pane = null; } }

  async function openHost(host) {
    try {
      const sess = await window.Deploy.ensureSession(host);
      unmount();
      const el = h('section', { id: 'srv-pane', class: 'db-pane', 'aria-label': 'Panel server' });
      document.getElementById('main').append(el);
      const P = { host, sess, el, tab: lsGet('abux.srv.tab', 'monitor'), sudo: lsGet('abux.srv.sudo.' + host.id, '0') === '1' };
      S.pane = P;
      paint();
    } catch (e) { toast(errMsg(e), 'err'); }
  }

  function paint() {
    const P = S.pane; if (!P) return;
    stopAll();
    const tabs = [['monitor', 'Monitor'], ['docker', 'Docker'], ['log', 'Log']];
    const sudo = h('input', { type: 'checkbox', checked: P.sudo, onchange: (e) => { P.sudo = e.target.checked; lsSet('abux.srv.sudo.' + P.host.id, P.sudo ? '1' : '0'); } });
    const head = h('header', { class: 'db-head' },
      h('button', { class: 'btn small', onclick: unmount }, '← Terminal'),
      h('div', { class: 'db-title' }, icon('activity'), h('b', {}, P.host.name), h('span', { class: 'mono sub' }, `${P.host.username}@${P.host.hostname}`)),
      h('div', { class: 'db-tabs', style: { border: 0, background: 'transparent' }, role: 'tablist' }, tabs.map(([id, label]) => h('button', { role: 'tab', class: P.tab === id ? 'on' : '', onclick: () => { P.tab = id; lsSet('abux.srv.tab', id); paint(); } }, label))),
      h('div', { class: 'grow' }),
      h('label', { class: 'check', title: 'Awali perintah Docker/log dengan sudo -n (butuh sudo tanpa password)' }, sudo, 'sudo'));
    const body = h('div', { class: 'srv-body' });
    P.el.replaceChildren(head, body);
    ({ monitor: paintMonitor, docker: paintDocker, log: paintLog })[P.tab](body, P);
  }

  // ---------- Monitor ----------
  function spark(values, max, color) {
    const w = 220; const hgt = 46;
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${hgt}`); svg.setAttribute('class', 'spark'); svg.setAttribute('preserveAspectRatio', 'none');
    if (values.length > 1) {
      const m = max || Math.max(1, ...values);
      const pts = values.map((v, i) => `${((i / 59) * w).toFixed(1)},${(hgt - 2 - (Math.min(v, m) / m) * (hgt - 4)).toFixed(1)}`);
      const path = document.createElementNS(SVG, 'polyline');
      path.setAttribute('points', pts.join(' ')); path.setAttribute('fill', 'none'); path.setAttribute('stroke', color); path.setAttribute('stroke-width', '1.8');
      svg.append(path);
    }
    return svg;
  }

  function paintMonitor(body, P) {
    const hist = { cpu: [], mem: [], load: [] };
    let prev = null; let busy = false; let sortKey = 'cpu';
    const cards = h('div', { class: 'mon-cards' });
    const disks = h('div', { class: 'mon-disks' });
    const procs = h('div', { class: 'mon-procs' });
    const status = h('span', { class: 'sub' }, 'Memuat…');
    body.append(h('div', { class: 'srv-bar' }, h('b', {}, 'Pemantau server'), h('span', { class: 'grow' }), status), cards, h('h4', { class: 'srv-h' }, 'Disk'), disks, h('h4', { class: 'srv-h' }, 'Proses teratas'), procs);

    const card = (title, big, sub, values, max, color) => h('div', { class: 'mon-card' }, h('div', { class: 'mon-t' }, title), h('div', { class: 'mon-v' }, big), h('div', { class: 'sub' }, sub), spark(values, max, color));
    function render(m, cpu) {
      const mp = m.mem ? Math.round((m.mem.used / m.mem.total) * 100) : 0;
      cards.replaceChildren(
        card('CPU', cpu == null ? '…' : cpu + '%', `${m.cores} core`, hist.cpu, 100, 'var(--accent)'),
        card('RAM', m.mem ? mp + '%' : '?', m.mem ? `${fmtBytes(m.mem.used)} / ${fmtBytes(m.mem.total)}` : '', hist.mem, 100, '#a855f7'),
        card('Beban rata-rata', m.load ? m.load[0].toFixed(2) : '?', m.load ? `5m ${m.load[1].toFixed(2)} · 15m ${m.load[2].toFixed(2)}` : '', hist.load, Math.max(m.cores, 1), '#f59e0b'),
        h('div', { class: 'mon-card' }, h('div', { class: 'mon-t' }, 'Uptime'), h('div', { class: 'mon-v' }, fmtUptime(m.uptime)), m.mem && m.mem.swapTotal ? h('div', { class: 'sub' }, `Swap ${fmtBytes(m.mem.swapUsed)} / ${fmtBytes(m.mem.swapTotal)}`) : h('div', { class: 'sub' }, 'Tanpa swap')));
      disks.replaceChildren(...(m.disks.length ? m.disks.map((d) => h('div', { class: 'mon-disk' + (d.pct >= 90 ? ' crit' : d.pct >= 80 ? ' warn' : '') },
        h('div', { class: 'mon-disk-top' }, h('span', { class: 'mono' }, d.mount), h('span', { class: 'sub' }, `${fmtBytes(d.used)} / ${fmtBytes(d.total)} · ${d.pct}%`), d.pct >= 80 ? h('span', { class: 'badge priv' }, d.pct >= 90 ? 'HAMPIR PENUH' : 'menipis') : null),
        h('div', { class: 'bar' }, h('i', { style: { width: d.pct + '%' } })))) : [h('div', { class: 'sub' }, 'Tidak ada data disk.')]));
      const list = [...m.procs].sort((a, b) => (sortKey === 'mem' ? b.mem - a.mem : b.cpu - a.cpu));
      const th = (k, label) => h('th', { class: 'sortable' + (sortKey === k ? ' on' : ''), onclick: () => { sortKey = k; render(m, cpu); } }, label);
      procs.replaceChildren(h('table', { class: 'srv-table' }, h('thead', {}, h('tr', {}, h('th', {}, 'PID'), h('th', {}, 'User'), th('cpu', '%CPU'), th('mem', '%MEM'), h('th', {}, 'Perintah'))),
        h('tbody', {}, list.map((p) => h('tr', {}, h('td', { class: 'mono' }, String(p.pid)), h('td', {}, p.user), h('td', {}, p.cpu.toFixed(1)), h('td', {}, p.mem.toFixed(1)), h('td', { class: 'mono' }, p.cmd))))));
    }
    async function tick() {
      if (busy || !S.pane || S.pane !== P) return;
      busy = true;
      try {
        const m = await api.server.monitor(P.sess.id);
        const cpu = prev && m.cpu ? cpuPct(prev, m.cpu) : null;
        prev = m.cpu;
        const push = (a, v) => { if (v != null) { a.push(v); if (a.length > 60) a.shift(); } };
        push(hist.cpu, cpu); push(hist.mem, m.mem ? (m.mem.used / m.mem.total) * 100 : null); push(hist.load, m.load ? m.load[0] : null);
        render(m, cpu);
        status.textContent = 'Diperbarui ' + new Date().toLocaleTimeString('id-ID') + ' · tiap 3 dtk';
      } catch (e) { status.textContent = 'Gagal: ' + errMsg(e); }
      busy = false;
    }
    tick();
    S.timers.add(setInterval(tick, 3000));
  }
  function cpuPct(a, b) { const dt = b.total - a.total; const di = b.idle - a.idle; return dt > 0 ? Math.max(0, Math.min(100, Math.round(((dt - di) / dt) * 1000) / 10)) : null; }

  // ---------- komponen log ----------
  function logPanel({ initialLevel = 'all' } = {}) {
    const L = { entries: [], partial: '', lvl: initialLevel, q: '', follow: true };
    const out = h('div', { class: 'log-out mono', tabindex: '0', role: 'log' });
    const count = h('span', { class: 'sub' });
    const search = h('input', { type: 'text', placeholder: 'Cari teks…', 'aria-label': 'Cari di log', oninput: (e) => { L.q = e.target.value; render(); } });
    const lvl = h('select', { 'aria-label': 'Filter level', onchange: (e) => { L.lvl = e.target.value; render(); } },
      [['all', 'Semua level'], ['warning', 'Warning + Error'], ['error', 'Hanya Error']].map(([v, t]) => h('option', { value: v, selected: v === L.lvl }, t)));
    const follow = h('input', { type: 'checkbox', checked: true, onchange: (e) => { L.follow = e.target.checked; if (L.follow) out.scrollTop = out.scrollHeight; } });
    const bar = h('div', { class: 'db-bar' }, search, lvl, h('label', { class: 'check' }, follow, 'Ikuti ke bawah'), h('span', { class: 'grow' }), count);
    let raf = 0;
    function render() {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const list = LV.filter(L.entries, { lvl: L.lvl, q: L.q });
        out.replaceChildren(...list.slice(-1500).map((e) => h('div', { class: 'log-e ' + e.level }, e.text)));
        count.textContent = `${list.length} dari ${L.entries.length} entri`;
        if (L.follow) out.scrollTop = out.scrollHeight;
      });
    }
    L.el = h('div', { class: 'log-panel' }, bar, out);
    L.set = (text) => { L.entries = LV.group(String(text).split('\n')); L.partial = ''; render(); };
    L.append = (chunk) => {
      const text = L.partial + chunk;
      const lines = text.split('\n'); L.partial = lines.pop();
      if (!lines.length) return;
      for (const l of lines) LV.push(L.entries, l);
      if (L.entries.length > MAX_ENTRIES) L.entries.splice(0, L.entries.length - MAX_ENTRIES);
      render();
    };
    L.clear = () => { L.entries = []; L.partial = ''; render(); };
    return L;
  }

  function trackStream(onData, onEnd) {
    return async (opts) => {
      const r = await api.server.streamStart(opts);
      S.streams.set(r.id, { onData, onEnd });
      return r.id;
    };
  }

  // ---------- Docker ----------
  function paintDocker(body, P) {
    const list = h('div', { class: 'dock-list' });
    const note = h('div', { class: 'db-note' }, 'Memuat container…');
    const logs = logPanel();
    const logTitle = h('b', {}, 'Log');
    let streamId = null;
    const composeDir = h('input', { type: 'text', class: 'mono', placeholder: '/var/www/proyek (folder berisi docker-compose.yml)', value: lsGet('abux.compose.' + P.host.id, ''), style: { flex: '1', minWidth: '260px' } });
    const composeList = h('div', { class: 'dock-compose' });

    async function stopLog() { if (streamId) { const id = streamId; streamId = null; S.streams.delete(id); await api.server.streamStop(id).catch(() => {}); } }
    async function startStream(title, opts) {
      await stopLog(); logs.clear(); logTitle.textContent = title;
      const mk = trackStream((d) => logs.append(d), () => {});
      streamId = await mk({ sessionId: P.sess.id, sudo: P.sudo, ...opts });
    }
    const dockerHint = (e) => { note.textContent = errMsg(e); note.className = 'db-note err'; list.replaceChildren(); };

    async function refresh() {
      try {
        const cs = await api.server.dockerPs(P.sess.id, P.sudo);
        note.textContent = cs.length ? `${cs.filter((c) => c.state === 'running').length} berjalan dari ${cs.length} container` : 'Belum ada container di server ini.';
        note.className = 'db-note';
        list.replaceChildren(...cs.map((c) => h('div', { class: 'dock-row' },
          h('span', { class: 'dot ' + (c.state === 'running' ? 'on' : c.state === 'restarting' ? 'warn' : '') }),
          h('div', { class: 'grow' }, h('div', { class: 'title' }, c.name), h('div', { class: 'sub mono' }, `${c.image} · ${c.status}${c.ports ? ' · ' + c.ports : ''}`)),
          h('button', { class: 'btn small', onclick: () => startStream('Log: ' + c.name, { kind: 'docker-logs', id: c.name, tail: 200 }).catch((e) => toast(errMsg(e), 'err')) }, 'Log'),
          c.state === 'running' ? h('button', { class: 'btn small', onclick: () => act('restart', c) }, 'Restart') : null,
          c.state === 'running' ? h('button', { class: 'btn small danger', onclick: () => act('stop', c) }, 'Stop') : h('button', { class: 'btn small primary', onclick: () => act('start', c) }, 'Start'))));
      } catch (e) { dockerHint(e); }
    }
    async function act(action, c) {
      if (action !== 'start' && !(await confirmDialog({ title: `${action === 'stop' ? 'Hentikan' : 'Restart'} container?`, message: `${c.name} (${c.image})`, confirmLabel: action === 'stop' ? 'Stop' : 'Restart', danger: action === 'stop' }))) return;
      try { await api.server.dockerAction({ sessionId: P.sess.id, action, id: c.name, sudo: P.sudo }); toast(`${c.name}: ${action} berhasil`, 'ok'); refresh(); } catch (e) { toast(errMsg(e), 'err'); }
    }
    async function composeRun(action) {
      const dir = composeDir.value.trim(); if (!dir) return toast('Isi folder proyek compose dulu.', 'err');
      lsSet('abux.compose.' + P.host.id, dir);
      if (action === 'down' && !(await confirmDialog({ title: 'compose down?', message: `Menghentikan dan menghapus container proyek di ${dir}. Volume data tidak dihapus.`, confirmLabel: 'Down', danger: true }))) return;
      try {
        if (action === 'logs') return await startStream('Compose: ' + dir, { kind: 'compose-logs', dir, tail: 200 });
        if (action === 'ps') {
          const r = await api.server.composePs(P.sess.id, dir, P.sudo);
          composeList.replaceChildren(...(r.length ? r.map((c) => h('div', { class: 'dock-row' }, h('span', { class: 'dot ' + (c.state === 'running' ? 'on' : '') }), h('div', { class: 'grow' }, h('div', { class: 'title' }, c.service || c.name), h('div', { class: 'sub mono' }, `${c.name} · ${c.status || c.state}`)))) : [h('div', { class: 'sub' }, 'Tidak ada layanan.')]));
          return;
        }
        await startStream(`docker compose ${action}`, { kind: 'compose-action', dir, action });
        setTimeout(refresh, 4000);
      } catch (e) { toast(errMsg(e), 'err'); }
    }
    const cbtn = (a, label) => h('button', { class: 'btn small', onclick: () => composeRun(a) }, label);
    body.append(
      h('div', { class: 'srv-bar' }, h('b', {}, 'Container'), h('span', { class: 'grow' }), h('button', { class: 'btn small', onclick: refresh }, icon('refresh'), 'Muat ulang')),
      note, list,
      h('h4', { class: 'srv-h' }, 'Docker Compose per proyek'),
      h('div', { class: 'db-bar' }, composeDir, cbtn('ps', 'Status'), cbtn('up', 'Up -d'), cbtn('restart', 'Restart'), cbtn('pull', 'Pull'), cbtn('build', 'Build'), cbtn('down', 'Down'), cbtn('logs', 'Log')),
      composeList,
      h('div', { class: 'srv-bar', style: { marginTop: '12px' } }, logTitle, h('span', { class: 'grow' }), h('button', { class: 'btn small', onclick: stopLog }, icon('stop'), 'Hentikan aliran')),
      logs.el);
    refresh();
  }

  // ---------- Log ----------
  function paintLog(body, P) {
    const key = 'abux.log.' + P.host.id;
    const saved = (() => { try { return JSON.parse(lsGet(key, '{}')); } catch (_) { return {}; } })();
    const kind = h('select', { 'aria-label': 'Sumber log', onchange: sync }, [['laravel', 'Laravel (storage/logs/laravel.log)'], ['nginx_error', 'Nginx error.log'], ['nginx_access', 'Nginx access.log'], ['syslog', 'Syslog (/var/log/syslog)'], ['journal', 'journalctl (sistem)'], ['file', 'Berkas lain…']].map(([v, t]) => h('option', { value: v, selected: v === (saved.kind || 'laravel') }, t)));
    const path = h('input', { type: 'text', class: 'mono', placeholder: '/var/www/proyek', value: saved.path || '', style: { flex: '1', minWidth: '220px' } });
    const lines = h('select', { 'aria-label': 'Jumlah baris' }, [200, 500, 1000, 3000].map((n) => h('option', { value: n, selected: n === (saved.lines || 500) }, `${n} baris`)));
    const logs = logPanel();
    let streamId = null; const liveBtn = h('button', { class: 'btn small' }, 'Live');
    function sync() { path.hidden = ['nginx_error', 'nginx_access', 'syslog', 'journal'].includes(kind.value); path.placeholder = kind.value === 'laravel' ? '/var/www/proyek (folder aplikasi)' : '/var/log/aplikasi.log'; }
    const source = () => (kind.value === 'laravel' ? { kind: 'laravel', dir: path.value.trim() } : kind.value === 'file' ? { kind: 'file', path: path.value.trim() } : { kind: kind.value });
    const persist = () => lsSet(key, JSON.stringify({ kind: kind.value, path: path.value, lines: Number(lines.value) }));
    async function stopLive() { if (streamId) { const id = streamId; streamId = null; S.streams.delete(id); liveBtn.textContent = 'Live'; liveBtn.classList.remove('primary'); await api.server.streamStop(id).catch(() => {}); } }
    async function load() {
      await stopLive(); persist();
      try { const r = await api.server.logFetch({ sessionId: P.sess.id, source: source(), lines: Number(lines.value), sudo: P.sudo }); logs.set(r.text); } catch (e) { toast(errMsg(e), 'err'); }
    }
    liveBtn.addEventListener('click', async () => {
      if (streamId) return stopLive();
      try { persist(); streamId = await trackStream((d) => logs.append(d), () => {})({ sessionId: P.sess.id, kind: 'log-follow', source: source(), sudo: P.sudo }); liveBtn.textContent = '● Live (klik untuk berhenti)'; liveBtn.classList.add('primary'); } catch (e) { toast(errMsg(e), 'err'); }
    });
    body.append(h('div', { class: 'srv-bar' }, h('b', {}, 'Penampil log')), h('div', { class: 'db-bar' }, kind, path, lines, h('button', { class: 'btn small primary', onclick: load }, 'Muat'), liveBtn), logs.el);
    sync();
  }

  // peristiwa aliran dari main
  api.server.onStreamData(({ id, data }) => { const s = S.streams.get(id); if (s) s.onData(data); });
  api.server.onStreamEnd(({ id }) => { S.streams.delete(id); });

  window.Srv = { renderSidebar, openHost, unmount };
})();
