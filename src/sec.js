// Server-side cryptography: the second encryption layer, password-hash verification,
// token hashing and TOTP (RFC 6238) — all built on Node's own crypto module.
import crypto from 'node:crypto';
import { KEYS } from './config.js';

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
export const hashToken = (token) => hmac(KEYS.token, String(token)).toString('hex');

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) {
    crypto.timingSafeEqual(x, x);
    return false;
  }
  return crypto.timingSafeEqual(x, y);
}

// ---- Layer 2: AES-256-GCM with a key that exists only in the server's environment ----
export function srvEnc(context, text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEYS.enc, iv, { authTagLength: 16 });
  c.setAAD(Buffer.from(context, 'utf8'));
  const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return 's1.' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

export function srvDec(context, blob) {
  if (typeof blob !== 'string' || !blob.startsWith('s1.')) throw new Error('bad server blob');
  const buf = Buffer.from(blob.slice(3), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', KEYS.enc, buf.subarray(0, 12), { authTagLength: 16 });
  d.setAAD(Buffer.from(context, 'utf8'));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

// ---- Links and checks ----
export const gateToken = (version) => hmac(KEYS.gate, `gate|${version}`).toString('base64url').slice(0, 32);
export const setupToken = () => hmac(KEYS.setup, 'setup|v1').toString('base64url').slice(0, 32);
export const keyCheck = () => hmac(KEYS.check, 'key-check').toString('hex');
export const fakeSalt = (username) => hmac(KEYS.fake, `salt|${username}`).subarray(0, 16).toString('base64');

// ---- Login hash: scrypt(HMAC(pepper, authKey)). The authKey itself is already the
// output of 1,000,000 PBKDF2 rounds done in the browser; the password never arrives here. ----
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };

export function hashAuth(authKeyB64, salt) {
  const pre = hmac(KEYS.pepper, Buffer.from(authKeyB64, 'base64'));
  return new Promise((resolve, reject) =>
    crypto.scrypt(pre, salt, 32, SCRYPT, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function verifyAuth(user, authKeyB64) {
  const h = await hashAuth(authKeyB64, Buffer.from(user.auth_salt, 'base64'));
  return crypto.timingSafeEqual(h, Buffer.from(user.auth_hash, 'base64'));
}

export async function dummyAuth() {
  await hashAuth(crypto.randomBytes(32).toString('base64'), crypto.randomBytes(16));
}

// ---- TOTP (Google Authenticator / Microsoft Authenticator compatible) ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function hotp(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secret).update(msg).digest();
  const off = h[h.length - 1] & 0x0f;
  const code = (((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3]) % 1_000_000;
  return String(code).padStart(6, '0');
}

export const newTotpSecret = () => crypto.randomBytes(20);

// Returns the matched time-step, or null. Steps at or before lastStep are rejected,
// so a code can never be used twice.
export function checkTotp(secret, code, lastStep = 0, now = Date.now()) {
  if (!/^\d{6}$/.test(String(code))) return null;
  const cur = Math.floor(now / 30_000);
  for (const step of [cur, cur - 1, cur + 1]) {
    if (step <= lastStep) continue;
    if (safeEqual(hotp(secret, step), code)) return step;
  }
  return null;
}

export function fingerprint(publicKeyB64) {
  const h = crypto.createHash('sha256').update(Buffer.from(publicKeyB64, 'base64')).digest();
  return h.subarray(0, 10).toString('hex').toUpperCase().match(/.{4}/g).join(' ');
}
