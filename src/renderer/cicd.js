'use strict';

/* Deploy otomatis setelah git push: tes dulu, lalu deploy ke server lewat GitHub Actions. */
(() => {
  const { h, icon, toast, field, modal, confirmDialog } = window.UI;
  const api = window.api;
  const App = window.AbuxApp;
  const errMsg = (e) => (e && e.message ? e.message : String(e));
  const DEFAULT_DEPLOY = { node: 'git pull origin main\nnpm ci --omit=dev\npm2 reload all', php: 'git pull origin main\ncomposer install --no-dev --optimize-autoloader\nphp artisan migrate --force\nphp artisan config:cache', none: 'git pull origin main' };
  const TEST_DEFAULT = { node: 'npm test', php: 'php artisan test', none: '' };

  async function open() {
    if (!App.state.hosts.length) { toast('Tambahkan host SSH dulu.', 'err'); return; }
    const gh = App.state.github;
    let repos = [];
    if (gh.loggedIn) { try { repos = App.state.repos || await api.github.repos(); App.state.repos = repos; } catch (_) { /* pakai input manual */ } }
    let pipelines = []; try { pipelines = await api.pipelines.list(); } catch (_) { /* abaikan */ }

    const hostSel = h('select', {}, App.state.hosts.map((x) => h('option', { value: x.id }, `${x.name} (${x.hostname})`)));
    const repo = repos.length ? h('select', {}, repos.map((r) => h('option', { value: r.fullName }, r.fullName + (r.private ? ' 🔒' : '')))) : h('input', { class: 'mono', placeholder: 'akunmu/proyek' });
    const branch = h('input', { class: 'mono', value: 'main' });
    const stack = h('select', {}, [['node', 'Node.js'], ['php', 'PHP / Laravel'], ['none', 'Tanpa tes']].map(([v, t]) => h('option', { value: v }, t)));
    const test = h('input', { class: 'mono', value: TEST_DEFAULT.node });
    const dir = h('input', { class: 'mono', placeholder: '/var/www/proyek' });
    const cmds = h('textarea', { class: 'mono', rows: 5, spellcheck: 'false' }); cmds.value = DEFAULT_DEPLOY.node;
    const fromPipe = h('select', {}, h('option', { value: '' }, '— isi manual —'), pipelines.map((p) => h('option', { value: p.id }, `${p.name}`)));
    const out = h('div', { class: 'ci-out' });
    stack.addEventListener('change', () => { test.value = TEST_DEFAULT[stack.value]; cmds.value = DEFAULT_DEPLOY[stack.value]; });
    fromPipe.addEventListener('change', () => {
      const p = pipelines.find((x) => x.id === fromPipe.value); if (!p) return;
      hostSel.value = p.hostId; dir.value = p.cwd; cmds.value = p.steps.map((s) => s.command).join('\n');
    });
    const input = () => ({ hostId: hostSel.value, fullName: repo.value.trim(), branch: branch.value.trim(), stack: stack.value, testCommand: test.value, appDir: dir.value.trim(), deployCommands: cmds.value });

    const m = modal({
      title: 'Deploy otomatis saat git push', subtitle: 'Abux membuat workflow GitHub Actions: tes dijalankan dulu, deploy ke server hanya bila tes lulus.', width: 720,
      body: h('div', {},
        h('div', { class: 'db-note' }, 'Kunci SSH khusus CI dibuat baru, dipasang di server, dan dikirim terenkripsi ke GitHub Secrets. Private key tidak disimpan di Abux dan tidak muncul di berkas workflow.'),
        pipelines.length ? field('Salin dari pipeline (opsional)', fromPipe) : null,
        h('div', { class: 'row' }, field('Host tujuan', hostSel), field('Repositori', repo, gh.loggedIn ? null : 'Login GitHub di panel GitHub untuk daftar otomatis dan penyetelan secret otomatis.')),
        h('div', { class: 'row' }, field('Branch pemicu', branch), field('Jenis proyek', stack)),
        field('Perintah tes (dijalankan di GitHub sebelum deploy)', test), field('Folder aplikasi di server', dir), field('Perintah deploy di server (satu per baris)', cmds, 'Dijalankan berurutan di folder di atas; berhenti bila ada yang gagal.'), out),
      buttons: [
        { label: 'Tutup' },
        { label: 'Pratinjau YAML', onClick: async () => { await preview(); return false; } },
        { label: 'Siapkan otomatis', kind: 'primary', onClick: async () => { await provision(); return false; } },
      ],
    });

    async function preview() {
      try {
        const r = await api.ci.preview(input());
        out.replaceChildren(h('div', { class: 'srv-bar' }, h('b', {}, '.github/workflows/abux-deploy.yml'), h('span', { class: 'grow' }), h('button', { class: 'btn small', onclick: () => api.clipboard.write(r.yaml).then(() => toast('YAML disalin', 'ok')) }, icon('copy'), 'Salin')), h('pre', { class: 'ci-yaml mono' }, r.yaml));
      } catch (e) { out.replaceChildren(h('div', { class: 'db-note err' }, errMsg(e))); }
    }
    async function provision() {
      const p = input();
      if (!gh.loggedIn) { out.replaceChildren(h('div', { class: 'db-note err' }, 'Login GitHub dulu (panel GitHub). Atau pakai "Pratinjau YAML" lalu pasang manual.')); return; }
      if (!/^[\w.-]+\/[\w.-]+$/.test(p.fullName)) { out.replaceChildren(h('div', { class: 'db-note err' }, 'Isi repositori dengan format pemilik/nama.')); return; }
      if (!(await confirmDialog({ title: 'Siapkan deploy otomatis?', message: `Akan menambah kunci di server, 5 secret + 1 berkas workflow di ${p.fullName} (branch ${p.branch}). Setiap push ke ${p.branch} akan men-deploy ke server.`, confirmLabel: 'Siapkan' }))) return;
      out.replaceChildren(h('div', { class: 'db-note' }, 'Menyiapkan…'));
      try {
        const host = App.state.hosts.find((x) => x.id === p.hostId);
        const sess = await window.Deploy.ensureSession(host);
        const r = await api.ci.provision({ ...p, sessionId: sess.id });
        out.replaceChildren(stepsView(r.steps), h('div', { class: 'db-note ok' }, `Selesai. Push ke ${p.branch} sekarang menjalankan tes lalu deploy. Pantau di tab Actions repositori.`));
      } catch (e) {
        out.replaceChildren(e.steps ? stepsView(e.steps) : '', h('div', { class: 'db-note err' }, errMsg(e)));
      }
    }
    const stepsView = (steps) => h('div', { class: 'ci-steps' }, steps.map((s) => h('div', { class: 'ci-step ' + (s.ok ? 'ok' : 'bad') }, h('span', {}, s.ok ? '✓' : '✗'), h('b', {}, s.name), h('span', { class: 'sub' }, s.detail || ''))));
    return m;
  }

  window.Cicd = { open };
})();
