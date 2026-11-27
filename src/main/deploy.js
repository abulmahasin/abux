'use strict';

const crypto = require('crypto');

const OUTPUT_CAP = 64 * 1024; // sisa output yang disimpan per langkah (ekor)
const SAVED_OUTPUT_CAP = 16 * 1024; // yang masuk riwayat di disk
const REF_RE = /^[0-9a-f]{7,64}$/i;

const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function cwdExpr(cwd) {
  if (cwd === '~') return '~';
  if (cwd.startsWith('~/')) return '~/' + shQuote(cwd.slice(2));
  return shQuote(cwd);
}

/** Perintah akhir: pindah ke folder kerja lalu jalankan lewat login shell pengguna (PATH composer/node/pm2 ikut termuat). */
function wrapCommand(cwd, command) {
  return `cd ${cwdExpr(cwd)} && exec "\${SHELL:-sh}" -lc ${shQuote(command)}`;
}

class DeployError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/**
 * Menjalankan pipeline deploy lewat sesi SSH yang sudah terhubung.
 * - Langkah dijalankan berurutan; berhenti di langkah yang gagal (kecuali continueOnError).
 * - Bisa dibatalkan; satu run aktif per host.
 * - Mencatat versi git sebelum deploy agar rollback bisa dilakukan.
 */
class DeployManager {
  constructor({ store, ssh, emit, stepTimeoutMs = 15 * 60 * 1000 }) {
    this.store = store;
    this.ssh = ssh;
    this.emit = emit;
    this.stepTimeoutMs = stepTimeoutMs;
    this.active = new Map(); // runId -> run
    this.locks = new Map(); // hostId -> runId
  }

  activeRuns() {
    return [...this.active.values()].map((r) => this._snapshot(r));
  }

  _snapshot(run) {
    return {
      id: run.id,
      pipelineId: run.pipelineId,
      pipelineName: run.pipelineName,
      hostId: run.hostId,
      hostName: run.hostName,
      kind: run.kind,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      previousRef: run.previousRef,
      rollbackOf: run.rollbackOf,
      warnings: run.warnings,
      steps: run.steps.map((s) => ({
        id: s.id, name: s.name, command: s.command, status: s.status,
        startedAt: s.startedAt, durationMs: s.durationMs, exitCode: s.exitCode, error: s.error,
      })),
    };
  }

  /**
   * @param {{pipelineId: string, sessionId: string, kind?: 'deploy'|'rollback', fromRunId?: string}} opts
   */
  async start({ pipelineId, sessionId, kind = 'deploy', fromRunId }) {
    const pipeline = this.store.getPipeline(pipelineId);
    if (!pipeline) throw new DeployError('Pipeline tidak ditemukan.', 'NO_PIPELINE');
    const host = this.store.getHostRaw(pipeline.hostId);
    if (!host) throw new DeployError('Host pipeline tidak ditemukan.', 'NO_HOST');
    const session = this.ssh.sessions.get(sessionId);
    if (!session || session.closed || session.hostId !== host.id) {
      throw new DeployError(`Sesi belum terhubung ke ${host.name}. Sambungkan dulu.`, 'NO_SESSION');
    }
    if (this.locks.has(host.id)) throw new DeployError(`Masih ada deploy yang berjalan di ${host.name}.`, 'BUSY');

    let previousRef = null;
    let sourceSteps = pipeline.steps;
    let rollbackOf = null;
    if (kind === 'rollback') {
      const from = this.store.getRun(fromRunId);
      if (!from || from.pipelineId !== pipeline.id) throw new DeployError('Run asal rollback tidak ditemukan.', 'NO_RUN');
      if (from.kind === 'rollback') throw new DeployError('Tidak bisa me-rollback sebuah rollback.', 'BAD_RUN');
      if (!from.previousRef || !REF_RE.test(from.previousRef)) {
        throw new DeployError('Run ini tidak punya catatan versi git sebelumnya, jadi rollback otomatis tidak tersedia.', 'NO_REF');
      }
      if (!pipeline.rollbackSteps.length) throw new DeployError('Pipeline ini belum punya langkah rollback.', 'NO_ROLLBACK');
      previousRef = from.previousRef;
      sourceSteps = pipeline.rollbackSteps;
      rollbackOf = from.id;
    } else if (kind !== 'deploy') {
      throw new DeployError('Jenis run tidak dikenal.', 'BAD_KIND');
    }

    const run = {
      id: crypto.randomUUID(),
      pipelineId: pipeline.id,
      pipelineName: pipeline.name,
      hostId: host.id,
      hostName: host.name,
      kind,
      status: 'running',
      startedAt: Date.now(),
      finishedAt: null,
      previousRef,
      rollbackOf,
      warnings: 0,
      canceled: false,
      cancel: null,
      steps: sourceSteps.map((s) => ({
        id: s.id, name: s.name, continueOnError: !!s.continueOnError,
        command: kind === 'rollback' ? s.command.split('{{PREVIOUS_REF}}').join(previousRef) : s.command,
        status: 'pending', startedAt: null, durationMs: null, exitCode: null, error: null, output: '',
      })),
    };
    this.active.set(run.id, run);
    this.locks.set(host.id, run.id);
    this.emit('deploy:event', { type: 'run-start', run: this._snapshot(run) });
    this._execute(run, pipeline, sessionId).catch((e) => this._finish(run, 'failed', e.message));
    return this._snapshot(run);
  }

  cancel(runId) {
    const run = this.active.get(runId);
    if (!run) throw new DeployError('Run tidak aktif.', 'NO_RUN');
    run.canceled = true;
    if (run.cancel) run.cancel();
    return true;
  }

  async _execute(run, pipeline, sessionId) {
    // Catat versi git sebelum deploy (hanya untuk deploy, hanya jika diminta; kegagalan bukan masalah).
    if (run.kind === 'deploy' && pipeline.captureRef) {
      try {
        let out = '';
        const h = this.ssh.execStream(sessionId, wrapCommand(pipeline.cwd, 'git rev-parse HEAD'), { onData: (d) => { out += d; }, timeoutMs: 20000 });
        const r = await h.promise;
        const ref = out.trim().split(/\s+/).pop() || '';
        if (r.code === 0 && REF_RE.test(ref)) {
          run.previousRef = ref;
          this.emit('deploy:event', { type: 'preflight', runId: run.id, previousRef: ref });
        }
      } catch (_) { /* sesi bermasalah akan terlihat di langkah pertama */ }
    }

    let failedAt = -1;
    for (let i = 0; i < run.steps.length; i++) {
      const step = run.steps[i];
      if (run.canceled) break;
      step.status = 'running';
      step.startedAt = Date.now();
      this.emit('deploy:event', { type: 'step-start', runId: run.id, index: i, startedAt: step.startedAt });

      let result;
      try {
        const h = this.ssh.execStream(sessionId, wrapCommand(pipeline.cwd, step.command), {
          timeoutMs: this.stepTimeoutMs,
          onData: (d) => {
            step.output = (step.output + d).slice(-OUTPUT_CAP);
            this.emit('deploy:event', { type: 'step-output', runId: run.id, index: i, data: d });
          },
        });
        run.cancel = h.cancel;
        if (run.canceled) h.cancel();
        result = await h.promise;
      } catch (e) {
        result = { code: null, error: e.message };
      }
      run.cancel = null;
      step.durationMs = Date.now() - step.startedAt;
      step.exitCode = result.code;

      if (run.canceled || result.canceled) {
        step.status = 'canceled';
        step.error = 'Dibatalkan.';
      } else if (result.timedOut) {
        step.status = 'failed';
        step.error = `Waktu habis (${Math.round(this.stepTimeoutMs / 1000)} detik). Perintah yang menunggu input (mis. sudo) tidak didukung.`;
      } else if (result.disconnected) {
        step.status = 'failed';
        step.error = 'Koneksi ke server terputus.';
      } else if (result.code === 0) {
        step.status = 'success';
      } else {
        step.status = 'failed';
        step.error = result.error || (result.code == null ? 'Proses berakhir tanpa kode keluar.' : `Keluar dengan kode ${result.code}.`);
      }
      this.emit('deploy:event', { type: 'step-end', runId: run.id, index: i, status: step.status, exitCode: step.exitCode, durationMs: step.durationMs, error: step.error });

      if (step.status === 'failed' && step.continueOnError) { run.warnings++; continue; }
      if (step.status === 'failed' || step.status === 'canceled') { failedAt = i; break; }
    }

    let final = 'success';
    if (run.canceled) final = 'canceled';
    else if (failedAt >= 0) final = 'failed';
    for (const s of run.steps) if (s.status === 'pending') s.status = 'skipped';
    this._finish(run, final);
  }

  _finish(run, status, note) {
    if (!this.active.has(run.id)) return;
    run.status = status;
    run.finishedAt = Date.now();
    if (note) for (const s of run.steps) if (s.status === 'pending' || s.status === 'running') { s.status = s.status === 'running' ? 'failed' : 'skipped'; if (s.status === 'failed') s.error = note; }
    this.active.delete(run.id);
    if (this.locks.get(run.hostId) === run.id) this.locks.delete(run.hostId);
    try {
      this.store.addRun({
        ...this._snapshot(run),
        steps: run.steps.map((s) => ({
          id: s.id, name: s.name, command: s.command, status: s.status, startedAt: s.startedAt,
          durationMs: s.durationMs, exitCode: s.exitCode, error: s.error, output: s.output.slice(-SAVED_OUTPUT_CAP),
        })),
      });
    } catch (_) { /* riwayat gagal disimpan tidak boleh menggagalkan hasil */ }
    this.emit('deploy:event', { type: 'run-end', run: this._snapshot(run) });
  }
}

module.exports = { DeployManager, DeployError, wrapCommand, shQuote };
