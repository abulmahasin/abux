'use strict';

const crypto = require('crypto');
const { utils } = require('ssh2');

const PUBKEY_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]+={0,3}( [^\r\n'"\\]*)?$/;

function sha256Fingerprint(blob) {
  return 'SHA256:' + crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
}

function normalizeType(parsed) {
  const t = parsed.type || '';
  if (t === 'ssh-ed25519') return 'ed25519';
  if (t === 'ssh-rsa') return 'rsa';
  if (t.startsWith('ecdsa')) return 'ecdsa';
  return t;
}

/** Hasilkan pasangan kunci OpenSSH baru. */
function generate({ type = 'ed25519', comment = 'abux', passphrase = '', bits = 4096 } = {}) {
  if (!['ed25519', 'rsa'].includes(type)) throw new Error('Tipe key tidak didukung.');
  const opts = { comment: String(comment).replace(/[\r\n'"\\]/g, '') };
  if (type === 'rsa') opts.bits = Number(bits) === 2048 ? 2048 : 4096;
  if (passphrase) {
    opts.passphrase = passphrase;
    opts.cipher = 'aes256-ctr';
    opts.rounds = 16;
  }
  const pair = utils.generateKeyPairSync(type, opts);
  const parsed = utils.parseKey(pair.public);
  if (parsed instanceof Error) throw parsed;
  return {
    type,
    privateKey: pair.private,
    publicKey: pair.public.trim(),
    fingerprint: sha256Fingerprint(parsed.getPublicSSH()),
    encrypted: !!passphrase,
  };
}

/** Parse private key yang diimpor. Mengembalikan info + flag apakah butuh passphrase. */
function inspectPrivateKey(privateKeyText, passphrase) {
  const text = String(privateKeyText || '').trim() + '\n';
  const pick = (p) => (Array.isArray(p) ? p[0] : p);
  let encrypted = false;
  let first = pick(utils.parseKey(text));
  if (first instanceof Error && /passphrase/i.test(first.message)) {
    encrypted = true;
    if (!passphrase) {
      const err = new Error('Key ini dienkripsi, masukkan passphrase.');
      err.code = 'NEEDS_SECRET';
      err.kind = 'passphrase';
      throw err;
    }
    first = pick(utils.parseKey(text, passphrase));
    if (first instanceof Error) throw new Error('Passphrase salah atau key tidak valid.');
  }
  if (first instanceof Error) throw new Error('File bukan private key yang valid: ' + first.message);
  if (first.isPrivateKey && !first.isPrivateKey()) throw new Error('File ini bukan private key.');
  const pubSsh = first.getPublicSSH();
  const type = normalizeType(first);
  const publicKey = `${first.type} ${pubSsh.toString('base64')}${first.comment ? ' ' + first.comment : ''}`.trim();
  return {
    type,
    privateKey: text,
    publicKey,
    fingerprint: sha256Fingerprint(pubSsh),
    encrypted,
  };
}

function isValidPublicKey(text) {
  return PUBKEY_RE.test(String(text || '').trim());
}

module.exports = { generate, inspectPrivateKey, isValidPublicKey, sha256Fingerprint };
