'use strict';

/* UI Deploy: daftar pipeline, editor, tampilan run beranimasi, riwayat, rollback. */
(() => {
  const { h, icon, iconButton, toast, field, modal, confirmDialog, fmtDate } = window.UI;
  const api = window.api;
  const App = window.AbuxApp;
  const TEMPLATES = window.DEPLOY_TEMPLATES || [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const errMsg = (e) => (e && e.message ? e.message : String(e));
  const strip = (s) => String(s).replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');

  const D = { pipelines: [], runs: new Map(), view: null };

  function fmtDur(ms) {
    if (ms == null) return '';
    if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)} dtk`;
    return `${Math.floor(s / 60)} mnt ${Math.round(s % 60)} dtk`;
  }

  const KIND = { deploy: 'Deploy', rollback: 'Rollback' };
  const STATUS_LABEL = { running: 'Berjalan', success: 'Sukses', failed: 'Gagal', canceled: 'Dibatalkan', pending: 'Menunggu', skipped: 'Dilewati' };

  const hostOf = (id) => App.state.hosts.find((x) => x.id === id);
  const pipelineOf = (id) => D.pipelines.find((x) => x.id === id);
  const activeRunFor = (pipelineId) => [...D.runs.values()].find((r) => r.run.pipelineId === pipelineId && r.run.status === 'running');

  async function reloadPipelines() { D.pipelines = await api.pipelines.list(); }
  const refreshSidebar = () => { if (App.state.view === 'deploy') App.renderBody(); };

  // ---------- ikon status (SVG konstan, aman) ----------
  const svgIcon = (inner) => {
    const s = document.createElement('span');
    s.className = 'st-svg';
    s.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
    return s;
  };
  function stateIcon(status) {
    switch (status) {
      case 'running': return h('span', { class: 'spinner', role: 'progressbar', 'aria-label': 'Berjalan' });
      case 'success': return svgIcon('<circle class="ring-fill" cx="12" cy="12" r="10"/><path class="mark" d="M7 12.500l3.200 3.200L17 9"/>');
      case 'failed': return svgIcon('<circle class="ring-fill" cx="12" cy="12" r="10"/><path class="mark" d="M8.500 8.500l7 7M15.500 8.500l-7 7"/>');
      case 'canceled': return svgIcon('<circle class="ring-fill" cx="12" cy="12" r="10"/><rect class="mark-fill" x="8.500" y="8.500" width="7" height="7" rx="1.500"/>');
      case 'skipped': return svgIcon('<circle class="ring-fill" cx="12" cy="12" r="10"/><path class="mark" d="M8 12h8"/>');
      default: return h('span', { class: 'ring' });
    }
  }

  // ---------- state run ----------
  function ensureRunState(run) {
    let st = D.runs.get(run.id);
    if (!st) { st = { run, outputs: new Map() }; D.runs.set(run.id, st); }
    return st;
  }

  function onEvent(ev) {
    if (ev.type === 'run-start') ensureRunState(ev.run);
    const id = ev.runId || (ev.run && ev.run.id);
    const st = D.runs.get(id);
    if (!st) return;
    const steps = st.run.steps;
    switch (ev.type) {
      case 'preflight': st.run.previousRef = ev.previousRef; break;
      case 'step-start': Object.assign(steps[ev.index], { status: 'running', startedAt: ev.startedAt }); break;
      case 'step-output': st.outputs.set(ev.index, ((st.outputs.get(ev.index) || '') + strip(ev.data)).slice(-65536)); break;
      case 'step-end': Object.assign(steps[ev.index], { status: ev.status, exitCode: ev.exitCode, durationMs: ev.durationMs, error: ev.error }); break;
      case 'run-end': st.run = ev.run; break;
      default: break;
    }
    refreshView(st, ev);
    updateChip();
    if (ev.type === 'run-start' || ev.type === 'run-end') refreshSidebar();
    if (ev.type === 'run-end' && !(D.view && D.view.runId === id)) {
      const r = ev.run;
      toast(`${KIND[r.kind]} "${r.pipelineName}": ${STATUS_LABEL[r.status].toLowerCase()}`, r.status === 'success' ? 'ok' : 'err');
    }
  }

  // ---------- chip status bar ----------
  function updateChip() {
    const chip = document.getElementById('st-deploy');
    if (!chip) return;
    const live = [...D.runs.values()].filter((r) => r.run.status === 'running');
    chip.hidden = live.length === 0;
    if (!live.length) return;
    const r = live[0].run;
    const done = r.steps.filter((s) => !['pending', 'running'].includes(s.status)).length;
    chip.replaceChildren(h('span', { class: 'spinner small' }), `${KIND[r.kind]}: ${r.pipelineName} · ${done}/${r.steps.length}`);
    chip.onclick = () => openRunView(r.id);
  }

  // ---------- sidebar ----------
  function emptyBox(title, text, action) {
    return h('div', { class: 'empty' }, h('b', {}, title), text, action ? h('div', { style: { marginTop: '12px' } }, action) : null);
  }

  function renderSidebar(body) {
    const q = App.state.filter.toLowerCase();
    if (!App.state.hosts.length) { body.append(emptyBox('Belum ada host', 'Tambahkan host dulu di panel Host, lalu buat pipeline deploy-nya di sini.')); return; }
    if (!D.pipelines.length) {
      body.append(emptyBox('Belum ada pipeline', 'Pipeline menjalankan rangkaian perintah (pull, install, migrasi, restart) ke server dan menampilkan progresnya langsung.', h('button', { class: 'btn primary', onclick: () => editPipeline() }, 'Buat pipeline')));
      return;
    }
    const list = D.pipelines.filter((p) => !q || p.name.toLowerCase().includes(q) || p.cwd.toLowerCase().includes(q) || (hostOf(p.hostId) || {}).name?.toLowerCase().includes(q));
    if (!list.length) { body.append(emptyBox('Tidak ditemukan', 'Coba kata kunci lain.')); return; }
    const groups = new Map();
    for (const p of list) {
      const n = (hostOf(p.hostId) || { name: 'Host dihapus' }).name;
      if (!groups.has(n)) groups.set(n, []);
      groups.get(n).push(p);
    }
    for (const [hostName, items] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
      body.append(h('div', { class: 'group-label' }, hostName));
      for (const p of items.sort((a, b) => a.name.localeCompare(b.name))) {
        const act = activeRunFor(p.id);
        const open = () => (act ? openRunView(act.run.id) : startRun(p));
        body.append(h('div', { class: 'item', tabindex: '0', role: 'button', title: act ? 'Deploy sedang berjalan, klik untuk melihat' : 'Klik untuk menjalankan deploy', onclick: open, onkeydown: (e) => { if (e.key === 'Enter') open(); } },
          act ? h('span', { class: 'spinner small' }) : h('span', { class: 'icon', style: { color: 'var(--accent)' } }, icon('rocket')),
          h('div', { class: 'grow' }, h('div', { class: 'title' }, p.name), h('div', { class: 'sub mono' }, `${p.cwd} · ${p.steps.length} langkah`)),
          h('div', { class: 'actions' },
            iconButton('history', 'Riwayat', () => openHistory(p)),
            iconButton('edit', 'Ubah', () => editPipeline(p)),
            iconButton('trash', 'Hapus', () => deletePipeline(p), 'danger'))));
      }
    }
  }

  async function deletePipeline(p) {
    if (!(await confirmDialog({ title: 'Hapus pipeline?', message: `"${p.name}" dan seluruh riwayat deploy-nya akan dihapus.`, confirmLabel: 'Hapus', danger: true }))) return;
    try { await api.pipelines.remove(p.id); await reloadPipelines(); refreshSidebar(); } catch (e) { toast(errMsg(e), 'err'); }
  }

  // ---------- editor pipeline ----------
  function stepsEditor(initial, { placeholder, addLabel }) {
    let steps = (initial || []).map((s) => ({ id: s.id, name: s.name || '', command: s.command || '', continueOnError: !!s.continueOnError }));
    const root = h('div', { class: 'steps-ed' });
    const move = (i, d) => { const j = i + d; if (j < 0 || j >= steps.length) return; [steps[i], steps[j]] = [steps[j], steps[i]]; render(); };
    function render() {
      root.replaceChildren();
      steps.forEach((s, i) => {
        root.append(h('div', { class: 'step-row' },
          h('span', { class: 'num' }, String(i + 1)),
          h('div', { class: 'step-fields' },
            h('input', { type: 'text', value: s.name, placeholder: 'Nama langkah', 'aria-label': `Nama langkah ${i + 1}`, oninput: (e) => { s.name = e.target.value; } }),
            h('input', { type: 'text', class: 'mono', value: s.command, placeholder, spellcheck: 'false', 'aria-label': `Perintah langkah ${i + 1}`, oninput: (e) => { s.command = e.target.value; } }),
            h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: s.continueOnError, onchange: (e) => { s.continueOnError = e.target.checked; } }), 'Lanjut walau gagal')),
          h('div', { class: 'step-btns' }, iconButton('up', 'Naikkan', () => move(i, -1)), iconButton('down', 'Turunkan', () => move(i, 1)), iconButton('trash', 'Hapus langkah', () => { steps.splice(i, 1); render(); }, 'danger'))));
      });
      root.append(h('button', { type: 'button', class: 'btn small', onclick: () => { steps.push({ name: '', command: '', continueOnError: false }); render(); } }, icon('plus'), addLabel));
    }
    render();
    return { el: root, get: () => steps, set: (list) => { steps = list.map((s) => ({ name: s.name, command: s.command, continueOnError: !!s.continueOnError })); render(); } };
  }

  function editPipeline(p) {
    if (!App.state.hosts.length) { toast('Tambahkan host dulu di panel Host.', 'err'); return; }
    const v = p || { name: '', hostId: App.state.hosts[0].id, cwd: '', steps: [], rollbackSteps: [], captureRef: true };
    const name = h('input', { type: 'text', value: v.name, placeholder: 'mis. AKARIS produksi' });
    const hostSel = h('select', {}, App.state.hosts.map((x) => h('option', { value: x.id, selected: x.id === v.hostId }, x.name)));
    const cwd = h('input', { type: 'text', class: 'mono', value: v.cwd, placeholder: '/var/www/app', spellcheck: 'false' });
    const capture = h('input', { type: 'checkbox', checked: v.captureRef !== false });
    const note = h('div', { class: 'hint', hidden: true });
    const tpl = h('select', {}, h('option', { value: '' }, 'Pilih template untuk mengisi otomatis…'), TEMPLATES.map((t) => h('option', { value: t.id }, t.label)));
    const deploySteps = stepsEditor(v.steps, { placeholder: 'perintah, mis. git pull --ff-only', addLabel: 'Tambah langkah' });
    const rollbackSteps = stepsEditor(v.rollbackSteps, { placeholder: 'mis. git reset --hard {{PREVIOUS_REF}}', addLabel: 'Tambah langkah rollback' });
    tpl.addEventListener('change', () => {
      const t = TEMPLATES.find((x) => x.id === tpl.value);
      if (!t) return;
      if (!cwd.value.trim()) cwd.value = t.cwd;
      if (!name.value.trim()) name.value = t.label;
      deploySteps.set(t.steps);
      rollbackSteps.set(t.rollbackSteps);
      note.textContent = t.note;
      note.hidden = false;
    });
    const body = h('div', {},
      field('Nama pipeline', name),
      h('div', { class: 'row' }, field('Host tujuan', hostSel), field('Folder kerja di server', cwd)),
      field('Template', tpl, 'Titik awal saja; semua perintah tetap bisa diubah.'),
      note,
      h('div', { class: 'field' }, h('div', { class: 'lbl' }, 'Langkah deploy (berurutan, berhenti di langkah yang gagal)'), deploySteps.el),
      h('div', { class: 'field' }, h('div', { class: 'lbl' }, 'Langkah rollback (opsional)'), rollbackSteps.el,
        h('div', { class: 'hint' }, 'Pakai {{PREVIOUS_REF}} untuk versi git sebelum deploy. Perintah dijalankan lewat login shell; gabungkan beberapa perintah dengan && dalam satu langkah.')),
      h('label', { class: 'check' }, capture, 'Catat versi git sebelum deploy (diperlukan untuk rollback)'));
    modal({
      title: p ? 'Ubah pipeline' : 'Pipeline baru',
      subtitle: 'Perintah berjalan non-interaktif; perintah yang meminta input (mis. sudo dengan password) akan kehabisan waktu.',
      body, width: '680px',
      buttons: [{ label: 'Batal' }, {
        label: 'Simpan', kind: 'primary',
        onClick: async () => {
          await api.pipelines.save({ id: p && p.id, name: name.value, hostId: hostSel.value, cwd: cwd.value, steps: deploySteps.get(), rollbackSteps: rollbackSteps.get(), captureRef: capture.checked });
          await reloadPipelines();
          refreshSidebar();
          toast('Pipeline disimpan', 'ok');
        },
      }],
    });
  }

  // ---------- menjalankan ----------
  function confirmRun(p, host, kind) {
    return new Promise((resolve) => {
      const steps = kind === 'rollback' ? p.rollbackSteps : p.steps;
      const red = host.color === 'red';
      const typed = h('input', { type: 'text', placeholder: host.name, spellcheck: 'false', autocomplete: 'off' });
      const list = h('div', { class: 'code pre-preview' }, steps.map((s, i) => h('div', {}, `${i + 1}. ${s.name}  `, h('span', { style: { color: 'var(--muted)' } }, s.command))));
      let decided = false;
      modal({
        title: kind === 'rollback' ? `Rollback "${p.name}"?` : `Deploy "${p.name}"?`,
        subtitle: `${host.name} (${host.username}@${host.hostname}) · folder ${p.cwd}`,
        body: h('div', {}, kind === 'rollback' ? h('div', { class: 'warn' }, 'Kode dikembalikan ke versi git sebelum deploy. Perubahan database (migrasi) tidak ikut dibatalkan.') : null,
          list, red ? field(`Host ini bertanda produksi. Ketik "${host.name}" untuk melanjutkan`, typed) : null),
        buttons: [
          { label: 'Batal', onClick: () => { decided = true; resolve(false); } },
          { label: kind === 'rollback' ? 'Jalankan rollback' : 'Jalankan deploy', kind: kind === 'rollback' ? 'danger' : 'primary',
            onClick: () => { if (red && typed.value.trim() !== host.name) throw new Error('Nama host tidak cocok.'); decided = true; resolve(true); } },
        ],
        onClose: () => { if (!decided) resolve(false); },
      });
    });
  }

  async function ensureSession(host) {
    const sessions = () => [...App.state.sessions.values()].filter((s) => s.host.id === host.id);
    let s = sessions().find((x) => x.status === 'connected');
    if (s) return s;
    s = sessions().find((x) => x.status === 'connecting') || App.createSession(host);
    toast(`Menyambung ke ${host.name}…`);
    const t0 = Date.now();
    while (Date.now() - t0 < 90000) {
      await sleep(150);
      if (s.status === 'connected') return s;
      if (s.status === 'closed') throw new Error(`Tidak bisa tersambung ke ${host.name}. Periksa koneksi lalu coba lagi.`);
    }
    throw new Error('Waktu menyambung habis.');
  }

  async function startRun(p, kind = 'deploy', fromRunId) {
    const host = hostOf(p.hostId);
    if (!host) { toast('Host pipeline ini sudah dihapus.', 'err'); return; }
    const running = activeRunFor(p.id);
    if (running) { openRunView(running.run.id); return; }
    if (!(await confirmRun(p, host, kind))) return;
    try {
      const session = await ensureSession(host);
      const snap = await api.deploy.start({ pipelineId: p.id, sessionId: session.id, kind, fromRunId });
      ensureRunState(snap);
      openRunView(snap.id);
    } catch (e) { toast(errMsg(e), 'err'); }
  }

  // ---------- tampilan run ----------
  function stopTimer() { if (D.view && D.view.timer) { clearInterval(D.view.timer); D.view.timer = null; } }

  function openRunView(runId) {
    const st = D.runs.get(runId);
    if (!st) return;
    if (D.view && D.view.runId === runId) return;
    if (D.view) D.view.modal.close();
    const run = st.run;
    const view = { runId, selected: null, userPicked: false, cards: [], timer: null };
    D.view = view;

    view.pill = h('span', { class: 'pill' });
    view.timerEl = h('span', { class: 'run-timer mono' });
    view.progress = h('div', { class: 'run-progress' }, h('i'));
    view.stepsEl = h('div', { class: 'run-steps' });
    view.banner = h('div', { class: 'run-banner', hidden: true, role: 'status' });
    view.logTitle = h('div', { class: 'run-log-title' });
    view.log = h('pre', { class: 'run-log mono', tabindex: '0' });
    view.actions = h('div', { class: 'run-actions' });

    run.steps.forEach((s, i) => {
      const card = h('div', { class: 'run-step pending', 'data-status': 'pending', tabindex: '0', role: 'button', title: 'Klik untuk melihat log langkah ini', onclick: () => pick(view, i), onkeydown: (e) => { if (e.key === 'Enter') pick(view, i); } },
        h('div', { class: 'rs-icon' }, stateIcon('pending')),
        h('div', { class: 'rs-main' }, h('div', { class: 'rs-name' }, `${i + 1}. ${s.name}`), h('div', { class: 'rs-cmd mono', title: s.command }, s.command)),
        h('div', { class: 'rs-time mono' }));
      view.cards.push(card);
      view.stepsEl.append(card);
    });

    const body = h('div', { class: 'run' },
      h('div', { class: 'run-head' }, view.pill, view.timerEl),
      view.progress, view.stepsEl, view.banner, view.logTitle, view.log, view.actions);
    view.modal = modal({
      title: `${KIND[run.kind]} · ${run.pipelineName}`,
      subtitle: `${run.hostName}${run.previousRef ? ` · versi sebelumnya ${run.previousRef.slice(0, 8)}` : ''}`,
      body, width: '760px', buttons: [],
      onClose: () => { stopTimer(); if (D.view === view) D.view = null; },
    });
    view.modal.el.classList.add('run-modal');
    refreshView(st, { type: 'full' });
    if (run.status === 'running') view.timer = setInterval(() => tick(view), 250);
  }

  function pick(view, i) {
    view.userPicked = true;
    view.selected = i;
    const st = D.runs.get(view.runId);
    if (st) showLog(view, st);
  }

  function tick(view) {
    const st = D.runs.get(view.runId);
    if (!st) return;
    const r = st.run;
    view.timerEl.textContent = fmtDur((r.finishedAt || Date.now()) - r.startedAt);
    r.steps.forEach((s, i) => {
      if (s.status === 'running' && s.startedAt) view.cards[i].querySelector('.rs-time').textContent = fmtDur(Date.now() - s.startedAt);
    });
  }

  function showLog(view, st) {
    const r = st.run;
    let i = view.selected;
    if (!view.userPicked || i == null) {
      const running = r.steps.findIndex((s) => s.status === 'running');
      if (running >= 0) i = running;
      else if (i == null || !view.userPicked) {
        const failed = r.steps.findIndex((s) => s.status === 'failed');
        i = failed >= 0 ? failed : Math.max(0, r.steps.map((s) => s.status).lastIndexOf('success'));
      }
      view.selected = i;
    }
    view.cards.forEach((c, k) => c.classList.toggle('selected', k === i));
    const step = r.steps[i];
    if (!step) { view.logTitle.textContent = ''; view.log.textContent = ''; return; }
    view.logTitle.textContent = `Log · ${step.name}`;
    const text = st.outputs.get(i) || '';
    const stick = view.log.scrollHeight - view.log.scrollTop - view.log.clientHeight < 40;
    view.log.textContent = text || (step.status === 'pending' ? 'Menunggu giliran…' : step.status === 'skipped' ? 'Dilewati karena langkah sebelumnya gagal.' : 'Belum ada output.');
    if (stick) view.log.scrollTop = view.log.scrollHeight;
  }

  function refreshView(st, ev) {
    const view = D.view;
    if (!view || view.runId !== st.run.id) return;
    const r = st.run;
    if (ev.type === 'step-output') {
      if (view.selected === ev.index || (!view.userPicked && r.steps[ev.index].status === 'running')) showLog(view, st);
      return;
    }
    r.steps.forEach((s, i) => {
      const card = view.cards[i];
      if (card.dataset.status !== s.status) {
        card.dataset.status = s.status;
        card.className = `run-step ${s.status}${view.selected === i ? ' selected' : ''}`;
        card.querySelector('.rs-icon').replaceChildren(stateIcon(s.status));
      }
      const time = card.querySelector('.rs-time');
      if (s.status === 'running') time.textContent = fmtDur(Date.now() - (s.startedAt || Date.now()));
      else if (s.durationMs != null) time.textContent = fmtDur(s.durationMs);
      else time.textContent = '';
    });
    const finished = r.steps.filter((s) => !['pending', 'running'].includes(s.status)).length;
    view.progress.firstChild.style.width = `${r.steps.length ? (finished / r.steps.length) * 100 : 0}%`;
    view.progress.className = `run-progress ${r.status}`;
    view.pill.textContent = STATUS_LABEL[r.status];
    view.pill.className = `pill ${r.status}`;
    view.timerEl.textContent = fmtDur((r.finishedAt || Date.now()) - r.startedAt);
    showLog(view, st);
    if (r.status !== 'running') { stopTimer(); renderEnd(view, st); } else renderActions(view, st);
  }

  function renderEnd(view, st) {
    const r = st.run;
    const dur = fmtDur((r.finishedAt || Date.now()) - r.startedAt);
    view.banner.hidden = false;
    view.banner.className = `run-banner ${r.status}`;
    let title; let detail;
    if (r.status === 'success') { title = `${KIND[r.kind]} selesai`; detail = `dalam ${dur}${r.warnings ? ` · ${r.warnings} langkah gagal tapi dilanjutkan` : ''}`; }
    else if (r.status === 'canceled') { title = `${KIND[r.kind]} dibatalkan`; detail = `setelah ${dur}`; }
    else {
      const i = r.steps.findIndex((s) => s.status === 'failed');
      const s = r.steps[i];
      title = i >= 0 ? `Berhenti di langkah ${i + 1}: ${s.name}` : `${KIND[r.kind]} gagal`;
      detail = i >= 0 && s.error ? s.error : `setelah ${dur}`;
    }
    view.banner.replaceChildren(stateIcon(r.status === 'running' ? 'pending' : r.status), h('div', {}, h('b', {}, title), h('span', {}, detail)));
    renderActions(view, st);
  }

  function renderActions(view, st) {
    const r = st.run;
    const p = pipelineOf(r.pipelineId);
    const bar = view.actions;
    bar.replaceChildren();
    if (r.status === 'running') {
      bar.append(h('span', { class: 'hint' }, 'Menutup jendela tidak menghentikan deploy; buka lagi lewat indikator di bawah.'), h('div', { class: 'grow' }));
      bar.append(h('button', { class: 'btn', onclick: () => view.modal.close() }, 'Sembunyikan'));
      bar.append(h('button', { class: 'btn danger', onclick: async () => {
        if (await confirmDialog({ title: 'Batalkan deploy?', message: 'Proses di server dihentikan dengan Ctrl+C. Langkah yang sudah selesai tidak otomatis dikembalikan.', confirmLabel: 'Batalkan deploy', danger: true })) {
          try { await api.deploy.cancel(r.id); } catch (e) { toast(errMsg(e), 'err'); }
        }
      } }, icon('stop'), 'Batalkan'));
      return;
    }
    const canRollback = p && r.kind === 'deploy' && p.rollbackSteps.length > 0 && !!r.previousRef;
    if (p && r.kind === 'deploy' && p.rollbackSteps.length > 0 && !r.previousRef) bar.append(h('span', { class: 'hint' }, 'Rollback tidak tersedia: versi git sebelum deploy tidak tercatat.'));
    bar.append(h('div', { class: 'grow' }));
    if (canRollback) bar.append(h('button', { class: 'btn danger', onclick: () => { view.modal.close(); startRun(p, 'rollback', r.id); } }, 'Rollback'));
    if (p && r.status !== 'success') bar.append(h('button', { class: 'btn primary', onclick: () => { view.modal.close(); startRun(p); } }, 'Jalankan lagi'));
    bar.append(h('button', { class: 'btn', onclick: () => view.modal.close() }, 'Tutup'));
  }

  // ---------- riwayat ----------
  async function openHistory(p) {
    let runs = [];
    try { runs = await api.deploy.runs(p.id); } catch (e) { toast(errMsg(e), 'err'); return; }
    let m;
    const body = h('div', { class: 'hist' });
    if (!runs.length) body.append(h('div', { class: 'empty' }, h('b', {}, 'Belum ada riwayat'), 'Run yang selesai akan tercatat di sini.'));
    for (const r of runs) {
      const dur = r.finishedAt ? fmtDur(r.finishedAt - r.startedAt) : '';
      const canRollback = r.kind === 'deploy' && p.rollbackSteps.length > 0 && !!r.previousRef;
      body.append(h('div', { class: 'hist-row' },
        h('span', { class: `pill ${r.status}` }, STATUS_LABEL[r.status] || r.status),
        h('div', { class: 'grow' }, h('div', { class: 'title' }, `${KIND[r.kind] || r.kind} · ${fmtDate(r.startedAt)}`), h('div', { class: 'sub mono' }, `${dur}${r.previousRef ? ` · dari ${r.previousRef.slice(0, 8)}` : ''}`)),
        h('button', { class: 'btn small', onclick: async () => {
          try {
            const full = await api.deploy.getRun(r.id);
            if (!full) throw new Error('Run tidak ditemukan.');
            const st = ensureRunState(full);
            st.run = full;
            full.steps.forEach((s, i) => st.outputs.set(i, strip(s.output || '')));
            m.close();
            openRunView(full.id);
          } catch (e) { toast(errMsg(e), 'err'); }
        } }, 'Lihat'),
        canRollback ? h('button', { class: 'btn small danger', onclick: () => { m.close(); startRun(p, 'rollback', r.id); } }, 'Rollback') : null));
    }
    m = modal({ title: `Riwayat · ${p.name}`, subtitle: 'Maksimal 100 run terbaru disimpan.', body, width: '640px', buttons: [{ label: 'Tutup' }] });
  }

  async function init() {
    await reloadPipelines();
    api.deploy.onEvent(onEvent);
    try {
      for (const r of await api.deploy.active()) ensureRunState(r);
    } catch (_) { /* abaikan */ }
    updateChip();
  }

  window.Deploy = { init, renderSidebar, editPipeline, ensureSession, reload: async () => { await reloadPipelines(); refreshSidebar(); } };
})();
