'use strict';

/* Menu Bantuan: daftar topik di sidebar + jendela panduan dengan daftar isi, pencarian, dan contoh. */
(() => {
  const { h, modal, toast } = window.UI;
  const TOPICS = window.HELP_TOPICS || [];
  let current = null; // { m, setTopic }

  // teks inline: `kode` dan **tebal**; tanpa innerHTML
  function inline(text) {
    const out = [];
    const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
    let last = 0; let m;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push(text.slice(last, m.index));
      const t = m[0];
      out.push(t.startsWith('`') ? h('code', {}, t.slice(1, -1)) : h('strong', {}, t.slice(2, -2)));
      last = m.index + t.length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }

  async function copy(text) {
    try { await window.api.clipboard.write(text); toast('Contoh disalin', 'ok'); } catch (e) { toast(e.message || String(e), 'err'); }
  }

  function renderBlock(b) {
    const [type, a, c] = b;
    switch (type) {
      case 'p': return h('p', {}, inline(a));
      case 'h': return h('h4', {}, a);
      case 'ul': return h('ul', {}, a.map((t) => h('li', {}, inline(t))));
      case 'ol': return h('ol', {}, a.map((t) => h('li', {}, inline(t))));
      case 'tip': return h('div', { class: 'help-note tip' }, h('b', {}, 'Tips'), h('span', {}, inline(a)));
      case 'warn': return h('div', { class: 'help-note warn' }, h('b', {}, 'Perhatian'), h('span', {}, inline(a)));
      case 'code': return h('div', { class: 'help-code' },
        h('div', { class: 'help-code-bar' }, h('span', {}, c || 'Contoh'), h('button', { type: 'button', class: 'btn small', onclick: () => copy(a) }, 'Salin')),
        h('pre', { class: 'mono' }, a));
      case 'table': return h('div', { class: 'help-table-wrap' }, h('table', { class: 'help-table' },
        h('thead', {}, h('tr', {}, a.map((x) => h('th', {}, x)))),
        h('tbody', {}, c.map((r) => h('tr', {}, r.map((x) => h('td', {}, inline(x))))))));
      default: return null;
    }
  }

  const plain = (t) => [t.title, t.summary, ...t.blocks.map((b) => JSON.stringify(b.slice(1)))].join(' ').toLowerCase();
  const search = (q) => { q = q.trim().toLowerCase(); return q ? TOPICS.filter((t) => plain(t).includes(q)) : TOPICS; };

  function open(topicId) {
    if (current) { current.setTopic(topicId || TOPICS[0].id); return; }
    let id = topicId || TOPICS[0].id;
    let filter = '';
    const toc = h('nav', { class: 'help-toc', 'aria-label': 'Daftar isi' });
    const article = h('article', { class: 'help-article', tabindex: '0' });
    const searchBox = h('input', { type: 'search', placeholder: 'Cari di panduan…', spellcheck: 'false', 'aria-label': 'Cari di panduan' });
    const body = h('div', { class: 'help-layout' }, h('div', { class: 'help-side' }, searchBox, toc), article);

    function renderToc() {
      toc.replaceChildren();
      const list = search(filter);
      if (!list.length) toc.append(h('div', { class: 'empty' }, 'Tidak ditemukan'));
      let g = null;
      for (const t of list) {
        if (t.group !== g) { g = t.group; toc.append(h('div', { class: 'group-label' }, g)); }
        toc.append(h('button', { type: 'button', class: 'help-toc-item' + (t.id === id ? ' on' : ''), onclick: () => setTopic(t.id) }, t.title));
      }
    }

    function setTopic(next) {
      id = next;
      const i = TOPICS.findIndex((t) => t.id === id);
      const t = TOPICS[i] || TOPICS[0];
      article.replaceChildren(
        h('h2', {}, t.title),
        h('p', { class: 'help-sum' }, t.summary),
        ...t.blocks.map(renderBlock),
        h('div', { class: 'help-nav' },
          i > 0 ? h('button', { type: 'button', class: 'btn', onclick: () => setTopic(TOPICS[i - 1].id) }, `← ${TOPICS[i - 1].title}`) : h('span'),
          i < TOPICS.length - 1 ? h('button', { type: 'button', class: 'btn primary', onclick: () => setTopic(TOPICS[i + 1].id) }, `${TOPICS[i + 1].title} →`) : h('span')));
      article.scrollTop = 0;
      renderToc();
    }

    searchBox.addEventListener('input', () => {
      filter = searchBox.value;
      const list = search(filter);
      if (list.length && !list.some((t) => t.id === id)) setTopic(list[0].id); else renderToc();
    });

    const m = modal({
      title: 'Bantuan & panduan', subtitle: 'Tutorial lengkap beserta contoh. Tekan Esc untuk menutup.',
      body, width: '980px', buttons: [{ label: 'Tutup' }],
      onClose: () => { current = null; },
    });
    m.el.classList.add('help-modal');
    current = { m, setTopic };
    setTopic(id);
    searchBox.focus();
  }

  function renderSidebar(body) {
    const q = (window.AbuxApp.state.filter || '').toLowerCase();
    const list = search(q);
    body.append(h('div', { class: 'help-intro' }, 'Panduan lengkap dengan contoh untuk setiap fitur.', h('div', { style: { marginTop: '10px' } }, h('button', { class: 'btn primary', onclick: () => open() }, 'Buka panduan (F1)'))));
    if (!list.length) { body.append(h('div', { class: 'empty' }, h('b', {}, 'Tidak ditemukan'), 'Coba kata kunci lain.')); return; }
    let g = null;
    for (const t of list) {
      if (t.group !== g) { g = t.group; body.append(h('div', { class: 'group-label' }, g)); }
      body.append(h('div', { class: 'item', tabindex: '0', role: 'button', onclick: () => open(t.id), onkeydown: (e) => { if (e.key === 'Enter') open(t.id); } },
        h('div', { class: 'grow' }, h('div', { class: 'title' }, t.title), h('div', { class: 'sub' }, t.summary))));
    }
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'F1' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); open(); }
  }, true);

  window.Help = { open, renderSidebar };
})();
