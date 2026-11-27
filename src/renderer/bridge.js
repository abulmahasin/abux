'use strict';

/*
 * Membungkus window.native (dari preload) menjadi window.api:
 * pemanggilan yang gagal melempar Error lengkap dengan code/kind/label,
 * yang tidak bisa dilewatkan langsung oleh contextBridge.
 */
(() => {
  const raw = window.native;
  const passthrough = (name) => /^on[A-Z]/.test(name) || name === 'write' || name === 'resize';
  const unwrap = async (promise) => {
    const r = await promise;
    if (r && r.ok) return r.data;
    const err = new Error((r && r.error) || 'Terjadi kesalahan.');
    if (r) {
      err.code = r.code;
      err.kind = r.kind;
      err.label = r.label;
    }
    throw err;
  };
  const api = {};
  for (const [ns, fns] of Object.entries(raw)) {
    api[ns] = {};
    for (const [name, fn] of Object.entries(fns)) {
      api[ns][name] = passthrough(name) ? fn : (...args) => unwrap(fn(...args));
    }
  }
  window.api = Object.freeze(api);
})();
