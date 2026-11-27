'use strict';

/* Editor berkas teks untuk SFTP: buka, ubah, simpan (Ctrl/Cmd+S), deteksi konflik. */
(() => {
  const { h, icon, toast, confirmDialog } = window.UI;
  const api = window.api;
  const errMsg = (e) => (e && e.message ? e.message : String(e));
  let current = null;

  async function open(sessionId, remotePath) {
    if (current && current.dirty && !(await confirmDialog({ title: 'Buang perubahan?', message: `${current.path} belum disimpan.`, confirmLabel: 'Buang', danger: true }))) return;
    if (current) close(true);
    let file;
    try { file = await api.sftp.readText(sessionId, remotePath); } catch (e) { toast(errMsg(e), 'err'); return; }
    const E = { sessionId, path: remotePath, mtime: file.mtime, original: file.content, dirty: false, saving: false };
    current = E;
    const ta = h('textarea', { class: 'ed-area mono', spellcheck: 'false', wrap: 'off', 'aria-label': 'Isi berkas ' + remotePath });
    ta.value = file.content;
    const status = h('span', { class: 'sub' });
    const pos = h('span', { class: 'sub mono' });
    const saveBtn = h('button', { class: 'btn primary small', disabled: true, onclick: () => save(false) }, 'Simpan');
    const title = h('b', { class: 'mono' }, remotePath);
    const dirtyDot = h('span', { class: 'badge priv', hidden: true }, 'belum disimpan');
    function update() {
      E.dirty = ta.value !== E.original;
      saveBtn.disabled = !E.dirty || E.saving; dirtyDot.hidden = !E.dirty;
      const before = ta.value.slice(0, ta.selectionStart).split('\n');
      pos.textContent = `Baris ${before.length}, Kol ${before[before.length - 1].length + 1} · ${ta.value.split('\n').length} baris`;
    }
    async function save(overwrite) {
      if (E.saving) return; E.saving = true; saveBtn.disabled = true; status.textContent = 'Menyimpan…';
      try {
        const r = await api.sftp.writeText({ sessionId, path: remotePath, content: ta.value, expectedMtime: E.mtime, overwrite });
        E.original = ta.value; E.mtime = r.mtime; status.textContent = 'Tersimpan ' + new Date().toLocaleTimeString('id-ID');
      } catch (e) {
        status.textContent = '';
        if (e.code === 'CONFLICT') { E.saving = false; if (await confirmDialog({ title: 'Berkas berubah di server', message: 'Seseorang/proses lain mengubah berkas ini setelah Anda membukanya. Timpa dengan versi Anda?', confirmLabel: 'Timpa', danger: true })) return save(true); }
        else toast(errMsg(e), 'err');
      }
      E.saving = false; update();
    }
    ta.addEventListener('input', update);
    ta.addEventListener('keyup', update); ta.addEventListener('click', update);
    ta.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (E.dirty) save(false); }
      else if (e.key === 'Escape') { e.preventDefault(); tryClose(); }
      else if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end'); update(); }
    });
    async function tryClose() { if (E.dirty && !(await confirmDialog({ title: 'Tutup tanpa menyimpan?', message: 'Perubahan akan hilang.', confirmLabel: 'Tutup', danger: true }))) return; close(true); }
    E.el = h('section', { id: 'editor-pane', class: 'db-pane', role: 'dialog', 'aria-label': 'Editor berkas' },
      h('header', { class: 'db-head' }, h('button', { class: 'btn small', onclick: tryClose }, '← Tutup'), h('div', { class: 'db-title' }, icon('edit'), title, dirtyDot), h('div', { class: 'grow' }), status, saveBtn),
      h('div', { class: 'ed-wrap' }, ta), h('footer', { class: 'ed-foot' }, pos, h('span', { class: 'grow' }), h('span', { class: 'sub' }, 'Ctrl/⌘+S simpan · Esc tutup · UTF-8')));
    document.getElementById('main').append(E.el);
    update(); ta.focus();
  }
  function close() { if (current) { current.el.remove(); current = null; } }
  window.Editor = { open, close, isDirty: () => !!(current && current.dirty) };
})();
