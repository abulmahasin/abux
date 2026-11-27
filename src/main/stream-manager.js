'use strict';

const crypto = require('crypto');

/** Menjalankan perintah streaming (log langsung) di sesi SSH dan meneruskan output ke renderer. */
class StreamManager {
  constructor({ ssh, emit }) {
    this.ssh = ssh;
    this.emit = emit;
    this.streams = new Map();
    this.max = 8;
    ssh.onSessionClosed((sessionId) => this.stopForSession(sessionId));
  }

  async start(sessionId, command) {
    if (this.streams.size >= this.max) throw new Error('Terlalu banyak aliran log aktif. Hentikan salah satu dulu.');
    const id = crypto.randomUUID();
    let buf = '';
    let timer = null;
    const flush = () => { timer = null; if (buf) { const data = buf; buf = ''; this.emit('stream:data', { id, data }); } };
    const r = this.ssh.execStream(sessionId, command, {
      onData: (d) => { buf += d; if (buf.length > 262144) buf = buf.slice(-262144); if (!timer) timer = setTimeout(flush, 80); },
    });
    const entry = { id, sessionId, cancel: r.cancel };
    this.streams.set(id, entry);
    r.promise.then((res) => {
      clearTimeout(timer); flush();
      this.streams.delete(id);
      this.emit('stream:end', { id, code: res.code, canceled: res.canceled, disconnected: res.disconnected });
    }).catch(() => { this.streams.delete(id); this.emit('stream:end', { id, code: null }); });
    return { id };
  }

  stop(id) { const s = this.streams.get(id); if (s) s.cancel(); }
  stopForSession(sessionId) { for (const s of this.streams.values()) if (s.sessionId === sessionId) s.cancel(); }
  stopAll() { for (const s of this.streams.values()) s.cancel(); }
}

module.exports = { StreamManager };
