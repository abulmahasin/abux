'use strict';

/** Pemecah dan pengklasifikasi SQL. Sengaja sederhana dan konservatif. */

/** Pecah skrip menjadi pernyataan; menghormati string, backtick, dan komentar. */
function splitStatements(sql) {
  const out = [];
  let cur = '';
  let i = 0;
  const n = sql.length;
  let quote = null;
  while (i < n) {
    const c = sql[i];
    const d = sql[i + 1];
    if (quote) {
      cur += c;
      if (c === '\\' && quote !== '`' && i + 1 < n) { cur += sql[i + 1]; i += 2; continue; }
      if (c === quote) {
        if (sql[i + 1] === quote) { cur += sql[i + 1]; i += 2; continue; }
        quote = null;
      }
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; cur += c; i++; continue; }
    if (c === '-' && d === '-' && (sql[i + 2] === ' ' || sql[i + 2] === '\t' || sql[i + 2] === '\n' || sql[i + 2] === undefined || sql[i + 2] === '\r')) {
      while (i < n && sql[i] !== '\n') { cur += sql[i]; i++; }
      continue;
    }
    if (c === '#') { while (i < n && sql[i] !== '\n') { cur += sql[i]; i++; } continue; }
    if (c === '/' && d === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      cur += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === ';') { if (stripNoise(cur).trim()) out.push(cur.trim()); cur = ''; i++; continue; }
    cur += c;
    i++;
  }
  if (stripNoise(cur).trim()) out.push(cur.trim());
  return out;
}

/** Hapus komentar dan isi string agar analisis kata kunci tidak tertipu. */
function stripNoise(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const d = sql[i + 1];
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      i++;
      while (i < n) {
        if (sql[i] === '\\' && q !== '`') { i += 2; continue; }
        if (sql[i] === q) { if (sql[i + 1] === q) { i += 2; continue; } break; }
        i++;
      }
      i++;
      out += ' ';
      continue;
    }
    if ((c === '-' && d === '-') || c === '#') { while (i < n && sql[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { const e = sql.indexOf('*/', i + 2); i = e === -1 ? n : e + 2; out += ' '; continue; }
    out += c;
    i++;
  }
  return out;
}

const READ_OK = new Set(['select', 'show', 'describe', 'desc', 'explain', 'use', 'with', 'values', 'table']);

/**
 * @returns {{kind: string, readOnlyOk: boolean, danger: string|null}}
 */
function classify(stmt) {
  const clean = stripNoise(stmt).trim().replace(/\s+/g, ' ');
  const first = (clean.match(/^[a-zA-Z]+/) || [''])[0].toLowerCase();
  let readOnlyOk = READ_OK.has(first);
  const low = clean.toLowerCase();
  // SELECT ... INTO OUTFILE / DUMPFILE / FOR UPDATE bukan pembacaan murni
  if (readOnlyOk && (/\binto\s+(outfile|dumpfile)\b/.test(low) || /\bfor\s+update\b/.test(low) || /\block\s+in\s+share\s+mode\b/.test(low))) readOnlyOk = false;
  // CTE yang berujung pada perubahan data
  if (first === 'with' && /\b(insert|update|delete|replace)\b/.test(low)) readOnlyOk = false;
  if (first === 'explain' && /\b(insert|update|delete|replace)\b/.test(low) && !/^explain\s+(select|insert|update|delete)/.test(low)) readOnlyOk = false;

  let danger = null;
  if (first === 'drop') danger = 'DROP menghapus objek database secara permanen.';
  else if (first === 'truncate') danger = 'TRUNCATE mengosongkan seluruh isi tabel.';
  else if (first === 'alter') danger = 'ALTER mengubah struktur tabel.';
  else if (first === 'rename') danger = 'RENAME mengubah nama objek database.';
  else if (first === 'grant' || first === 'revoke') danger = 'Perintah ini mengubah hak akses database.';
  else if ((first === 'delete' || first === 'update') && !/\bwhere\b/.test(low)) {
    danger = `${first.toUpperCase()} tanpa WHERE akan mengubah SEMUA baris tabel.`;
  }
  return { kind: first, readOnlyOk, danger };
}

module.exports = { splitStatements, stripNoise, classify };
