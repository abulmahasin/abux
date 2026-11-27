'use strict';
/* Logika murni penampil log (level + pengelompokan entri). Dipakai renderer dan tes. */
(function (root) {
  const ERR = /\b(ERROR|CRITICAL|ALERT|EMERGENCY|FATAL|PANIC|EXCEPTION)\b|\[(error|crit|alert|emerg)\]/i;
  const WARN = /\bWARN(ING)?\b|\[warn\]/i;

  function level(line) {
    if (ERR.test(line)) return 'error';
    if (WARN.test(line)) return 'warning';
    return 'info';
  }

  // Baris baru entri: stempel waktu Laravel "[2026-01-01 ..." atau ISO "2026-01-01T..." atau syslog "Jan  1 ..."
  const START = /^(\[\d{4}-\d{2}-\d{2}|\d{4}[-/]\d{2}[-/]\d{2}[T ]|[A-Z][a-z]{2} +\d{1,2} \d\d:\d\d|\S+ \S+ \S+ \[\d+\/[A-Za-z]{3}\/)/;

  /** Tambahkan satu baris ke daftar entri: baris lanjutan (stack trace) digabung ke entri sebelumnya. */
  function push(entries, raw) {
    const line = String(raw).replace(/\r$/, '');
    if (!entries.length && !line) return;
    if (!entries.length || START.test(line)) { entries.push({ text: line, level: level(line) }); return; }
    const cur = entries[entries.length - 1];
    cur.text += '\n' + line;
    if (cur.level === 'info' || (cur.level === 'warning' && ERR.test(line))) { const l = level(line); if (l === 'error' || (l === 'warning' && cur.level === 'info')) cur.level = l; }
  }

  function group(lines) {
    const out = [];
    for (const l of lines) push(out, l);
    return out;
  }

  /** Terapkan filter level ('all'|'error'|'warning' = warning ke atas) dan pencarian teks. */
  function filter(entries, { lvl = 'all', q = '' } = {}) {
    const needle = String(q || '').toLowerCase();
    return entries.filter((e) => {
      if (lvl === 'error' && e.level !== 'error') return false;
      if (lvl === 'warning' && e.level === 'info') return false;
      return !needle || e.text.toLowerCase().includes(needle);
    });
  }

  const api = { level, group, filter, push };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LogView = api;
})(typeof window !== 'undefined' ? window : globalThis);
