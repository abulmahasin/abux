'use strict';

/* Helper UI kecil: pembuat DOM aman (tanpa innerHTML untuk data pengguna), modal, toast, menu konteks. */
window.UI = (() => {
  const ICONS = {
    server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
    snippet: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3M14 9l2 2"/>',
    github: '<path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/>',
    settings: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    edit: '<path d="M12 20h9M16.500 3.500a2.100 2.100 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    upload: '<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>',
    download: '<path d="M12 4v12M7 11l5 5 5-5M4 20h16"/>',
    refresh: '<path d="M21 12a9 9 0 0 1-15.500 6.200M3 12A9 9 0 0 1 18.500 5.800M21 4v5h-5M3 20v-5h5"/>',
    up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
    x: '<path d="M18 6L6 18M6 6l12 12"/>',
    terminal: '<path d="M4 17l6-6-6-6M12 19h8"/>',
    link: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    play: '<path d="M6 4l14 8-14 8z"/>',
    folderPlus: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 11v6M9 14h6"/>',
    files: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.500-4.500"/>',
    cloud: '<path d="M17.500 19a4.500 4.500 0 0 0 .5-9 6 6 0 0 0-11.500 1.500A4 4 0 0 0 7 19z"/>',
    rename: '<path d="M4 20h4L19 9l-4-4L4 16zM13 7l4 4"/>',
    database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.700 3.600 3 8 3s8-1.300 8-3V5M4 11v6c0 1.700 3.600 3 8 3s8-1.300 8-3v-6"/>',
    table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.500 9.500a2.500 2.500 0 1 1 3.500 2.300c-.700.400-1 .900-1 1.700M12 17h.01"/>',
    rocket: '<path d="M4.500 16.500c-1.500 1.260-2 5-2 5s3.740-.5 5-2c.710-.840.700-2.130-.090-2.910a2.180 2.180 0 0 0-2.910-.090zM12 15l-3-3a22 22 0 0 1 2-3.950A12.880 12.880 0 0 1 22 2c0 2.720-.780 7.500-6 11a22.350 22.350 0 0 1-4 2zM9 12H4s.550-3.030 2-4c1.620-1.080 5 0 5 0M12 15v5s3.030-.550 4-2c1.080-1.620 0-5 0-5"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.700L3 8M3 3v5h5M12 7v5l3 2"/>',
    down: '<path d="M12 5v14M5 12l7 7 7-7"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    redis: '<path d="M12 3l9 4.500-9 4.500-9-4.500zM3 12l9 4.500 9-4.500M3 16.500l9 4.500 9-4.500"/>',
    docker: '<path d="M3 12h4v-3H3zM8 12h4V9H8zM13 12h4V9h-4zM8 8h4V5H8zM2 14c1 5 5 6 9 6 6 0 9-3 10-8-1-.5-3-.5-4 .5"/>',
    server2: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  };

  function icon(name) {
    const s = document.createElement('span');
    s.className = 'icon';
    s.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`; // konstanta internal, aman
    return s;
  }

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'hidden') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function iconButton(name, title, onClick, extra) {
    return h('button', { class: 'icon-btn ' + (extra || ''), title, 'aria-label': title, type: 'button', onclick: (e) => { e.stopPropagation(); onClick(e); } }, icon(name));
  }

  function toast(message, type) {
    const el = h('div', { class: 'toast ' + (type || ''), role: 'status' }, message);
    document.getElementById('toast-root').append(el);
    setTimeout(() => el.remove(), type === 'err' ? 7000 : 3500);
  }

  function field(label, control, hint) {
    return h('div', { class: 'field' }, h('label', {}, label), control, hint ? h('div', { class: 'hint' }, hint) : null);
  }

  /**
   * Modal generik. buttons: [{label, kind:'primary'|'danger'|'', onClick: async (api) => false|void}]
   * Mengembalikan {close, setError, el}.
   */
  function modal({ title, subtitle, body, buttons, onClose, width }) {
    const root = document.getElementById('modal-root');
    const previouslyFocused = document.activeElement;
    const errBox = h('div', { class: 'err', hidden: true });
    const footer = h('footer');
    const box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, style: width ? { width } : null },
      h('header', {}, h('h3', {}, title), subtitle ? h('p', {}, subtitle) : null),
      h('div', { class: 'body' }, errBox, body),
      footer);
    const backdrop = h('div', { class: 'backdrop' }, box);
    let closed = false;
    const api = {
      el: box,
      setError(msg) { errBox.textContent = msg || ''; errBox.hidden = !msg; },
      close(result) {
        if (closed) return;
        closed = true;
        document.removeEventListener('keydown', onKey, true);
        backdrop.remove();
        if (previouslyFocused && previouslyFocused.focus) try { previouslyFocused.focus(); } catch (_) { /* abaikan */ }
        if (onClose) onClose(result);
      },
    };
    const btnEls = [];
    for (const b of buttons || []) {
      const el = h('button', { class: 'btn ' + (b.kind || ''), type: 'button' }, b.label);
      el.addEventListener('click', async () => {
        if (el.disabled) return;
        api.setError('');
        el.disabled = true;
        try {
          const r = b.onClick ? await b.onClick(api) : undefined;
          if (r !== false) api.close(b.value);
        } catch (e) {
          api.setError(e.message || String(e));
        } finally {
          el.disabled = false;
        }
      });
      btnEls.push([b, el]);
      footer.append(el);
    }
    function onKey(e) {
      if (!backdrop.isConnected) return;
      // Hanya modal paling atas yang bereaksi.
      if (root.lastElementChild !== backdrop) return;
      if (e.key === 'Escape') { e.stopPropagation(); api.close(); }
      else if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') {
        const primary = btnEls.find(([b]) => b.kind === 'primary' || b.kind === 'danger');
        if (primary) { e.preventDefault(); primary[1].click(); }
      }
    }
    document.addEventListener('keydown', onKey, true);
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop && !(buttons || []).some((b) => b.noBackdropClose)) { /* sengaja tidak menutup agar input tidak hilang */ } });
    root.append(backdrop);
    const first = box.querySelector('input:not([type=checkbox]), select, textarea');
    setTimeout(() => (first || box.querySelector('button.primary, button')).focus(), 0);
    return api;
  }

  function confirmDialog({ title, message, confirmLabel = 'Ya', danger = false, extra }) {
    return new Promise((resolve) => {
      let decided = false;
      modal({
        title,
        body: h('div', {}, h('p', { style: { margin: '4px 0 8px', whiteSpace: 'pre-wrap' } }, message), extra || null),
        buttons: [
          { label: 'Batal', onClick: () => { decided = true; resolve(false); } },
          { label: confirmLabel, kind: danger ? 'danger' : 'primary', onClick: () => { decided = true; resolve(true); } },
        ],
        onClose: () => { if (!decided) resolve(false); },
      });
    });
  }

  function promptDialog({ title, message, label, type = 'text', confirmLabel = 'OK', value = '', hint }) {
    return new Promise((resolve) => {
      const input = h('input', { type, value, autocomplete: 'off', spellcheck: 'false' });
      let out = null;
      modal({
        title,
        subtitle: message,
        body: field(label, input, hint),
        buttons: [
          { label: 'Batal' },
          { label: confirmLabel, kind: 'primary', onClick: () => { out = input.value; } },
        ],
        onClose: () => resolve(out),
      });
    });
  }

  function contextMenu(x, y, items) {
    const root = document.getElementById('ctx-root');
    root.replaceChildren();
    const menu = h('div', { class: 'menu', role: 'menu' });
    for (const it of items) {
      if (it === '-') { menu.append(h('hr')); continue; }
      menu.append(h('button', { type: 'button', role: 'menuitem', onclick: () => { close(); it.onClick(); } }, h('span', {}, it.label), it.hint ? h('small', {}, it.hint) : null));
    }
    root.append(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.min(x, window.innerWidth - r.width - 6) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - r.height - 6) + 'px';
    function close() {
      root.replaceChildren();
      window.removeEventListener('mousedown', outside, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', esc, true);
    }
    function outside(e) { if (!menu.contains(e.target)) close(); }
    function esc(e) { if (e.key === 'Escape') close(); }
    setTimeout(() => {
      window.addEventListener('mousedown', outside, true);
      window.addEventListener('blur', close);
      window.addEventListener('keydown', esc, true);
    }, 0);
  }

  const fmtSize = (n) => {
    if (n == null) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (i === 0 ? v : v.toFixed(1)) + ' ' + u[i];
  };
  const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) : '');

  return { h, icon, iconButton, toast, field, modal, confirmDialog, promptDialog, contextMenu, fmtSize, fmtDate };
})();
