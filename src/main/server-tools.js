'use strict';

/**
 * Pembangun perintah + parser untuk panel Server (Monitor, Docker, Log).
 * Semua perintah dibangun di sini dari input yang divalidasi ketat; renderer tidak pernah
 * mengirim string shell mentah.
 */

class ToolError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
function checkId(id) {
  if (!ID_RE.test(String(id || ''))) throw new ToolError('Nama/ID container tidak valid.', 'BAD_ARG');
  return String(id);
}
function checkPath(p) {
  const s = String(p || '');
  if (!s.startsWith('/') || s.length > 512 || /[\0\r\n]/.test(s)) throw new ToolError('Path harus absolut dan tidak boleh berisi karakter kontrol.', 'BAD_ARG');
  return s;
}
const sudoPrefix = (sudo) => (sudo ? 'sudo -n ' : '');
const clampInt = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n))) : d; };

// ---------- Monitor ----------
const MONITOR_SCRIPT = [
  'echo "##cpu"; head -n 1 /proc/stat',
  'echo "##cores"; (nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo)',
  'echo "##mem"; grep -E "^(MemTotal|MemAvailable|MemFree|Buffers|Cached|SwapTotal|SwapFree):" /proc/meminfo',
  'echo "##load"; cat /proc/loadavg',
  'echo "##up"; cut -d" " -f1 /proc/uptime',
  'echo "##disk"; df -P -k -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null | tail -n +2',
  'echo "##ps"; ps -eo pid,user,pcpu,pmem,comm --sort=-pcpu 2>/dev/null | head -n 16',
].join('; ');

function sections(out) {
  const res = {};
  let cur = null;
  for (const line of String(out).split('\n')) {
    const m = /^##(\w+)$/.exec(line.trim());
    if (m) { cur = m[1]; res[cur] = []; } else if (cur && line.trim()) res[cur].push(line);
  }
  return res;
}

function parseMonitor(stdout) {
  const s = sections(stdout);
  const out = { cpu: null, cores: 1, mem: null, load: null, uptime: 0, disks: [], procs: [] };
  if (s.cpu && s.cpu[0]) {
    const p = s.cpu[0].trim().split(/\s+/).slice(1).map(Number);
    if (p.length >= 4 && p.every(Number.isFinite)) {
      const idle = p[3] + (p[4] || 0);
      out.cpu = { total: p.reduce((a, b) => a + b, 0), idle };
    }
  }
  if (s.cores && s.cores[0]) out.cores = Math.max(1, parseInt(s.cores[0], 10) || 1);
  if (s.mem) {
    const m = {};
    for (const l of s.mem) { const x = /^(\w+):\s+(\d+)/.exec(l.trim()); if (x) m[x[1]] = Number(x[2]) * 1024; }
    if (m.MemTotal) {
      const avail = m.MemAvailable != null ? m.MemAvailable : (m.MemFree || 0) + (m.Buffers || 0) + (m.Cached || 0);
      out.mem = { total: m.MemTotal, used: Math.max(0, m.MemTotal - avail), swapTotal: m.SwapTotal || 0, swapUsed: Math.max(0, (m.SwapTotal || 0) - (m.SwapFree || 0)) };
    }
  }
  if (s.load && s.load[0]) { const p = s.load[0].trim().split(/\s+/).map(Number); if (p.length >= 3) out.load = [p[0], p[1], p[2]]; }
  if (s.up && s.up[0]) out.uptime = Math.floor(Number(s.up[0]) || 0);
  if (s.disk) {
    for (const l of s.disk) {
      const p = l.trim().split(/\s+/);
      if (p.length < 6) continue;
      const total = Number(p[1]) * 1024; const used = Number(p[2]) * 1024;
      if (!Number.isFinite(total) || total <= 0) continue;
      out.disks.push({ fs: p[0], mount: p.slice(5).join(' '), total, used, pct: Math.round((used / total) * 100) });
    }
  }
  if (s.ps) {
    for (const l of s.ps.slice(1)) {
      const p = l.trim().split(/\s+/);
      if (p.length < 5) continue;
      out.procs.push({ pid: Number(p[0]), user: p[1], cpu: Number(p[2]), mem: Number(p[3]), cmd: p.slice(4).join(' ') });
    }
  }
  return out;
}

/** Persentase CPU dari dua sampel /proc/stat. */
function cpuPercent(prev, cur) {
  if (!prev || !cur) return null;
  const dt = cur.total - prev.total;
  const di = cur.idle - prev.idle;
  if (dt <= 0) return null;
  return Math.max(0, Math.min(100, Math.round(((dt - di) / dt) * 1000) / 10));
}

// ---------- Docker ----------
function parseJsonLines(text) {
  const out = [];
  const t = String(text).trim();
  if (!t) return out;
  if (t.startsWith('[')) { try { return JSON.parse(t); } catch (_) { return out; } }
  for (const l of t.split('\n')) { try { out.push(JSON.parse(l)); } catch (_) { /* abaikan baris non-JSON */ } }
  return out;
}

const dockerPsCmd = (sudo) => `${sudoPrefix(sudo)}docker ps -a --no-trunc --format '{{json .}}'`;
function parseDockerPs(stdout) {
  return parseJsonLines(stdout).map((c) => ({
    id: String(c.ID || '').slice(0, 12), name: c.Names || '', image: c.Image || '', state: (c.State || '').toLowerCase(),
    status: c.Status || '', ports: c.Ports || '', created: c.RunningFor || '',
  }));
}
const DOCKER_ACTIONS = new Set(['start', 'stop', 'restart']);
function dockerActionCmd(action, id, sudo) {
  if (!DOCKER_ACTIONS.has(action)) throw new ToolError('Aksi Docker tidak dikenal.', 'BAD_ARG');
  return `${sudoPrefix(sudo)}docker ${action} ${shq(checkId(id))}`;
}
function dockerLogsCmd(id, { tail = 200, follow = false, sudo = false } = {}) {
  return `${sudoPrefix(sudo)}docker logs --timestamps --tail ${clampInt(tail, 1, 5000, 200)}${follow ? ' -f' : ''} ${shq(checkId(id))} 2>&1`;
}
const COMPOSE_ACTIONS = { up: 'up -d', down: 'down', restart: 'restart', pull: 'pull', build: 'build', ps: 'ps' };
function composeCmd(dir, action, sudo) {
  if (!COMPOSE_ACTIONS[action]) throw new ToolError('Aksi compose tidak dikenal.', 'BAD_ARG');
  return `cd ${shq(checkPath(dir))} && ${sudoPrefix(sudo)}docker compose ${COMPOSE_ACTIONS[action]} 2>&1`;
}
function composePsCmd(dir, sudo) {
  return `cd ${shq(checkPath(dir))} && ${sudoPrefix(sudo)}docker compose ps -a --format json`;
}
function composeLogsCmd(dir, { tail = 200, follow = false, sudo = false } = {}) {
  return `cd ${shq(checkPath(dir))} && ${sudoPrefix(sudo)}docker compose logs --no-color --timestamps --tail ${clampInt(tail, 1, 5000, 200)}${follow ? ' -f' : ''} 2>&1`;
}
function parseComposePs(stdout) {
  return parseJsonLines(stdout).map((c) => ({ name: c.Name || '', service: c.Service || '', state: (c.State || '').toLowerCase(), status: c.Status || '', image: c.Image || '' }));
}

// ---------- Log ----------
const LOG_PRESETS = {
  nginx_error: '/var/log/nginx/error.log',
  nginx_access: '/var/log/nginx/access.log',
  syslog: '/var/log/syslog',
};
/** @param {{kind:string, path?:string, dir?:string}} src */
function logSource(src) {
  const kind = src && src.kind;
  if (kind === 'journal') return { journal: true };
  if (LOG_PRESETS[kind]) return { path: LOG_PRESETS[kind] };
  if (kind === 'laravel') return { path: checkPath(String(src.dir || '').replace(/\/+$/, '') + '/storage/logs/laravel.log') };
  if (kind === 'file') return { path: checkPath(src.path) };
  throw new ToolError('Sumber log tidak dikenal.', 'BAD_ARG');
}
function logFetchCmd(src, { lines = 500, sudo = false } = {}) {
  const s = logSource(src); const n = clampInt(lines, 1, 5000, 500);
  return s.journal ? `${sudoPrefix(sudo)}journalctl -n ${n} --no-pager 2>&1` : `${sudoPrefix(sudo)}tail -n ${n} -- ${shq(s.path)} 2>&1`;
}
function logFollowCmd(src, { sudo = false } = {}) {
  const s = logSource(src);
  return s.journal ? `${sudoPrefix(sudo)}journalctl -f -n 0 --no-pager 2>&1` : `${sudoPrefix(sudo)}tail -n 0 -F -- ${shq(s.path)} 2>&1`;
}

module.exports = {
  ToolError, shq, MONITOR_SCRIPT, parseMonitor, cpuPercent,
  dockerPsCmd, parseDockerPs, dockerActionCmd, dockerLogsCmd, composeCmd, composePsCmd, composeLogsCmd, parseComposePs,
  logSource, logFetchCmd, logFollowCmd, LOG_PRESETS,
};
