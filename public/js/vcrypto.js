// Layer 1 — zero-knowledge encryption that runs inside the browser.
// Uses only the browser's built-in Web Crypto API (no third-party code).
//
//   master password --PBKDF2-SHA256 x1,000,000--> master key --HKDF--> auth key (sent to server)
//                                                              \--HKDF--> KEK (never leaves the browser)
//   KEK --AES-256-GCM--> the user's ECDH P-384 private key
//   team vault key (AES-256) is wrapped for each member with ECDH P-384 + HKDF-SHA-384 + AES-256-GCM
//   every credential is encrypted with the vault key (AES-256-GCM, random IV, bound to its id)

const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();
const td = new TextDecoder();
const CURVE = 'P-384';

export const KDF_ITER = 1_000_000;

export function toB64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function randomBytes(n) {
  const a = new Uint8Array(n);
  globalThis.crypto.getRandomValues(a);
  return a;
}

export const uuid = () => globalThis.crypto.randomUUID();
export const newSalt = () => toB64(randomBytes(16));

async function aesEnc(key, bytes, aad) {
  const iv = randomBytes(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad), tagLength: 128 }, key, bytes);
  return `c1.${toB64(iv)}.${toB64(ct)}`;
}

async function aesDec(key, blob, aad) {
  const parts = String(blob).split('.');
  if (parts.length !== 3 || parts[0] !== 'c1') throw new Error('bad_blob');
  const pt = await subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(parts[1]), additionalData: te.encode(aad), tagLength: 128 },
    key,
    fromB64(parts[2]),
  );
  return new Uint8Array(pt);
}

const normPw = (pw) => te.encode(String(pw).normalize('NFKC'));

export async function deriveFromPassword(password, saltB64, iterations) {
  const base = await subtle.importKey('raw', normPw(password), 'PBKDF2', false, ['deriveBits']);
  const master = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(saltB64), iterations }, base, 256);
  const hk = await subtle.importKey('raw', master, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const zero = new Uint8Array(32);
  const authBits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: zero, info: te.encode('team-vault/auth-v1') }, hk, 256);
  const kek = await subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: zero, info: te.encode('team-vault/kek-v1') },
    hk,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  return { authKey: toB64(authBits), kek };
}

export async function createUserKeys(kek) {
  const kp = await subtle.generateKey({ name: 'ECDH', namedCurve: CURVE }, true, ['deriveBits']);
  const spki = new Uint8Array(await subtle.exportKey('spki', kp.publicKey));
  const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', kp.privateKey));
  const encPrivateKey = await aesEnc(kek, pkcs8, 'team-vault/privkey-v1');
  const privateKey = await subtle.importKey('pkcs8', pkcs8, { name: 'ECDH', namedCurve: CURVE }, false, ['deriveBits']);
  pkcs8.fill(0);
  return { publicKey: toB64(spki), encPrivateKey, privateKey };
}

export async function openPrivateKey(kek, encPrivateKey) {
  const pkcs8 = await aesDec(kek, encPrivateKey, 'team-vault/privkey-v1');
  try {
    return await subtle.importKey('pkcs8', pkcs8, { name: 'ECDH', namedCurve: CURVE }, false, ['deriveBits']);
  } finally {
    pkcs8.fill(0);
  }
}

// Re-encrypt the private key under a new KEK (used when the master password changes).
export async function rewrapPrivateKey(oldKek, encPrivateKey, newKek) {
  const pkcs8 = await aesDec(oldKek, encPrivateKey, 'team-vault/privkey-v1');
  try {
    return await aesEnc(newKek, pkcs8, 'team-vault/privkey-v1');
  } finally {
    pkcs8.fill(0);
  }
}

async function wrapKey(shared, salt, usage) {
  const hk = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-384', salt, info: te.encode('team-vault/wrap-v1') },
    hk,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

export async function wrapVaultKey(rawVaultKey, recipientPublicKeyB64, userId, keyVersion) {
  const recipient = await subtle.importKey('spki', fromB64(recipientPublicKeyB64), { name: 'ECDH', namedCurve: CURVE }, false, []);
  const eph = await subtle.generateKey({ name: 'ECDH', namedCurve: CURVE }, false, ['deriveBits']);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: recipient }, eph.privateKey, 384);
  const salt = randomBytes(16);
  const k = await wrapKey(shared, salt, 'encrypt');
  const epk = new Uint8Array(await subtle.exportKey('spki', eph.publicKey));
  const ct = await aesEnc(k, rawVaultKey, `team-vault/wrap|${userId}|${keyVersion}`);
  return JSON.stringify({ v: 1, epk: toB64(epk), salt: toB64(salt), ct });
}

async function unwrapRaw(wrappedJson, privateKey, userId, keyVersion) {
  const w = JSON.parse(wrappedJson);
  if (!w || w.v !== 1) throw new Error('bad_wrap');
  const epk = await subtle.importKey('spki', fromB64(w.epk), { name: 'ECDH', namedCurve: CURVE }, false, []);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: epk }, privateKey, 384);
  const k = await wrapKey(shared, fromB64(w.salt), 'decrypt');
  return aesDec(k, w.ct, `team-vault/wrap|${userId}|${keyVersion}`);
}

// Normal use: a non-extractable key that can encrypt/decrypt but can't be exported.
export async function unwrapVaultKey(wrappedJson, privateKey, userId, keyVersion) {
  const raw = await unwrapRaw(wrappedJson, privateKey, userId, keyVersion);
  try {
    return await importVaultKey(raw);
  } finally {
    raw.fill(0);
  }
}

// Admin use only (approving a member / rotating): the raw bytes, to be wiped right after.
export const unwrapVaultKeyRaw = unwrapRaw;

export const newVaultKeyRaw = () => randomBytes(32);

export function importVaultKey(raw) {
  return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function sealEntry(vaultKey, id, keyVersion, meta, secret) {
  return {
    meta: await aesEnc(vaultKey, te.encode(JSON.stringify(meta)), `team-vault/meta|${id}|${keyVersion}`),
    secret: await aesEnc(vaultKey, te.encode(JSON.stringify(secret)), `team-vault/secret|${id}|${keyVersion}`),
  };
}

export async function openMeta(vaultKey, id, keyVersion, blob) {
  return JSON.parse(td.decode(await aesDec(vaultKey, blob, `team-vault/meta|${id}|${keyVersion}`)));
}

export async function openSecret(vaultKey, id, keyVersion, blob) {
  return JSON.parse(td.decode(await aesDec(vaultKey, blob, `team-vault/secret|${id}|${keyVersion}`)));
}

// Small shared documents (the admins' billing notes), bound to their name and key version.
export async function sealDoc(vaultKey, name, keyVersion, obj) {
  return aesEnc(vaultKey, te.encode(JSON.stringify(obj)), `team-vault/doc|${name}|${keyVersion}`);
}

export async function openDoc(vaultKey, name, keyVersion, blob) {
  return JSON.parse(td.decode(await aesDec(vaultKey, blob, `team-vault/doc|${name}|${keyVersion}`)));
}

// Opaque labels (which alerts were seen) that reveal nothing to the server.
export function hmacKey(rawB64) {
  return subtle.importKey('raw', fromB64(rawB64), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

export async function hmacHex(key, text) {
  const sig = new Uint8Array(await subtle.sign('HMAC', key, te.encode(text)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function backupKey(password, salt, iterations) {
  const base = await subtle.importKey('raw', normPw(password), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function sealBackup(password, payload) {
  const salt = randomBytes(16);
  const key = await backupKey(password, salt, KDF_ITER);
  const data = await aesEnc(key, te.encode(JSON.stringify(payload)), 'team-vault/backup-v1');
  return JSON.stringify({ format: 'team-vault-backup', v: 1, kdf: { name: 'PBKDF2-SHA256', iterations: KDF_ITER, salt: toB64(salt) }, data });
}

export async function openBackup(password, text) {
  let f;
  try {
    f = JSON.parse(text);
  } catch {
    throw new Error('backup_format');
  }
  if (!f || f.format !== 'team-vault-backup' || f.v !== 1 || !f.kdf || !f.data) throw new Error('backup_format');
  const iterations = Number(f.kdf.iterations);
  if (!Number.isInteger(iterations) || iterations < 100_000 || iterations > 10_000_000) throw new Error('backup_format');
  const key = await backupKey(password, fromB64(f.kdf.salt), iterations);
  try {
    return JSON.parse(td.decode(await aesDec(key, f.data, 'team-vault/backup-v1')));
  } catch {
    throw new Error('backup_password');
  }
}

export async function fingerprint(publicKeyB64) {
  const h = new Uint8Array(await subtle.digest('SHA-256', fromB64(publicKeyB64)));
  const hex = Array.from(h.subarray(0, 10), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return hex.match(/.{4}/g).join(' ');
}

function randInt(n) {
  const limit = Math.floor(0x100000000 / n) * n;
  const a = new Uint32Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(a);
    if (a[0] < limit) return a[0] % n;
  }
}

// Unambiguous characters only (no I/l/1, O/0) so passwords can be read aloud or retyped.
export function generatePassword(length = 20, symbols = true) {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789'];
  if (symbols) sets.push('!@#$%^&*-_=+?');
  const all = sets.join('');
  for (;;) {
    let pw = '';
    for (let i = 0; i < length; i++) pw += all[randInt(all.length)];
    if (sets.every((s) => [...pw].some((c) => s.includes(c)))) return pw;
  }
}

// Rough strength estimate in bits, with penalties for obvious patterns.
export function strength(pw) {
  const s = String(pw || '');
  let pool = 0;
  if (/[a-z]/.test(s)) pool += 26;
  if (/[A-Z]/.test(s)) pool += 26;
  if (/\d/.test(s)) pool += 10;
  if (/[^A-Za-z0-9؀-ۿ]/.test(s)) pool += 33;
  if (/[؀-ۿ]/.test(s)) pool += 36;
  const unique = new Set(s).size;
  let bits = Math.min(s.length, unique * 2) * Math.log2(pool || 1);
  if (/(.)\1{2,}/.test(s)) bits -= 10;
  if (/(0123|1234|2345|3456|4567|5678|6789|abcd|qwer|asdf|password|admin|pass)/i.test(s)) bits -= 25;
  bits = Math.max(0, Math.round(bits));
  const score = bits < 45 ? 0 : bits < 60 ? 1 : bits < 75 ? 2 : bits < 95 ? 3 : 4;
  return { bits, score };
}
