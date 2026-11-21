// Runtime configuration. Every secret is derived from MASTER_SECRET, which lives
// only in the hosting provider's environment variables (never in the code or DB).
import crypto from 'node:crypto';

const env = process.env;

export const IS_PROD = env.NODE_ENV === 'production';
export const PORT = Number(env.PORT) || 3000;
export const APP_NAME = (env.APP_NAME || 'الخزنة').slice(0, 40);
export const TOTP_ISSUER = (env.TOTP_ISSUER || 'Team Vault').slice(0, 40);
export const DATABASE_URL = env.DATABASE_URL || '';
export const RECOVERY_USER = (env.RECOVERY_USER || '').trim().toLowerCase() || null;
export const DB_PLAN = (env.DB_PLAN || '').trim().toLowerCase();
export const PUBLIC_URL = (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
export const COOKIE_SECURE = env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : IS_PROD;

export const SESSION_IDLE_MS = 30 * 60 * 1000; // server-side idle timeout
export const SESSION_MAX_MS = 12 * 60 * 60 * 1000; // absolute session lifetime
export const INVITE_TTL_MS = 72 * 60 * 60 * 1000;
export const DEVICE_COOKIE_MS = 400 * 24 * 60 * 60 * 1000;
export const KDF_ITER_DEFAULT = 1_000_000;
export const KDF_ITER_MIN = 600_000;
export const KDF_ITER_MAX = 10_000_000;
export const LOCK_THRESHOLD = 5; // failed attempts before the account is locked

const secret = env.MASTER_SECRET || '';
if (secret.length < 32) {
  console.error('FATAL: MASTER_SECRET is missing or shorter than 32 characters.');
  process.exit(1);
}

const root = Buffer.from(secret, 'utf8');
const derive = (label) =>
  Buffer.from(crypto.hkdfSync('sha256', root, Buffer.alloc(0), Buffer.from(`team-vault/${label}`, 'utf8'), 32));

// Independent sub-keys, one per purpose (HKDF domain separation).
export const KEYS = Object.freeze({
  enc: derive('server-enc-v1'), // server-side AES-256-GCM layer over everything stored
  pepper: derive('auth-pepper-v1'), // pepper mixed into login hashes
  token: derive('token-hmac-v1'), // hashing session/device/invite tokens
  gate: derive('gate-v1'), // the hidden entry link
  setup: derive('setup-v1'), // one-time first-admin setup link
  fake: derive('fake-salt-v1'), // fake salts so usernames can't be probed
  check: derive('key-check-v1'), // detects a changed MASTER_SECRET at boot
});
