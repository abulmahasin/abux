'use strict';

/**
 * Server SSH tiruan yang MENJALANKAN perintah di mesin lokal (sh -c) dan menyediakan SFTP
 * berbasis berkas sungguhan. Dipakai tes Monitor, Docker (lewat shim), Log, dan editor SFTP.
 * `env` dapat diatur agar perintah memakai shim `docker` di PATH.
 */
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');
const { Server, utils } = require('ssh2');

const { STATUS_CODE, OPEN_MODE } = utils.sftp;

function attrsOf(st) {
  return { mode: st.mode, uid: st.uid, gid: st.gid, size: st.size, atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000) };
}

function startLocalSsh({ env = process.env, root } = {}) {
  const log = [];
  const server = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (client) => {
    client.on('authentication', (ctx) => ctx.accept());
    client.on('ready', () => {
      client.on('tcpip', (accept, reject, info) => {
        const up = net.connect(info.destPort, '127.0.0.1');
        up.on('connect', () => { const ch = accept(); ch.pipe(up); up.pipe(ch); ch.on('close', () => up.destroy()); up.on('close', () => ch.close()); });
        up.on('error', () => { try { reject(); } catch (_) { /* abaikan */ } });
      });
      client.on('session', (accept) => {
        const s = accept();
        s.on('pty', (a) => a && a());
        s.on('window-change', (a) => a && a());
        s.on('shell', (a) => { const st = a(); st.write('welcome\r\n$ '); });
        s.on('exec', (a, _rej, info) => {
          const st = a();
          log.push(info.command);
          const child = spawn('sh', ['-c', info.command], { env, stdio: ['pipe', 'pipe', 'pipe'] });
          child.stdout.on('data', (d) => st.write(d));
          child.stderr.on('data', (d) => st.stderr.write(d));
          child.on('close', (code) => { try { st.exit(code == null ? 1 : code); st.end(); } catch (_) { /* abaikan */ } });
          // Ctrl+C lewat PTY: tiruan sederhana -> hentikan proses
          st.on('data', (d) => { if (d.includes(3)) child.kill('SIGINT'); });
          st.on('close', () => { try { child.kill('SIGKILL'); } catch (_) { /* abaikan */ } });
        });
        s.on('sftp', (acc) => {
          const sftp = acc();
          const handles = new Map();
          let n = 0;
          const real = (p) => (root ? require('path').join(root, p) : p);
          const fail = (id, e) => sftp.status(id, e && e.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : e && (e.code === 'EACCES' || e.code === 'EPERM') ? STATUS_CODE.PERMISSION_DENIED : STATUS_CODE.FAILURE);
          sftp.on('REALPATH', (id, p) => sftp.name(id, [{ filename: p === '.' ? (root || process.cwd()) : p, longname: '', attrs: {} }]));
          const doStat = (id, p) => { try { sftp.attrs(id, attrsOf(fs.statSync(real(p)))); } catch (e) { fail(id, e); } };
          sftp.on('STAT', doStat);
          sftp.on('LSTAT', doStat);
          sftp.on('OPEN', (id, filename, flags) => {
            try {
              let f = 'r';
              if (flags & OPEN_MODE.WRITE) f = (flags & OPEN_MODE.TRUNC) ? 'w' : (flags & OPEN_MODE.APPEND ? 'a' : 'r+');
              if ((flags & OPEN_MODE.CREAT) && f === 'r+') f = fs.existsSync(real(filename)) ? 'r+' : 'w';
              const fd = fs.openSync(real(filename), f);
              handles.set(++n, { fd, path: real(filename) });
              sftp.handle(id, Buffer.from([n]));
            } catch (e) { fail(id, e); }
          });
          sftp.on('FSTAT', (id, h) => { const x = handles.get(h[0]); if (!x) return sftp.status(id, STATUS_CODE.FAILURE); try { sftp.attrs(id, attrsOf(fs.fstatSync(x.fd))); } catch (e) { fail(id, e); } });
          sftp.on('READ', (id, h, offset, length) => {
            const x = handles.get(h[0]); if (!x) return sftp.status(id, STATUS_CODE.FAILURE);
            const buf = Buffer.alloc(length);
            const r = fs.readSync(x.fd, buf, 0, length, offset);
            if (r === 0) return sftp.status(id, STATUS_CODE.EOF);
            sftp.data(id, buf.slice(0, r));
          });
          sftp.on('WRITE', (id, h, offset, data) => { const x = handles.get(h[0]); if (!x) return sftp.status(id, STATUS_CODE.FAILURE); fs.writeSync(x.fd, data, 0, data.length, offset); sftp.status(id, STATUS_CODE.OK); });
          sftp.on('SETSTAT', (id) => sftp.status(id, STATUS_CODE.OK));
          sftp.on('FSETSTAT', (id) => sftp.status(id, STATUS_CODE.OK));
          sftp.on('CLOSE', (id, h) => { const x = handles.get(h[0]); if (x) { try { fs.closeSync(x.fd); } catch (_) { /* abaikan */ } handles.delete(h[0]); } sftp.status(id, STATUS_CODE.OK); });
        });
      });
    });
    client.on('error', () => {});
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ server, port: server.address().port, log })));
}

module.exports = { startLocalSsh };
