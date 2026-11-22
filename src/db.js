// PostgreSQL access. The database only ever receives ciphertext for credentials:
// every credential is encrypted in the browser (layer 1) and again on the server (layer 2).
import pg from 'pg';

let pool = null;

export function initPool(url) {
  if (!url) {
    console.error('FATAL: DATABASE_URL is not set.');
    process.exit(1);
  }
  const host = new URL(url).hostname;
  // Render's private-network hostnames have no dots (e.g. dpg-xxxx-a).
  const privateHost = host === 'localhost' || host === '127.0.0.1' || host === '::1' || !host.includes('.');
  const mode = (process.env.DB_SSL || '').toLowerCase();
  let ssl = false;
  if (mode === 'require') ssl = { rejectUnauthorized: true };
  else if (mode === 'no-verify') ssl = { rejectUnauthorized: false };
  else if (mode !== 'disable' && !privateHost) ssl = { rejectUnauthorized: true };

  // Keep strict certificate checking even after node-postgres changes what "require" means.
  const u = new URL(url);
  if (['require', 'prefer', 'verify-ca'].includes(u.searchParams.get('sslmode'))) u.searchParams.set('sslmode', 'verify-full');

  pool = new pg.Pool({
    connectionString: u.toString(),
    ssl,
    max: 6,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 20_000,
    keepAlive: true,
  });
  pool.on('error', (e) => console.error('db pool error:', e.message));
  return pool;
}

export const q = (text, params) => pool.query(text, params);

export async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    try {
      await c.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    c.release();
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   text PRIMARY KEY,
  value text NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id              uuid PRIMARY KEY,
  username        text NOT NULL UNIQUE,
  display_name    text NOT NULL,
  role            text NOT NULL CHECK (role IN ('admin','member')),
  status          text NOT NULL CHECK (status IN ('pending_totp','pending_approval','active')),
  kdf_salt        text NOT NULL,
  kdf_iter        integer NOT NULL,
  auth_hash       text NOT NULL,
  auth_salt       text NOT NULL,
  public_key      text NOT NULL,
  enc_private_key text NOT NULL,
  totp_secret     text,
  totp_pending    text,
  totp_enabled    boolean NOT NULL DEFAULT false,
  totp_last_step  bigint NOT NULL DEFAULT 0,
  failed_logins   integer NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  approved_by     uuid,
  approved_at     timestamptz,
  last_login_at   timestamptz
);

CREATE TABLE IF NOT EXISTS invites (
  id           uuid PRIMARY KEY,
  code_hash    text NOT NULL UNIQUE,
  username     text NOT NULL,
  display_name text NOT NULL,
  role         text NOT NULL CHECK (role IN ('admin','member')),
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  user_id      uuid
);

CREATE TABLE IF NOT EXISTS vault_keys (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_version integer NOT NULL,
  wrapped     text NOT NULL,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key_version)
);

CREATE TABLE IF NOT EXISTS entries (
  id          uuid PRIMARY KEY,
  key_version integer NOT NULL,
  meta_ct     text NOT NULL,
  secret_ct   text NOT NULL,
  created_by  uuid,
  updated_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  deleted_by  uuid
);

CREATE TABLE IF NOT EXISTS devices (
  id            uuid PRIMARY KEY,
  token_hash    text NOT NULL UNIQUE,
  label         text NOT NULL,
  setup_allowed boolean NOT NULL DEFAULT false,
  revoked       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_ip    text,
  last_seen_at  timestamptz
);

CREATE TABLE IF NOT EXISTS user_devices (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id    uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  status       text NOT NULL CHECK (status IN ('pending','approved','rejected')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by   uuid,
  decided_at   timestamptz,
  last_used_at timestamptz,
  last_ip      text,
  PRIMARY KEY (user_id, device_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash   text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id    uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  ip           text
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

CREATE TABLE IF NOT EXISTS audit (
  id       bigserial PRIMARY KEY,
  at       timestamptz NOT NULL DEFAULT now(),
  user_id  uuid,
  username text,
  action   text NOT NULL,
  entry_id uuid,
  ip       text,
  device   text,
  details  jsonb
);

-- Billing notes for admins (which client each subscription belongs to, what we charge them,
-- extra recurring costs). One document, encrypted in the browser with the vault key (layer 1)
-- and again on the server (layer 2), like the credentials.
CREATE TABLE IF NOT EXISTS billing_doc (
  id          smallint PRIMARY KEY CHECK (id = 1),
  key_version integer NOT NULL,
  blob_ct     text NOT NULL,
  revision    integer NOT NULL DEFAULT 1,
  updated_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Which alerts each admin has already seen. Keys are HMACs computed in the browser with a
-- secret kept inside the encrypted billing document, so they reveal nothing about the alert.
CREATE TABLE IF NOT EXISTS notice_reads (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key     text NOT NULL,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

-- Sign-in is username + master password only (no authenticator app): drop the old 2FA secrets.
UPDATE users SET totp_enabled = false, totp_secret = NULL, totp_pending = NULL, totp_last_step = 0
 WHERE totp_enabled OR totp_secret IS NOT NULL OR totp_pending IS NOT NULL;

-- The activity log is append-only: the database itself ignores edits and deletes.
CREATE OR REPLACE RULE audit_no_update AS ON UPDATE TO audit DO INSTEAD NOTHING;
CREATE OR REPLACE RULE audit_no_delete AS ON DELETE TO audit DO INSTEAD NOTHING;
`;

export async function migrate() {
  await q(SCHEMA);
  await q(
    `INSERT INTO settings (key, value) VALUES
       ('key_version','1'), ('vault_revision','0'), ('gate_version','1'), ('db_created_at', $1)
     ON CONFLICT (key) DO NOTHING`,
    [new Date().toISOString()],
  );
}

const cache = new Map();

export async function getSetting(key) {
  if (cache.has(key)) return cache.get(key);
  const r = await q('SELECT value FROM settings WHERE key = $1', [key]);
  const v = r.rows[0] ? r.rows[0].value : null;
  cache.set(key, v);
  return v;
}

export async function setSetting(key, value, db = null) {
  await (db || pool).query(
    'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, String(value)],
  );
  cache.delete(key);
}

export function clearSettingsCache() {
  cache.clear();
}

// Locks the vault-wide counters in a fixed order so concurrent writers and a key
// rotation can never deadlock or interleave.
export async function lockVault(c) {
  const r = await c.query(
    "SELECT key, value FROM settings WHERE key IN ('key_version','vault_revision') ORDER BY key FOR UPDATE",
  );
  const m = Object.fromEntries(r.rows.map((x) => [x.key, x.value]));
  return { keyVersion: Number(m.key_version), revision: Number(m.vault_revision) };
}

export async function bumpRevision(c) {
  await c.query("UPDATE settings SET value = (value::bigint + 1)::text WHERE key = 'vault_revision'");
}
