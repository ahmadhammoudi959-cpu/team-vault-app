// Team Vault — zero-knowledge credentials vault.
// The browser encrypts every credential before it is sent (layer 1, keys never leave the
// browser); this server wraps it again with its own key (layer 2) before it reaches the DB.
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import QRCode from 'qrcode';
import * as cfg from './src/config.js';
import {
  initPool, migrate, q, tx, getSetting, setSetting, clearSettingsCache, lockVault, bumpRevision,
} from './src/db.js';
import {
  randomToken, hashToken, safeEqual, srvEnc, srvDec, gateToken, setupToken, keyCheck, fakeSalt,
  hashAuth, verifyAuth, dummyAuth, base32, newTotpSecret, checkTotp, fingerprint,
} from './src/sec.js';
import {
  HttpError, v, parseCookies, cookieName, setCookie, clearCookie, clientIp, deviceLabel, hit,
  rateLimit, securityHeaders, notFound,
} from './src/http.js';
import { hostingerSnapshot, renderSnapshot, upcoming } from './src/integrations.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEVICE_COOKIE = cookieName('vd');
const SESSION_COOKIE = cookieName('vs');
const META_MAX = 24_000;
const SECRET_MAX = 120_000;
const MIN = 60 * 1000;

const app = express();
app.disable('x-powered-by');
app.set('etag', false);

app.use(securityHeaders);
app.use((req, res, next) => {
  req.cookies = parseCookies(req.headers.cookie);
  next();
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
async function audit(req, action, { userId, username, entryId = null, details = null } = {}) {
  try {
    const s = req && req.session;
    await q(
      'INSERT INTO audit (user_id, username, action, entry_id, ip, device, details) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [
        userId ?? (s ? s.user_id : null),
        String(username ?? (s ? s.username : '') ?? '').slice(0, 64) || null,
        action,
        entryId,
        req ? clientIp(req) : null,
        req && req.device ? req.device.label : null,
        details ? JSON.stringify(details) : null,
      ],
    );
  } catch (e) {
    console.error('audit write failed:', e.message);
  }
}

const deviceCache = new Map();
const forgetDevices = () => deviceCache.clear();

async function loadDevice(req) {
  const token = req.cookies[DEVICE_COOKIE];
  if (!token || token.length > 100) return null;
  const h = hashToken(token);
  const hitc = deviceCache.get(h);
  if (hitc && hitc.exp > Date.now()) return hitc.dev;
  const r = await q('SELECT id, label, setup_allowed, revoked, last_seen_at FROM devices WHERE token_hash = $1', [h]);
  const dev = r.rows[0] && !r.rows[0].revoked ? r.rows[0] : null;
  if (dev) {
    if (!dev.last_seen_at || Date.now() - new Date(dev.last_seen_at).getTime() > 10 * MIN) {
      await q('UPDATE devices SET last_seen_at = now() WHERE id = $1', [dev.id]);
    }
    deviceCache.set(h, { dev, exp: Date.now() + 30_000 });
  }
  return dev;
}

async function enrollDevice(req, res, setupAllowed) {
  const token = randomToken(32);
  const dev = { id: crypto.randomUUID(), label: deviceLabel(req.get('user-agent') || ''), setup_allowed: setupAllowed, revoked: false };
  await q('INSERT INTO devices (id, token_hash, label, setup_allowed, created_ip, last_seen_at) VALUES ($1,$2,$3,$4,$5,now())', [
    dev.id, hashToken(token), dev.label, setupAllowed, clientIp(req),
  ]);
  // Lax so the cookie is sent when the link is opened from WhatsApp/e-mail; sessions stay Strict.
  setCookie(res, DEVICE_COOKIE, token, { maxAge: cfg.DEVICE_COOKIE_MS, sameSite: 'Lax' });
  return dev;
}

async function createSession(db, res, userId, deviceId, req) {
  const token = randomToken(32);
  await (db || { query: q }).query(
    'INSERT INTO sessions (token_hash, user_id, device_id, expires_at, ip) VALUES ($1,$2,$3,$4,$5)',
    [hashToken(token), userId, deviceId, new Date(Date.now() + cfg.SESSION_MAX_MS), clientIp(req)],
  );
  setCookie(res, SESSION_COOKIE, token, { sameSite: 'Strict' });
}

let setupDone = false;
async function isSetupDone() {
  if (setupDone) return true;
  setupDone = (await getSetting('setup_done')) === '1';
  return setupDone;
}

const totpSecretOf = (u) => Buffer.from(srvDec(`totp:${u.id}`, u.totp_secret), 'base64');

async function totpPayload(username, secretBuf) {
  const b32 = base32(secretBuf);
  const label = `${encodeURIComponent(cfg.TOTP_ISSUER)}:${encodeURIComponent(username)}`;
  const uri = `otpauth://totp/${label}?secret=${b32}&issuer=${encodeURIComponent(cfg.TOTP_ISSUER)}&algorithm=SHA1&digits=6&period=30`;
  const svg = await QRCode.toString(uri, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, color: { dark: '#17222b', light: '#ffffff' } });
  return { qr: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, secret: b32.match(/.{1,4}/g).join(' ') };
}

async function keysPayload(userId) {
  const u = (await q('SELECT id, username, display_name, role, public_key, enc_private_key FROM users WHERE id = $1', [userId])).rows[0];
  const kv = Number(await getSetting('key_version'));
  const w = (await q('SELECT wrapped FROM vault_keys WHERE user_id = $1 AND key_version = $2', [userId, kv])).rows[0];
  if (!w) throw new HttpError(409, 'no_vault_key');
  return {
    user: { id: u.id, username: u.username, displayName: u.display_name, role: u.role },
    keys: {
      publicKey: u.public_key,
      encPrivateKey: srvDec(`privkey:${u.id}`, u.enc_private_key),
      keyVersion: kv,
      wrappedVaultKey: srvDec(`wrap:${u.id}:${kv}`, w.wrapped),
    },
  };
}

async function registerFailure(req, u, reason) {
  const n = (u.failed_logins || 0) + 1;
  const lockMin = n >= cfg.LOCK_THRESHOLD ? Math.min(15 * 2 ** (n - cfg.LOCK_THRESHOLD), 24 * 60) : 0;
  await q(
    `UPDATE users SET failed_logins = failed_logins + 1,
       locked_until = CASE WHEN $2::int > 0 THEN now() + make_interval(mins => $2::int) ELSE locked_until END
     WHERE id = $1`,
    [u.id, lockMin],
  );
  await audit(req, 'login_fail', { userId: u.id, username: u.username, details: { reason } });
  if (lockMin) await audit(req, 'account_locked', { userId: u.id, username: u.username, details: { minutes: lockMin } });
  return lockMin;
}

const tickets = new Map();
function newTicket(data) {
  const t = randomToken(24);
  tickets.set(t, { ...data, exp: Date.now() + 10 * MIN, tries: 0 });
  return t;
}
function getTicket(t) {
  const x = typeof t === 'string' ? tickets.get(t) : null;
  if (!x) return null;
  if (x.exp < Date.now()) {
    tickets.delete(t);
    return null;
  }
  return x;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, x] of tickets) if (x.exp < now) tickets.delete(k);
}, MIN).unref();

function originOf(req) {
  const host = req.get('host');
  if (!host) return cfg.PUBLIC_URL;
  return `${cfg.IS_PROD ? 'https' : req.protocol}://${host}`;
}

async function gateLink(req) {
  return `${originOf(req)}/k/${gateToken(await getSetting('gate_version'))}`;
}

// ---------------------------------------------------------------------------
// renewal data from Hostinger / Render (cached; refreshed on demand by admins)
// ---------------------------------------------------------------------------
const integ = {
  hostinger: { token: cfg.HOSTINGER_API_TOKEN, load: hostingerSnapshot, data: null, at: 0, pending: null },
  render: { token: cfg.RENDER_API_KEY, load: renderSnapshot, data: null, at: 0, pending: null },
};
const INTEG_TTL = 30 * MIN;

function refreshIntegration(kind, force = false) {
  const slot = integ[kind];
  if (!slot.token) return Promise.resolve(null);
  if (!force && slot.data && Date.now() - slot.at < INTEG_TTL) return Promise.resolve(slot.data);
  if (slot.pending) return slot.pending;
  slot.pending = slot
    .load(slot.token)
    .catch((e) => ({ error: (e && e.code) || 'failed', fetchedAt: new Date().toISOString() }))
    .then((data) => {
      // Keep the last good snapshot if a refresh fails, but remember the failure.
      slot.data = data.error && slot.data && !slot.data.error ? { ...slot.data, lastError: data.error } : data;
      slot.at = Date.now();
      return slot.data;
    })
    .finally(() => {
      slot.pending = null;
    });
  return slot.pending;
}

function integrationView(kind) {
  const slot = integ[kind];
  if (!slot.token) return { notConfigured: true };
  return slot.data || { loading: true };
}

// ---------------------------------------------------------------------------
// Layer: the hidden door. Without an enrolled device cookie every URL is "Not Found".
// ---------------------------------------------------------------------------
app.get('/k/:token', async (req, res) => {
  if (hit(`gate:${clientIp(req)}`, 20, 60 * MIN)) return notFound(res);
  if (!safeEqual(req.params.token, gateToken(await getSetting('gate_version')))) return notFound(res);
  if (!(await loadDevice(req))) await enrollDevice(req, res, false);
  res.redirect(302, '/');
});

app.get('/setup/:token', async (req, res) => {
  if (hit(`gate:${clientIp(req)}`, 20, 60 * MIN)) return notFound(res);
  if (await isSetupDone()) return notFound(res);
  if (!safeEqual(req.params.token, setupToken())) return notFound(res);
  const dev = await loadDevice(req);
  if (dev) {
    await q('UPDATE devices SET setup_allowed = true WHERE id = $1', [dev.id]);
    forgetDevices();
  } else {
    await enrollDevice(req, res, true);
  }
  res.redirect(302, '/');
});

app.use(async (req, res, next) => {
  const dev = await loadDevice(req);
  if (!dev) return notFound(res);
  req.device = dev;
  next();
});

app.use(
  express.static(path.join(__dirname, 'public'), {
    index: 'index.html',
    dotfiles: 'ignore',
    etag: false,
    lastModified: false,
    setHeaders: (res, filePath) => {
      // Fonts never change and hold nothing sensitive; everything else is always re-fetched.
      res.setHeader('Cache-Control', filePath.endsWith('.woff2') ? 'private, max-age=31536000, immutable' : 'no-store');
    },
  }),
);

// ---------------------------------------------------------------------------
// API plumbing: CSRF guard, JSON parsing, session
// ---------------------------------------------------------------------------
const publicHost = (() => {
  try {
    return new URL(cfg.PUBLIC_URL).host;
  } catch {
    return null;
  }
})();

function csrfGuard(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  if (req.get('x-vault') !== '1') return res.status(403).json({ error: 'forbidden' });
  const origin = req.get('origin');
  if (origin) {
    let host = null;
    try {
      host = new URL(origin).host;
    } catch {
      /* ignore */
    }
    if (!host || (host !== req.get('host') && host !== publicHost)) return res.status(403).json({ error: 'forbidden' });
  }
  if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is('application/json')) {
    return res.status(415).json({ error: 'unsupported' });
  }
  next();
}

const jsonSmall = express.json({ limit: '1mb' });
const jsonBig = express.json({ limit: '40mb' });
const BIG_PATHS = new Set(['/admin/import', '/admin/rotate']);
const bodyParser = (req, res, next) => (BIG_PATHS.has(req.path) ? jsonBig : jsonSmall)(req, res, next);

async function loadSession(req, res, next) {
  req.session = null;
  const token = req.cookies[SESSION_COOKIE];
  if (token && token.length <= 100) {
    const r = await q(
      `SELECT s.token_hash, s.user_id, s.device_id, s.last_seen_at, s.expires_at,
              u.username, u.display_name, u.role
         FROM sessions s
         JOIN users u ON u.id = s.user_id AND u.status = 'active'
         JOIN user_devices ud ON ud.user_id = s.user_id AND ud.device_id = s.device_id AND ud.status = 'approved'
        WHERE s.token_hash = $1 AND s.device_id = $2`,
      [hashToken(token), req.device.id],
    );
    const s = r.rows[0];
    const now = Date.now();
    if (s && new Date(s.expires_at).getTime() > now && now - new Date(s.last_seen_at).getTime() < cfg.SESSION_IDLE_MS) {
      req.session = s;
      if (now - new Date(s.last_seen_at).getTime() > MIN) {
        await q('UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1', [s.token_hash]);
      }
    } else {
      if (s) await q('DELETE FROM sessions WHERE token_hash = $1', [s.token_hash]);
      clearCookie(res, SESSION_COOKIE);
    }
  }
  next();
}

function requireSession(req, res, next) {
  if (!req.session) return res.status(401).json({ error: 'no_session' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session) return res.status(401).json({ error: 'no_session' });
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  next();
}
const perUser = (name, limit, windowMs) => rateLimit(name, limit, windowMs, (req) => (req.session ? req.session.user_id : clientIp(req)));

const api = express.Router();

// ---------------------------------------------------------------------------
// state + first-time setup
// ---------------------------------------------------------------------------
api.get('/state', async (req, res) => {
  const done = await isSetupDone();
  const s = req.session;
  res.json({
    appName: cfg.APP_NAME,
    setupNeeded: !done,
    setupAllowed: !done && !!req.device.setup_allowed,
    device: req.device.label,
    session: s ? { id: s.user_id, username: s.username, displayName: s.display_name, role: s.role } : null,
  });
});

api.post('/setup/start', rateLimit('setup', 15, 15 * MIN), async (req, res) => {
  if ((await isSetupDone()) || !req.device.setup_allowed) throw new HttpError(404, 'not_found');
  const b = req.body || {};
  const id = v.uuid(b.userId, 'userId');
  const username = v.username(b.username);
  const displayName = v.display(b.displayName);
  const kdfSalt = v.b64(b.kdfSalt, 16, 64, 'kdfSalt');
  const kdfIter = v.iter(b.kdfIter);
  const authKey = v.authKey(b.authKey);
  const publicKey = v.publicKey(b.publicKey);
  const encPrivateKey = v.blob(b.encPrivateKey, 4096, 'encPrivateKey');
  const wrapped = v.wrap(b.wrappedVaultKey);
  const authSalt = crypto.randomBytes(16);
  const authHash = await hashAuth(authKey, authSalt);
  const totp = newTotpSecret();
  await tx(async (c) => {
    await c.query("DELETE FROM users WHERE status = 'pending_totp'");
    await c.query(
      `INSERT INTO users (id, username, display_name, role, status, kdf_salt, kdf_iter, auth_hash, auth_salt,
                          public_key, enc_private_key, totp_secret)
       VALUES ($1,$2,$3,'admin','pending_totp',$4,$5,$6,$7,$8,$9,$10)`,
      [id, username, displayName, kdfSalt, kdfIter, authHash.toString('base64'), authSalt.toString('base64'),
        publicKey, srvEnc(`privkey:${id}`, encPrivateKey), srvEnc(`totp:${id}`, totp.toString('base64'))],
    );
    await c.query('INSERT INTO vault_keys (user_id, key_version, wrapped, created_by) VALUES ($1, 1, $2, $1)', [
      id, srvEnc(`wrap:${id}:1`, wrapped),
    ]);
  });
  res.json(await totpPayload(username, totp));
});

api.post('/setup/finish', rateLimit('setup', 15, 15 * MIN), async (req, res) => {
  if ((await isSetupDone()) || !req.device.setup_allowed) throw new HttpError(404, 'not_found');
  const username = v.username(req.body?.username);
  const code = v.totp(req.body?.totp);
  const u = (await q("SELECT * FROM users WHERE username = $1 AND status = 'pending_totp' AND role = 'admin'", [username])).rows[0];
  if (!u) throw new HttpError(400, 'setup_restart');
  const step = checkTotp(totpSecretOf(u), code, Number(u.totp_last_step));
  if (step === null) throw new HttpError(400, 'bad_totp');
  await tx(async (c) => {
    const ins = await c.query("INSERT INTO settings (key, value) VALUES ('setup_done', '1') ON CONFLICT (key) DO NOTHING RETURNING key");
    if (!ins.rowCount) throw new HttpError(404, 'not_found');
    await c.query(
      "UPDATE users SET status = 'active', totp_enabled = true, totp_last_step = $2, approved_at = now(), last_login_at = now() WHERE id = $1",
      [u.id, step],
    );
    await c.query(
      `INSERT INTO user_devices (user_id, device_id, status, decided_by, decided_at, last_used_at, last_ip)
       VALUES ($1, $2, 'approved', $1, now(), now(), $3)`,
      [u.id, req.device.id, clientIp(req)],
    );
    await c.query('UPDATE devices SET setup_allowed = false WHERE id = $1', [req.device.id]);
    await createSession(c, res, u.id, req.device.id, req);
  });
  setupDone = true;
  clearSettingsCache();
  forgetDevices();
  await audit(req, 'setup_complete', { userId: u.id, username: u.username });
  res.json({ status: 'ok', ...(await keysPayload(u.id)) });
});

// ---------------------------------------------------------------------------
// login, 2FA, device approval, unlock
// ---------------------------------------------------------------------------
api.post('/auth/prelogin', rateLimit('prelogin', 40, 15 * MIN), async (req, res) => {
  const username = v.usernameLoose(req.body?.username);
  if (username) {
    const u = (await q("SELECT kdf_salt, kdf_iter FROM users WHERE username = $1 AND status IN ('active','pending_approval')", [username])).rows[0];
    if (u) return res.json({ kdfSalt: u.kdf_salt, kdfIter: u.kdf_iter });
  }
  // Unknown users get a stable fake salt, so nobody can test which usernames exist.
  res.json({ kdfSalt: fakeSalt(username || '-'), kdfIter: cfg.KDF_ITER_DEFAULT });
});

async function finishLogin(req, res, u, autoApproveDevice) {
  if (u.status === 'pending_approval') {
    await audit(req, 'login_waiting_approval', { userId: u.id, username: u.username });
    return res.json({ status: 'pending_approval', fingerprint: fingerprint(u.public_key) });
  }
  const ud = (await q('SELECT status FROM user_devices WHERE user_id = $1 AND device_id = $2', [u.id, req.device.id])).rows[0];
  if (!ud || ud.status !== 'approved') {
    if (ud && ud.status === 'rejected') {
      await audit(req, 'login_device_blocked', { userId: u.id, username: u.username });
      throw new HttpError(403, 'device_blocked');
    }
    if (autoApproveDevice) {
      await q(
        `INSERT INTO user_devices (user_id, device_id, status, decided_by, decided_at) VALUES ($1, $2, 'approved', $1, now())
         ON CONFLICT (user_id, device_id) DO UPDATE SET status = 'approved', decided_by = $1, decided_at = now()`,
        [u.id, req.device.id],
      );
      await audit(req, 'device_recovery_approved', { userId: u.id, username: u.username });
    } else {
      await q(
        `INSERT INTO user_devices (user_id, device_id, status, last_ip) VALUES ($1, $2, 'pending', $3)
         ON CONFLICT (user_id, device_id) DO UPDATE SET requested_at = now(), last_ip = $3`,
        [u.id, req.device.id, clientIp(req)],
      );
      await audit(req, 'device_pending', { userId: u.id, username: u.username });
      return res.json({ status: 'device_pending', device: req.device.label });
    }
  }
  await createSession(null, res, u.id, req.device.id, req);
  await q('UPDATE users SET last_login_at = now() WHERE id = $1', [u.id]);
  await q('UPDATE user_devices SET last_used_at = now(), last_ip = $3 WHERE user_id = $1 AND device_id = $2', [u.id, req.device.id, clientIp(req)]);
  await audit(req, 'login_ok', { userId: u.id, username: u.username });
  res.json({ status: 'ok', ...(await keysPayload(u.id)) });
}

api.post('/auth/login', rateLimit('login', 12, 15 * MIN), async (req, res) => {
  const b = req.body || {};
  const username = v.usernameLoose(b.username);
  const authKey = v.isAuthKey(b.authKey) ? b.authKey : null;
  const code = String(b.totp ?? '').replace(/\s+/g, '');
  const u = username ? (await q('SELECT * FROM users WHERE username = $1', [username])).rows[0] : null;
  if (!u || !authKey || !['active', 'pending_approval'].includes(u.status)) {
    await dummyAuth();
    await audit(req, 'login_fail', { username: username || String(b.username ?? '').slice(0, 40), details: { reason: 'unknown_user' } });
    throw new HttpError(401, 'bad_credentials');
  }
  if (u.locked_until && new Date(u.locked_until).getTime() > Date.now()) {
    await audit(req, 'login_while_locked', { userId: u.id, username: u.username });
    throw new HttpError(423, 'locked', { minutes: Math.ceil((new Date(u.locked_until).getTime() - Date.now()) / MIN) });
  }
  const passOk = await verifyAuth(u, authKey);
  const recovery = !!cfg.RECOVERY_USER && cfg.RECOVERY_USER === u.username;
  const needTotp = u.totp_enabled && !recovery;
  const step = passOk && needTotp ? checkTotp(totpSecretOf(u), code, Number(u.totp_last_step)) : null;
  if (!passOk || (needTotp && step === null)) {
    await registerFailure(req, u, passOk ? 'bad_totp' : 'bad_password');
    throw new HttpError(401, 'bad_credentials');
  }
  await q('UPDATE users SET failed_logins = 0, locked_until = NULL, totp_last_step = GREATEST(totp_last_step, $2) WHERE id = $1', [u.id, step ?? 0]);
  if (!needTotp) {
    // 2FA was reset by an admin, or RECOVERY_USER is set: enrol a new authenticator first.
    const secret = newTotpSecret();
    await q('UPDATE users SET totp_pending = $2 WHERE id = $1', [u.id, srvEnc(`totp-pending:${u.id}`, secret.toString('base64'))]);
    if (recovery) await audit(req, 'recovery_login', { userId: u.id, username: u.username });
    const ticket = newTicket({ userId: u.id, deviceId: req.device.id, recovery });
    return res.json({ status: 'totp_setup', ticket, ...(await totpPayload(u.username, secret)) });
  }
  await finishLogin(req, res, u, false);
});

api.post('/auth/totp-setup', rateLimit('login', 12, 15 * MIN), async (req, res) => {
  const t = getTicket(req.body?.ticket);
  if (!t || t.deviceId !== req.device.id) throw new HttpError(400, 'ticket_expired');
  const code = v.totp(req.body?.totp);
  const u = (await q('SELECT * FROM users WHERE id = $1', [t.userId])).rows[0];
  if (!u || !u.totp_pending) throw new HttpError(400, 'ticket_expired');
  const secret = Buffer.from(srvDec(`totp-pending:${u.id}`, u.totp_pending), 'base64');
  const step = checkTotp(secret, code, 0);
  if (step === null) {
    t.tries += 1;
    if (t.tries >= 5) tickets.delete(req.body.ticket);
    throw new HttpError(400, 'bad_totp');
  }
  tickets.delete(req.body.ticket);
  await q('UPDATE users SET totp_secret = $2, totp_pending = NULL, totp_enabled = true, totp_last_step = $3 WHERE id = $1', [
    u.id, srvEnc(`totp:${u.id}`, secret.toString('base64')), step,
  ]);
  await audit(req, 'totp_enrolled', { userId: u.id, username: u.username });
  const fresh = (await q('SELECT * FROM users WHERE id = $1', [u.id])).rows[0];
  await finishLogin(req, res, fresh, t.recovery);
});

api.post('/auth/unlock', requireSession, rateLimit('unlock', 12, 15 * MIN), async (req, res) => {
  const u = (await q('SELECT * FROM users WHERE id = $1', [req.session.user_id])).rows[0];
  if (u.locked_until && new Date(u.locked_until).getTime() > Date.now()) {
    await q('DELETE FROM sessions WHERE user_id = $1', [u.id]);
    clearCookie(res, SESSION_COOKIE);
    throw new HttpError(423, 'locked', { minutes: Math.ceil((new Date(u.locked_until).getTime() - Date.now()) / MIN) });
  }
  const ok = v.isAuthKey(req.body?.authKey) && (await verifyAuth(u, req.body.authKey));
  if (!ok) {
    const locked = await registerFailure(req, u, 'unlock_bad_password');
    if (locked) {
      await q('DELETE FROM sessions WHERE user_id = $1', [u.id]);
      clearCookie(res, SESSION_COOKIE);
    }
    throw new HttpError(401, 'bad_password');
  }
  await q('UPDATE users SET failed_logins = 0 WHERE id = $1', [u.id]);
  await audit(req, 'unlock_ok');
  res.json({ status: 'ok', ...(await keysPayload(u.id)) });
});

api.post('/auth/ping', requireSession, (req, res) => res.json({ ok: true }));

api.post('/auth/logout', async (req, res) => {
  if (req.session) {
    await q('DELETE FROM sessions WHERE token_hash = $1', [req.session.token_hash]);
    await audit(req, 'logout');
  }
  clearCookie(res, SESSION_COOKIE);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// joining the team by invite
// ---------------------------------------------------------------------------
async function findInvite(code) {
  if (typeof code !== 'string' || code.length < 20 || code.length > 80) return null;
  const r = await q('SELECT * FROM invites WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()', [hashToken(code)]);
  return r.rows[0] || null;
}

api.post('/register/info', rateLimit('register', 30, 15 * MIN), async (req, res) => {
  const inv = await findInvite(req.body?.inviteCode);
  if (!inv) throw new HttpError(404, 'invite_invalid');
  res.json({ username: inv.username, displayName: inv.display_name, role: inv.role });
});

api.post('/register/start', rateLimit('register', 30, 15 * MIN), async (req, res) => {
  const inv = await findInvite(req.body?.inviteCode);
  if (!inv) throw new HttpError(404, 'invite_invalid');
  const b = req.body;
  const id = v.uuid(b.userId, 'userId');
  const kdfSalt = v.b64(b.kdfSalt, 16, 64, 'kdfSalt');
  const kdfIter = v.iter(b.kdfIter);
  const authKey = v.authKey(b.authKey);
  const publicKey = v.publicKey(b.publicKey);
  const encPrivateKey = v.blob(b.encPrivateKey, 4096, 'encPrivateKey');
  const authSalt = crypto.randomBytes(16);
  const authHash = await hashAuth(authKey, authSalt);
  const totp = newTotpSecret();
  await tx(async (c) => {
    if (inv.user_id) await c.query("DELETE FROM users WHERE id = $1 AND status = 'pending_totp'", [inv.user_id]);
    const taken = await c.query('SELECT 1 FROM users WHERE username = $1', [inv.username]);
    if (taken.rowCount) throw new HttpError(409, 'username_taken');
    await c.query(
      `INSERT INTO users (id, username, display_name, role, status, kdf_salt, kdf_iter, auth_hash, auth_salt,
                          public_key, enc_private_key, totp_secret)
       VALUES ($1,$2,$3,$4,'pending_totp',$5,$6,$7,$8,$9,$10,$11)`,
      [id, inv.username, inv.display_name, inv.role, kdfSalt, kdfIter, authHash.toString('base64'), authSalt.toString('base64'),
        publicKey, srvEnc(`privkey:${id}`, encPrivateKey), srvEnc(`totp:${id}`, totp.toString('base64'))],
    );
    await c.query('UPDATE invites SET user_id = $2 WHERE id = $1', [inv.id, id]);
  });
  res.json(await totpPayload(inv.username, totp));
});

api.post('/register/finish', rateLimit('register', 30, 15 * MIN), async (req, res) => {
  const inv = await findInvite(req.body?.inviteCode);
  if (!inv || !inv.user_id) throw new HttpError(404, 'invite_invalid');
  const code = v.totp(req.body?.totp);
  const u = (await q("SELECT * FROM users WHERE id = $1 AND status = 'pending_totp'", [inv.user_id])).rows[0];
  if (!u) throw new HttpError(404, 'invite_invalid');
  const step = checkTotp(totpSecretOf(u), code, 0);
  if (step === null) throw new HttpError(400, 'bad_totp');
  await tx(async (c) => {
    await c.query("UPDATE users SET status = 'pending_approval', totp_enabled = true, totp_last_step = $2 WHERE id = $1", [u.id, step]);
    await c.query('UPDATE invites SET used_at = now() WHERE id = $1', [inv.id]);
    await c.query(
      `INSERT INTO user_devices (user_id, device_id, status, last_ip) VALUES ($1, $2, 'pending', $3)
       ON CONFLICT (user_id, device_id) DO NOTHING`,
      [u.id, req.device.id, clientIp(req)],
    );
  });
  await audit(req, 'member_registered', { userId: u.id, username: u.username });
  res.json({ status: 'pending_approval', fingerprint: fingerprint(u.public_key) });
});

// ---------------------------------------------------------------------------
// credentials
// ---------------------------------------------------------------------------
api.get('/entries', requireSession, async (req, res) => {
  const kv = Number(await getSetting('key_version'));
  const rows = (await q(
    'SELECT id, key_version, meta_ct, created_by, updated_by, created_at, updated_at FROM entries WHERE deleted_at IS NULL ORDER BY updated_at DESC',
  )).rows;
  const users = (await q('SELECT id, display_name FROM users')).rows;
  res.json({
    keyVersion: kv,
    entries: rows.map((r) => ({
      id: r.id,
      keyVersion: r.key_version,
      meta: srvDec(`entry-meta:${r.id}`, r.meta_ct),
      createdBy: r.created_by,
      updatedBy: r.updated_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
    users: Object.fromEntries(users.map((u) => [u.id, u.display_name])),
  });
});

// Passwords are fetched one at a time, on demand, so every view/copy is logged by the server.
api.post('/entries/:id/secret', requireSession, async (req, res) => {
  const wait = hit(`reveal:${req.session.user_id}`, 80, 15 * MIN);
  if (wait) {
    if (!hit(`reveal-audit:${req.session.user_id}`, 1, 15 * MIN)) await audit(req, 'reveal_limit_hit');
    res.setHeader('Retry-After', String(wait));
    return res.status(429).json({ error: 'rate_limited', retryAfter: wait });
  }
  const id = v.uuid(req.params.id);
  const reason = ['view', 'copy', 'edit'].includes(req.body?.reason) ? req.body.reason : 'view';
  const r = (await q('SELECT key_version, secret_ct FROM entries WHERE id = $1 AND deleted_at IS NULL', [id])).rows[0];
  if (!r) throw new HttpError(404, 'not_found');
  await audit(req, `secret_${reason}`, { entryId: id });
  res.json({ keyVersion: r.key_version, secret: srvDec(`entry-secret:${id}`, r.secret_ct) });
});

api.post('/entries', requireSession, perUser('write', 200, 15 * MIN), async (req, res) => {
  const b = req.body || {};
  const id = v.uuid(b.id);
  const kv = v.int(b.keyVersion, 1, 1e9, 'keyVersion');
  const meta = v.blob(b.meta, META_MAX, 'meta');
  const secret = v.blob(b.secret, SECRET_MAX, 'secret');
  await tx(async (c) => {
    const vault = await lockVault(c);
    if (vault.keyVersion !== kv) throw new HttpError(409, 'key_changed');
    const ins = await c.query(
      `INSERT INTO entries (id, key_version, meta_ct, secret_ct, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$5)
       ON CONFLICT (id) DO NOTHING`,
      [id, kv, srvEnc(`entry-meta:${id}`, meta), srvEnc(`entry-secret:${id}`, secret), req.session.user_id],
    );
    if (!ins.rowCount) throw new HttpError(409, 'exists');
    await bumpRevision(c);
  });
  await audit(req, 'entry_create', { entryId: id });
  res.json({ ok: true });
});

api.put('/entries/:id', requireSession, perUser('write', 200, 15 * MIN), async (req, res) => {
  const id = v.uuid(req.params.id);
  const b = req.body || {};
  const kv = v.int(b.keyVersion, 1, 1e9, 'keyVersion');
  const meta = v.blob(b.meta, META_MAX, 'meta');
  const secret = v.blob(b.secret, SECRET_MAX, 'secret');
  await tx(async (c) => {
    const vault = await lockVault(c);
    if (vault.keyVersion !== kv) throw new HttpError(409, 'key_changed');
    const up = await c.query(
      `UPDATE entries SET key_version = $2, meta_ct = $3, secret_ct = $4, updated_by = $5, updated_at = now()
        WHERE id = $1 AND deleted_at IS NULL`,
      [id, kv, srvEnc(`entry-meta:${id}`, meta), srvEnc(`entry-secret:${id}`, secret), req.session.user_id],
    );
    if (!up.rowCount) throw new HttpError(404, 'not_found');
    await bumpRevision(c);
  });
  await audit(req, 'entry_update', { entryId: id });
  res.json({ ok: true });
});

api.delete('/entries/:id', requireSession, perUser('write', 200, 15 * MIN), async (req, res) => {
  const id = v.uuid(req.params.id);
  await tx(async (c) => {
    await lockVault(c);
    const up = await c.query('UPDATE entries SET deleted_at = now(), deleted_by = $2 WHERE id = $1 AND deleted_at IS NULL', [id, req.session.user_id]);
    if (!up.rowCount) throw new HttpError(404, 'not_found');
    await bumpRevision(c);
  });
  await audit(req, 'entry_delete', { entryId: id });
  res.json({ ok: true });
});

api.post('/account/password', requireSession, rateLimit('unlock', 12, 15 * MIN), async (req, res) => {
  const b = req.body || {};
  const u = (await q('SELECT * FROM users WHERE id = $1', [req.session.user_id])).rows[0];
  if (!v.isAuthKey(b.currentAuthKey) || !(await verifyAuth(u, b.currentAuthKey))) {
    await registerFailure(req, u, 'password_change_bad_current');
    throw new HttpError(401, 'bad_password');
  }
  const kdfSalt = v.b64(b.kdfSalt, 16, 64, 'kdfSalt');
  const kdfIter = v.iter(b.kdfIter);
  const authKey = v.authKey(b.authKey);
  const encPrivateKey = v.blob(b.encPrivateKey, 4096, 'encPrivateKey');
  const authSalt = crypto.randomBytes(16);
  const authHash = await hashAuth(authKey, authSalt);
  await q(
    'UPDATE users SET kdf_salt = $2, kdf_iter = $3, auth_hash = $4, auth_salt = $5, enc_private_key = $6, failed_logins = 0 WHERE id = $1',
    [u.id, kdfSalt, kdfIter, authHash.toString('base64'), authSalt.toString('base64'), srvEnc(`privkey:${u.id}`, encPrivateKey)],
  );
  await q('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [u.id, req.session.token_hash]);
  await audit(req, 'password_change');
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// administration
// ---------------------------------------------------------------------------
api.get('/admin/status', requireAdmin, async (req, res) => {
  const r = await q(`SELECT
      (SELECT count(*) FROM entries WHERE deleted_at IS NULL)::int AS entries,
      (SELECT count(*) FROM entries WHERE deleted_at IS NOT NULL)::int AS trashed,
      (SELECT count(*) FROM users WHERE status = 'active')::int AS members,
      (SELECT count(*) FROM users WHERE status = 'pending_approval')::int AS "pendingMembers",
      (SELECT count(*) FROM user_devices ud
         JOIN devices d ON d.id = ud.device_id
         JOIN users u ON u.id = ud.user_id AND u.status = 'active'
        WHERE ud.status = 'pending' AND NOT d.revoked)::int AS "pendingDevices"`);
  for (const kind of Object.keys(integ)) {
    const slot = integ[kind];
    if (slot.token && (!slot.data || Date.now() - slot.at > 6 * 60 * MIN)) refreshIntegration(kind).catch(() => {});
  }
  res.json({
    ...r.rows[0],
    dbPlan: cfg.DB_PLAN,
    dbCreatedAt: await getSetting('db_created_at'),
    lastBackupAt: await getSetting('last_backup_at'),
    recoveryUser: cfg.RECOVERY_USER,
    renewals: upcoming({ hostinger: integ.hostinger.data, render: integ.render.data }, 30).slice(0, 20),
    renewalsPending: Object.values(integ).some((slot) => slot.token && !slot.data),
  });
});

api.get('/admin/renewals', requireAdmin, async (req, res) => {
  const force = req.query.refresh === '1';
  if (force) {
    const wait = hit(`renewals:${req.session.user_id}`, 10, 15 * MIN);
    if (wait) throw new HttpError(429, 'rate_limited', { retryAfter: wait });
  }
  await Promise.all([refreshIntegration('hostinger', force), refreshIntegration('render', force)]);
  if (force) await audit(req, 'renewals_refresh');
  res.json({ windowDays: 30, hostinger: integrationView('hostinger'), render: integrationView('render') });
});

api.get('/admin/users', requireAdmin, async (req, res) => {
  const kv = Number(await getSetting('key_version'));
  const users = (await q(
    `SELECT u.*, EXISTS (SELECT 1 FROM vault_keys k WHERE k.user_id = u.id AND k.key_version = $1) AS has_key
       FROM users u WHERE u.status <> 'pending_totp' ORDER BY (u.status = 'pending_approval') DESC, u.created_at`,
    [kv],
  )).rows;
  const invites = (await q(
    'SELECT id, username, display_name, role, created_at, expires_at FROM invites WHERE used_at IS NULL AND expires_at > now() ORDER BY created_at DESC',
  )).rows;
  res.json({
    keyVersion: kv,
    users: users.map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.display_name,
      role: u.role,
      status: u.status,
      publicKey: u.public_key,
      fingerprint: fingerprint(u.public_key),
      totpEnabled: u.totp_enabled,
      locked: !!(u.locked_until && new Date(u.locked_until).getTime() > Date.now()),
      createdAt: u.created_at,
      lastLoginAt: u.last_login_at,
      hasKey: u.has_key,
    })),
    invites: invites.map((i) => ({ id: i.id, username: i.username, displayName: i.display_name, role: i.role, createdAt: i.created_at, expiresAt: i.expires_at })),
  });
});

api.post('/admin/invites', requireAdmin, async (req, res) => {
  const username = v.username(req.body?.username);
  const displayName = v.display(req.body?.displayName);
  const role = v.role(req.body?.role);
  const exists = await q(
    'SELECT 1 FROM users WHERE username = $1 UNION ALL SELECT 1 FROM invites WHERE username = $1 AND used_at IS NULL AND expires_at > now()',
    [username],
  );
  if (exists.rowCount) throw new HttpError(409, 'username_taken');
  const code = randomToken(24);
  const expires = new Date(Date.now() + cfg.INVITE_TTL_MS);
  await q('INSERT INTO invites (id, code_hash, username, display_name, role, created_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
    crypto.randomUUID(), hashToken(code), username, displayName, role, req.session.user_id, expires,
  ]);
  await audit(req, 'invite_create', { details: { username, role } });
  res.json({ link: `${await gateLink(req)}#invite=${code}`, expiresAt: expires });
});

api.delete('/admin/invites/:id', requireAdmin, async (req, res) => {
  const id = v.uuid(req.params.id);
  const r = await q('DELETE FROM invites WHERE id = $1 AND used_at IS NULL RETURNING username, user_id', [id]);
  if (!r.rowCount) throw new HttpError(404, 'not_found');
  if (r.rows[0].user_id) await q("DELETE FROM users WHERE id = $1 AND status = 'pending_totp'", [r.rows[0].user_id]);
  await audit(req, 'invite_cancel', { details: { username: r.rows[0].username } });
  res.json({ ok: true });
});

api.post('/admin/users/:id/approve', requireAdmin, async (req, res) => {
  const id = v.uuid(req.params.id);
  const kv = v.int(req.body?.keyVersion, 1, 1e9, 'keyVersion');
  const wrapped = v.wrap(req.body?.wrapped);
  let username = null;
  await tx(async (c) => {
    const vault = await lockVault(c);
    if (vault.keyVersion !== kv) throw new HttpError(409, 'key_changed');
    const u = (await c.query("SELECT username FROM users WHERE id = $1 AND status = 'pending_approval' FOR UPDATE", [id])).rows[0];
    if (!u) throw new HttpError(404, 'not_found');
    username = u.username;
    await c.query(
      `INSERT INTO vault_keys (user_id, key_version, wrapped, created_by) VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id, key_version) DO UPDATE SET wrapped = EXCLUDED.wrapped`,
      [id, kv, srvEnc(`wrap:${id}:${kv}`, wrapped), req.session.user_id],
    );
    await c.query("UPDATE users SET status = 'active', approved_by = $2, approved_at = now() WHERE id = $1", [id, req.session.user_id]);
    await c.query(
      "UPDATE user_devices SET status = 'approved', decided_by = $2, decided_at = now() WHERE user_id = $1 AND status = 'pending'",
      [id, req.session.user_id],
    );
  });
  await audit(req, 'member_approve', { details: { username } });
  res.json({ ok: true });
});

// Only accounts that never received the vault key can be deleted directly.
// Active members are removed through /admin/rotate, which also replaces the vault key.
api.delete('/admin/users/:id', requireAdmin, async (req, res) => {
  const id = v.uuid(req.params.id);
  const r = await q("DELETE FROM users WHERE id = $1 AND status IN ('pending_totp','pending_approval') RETURNING username", [id]);
  if (!r.rowCount) throw new HttpError(409, 'use_rotation');
  await audit(req, 'member_reject', { details: { username: r.rows[0].username } });
  res.json({ ok: true });
});

api.post('/admin/users/:id/role', requireAdmin, async (req, res) => {
  const id = v.uuid(req.params.id);
  const role = v.role(req.body?.role);
  let username = null;
  await tx(async (c) => {
    const u = (await c.query("SELECT username, role FROM users WHERE id = $1 AND status = 'active' FOR UPDATE", [id])).rows[0];
    if (!u) throw new HttpError(404, 'not_found');
    username = u.username;
    if (u.role === 'admin' && role === 'member') {
      const n = (await c.query("SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND status = 'active'")).rows[0].n;
      if (n <= 1) throw new HttpError(409, 'last_admin');
    }
    await c.query('UPDATE users SET role = $2 WHERE id = $1', [id, role]);
  });
  await audit(req, 'role_change', { details: { username, role } });
  res.json({ ok: true });
});

api.post('/admin/users/:id/reset-totp', requireAdmin, async (req, res) => {
  const id = v.uuid(req.params.id);
  if (id === req.session.user_id) throw new HttpError(409, 'not_self');
  const r = await q(
    "UPDATE users SET totp_enabled = false, totp_secret = NULL, totp_pending = NULL WHERE id = $1 AND status = 'active' RETURNING username",
    [id],
  );
  if (!r.rowCount) throw new HttpError(404, 'not_found');
  await q('DELETE FROM sessions WHERE user_id = $1', [id]);
  await audit(req, 'totp_reset', { details: { username: r.rows[0].username } });
  res.json({ ok: true });
});

api.post('/admin/users/:id/unlock', requireAdmin, async (req, res) => {
  const id = v.uuid(req.params.id);
  const r = await q('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1 RETURNING username', [id]);
  if (!r.rowCount) throw new HttpError(404, 'not_found');
  await audit(req, 'account_unlock', { details: { username: r.rows[0].username } });
  res.json({ ok: true });
});

// Key rotation: the admin's browser re-encrypts every entry with a brand-new vault key and
// wraps it for every remaining member. Removed members are left with a key that opens nothing.
api.get('/admin/rotation', requireAdmin, async (req, res) => {
  const s = (await q("SELECT key, value FROM settings WHERE key IN ('key_version','vault_revision')")).rows;
  const m = Object.fromEntries(s.map((x) => [x.key, x.value]));
  const entries = (await q('SELECT id, key_version, meta_ct, secret_ct FROM entries')).rows;
  const users = (await q("SELECT id, public_key FROM users WHERE status = 'active'")).rows;
  await audit(req, 'rotation_prepare', { details: { entries: entries.length } });
  res.json({
    keyVersion: Number(m.key_version),
    revision: Number(m.vault_revision),
    entries: entries.map((e) => ({
      id: e.id,
      keyVersion: e.key_version,
      meta: srvDec(`entry-meta:${e.id}`, e.meta_ct),
      secret: srvDec(`entry-secret:${e.id}`, e.secret_ct),
    })),
    users: users.map((u) => ({ id: u.id, publicKey: u.public_key })),
  });
});

api.post('/admin/rotate', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const from = v.int(b.fromVersion, 1, 1e9, 'fromVersion');
  const to = v.int(b.newVersion, 2, 1e9, 'newVersion');
  if (to !== from + 1) throw new HttpError(400, 'invalid', { field: 'newVersion' });
  const revision = v.int(b.revision, 0, Number.MAX_SAFE_INTEGER, 'revision');
  const removeId = b.removeUserId ? v.uuid(b.removeUserId, 'removeUserId') : null;
  if (removeId === req.session.user_id) throw new HttpError(409, 'not_self');
  if (!Array.isArray(b.entries) || !Array.isArray(b.wraps)) throw new HttpError(400, 'invalid');
  const entries = b.entries.map((e) => ({ id: v.uuid(e?.id), meta: v.blob(e?.meta, META_MAX, 'meta'), secret: v.blob(e?.secret, SECRET_MAX, 'secret') }));
  const wraps = b.wraps.map((w) => ({ userId: v.uuid(w?.userId, 'userId'), wrapped: v.wrap(w?.wrapped) }));
  let removedName = null;
  await tx(async (c) => {
    const vault = await lockVault(c);
    if (vault.keyVersion !== from || vault.revision !== revision) throw new HttpError(409, 'vault_changed');
    const ids = (await c.query('SELECT id FROM entries')).rows.map((r) => r.id).sort();
    const sent = entries.map((e) => e.id).sort();
    if (ids.length !== sent.length || ids.some((id, i) => id !== sent[i])) throw new HttpError(409, 'vault_changed');
    const active = (await c.query("SELECT id, username, role FROM users WHERE status = 'active' FOR UPDATE")).rows;
    if (removeId) {
      const target = active.find((u) => u.id === removeId);
      if (!target) throw new HttpError(404, 'not_found');
      if (target.role === 'admin' && active.filter((u) => u.role === 'admin').length <= 1) throw new HttpError(409, 'last_admin');
      removedName = target.username;
    }
    const remaining = active.filter((u) => u.id !== removeId).map((u) => u.id).sort();
    const wrapIds = wraps.map((w) => w.userId).sort();
    if (remaining.length !== wrapIds.length || remaining.some((id, i) => id !== wrapIds[i])) throw new HttpError(409, 'vault_changed');
    for (const e of entries) {
      await c.query('UPDATE entries SET key_version = $2, meta_ct = $3, secret_ct = $4 WHERE id = $1', [
        e.id, to, srvEnc(`entry-meta:${e.id}`, e.meta), srvEnc(`entry-secret:${e.id}`, e.secret),
      ]);
    }
    for (const w of wraps) {
      await c.query('INSERT INTO vault_keys (user_id, key_version, wrapped, created_by) VALUES ($1,$2,$3,$4)', [
        w.userId, to, srvEnc(`wrap:${w.userId}:${to}`, w.wrapped), req.session.user_id,
      ]);
    }
    await c.query('DELETE FROM vault_keys WHERE key_version <> $1', [to]);
    await c.query("UPDATE settings SET value = $1 WHERE key = 'key_version'", [String(to)]);
    await bumpRevision(c);
    if (removeId) await c.query('DELETE FROM users WHERE id = $1', [removeId]);
  });
  clearSettingsCache();
  await audit(req, removeId ? 'member_remove' : 'key_rotate', { details: { username: removedName, keyVersion: to, entries: entries.length } });
  res.json({ ok: true, keyVersion: to });
});

api.get('/admin/devices', requireAdmin, async (req, res) => {
  const r = await q(
    `SELECT ud.user_id, ud.device_id, ud.status, ud.requested_at, ud.last_used_at, ud.last_ip,
            u.username, u.display_name, d.label
       FROM user_devices ud
       JOIN users u ON u.id = ud.user_id
       JOIN devices d ON d.id = ud.device_id
      WHERE NOT d.revoked AND ud.status <> 'rejected' AND u.status = 'active'
      ORDER BY (ud.status = 'pending') DESC, COALESCE(ud.last_used_at, ud.requested_at) DESC`,
  );
  res.json({
    currentDeviceId: req.device.id,
    devices: r.rows.map((d) => ({
      userId: d.user_id,
      deviceId: d.device_id,
      status: d.status,
      requestedAt: d.requested_at,
      lastUsedAt: d.last_used_at,
      lastIp: d.last_ip,
      username: d.username,
      displayName: d.display_name,
      label: d.label,
    })),
  });
});

api.post('/admin/devices/approve', requireAdmin, async (req, res) => {
  const userId = v.uuid(req.body?.userId, 'userId');
  const deviceId = v.uuid(req.body?.deviceId, 'deviceId');
  const r = await q(
    `UPDATE user_devices ud SET status = 'approved', decided_by = $3, decided_at = now()
       FROM users u, devices d
      WHERE ud.user_id = $1 AND ud.device_id = $2 AND ud.status = 'pending' AND u.id = ud.user_id AND d.id = ud.device_id
      RETURNING u.username, d.label`,
    [userId, deviceId, req.session.user_id],
  );
  if (!r.rowCount) throw new HttpError(404, 'not_found');
  await audit(req, 'device_approve', { details: { username: r.rows[0].username, device: r.rows[0].label } });
  res.json({ ok: true });
});

api.post('/admin/devices/block', requireAdmin, async (req, res) => {
  const deviceId = v.uuid(req.body?.deviceId, 'deviceId');
  if (deviceId === req.device.id) throw new HttpError(409, 'not_self');
  let label = null;
  await tx(async (c) => {
    const d = (await c.query('UPDATE devices SET revoked = true WHERE id = $1 RETURNING label', [deviceId])).rows[0];
    if (!d) throw new HttpError(404, 'not_found');
    label = d.label;
    await c.query("UPDATE user_devices SET status = 'rejected', decided_by = $2, decided_at = now() WHERE device_id = $1", [deviceId, req.session.user_id]);
    await c.query('DELETE FROM sessions WHERE device_id = $1', [deviceId]);
  });
  forgetDevices();
  await audit(req, 'device_block', { details: { device: label } });
  res.json({ ok: true });
});

api.get('/admin/audit', requireAdmin, async (req, res) => {
  const before = Number.parseInt(String(req.query.before || ''), 10);
  const limit = 100;
  const r = Number.isFinite(before) && before > 0
    ? await q('SELECT * FROM audit WHERE id < $1 ORDER BY id DESC LIMIT $2', [before, limit])
    : await q('SELECT * FROM audit ORDER BY id DESC LIMIT $1', [limit]);
  res.json({
    items: r.rows.map((a) => ({
      id: Number(a.id), at: a.at, userId: a.user_id, username: a.username, action: a.action,
      entryId: a.entry_id, ip: a.ip, device: a.device, details: a.details,
    })),
    hasMore: r.rows.length === limit,
  });
});

api.get('/admin/gate', requireAdmin, async (req, res) => {
  res.json({ link: await gateLink(req) });
});

api.post('/admin/gate/rotate', requireAdmin, async (req, res) => {
  const cur = Number(await getSetting('gate_version')) || 1;
  await setSetting('gate_version', cur + 1);
  await audit(req, 'gate_rotate');
  res.json({ link: await gateLink(req) });
});

api.get('/admin/export', requireAdmin, async (req, res) => {
  const rows = (await q('SELECT id, key_version, meta_ct, secret_ct, created_at, updated_at FROM entries WHERE deleted_at IS NULL ORDER BY created_at')).rows;
  await setSetting('last_backup_at', new Date().toISOString());
  await audit(req, 'backup_export', { details: { count: rows.length } });
  res.json({
    entries: rows.map((r) => ({
      id: r.id,
      keyVersion: r.key_version,
      meta: srvDec(`entry-meta:${r.id}`, r.meta_ct),
      secret: srvDec(`entry-secret:${r.id}`, r.secret_ct),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
  });
});

api.post('/admin/import', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const kv = v.int(b.keyVersion, 1, 1e9, 'keyVersion');
  if (!Array.isArray(b.entries) || b.entries.length < 1 || b.entries.length > 2000) throw new HttpError(400, 'invalid', { field: 'entries' });
  const items = b.entries.map((e) => ({ id: v.uuid(e?.id), meta: v.blob(e?.meta, META_MAX, 'meta'), secret: v.blob(e?.secret, SECRET_MAX, 'secret') }));
  let added = 0;
  await tx(async (c) => {
    const vault = await lockVault(c);
    if (vault.keyVersion !== kv) throw new HttpError(409, 'key_changed');
    for (const it of items) {
      const r = await c.query(
        `INSERT INTO entries (id, key_version, meta_ct, secret_ct, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$5)
         ON CONFLICT (id) DO NOTHING`,
        [it.id, kv, srvEnc(`entry-meta:${it.id}`, it.meta), srvEnc(`entry-secret:${it.id}`, it.secret), req.session.user_id],
      );
      added += r.rowCount;
    }
    await bumpRevision(c);
  });
  await audit(req, 'backup_import', { details: { count: added } });
  res.json({ ok: true, added });
});

api.get('/admin/trash', requireAdmin, async (req, res) => {
  const rows = (await q('SELECT id, key_version, meta_ct, deleted_at, deleted_by FROM entries WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC')).rows;
  res.json({
    entries: rows.map((r) => ({ id: r.id, keyVersion: r.key_version, meta: srvDec(`entry-meta:${r.id}`, r.meta_ct), deletedAt: r.deleted_at, deletedBy: r.deleted_by })),
  });
});

api.post('/admin/trash/:id/restore', requireAdmin, async (req, res) => {
  const id = v.uuid(req.params.id);
  await tx(async (c) => {
    await lockVault(c);
    const up = await c.query(
      'UPDATE entries SET deleted_at = NULL, deleted_by = NULL, updated_at = now(), updated_by = $2 WHERE id = $1 AND deleted_at IS NOT NULL',
      [id, req.session.user_id],
    );
    if (!up.rowCount) throw new HttpError(404, 'not_found');
    await bumpRevision(c);
  });
  await audit(req, 'entry_restore', { entryId: id });
  res.json({ ok: true });
});

api.delete('/admin/trash/:id', requireAdmin, async (req, res) => {
  const id = v.uuid(req.params.id);
  await tx(async (c) => {
    await lockVault(c);
    const del = await c.query('DELETE FROM entries WHERE id = $1 AND deleted_at IS NOT NULL', [id]);
    if (!del.rowCount) throw new HttpError(404, 'not_found');
    await bumpRevision(c);
  });
  await audit(req, 'entry_purge', { entryId: id });
  res.json({ ok: true });
});

app.use('/api', csrfGuard, bodyParser, loadSession, api);
app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));
app.use((req, res) => notFound(res));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) return;
  if (!req.device) return notFound(res);
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.code, ...err.extra });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'too_large' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid' });
  console.error('request error:', err && err.stack ? err.stack : err);
  res.status(500).json({ error: 'server_error' });
});

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
async function housekeeping() {
  try {
    await q("DELETE FROM sessions WHERE expires_at < now() OR last_seen_at < now() - interval '1 day'");
    await q("DELETE FROM users WHERE status = 'pending_totp' AND created_at < now() - interval '1 day'");
    await q("DELETE FROM invites WHERE expires_at < now() - interval '30 days'");
    await q(
      `DELETE FROM devices d WHERE NOT d.setup_allowed AND d.created_at < now() - interval '30 days'
         AND NOT EXISTS (SELECT 1 FROM user_devices ud WHERE ud.device_id = d.id)`,
    );
  } catch (e) {
    console.error('housekeeping failed:', e.message);
  }
}

async function main() {
  initPool(cfg.DATABASE_URL);
  await migrate();
  const check = keyCheck();
  const stored = await getSetting('server_key_check');
  if (!stored) {
    await setSetting('server_key_check', check);
  } else if (!safeEqual(stored, check)) {
    console.error('FATAL: MASTER_SECRET does not match this database. Restore the original MASTER_SECRET value; never regenerate it.');
    process.exit(1);
  }
  if (!(await isSetupDone())) {
    console.log('\n============================================================');
    console.log(' FIRST-TIME SETUP: open this link in your browser to create the first admin');
    console.log(` ${cfg.PUBLIC_URL}/setup/${setupToken()}`);
    console.log(' (the link stops working as soon as the first admin exists)');
    console.log('============================================================\n');
  }
  if (cfg.RECOVERY_USER) {
    console.warn(`WARNING: RECOVERY_USER=${cfg.RECOVERY_USER} is set. Remove it from the environment right after the recovery login.`);
  }
  await housekeeping();
  setInterval(housekeeping, 60 * MIN).unref();
  const server = app.listen(cfg.PORT, '0.0.0.0', () => console.log(`vault listening on port ${cfg.PORT}`));
  server.headersTimeout = 30_000;
  server.requestTimeout = 120_000;
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
