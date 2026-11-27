'use strict';

/**
 * Generator workflow GitHub Actions: tes dulu, lalu deploy ke server lewat SSH.
 * Rahasia (key, host) TIDAK ditulis ke berkas; workflow hanya merujuk ${{ secrets.* }}.
 */

const WORKFLOW_PATH = '.github/workflows/abux-deploy.yml';
const SECRET_NAMES = ['ABUX_SSH_KEY', 'ABUX_KNOWN_HOSTS', 'ABUX_SSH_HOST', 'ABUX_SSH_USER', 'ABUX_SSH_PORT'];
const STACKS = {
  node: { label: 'Node.js', test: 'npm test', install: 'npm ci' },
  php: { label: 'PHP / Laravel', test: 'php artisan test', install: 'composer install --no-interaction --prefer-dist' },
  none: { label: 'Tanpa tes', test: '', install: '' },
};
const DELIM = 'ABUX_DEPLOY_EOF';

class WorkflowError extends Error { constructor(m) { super(m); this.code = 'BAD_WORKFLOW'; } }

const indent = (text, n) => String(text).split('\n').map((l) => (l ? ' '.repeat(n) + l : l)).join('\n');

function cleanCommands(text, label) {
  const lines = String(text || '').split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim());
  for (const l of lines) {
    if (l.includes('${{')) throw new WorkflowError(`${label}: "\${{" tidak diperbolehkan (dievaluasi GitHub sebelum shell).`);
    if (l.includes(DELIM)) throw new WorkflowError(`${label}: berisi penanda terlarang.`);
    if (/[\0]/.test(l)) throw new WorkflowError(`${label}: karakter tidak valid.`);
    if (l.length > 2000) throw new WorkflowError(`${label}: baris terlalu panjang.`);
  }
  return lines;
}

/**
 * @param {{stack:string, branch:string, testCommand?:string, appDir:string, deployCommands:string, nodeVersion?:string, phpVersion?:string}} o
 */
function generateWorkflow(o) {
  const stack = STACKS[o.stack] ? o.stack : 'none';
  const branch = String(o.branch || 'main').trim();
  if (!/^[A-Za-z0-9._\/-]{1,100}$/.test(branch) || branch.includes('..')) throw new WorkflowError('Nama branch tidak valid.');
  const appDir = String(o.appDir || '').trim();
  if (!/^(\/|~\/)[^\0\r\n]*$/.test(appDir) || appDir.length > 400) throw new WorkflowError('Folder aplikasi di server harus path absolut (/ atau ~/).');
  const deploy = cleanCommands(o.deployCommands, 'Perintah deploy');
  if (!deploy.length) throw new WorkflowError('Isi minimal satu perintah deploy.');
  const testCmd = cleanCommands(o.testCommand != null ? o.testCommand : STACKS[stack].test, 'Perintah tes');
  const nodeV = /^\d{1,2}(\.\d+)*$/.test(o.nodeVersion || '') ? o.nodeVersion : '20';
  const phpV = /^\d\.\d{1,2}$/.test(o.phpVersion || '') ? o.phpVersion : '8.3';
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const cdLine = appDir.startsWith('~/') ? `cd "$HOME"/${q(appDir.slice(2))}` : `cd ${q(appDir)}`;

  const setup = [];
  if (stack === 'node') setup.push(`      - uses: actions/setup-node@v4\n        with:\n          node-version: '${nodeV}'\n          cache: npm`);
  if (stack === 'php') setup.push(`      - uses: shivammathur/setup-php@v2\n        with:\n          php-version: '${phpV}'`);
  const steps = ['      - uses: actions/checkout@v4', ...setup];
  if (STACKS[stack].install) steps.push(`      - name: Pasang dependensi\n        run: ${STACKS[stack].install}`);
  if (testCmd.length) steps.push(`      - name: Jalankan tes\n        run: |\n${indent(testCmd.join('\n'), 10)}`);
  else steps.push('      - name: Lewati tes\n        run: echo "Tidak ada perintah tes."');

  const remote = ['set -e', cdLine, ...deploy].join('\n');
  return `# Dibuat oleh Abux. Tes berjalan dulu; deploy hanya jika tes lulus.
# Rahasia ada di GitHub > Settings > Secrets and variables > Actions (bukan di berkas ini).
name: Test & Deploy (Abux)

on:
  push:
    branches: [ ${JSON.stringify(branch)} ]
  workflow_dispatch:

concurrency:
  group: abux-deploy-\${{ github.ref }}
  cancel-in-progress: false

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
${steps.join('\n')}

  deploy:
    needs: test
    if: github.event_name == 'workflow_dispatch' || github.ref == 'refs/heads/${branch}'
    runs-on: ubuntu-latest
    steps:
      - name: Siapkan SSH
        env:
          SSH_KEY: \${{ secrets.ABUX_SSH_KEY }}
          KNOWN_HOSTS: \${{ secrets.ABUX_KNOWN_HOSTS }}
        run: |
          install -m 700 -d ~/.ssh
          printf '%s\\n' "$SSH_KEY" > ~/.ssh/id_abux
          chmod 600 ~/.ssh/id_abux
          printf '%s\\n' "$KNOWN_HOSTS" > ~/.ssh/known_hosts

      - name: Deploy ke server
        env:
          SSH_HOST: \${{ secrets.ABUX_SSH_HOST }}
          SSH_USER: \${{ secrets.ABUX_SSH_USER }}
          SSH_PORT: \${{ secrets.ABUX_SSH_PORT }}
        run: |
          ssh -i ~/.ssh/id_abux -p "$SSH_PORT" -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes "$SSH_USER@$SSH_HOST" 'bash -s' <<'${DELIM}'
${indent(remote, 10)}
          ${DELIM}
`;
}

module.exports = { generateWorkflow, WorkflowError, WORKFLOW_PATH, SECRET_NAMES, STACKS };
