'use strict';
// Pemeriksaan sintaks cepat untuk semua berkas JS proyek (dipakai CI).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const roots = ['src', 'test', 'scripts'];
let bad = 0;
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
for (const r of roots) {
  if (!fs.existsSync(r)) continue;
  for (const f of walk(r).filter((x) => x.endsWith('.js'))) {
    try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (e) { bad++; console.error(`SINTAKS ERROR ${f}\n${e.stderr}`); }
  }
}
console.log(bad ? `${bad} berkas bermasalah` : 'sintaks OK');
process.exit(bad ? 1 : 0);
