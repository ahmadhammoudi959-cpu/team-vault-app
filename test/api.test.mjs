// End-to-end API test: runs the real server against a throwaway Postgres database and drives it
// with the same browser crypto module the web app uses (public/js/vcrypto.js).
//   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/vault_test node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5433/vault_test';
const PORT = 3200 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = crypto.randomBytes(32).toString('base64');
process.env.MASTER_SECRET = SECRET;

const vc = await import(path.join(root, 'public/js/vcrypto.js'));
const { startMockApis } = await import(path.join(root, 'test/mock_apis.mjs'));
const sec = await import(path.join(root, 'src/sec.js'));
const ITER = 600_000;

// ---------- helpers ----------
function b32decode(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = s.replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | A.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  return Buffer.from(out);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Returns a TOTP code for a step the server hasn't seen yet (waits for the clock if needed).
class Authenticator {
  constructor(secretText) {
    this.secret = b32decode(secretText);
    this.last = 0;
  }
  async code() {
    let now = Math.floor(Date.now() / 30_000);
    let step = Math.max(this.last + 1, now - 1);
    while (step > now + 1) {
      await sleep(1000);
      now = Math.floor(Date.now() / 30_000);
    }
    this.last = step;
    return sec.hotp(this.secret, step);
  }
}

let ipCounter = 10;
class Client {
  constructor() {
    this.jar = new Map();
    this.ip = `203.0.113.${ipCounter++}`;
  }
  cookieHeader() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  store(res) {
    for (const c of res.headers.getSetCookie()) {
      const [kv, ...attrs] = c.split(';');
      const i = kv.indexOf('=');
      const k = kv.slice(0, i).trim();
      const val = kv.slice(i + 1).trim();
      const maxAge = attrs.map((a) => a.trim().toLowerCase()).find((a) => a.startsWith('max-age='));
      if (!val || (maxAge && Number(maxAge.split('=')[1]) <= 0)) this.jar.delete(k);
      else this.jar.set(k, val);
    }
  }
  async raw(method, p, { body, headers = {} } = {}) {
    const h = { 'cf-connecting-ip': this.ip, ...headers };
    if (this.jar.size) h.cookie = this.cookieHeader();
    if (body !== undefined && !h['content-type']) h['content-type'] = 'application/json';
    const res = await fetch(BASE + p, {
      method,
      headers: h,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      redirect: 'manual',
    });
    this.store(res);
    return res;
  }
  async api(method, p, body, extraHeaders = {}) {
    const res = await this.raw(method, `/api${p}`, { body, headers: { 'x-vault': '1', ...extraHeaders } });
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, data, headers: res.headers };
  }
}

async function startServer(env = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, MASTER_SECRET: SECRET, DATABASE_URL: DB, PORT: String(PORT), NODE_ENV: 'test', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const ok = await new Promise((resolve) => {
    const t = setInterval(() => {
      if (out.includes('listening')) {
        clearInterval(t);
        resolve(true);
      }
    }, 50);
    child.on('exit', () => {
      clearInterval(t);
      resolve(false);
    });
  });
  return { child, ok, log: () => out };
}

// Simulates a browser: derives keys from the master password, unlocks the vault.
async function registerKeys(password) {
  const salt = vc.newSalt();
  const { authKey, kek } = await vc.deriveFromPassword(password, salt, ITER);
  const keys = await vc.createUserKeys(kek);
  return { salt, authKey, kek, ...keys };
}

async function login(client, username, password, auth) {
  const pre = await client.api('POST', '/auth/prelogin', { username });
  const { authKey, kek } = await vc.deriveFromPassword(password, pre.data.kdfSalt, pre.data.kdfIter);
  const r = await client.api('POST', '/auth/login', { username, authKey, totp: auth ? await auth.code() : '000000' });
  return { ...r, kek };
}

async function openVault(r, kek) {
  const privateKey = await vc.openPrivateKey(kek, r.data.keys.encPrivateKey);
  const vaultKey = await vc.unwrapVaultKey(r.data.keys.wrappedVaultKey, privateKey, r.data.user.id, r.data.keys.keyVersion);
  return { privateKey, vaultKey, keyVersion: r.data.keys.keyVersion, wrapped: r.data.keys.wrappedVaultKey, userId: r.data.user.id };
}

async function addEntry(client, vault, meta, secret) {
  const id = vc.uuid();
  const sealed = await vc.sealEntry(vault.vaultKey, id, vault.keyVersion, meta, secret);
  const r = await client.api('POST', '/entries', { id, keyVersion: vault.keyVersion, ...sealed });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return id;
}

async function listEntries(client, vault) {
  const r = await client.api('GET', '/entries');
  assert.equal(r.status, 200);
  const out = [];
  for (const e of r.data.entries) out.push({ id: e.id, ...(await vc.openMeta(vault.vaultKey, e.id, e.keyVersion, e.meta)) });
  return { keyVersion: r.data.keyVersion, entries: out };
}

// ---------- the test ----------
test('vault end-to-end', { timeout: 15 * 60_000 }, async (t) => {
  const admin = new pg.Client({ connectionString: DB.replace(/\/[^/]+$/, '/postgres') });
  await admin.connect();
  const dbName = DB.split('/').pop();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  const db = new pg.Client({ connectionString: DB });

  const mock = await startMockApis({ hostingerToken: 'h-test-token', renderToken: 'r-test-token' });
  const srv = await startServer({
    HOSTINGER_API_TOKEN: 'h-test-token',
    RENDER_API_KEY: 'r-test-token',
    HOSTINGER_API_BASE: `http://127.0.0.1:${mock.port}`,
    RENDER_API_BASE: `http://127.0.0.1:${mock.port}/v1`,
  });
  assert.ok(srv.ok, srv.log());
  t.after(() => mock.close());
  await db.connect();
  t.after(async () => {
    srv.child.kill('SIGTERM');
    await db.end();
  });

  const setupToken = srv.log().match(/\/setup\/([A-Za-z0-9_-]{32})/)[1];
  assert.equal(setupToken, sec.setupToken());

  const stranger = new Client();
  const A = new Client(); // admin's laptop
  let adminVault;
  let adminAuth;
  const adminPw = 'Correct-Horse-Battery-77!';

  await t.test('strangers see nothing but 404', async () => {
    for (const p of ['/', '/index.html', '/js/app.js', '/api/state', '/k/xxxxxxxx', '/setup/xxxx', '/favicon.svg']) {
      const res = await stranger.raw('GET', p);
      assert.equal(res.status, 404, p);
      assert.equal(await res.text(), 'Not Found');
    }
    const res = await stranger.raw('POST', '/api/auth/login', { body: { username: 'x' }, headers: { 'x-vault': '1' } });
    assert.equal(res.status, 404);
    assert.equal(stranger.jar.size, 0);
  });

  await t.test('first admin setup via one-time link', async () => {
    const res = await A.raw('GET', `/setup/${setupToken}`);
    assert.equal(res.status, 302);
    assert.equal(A.jar.size, 1);
    const st = await A.api('GET', '/state');
    assert.equal(st.data.setupNeeded, true);
    assert.equal(st.data.setupAllowed, true);

    const userId = vc.uuid();
    const k = await registerKeys(adminPw);
    const raw = vc.newVaultKeyRaw();
    const wrapped = await vc.wrapVaultKey(raw, k.publicKey, userId, 1);
    const s1 = await A.api('POST', '/setup/start', {
      userId, username: 'owner', displayName: 'المدير', kdfSalt: k.salt, kdfIter: ITER,
      authKey: k.authKey, publicKey: k.publicKey, encPrivateKey: k.encPrivateKey, wrappedVaultKey: wrapped,
    });
    assert.equal(s1.status, 200, JSON.stringify(s1.data));
    assert.match(s1.data.qr, /^data:image\/svg\+xml;base64,/);
    adminAuth = new Authenticator(s1.data.secret);
    const bad = await A.api('POST', '/setup/finish', { username: 'owner', totp: '123456' });
    assert.equal(bad.status, 400);
    const s2 = await A.api('POST', '/setup/finish', { username: 'owner', totp: await adminAuth.code() });
    assert.equal(s2.status, 200, JSON.stringify(s2.data));
    assert.equal(s2.data.status, 'ok');
    adminVault = await openVault(s2, k.kek);
    const again = await stranger.raw('GET', `/setup/${setupToken}`);
    assert.equal(again.status, 404, 'setup link must die after setup');
  });

  await t.test('CSRF and content-type guards', async () => {
    const id = vc.uuid();
    const sealed = await vc.sealEntry(adminVault.vaultKey, id, 1, { client: 'x' }, { password: 'y' });
    const noHeader = await A.raw('POST', '/api/entries', { body: { id, keyVersion: 1, ...sealed } });
    assert.equal(noHeader.status, 403);
    const evil = await A.api('POST', '/entries', { id, keyVersion: 1, ...sealed }, { origin: 'https://evil.example' });
    assert.equal(evil.status, 403);
    const text = await A.raw('POST', '/api/entries', { body: 'hi', headers: { 'x-vault': '1', 'content-type': 'text/plain' } });
    assert.equal(text.status, 415);
  });

  let igId;
  await t.test('add, search data, reveal, edit, delete, restore', async () => {
    igId = await addEntry(A, adminVault, { client: 'Star Style', platform: 'instagram', label: '@starstyle.eg', username: 'starstyle.eg', url: 'https://instagram.com/starstyle.eg' }, { password: 'Ig-Pass-123', notes: 'backup codes: 1111 2222' });
    await addEntry(A, adminVault, { client: 'Star Style', platform: 'facebook', label: 'Page', username: 'ads@starstyle.com', url: '' }, { password: 'Fb-Pass-456', notes: '' });
    const otherId = await addEntry(A, adminVault, { client: 'Nile Foods', platform: 'tiktok', label: '', username: 'nilefoods', url: '' }, { password: 'Tt-789', notes: '' });
    const list = await listEntries(A, adminVault);
    assert.equal(list.entries.length, 3);
    assert.equal(list.entries.filter((e) => e.client === 'Star Style').length, 2);

    const sec1 = await A.api('POST', `/entries/${igId}/secret`, { reason: 'copy' });
    assert.equal(sec1.status, 200);
    const s = await vc.openSecret(adminVault.vaultKey, igId, sec1.data.keyVersion, sec1.data.secret);
    assert.equal(s.password, 'Ig-Pass-123');

    const upd = await vc.sealEntry(adminVault.vaultKey, igId, 1, { client: 'Star Style', platform: 'instagram', label: '@starstyle.eg', username: 'starstyle.eg', url: '' }, { password: 'Ig-NEW-999', notes: '', history: [{ password: 'Ig-Pass-123', changedAt: new Date().toISOString() }] });
    const u = await A.api('PUT', `/entries/${igId}`, { keyVersion: 1, ...upd });
    assert.equal(u.status, 200);

    // A ciphertext moved to another entry id must not decrypt (AAD binds it to its id).
    const sec2 = await A.api('POST', `/entries/${otherId}/secret`, { reason: 'view' });
    await assert.rejects(vc.openSecret(adminVault.vaultKey, igId, 1, sec2.data.secret));

    const del = await A.api('DELETE', `/entries/${otherId}`);
    assert.equal(del.status, 200);
    assert.equal((await listEntries(A, adminVault)).entries.length, 2);
    const trash = await A.api('GET', '/admin/trash');
    assert.equal(trash.data.entries.length, 1);
    const rest = await A.api('POST', `/admin/trash/${otherId}/restore`, {});
    assert.equal(rest.status, 200);
    assert.equal((await listEntries(A, adminVault)).entries.length, 3);
  });

  await t.test('database holds only double-encrypted data', async () => {
    const rows = (await db.query('SELECT meta_ct, secret_ct FROM entries')).rows;
    for (const r of rows) {
      assert.match(r.meta_ct, /^s1\./);
      assert.match(r.secret_ct, /^s1\./);
      const dump = r.meta_ct + r.secret_ct;
      for (const needle of ['Star', 'star', 'Ig-', 'instagram', 'Nile']) assert.ok(!dump.includes(needle), needle);
    }
    const u = (await db.query("SELECT * FROM users WHERE username = 'owner'")).rows[0];
    assert.match(u.enc_private_key, /^s1\./);
    assert.match(u.totp_secret, /^s1\./);
    assert.ok(!JSON.stringify(u).includes(adminPw));
    // Peeling the server layer still leaves browser-encrypted data.
    const meta = sec.srvDec(`entry-meta:${igId}`, (await db.query('SELECT meta_ct FROM entries WHERE id = $1', [igId])).rows[0].meta_ct);
    assert.match(meta, /^c1\./);
    assert.ok(!meta.includes('Star'));
    // The activity log refuses edits and deletes.
    const before = (await db.query('SELECT count(*)::int AS n FROM audit')).rows[0].n;
    await db.query('DELETE FROM audit');
    await db.query("UPDATE audit SET action = 'x'");
    const after = (await db.query('SELECT count(*)::int AS n FROM audit')).rows[0].n;
    assert.equal(after, before);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM audit WHERE action = 'x'")).rows[0].n, 0);
  });

  await t.test('renewals come from Hostinger and Render with read-only calls', async () => {
    const r = await A.api('GET', '/admin/renewals?refresh=1');
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.hostinger.domains.length, 3);
    assert.equal(r.data.hostinger.subscriptions.find((x) => x.id === 'sub-1').renewalPrice, 155.88);
    assert.equal(r.data.render.services.length, 2);
    assert.ok(r.data.render.databases.find((x) => x.name === 'star-style-db').expiresAt);
    assert.ok(!JSON.stringify(r.data).includes('test-token'), 'tokens never reach the browser');
    assert.ok(mock.calls.length >= 4);
    for (const c of mock.calls) {
      assert.equal(c.method, 'GET');
      assert.ok(c.auth === 'Bearer h-test-token' || c.auth === 'Bearer r-test-token');
    }
    const st = await A.api('GET', '/admin/status');
    const names = st.data.renewals.map((x) => x.title);
    for (const n of ['star-style-db', 'starstyle.com (.COM Domain)', 'Business Web Hosting', 'old-client.com']) assert.ok(names.includes(n), n);
    for (const n of ['nilefoods.net', 'nilefoods.net (.net Domain)', 'starstyle.com']) assert.ok(!names.includes(n), n);
    assert.equal(st.data.renewals[0].title, 'old-client.com', 'already expired comes first');

    process.env.HOSTINGER_API_BASE = `http://127.0.0.1:${mock.port}`;
    process.env.RENDER_API_BASE = `http://127.0.0.1:${mock.port}/v1`;
    const integ = await import(path.join(root, 'src/integrations.js'));
    await assert.rejects(integ.hostingerSnapshot('wrong-token'), (e) => e.code === 'auth');
    await assert.rejects(integ.renderSnapshot('wrong-token'), (e) => e.code === 'auth');
  });

  await t.test('unknown users get a stable fake salt', async () => {
    const a = await stranger.api('POST', '/auth/prelogin', { username: 'nobody' });
    assert.equal(a.status, 404, 'stranger still blocked');
    const b1 = await A.api('POST', '/auth/prelogin', { username: 'nobody' });
    const b2 = await A.api('POST', '/auth/prelogin', { username: 'nobody' });
    assert.equal(b1.data.kdfSalt, b2.data.kdfSalt);
    assert.equal(b1.data.kdfIter, 1_000_000);
  });

  // ---- team member flow ----
  const B = new Client(); // member's laptop
  const memberPw = 'Member-Strong-Pass-2026';
  let memberAuth;
  let memberId;
  let gate;
  await t.test('invite → register → waits for approval', async () => {
    const g = await A.api('GET', '/admin/gate');
    gate = new URL(g.data.link).pathname;
    const inv = await A.api('POST', '/admin/invites', { username: 'ahmed', displayName: 'أحمد', role: 'member' });
    assert.equal(inv.status, 200);
    const link = new URL(inv.data.link);
    assert.equal(link.pathname, gate);
    const code = new URLSearchParams(link.hash.slice(1)).get('invite');
    const dup = await A.api('POST', '/admin/invites', { username: 'ahmed', displayName: 'x', role: 'member' });
    assert.equal(dup.status, 409);

    assert.equal((await B.raw('GET', gate)).status, 302);
    const info = await B.api('POST', '/register/info', { inviteCode: code });
    assert.equal(info.data.username, 'ahmed');
    memberId = vc.uuid();
    const k = await registerKeys(memberPw);
    const r1 = await B.api('POST', '/register/start', { inviteCode: code, userId: memberId, kdfSalt: k.salt, kdfIter: ITER, authKey: k.authKey, publicKey: k.publicKey, encPrivateKey: k.encPrivateKey });
    assert.equal(r1.status, 200, JSON.stringify(r1.data));
    memberAuth = new Authenticator(r1.data.secret);
    const r2 = await B.api('POST', '/register/finish', { inviteCode: code, totp: await memberAuth.code() });
    assert.equal(r2.data.status, 'pending_approval');
    assert.equal(r2.data.fingerprint, await vc.fingerprint(k.publicKey));
    const reuse = await B.api('POST', '/register/info', { inviteCode: code });
    assert.equal(reuse.status, 404, 'invite is single-use');

    const early = await login(B, 'ahmed', memberPw, memberAuth);
    assert.equal(early.data.status, 'pending_approval');
  });

  await t.test('admin approves the member and shares the vault key', async () => {
    const list = await A.api('GET', '/admin/users');
    const m = list.data.users.find((u) => u.username === 'ahmed');
    assert.equal(m.status, 'pending_approval');
    assert.equal(m.fingerprint, await vc.fingerprint(m.publicKey));
    const raw = await vc.unwrapVaultKeyRaw(adminVault.wrapped, adminVault.privateKey, adminVault.userId, adminVault.keyVersion);
    const wrapped = await vc.wrapVaultKey(raw, m.publicKey, m.id, adminVault.keyVersion);
    raw.fill(0);
    const ap = await A.api('POST', `/admin/users/${m.id}/approve`, { keyVersion: adminVault.keyVersion, wrapped });
    assert.equal(ap.status, 200, JSON.stringify(ap.data));

    const r = await login(B, 'ahmed', memberPw, memberAuth);
    assert.equal(r.data.status, 'ok', JSON.stringify(r.data));
    const mv = await openVault(r, r.kek);
    const list2 = await listEntries(B, mv);
    assert.equal(list2.entries.filter((e) => e.client === 'Star Style').length, 2);
    const forbidden = await B.api('GET', '/admin/users');
    assert.equal(forbidden.status, 403);
    assert.equal((await B.api('GET', '/admin/renewals')).status, 403);
  });

  await t.test('TOTP codes cannot be replayed and wrong codes fail', async () => {
    const C = new Client();
    await C.raw('GET', gate);
    const code = sec.hotp(memberAuth.secret, memberAuth.last);
    const pre = await C.api('POST', '/auth/prelogin', { username: 'ahmed' });
    const { authKey } = await vc.deriveFromPassword(memberPw, pre.data.kdfSalt, pre.data.kdfIter);
    const replay = await C.api('POST', '/auth/login', { username: 'ahmed', authKey, totp: code });
    assert.equal(replay.status, 401);
    await db.query("UPDATE users SET failed_logins = 0 WHERE username = 'ahmed'");
  });

  const C = new Client(); // member's phone (new device)
  await t.test('a new device needs admin approval; blocking it locks it out', async () => {
    assert.equal((await C.raw('GET', gate)).status, 302);
    const r = await login(C, 'ahmed', memberPw, memberAuth);
    assert.equal(r.data.status, 'device_pending');
    const devs = await A.api('GET', '/admin/devices');
    const pending = devs.data.devices.find((d) => d.status === 'pending' && d.username === 'ahmed');
    assert.ok(pending);
    const ap = await A.api('POST', '/admin/devices/approve', { userId: pending.userId, deviceId: pending.deviceId });
    assert.equal(ap.status, 200);
    const r2 = await login(C, 'ahmed', memberPw, memberAuth);
    assert.equal(r2.data.status, 'ok');
    assert.equal((await C.api('GET', '/entries')).status, 200);

    const self = await A.api('POST', '/admin/devices/block', { deviceId: devs.data.currentDeviceId });
    assert.equal(self.status, 409, 'admin cannot block the device they are using');
    const bl = await A.api('POST', '/admin/devices/block', { deviceId: pending.deviceId });
    assert.equal(bl.status, 200);
    const after = await C.raw('GET', '/api/state');
    assert.equal(after.status, 404, 'blocked device sees nothing');
  });

  await t.test('wrong passwords lock the account; admin can unlock', async () => {
    const D = new Client();
    await D.raw('GET', gate);
    for (let i = 0; i < 5; i++) {
      const r = await login(D, 'ahmed', 'wrong-password-xx', null);
      assert.equal(r.status, 401);
    }
    const locked = await login(D, 'ahmed', memberPw, null);
    assert.equal(locked.status, 423);
    assert.ok(locked.data.minutes >= 1);
    const ul = await A.api('POST', `/admin/users/${memberId}/unlock`, {});
    assert.equal(ul.status, 200);
  });

  await t.test('session survives a reload only via unlock with the master password', async () => {
    const bad = await B.api('POST', '/auth/unlock', { authKey: Buffer.alloc(32).toString('base64') });
    assert.equal(bad.status, 401);
    const pre = await B.api('POST', '/auth/prelogin', { username: 'ahmed' });
    const { authKey, kek } = await vc.deriveFromPassword(memberPw, pre.data.kdfSalt, pre.data.kdfIter);
    const ok = await B.api('POST', '/auth/unlock', { authKey });
    assert.equal(ok.status, 200);
    await openVault(ok, kek);
  });

  await t.test('removing a member rotates the vault key', async () => {
    const d = await A.api('GET', '/admin/rotation');
    assert.equal(d.status, 200);
    const newVersion = d.data.keyVersion + 1;
    const raw = vc.newVaultKeyRaw();
    const newKey = await vc.importVaultKey(raw);
    const entries = [];
    for (const e of d.data.entries) {
      const meta = await vc.openMeta(adminVault.vaultKey, e.id, e.keyVersion, e.meta);
      const secret = await vc.openSecret(adminVault.vaultKey, e.id, e.keyVersion, e.secret);
      entries.push({ id: e.id, ...(await vc.sealEntry(newKey, e.id, newVersion, meta, secret)) });
    }
    const wraps = [];
    for (const u of d.data.users.filter((x) => x.id !== memberId)) wraps.push({ userId: u.id, wrapped: await vc.wrapVaultKey(raw, u.publicKey, u.id, newVersion) });
    const stale = await A.api('POST', '/admin/rotate', { fromVersion: d.data.keyVersion, newVersion, revision: d.data.revision - 1, removeUserId: memberId, entries, wraps });
    assert.equal(stale.status, 409);
    const r = await A.api('POST', '/admin/rotate', { fromVersion: d.data.keyVersion, newVersion, revision: d.data.revision, removeUserId: memberId, entries, wraps });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    raw.fill(0);

    const gone = await B.api('GET', '/entries');
    assert.equal(gone.status, 401, 'removed member session is dead');
    const relog = await login(B, 'ahmed', memberPw, null);
    assert.equal(relog.status, 401);

    // Admin re-unlocks and reads everything with the new key.
    const pre = await A.api('POST', '/auth/prelogin', { username: 'owner' });
    const { authKey, kek } = await vc.deriveFromPassword(adminPw, pre.data.kdfSalt, pre.data.kdfIter);
    const un = await A.api('POST', '/auth/unlock', { authKey });
    adminVault = await openVault(un, kek);
    assert.equal(adminVault.keyVersion, 2);
    const list = await listEntries(A, adminVault);
    assert.equal(list.entries.length, 3);
    const oldKeyAttempt = await db.query('SELECT count(*)::int AS n FROM vault_keys WHERE key_version = 1');
    assert.equal(oldKeyAttempt.rows[0].n, 0, 'old wraps are deleted');
    const writeOld = await A.api('POST', '/entries', { id: vc.uuid(), keyVersion: 1, ...(await vc.sealEntry(adminVault.vaultKey, vc.uuid(), 1, {}, {})) });
    assert.equal(writeOld.status, 409);
  });

  await t.test('encrypted backup round-trip and import', async () => {
    const ex = await A.api('GET', '/admin/export');
    const items = [];
    for (const e of ex.data.entries) {
      items.push({ ...(await vc.openMeta(adminVault.vaultKey, e.id, e.keyVersion, e.meta)), ...(await vc.openSecret(adminVault.vaultKey, e.id, e.keyVersion, e.secret)) });
    }
    const file = await vc.sealBackup('Backup-Pass-2026!!', { entries: items });
    assert.ok(!file.includes('Star'));
    await assert.rejects(vc.openBackup('wrong-backup-pass', file), /backup_password/);
    const back = await vc.openBackup('Backup-Pass-2026!!', file);
    assert.equal(back.entries.length, 3);
    const toImport = [];
    for (const it of back.entries) {
      const id = vc.uuid();
      const { password, notes, history, ...meta } = it;
      toImport.push({ id, ...(await vc.sealEntry(adminVault.vaultKey, id, adminVault.keyVersion, meta, { password, notes, history })) });
    }
    const im = await A.api('POST', '/admin/import', { keyVersion: adminVault.keyVersion, entries: toImport });
    assert.equal(im.data.added, 3);
    assert.equal((await listEntries(A, adminVault)).entries.length, 6);
  });

  await t.test('activity log captured the important events', async () => {
    const a = await A.api('GET', '/admin/audit');
    const actions = new Set(a.data.items.map((x) => x.action));
    for (const need of ['setup_complete', 'entry_create', 'secret_copy', 'secret_view', 'entry_delete', 'member_approve', 'device_pending', 'device_block', 'account_locked', 'member_remove', 'backup_export', 'backup_import', 'login_fail']) {
      assert.ok(actions.has(need), need);
    }
  });

  await t.test('changing the master password', async () => {
    const pre = await A.api('POST', '/auth/prelogin', { username: 'owner' });
    const cur = await vc.deriveFromPassword(adminPw, pre.data.kdfSalt, pre.data.kdfIter);
    const salt = vc.newSalt();
    const next = await vc.deriveFromPassword('Brand-New-Master-Pass-9', salt, ITER);
    const encPrivateKey = await vc.rewrapPrivateKey(cur.kek, (await A.api('POST', '/auth/unlock', { authKey: cur.authKey })).data.keys.encPrivateKey, next.kek);
    const r = await A.api('POST', '/account/password', { currentAuthKey: cur.authKey, kdfSalt: salt, kdfIter: ITER, authKey: next.authKey, encPrivateKey });
    assert.equal(r.status, 200);
    const oldTry = await A.api('POST', '/auth/unlock', { authKey: cur.authKey });
    assert.equal(oldTry.status, 401);
    const pre2 = await A.api('POST', '/auth/prelogin', { username: 'owner' });
    const n2 = await vc.deriveFromPassword('Brand-New-Master-Pass-9', pre2.data.kdfSalt, pre2.data.kdfIter);
    const ok = await A.api('POST', '/auth/unlock', { authKey: n2.authKey });
    assert.equal(ok.status, 200);
    await openVault(ok, n2.kek);
  });

  await t.test('server refuses to start with a different MASTER_SECRET', async () => {
    srv.child.kill('SIGTERM');
    await sleep(500);
    const wrong = await startServer({ MASTER_SECRET: crypto.randomBytes(32).toString('base64') });
    assert.equal(wrong.ok, false);
    assert.match(wrong.log(), /MASTER_SECRET does not match/);
  });
});
