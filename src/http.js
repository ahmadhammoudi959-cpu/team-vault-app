// HTTP helpers: errors, validation, cookies, client IP, rate limiting, security headers.
import { COOKIE_SECURE, IS_PROD, KDF_ITER_MAX, KDF_ITER_MIN } from './config.js';

export class HttpError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
const bad = (field) => new HttpError(400, 'invalid', { field });

// ---------- validation ----------
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const BLOB = /^c1\.[A-Za-z0-9+/]+={0,2}\.[A-Za-z0-9+/]+={0,2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const v = {
  uuid(s, field = 'id') {
    if (typeof s !== 'string' || !UUID.test(s)) throw bad(field);
    return s.toLowerCase();
  },
  username(s) {
    const u = String(s ?? '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(u)) throw bad('username');
    return u;
  },
  usernameLoose(s) {
    const u = String(s ?? '').trim().toLowerCase();
    return /^[a-z0-9][a-z0-9._-]{2,31}$/.test(u) ? u : null;
  },
  display(s) {
    const d = String(s ?? '').replace(/\s+/g, ' ').trim();
    if (d.length < 1 || d.length > 60) throw bad('displayName');
    return d;
  },
  b64(s, minBytes, maxBytes, field) {
    if (typeof s !== 'string' || !B64.test(s)) throw bad(field);
    const n = Buffer.from(s, 'base64').length;
    if (n < minBytes || n > maxBytes) throw bad(field);
    return s;
  },
  authKey(s) {
    return v.b64(s, 32, 32, 'authKey');
  },
  isAuthKey(s) {
    return typeof s === 'string' && B64.test(s) && Buffer.from(s, 'base64').length === 32;
  },
  publicKey(s) {
    return v.b64(s, 64, 256, 'publicKey');
  },
  blob(s, maxLen, field = 'blob') {
    if (typeof s !== 'string' || s.length > maxLen || !BLOB.test(s)) throw bad(field);
    return s;
  },
  wrap(s) {
    if (typeof s !== 'string' || s.length > 4096) throw bad('wrapped');
    let w;
    try {
      w = JSON.parse(s);
    } catch {
      throw bad('wrapped');
    }
    if (!w || w.v !== 1 || !B64.test(w.epk || '') || !B64.test(w.salt || '') || !BLOB.test(w.ct || '')) throw bad('wrapped');
    return s;
  },
  int(n, min, max, field = 'number') {
    if (!Number.isInteger(n) || n < min || n > max) throw bad(field);
    return n;
  },
  iter(n) {
    return v.int(n, KDF_ITER_MIN, KDF_ITER_MAX, 'kdfIter');
  },
  role(r) {
    if (r !== 'admin' && r !== 'member') throw bad('role');
    return r;
  },
};

// ---------- cookies ----------
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    out[k] = part.slice(i + 1).trim();
  }
  return out;
}

// "__Host-" cookies must be Secure, host-only and Path=/ — browsers refuse them otherwise.
export const cookieName = (base) => (COOKIE_SECURE ? `__Host-${base}` : base);

export function setCookie(res, name, value, { maxAge = null, sameSite = 'Strict' } = {}) {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', `SameSite=${sameSite}`];
  if (COOKIE_SECURE) parts.push('Secure');
  if (maxAge != null) parts.push(`Max-Age=${Math.floor(maxAge / 1000)}`);
  res.append('Set-Cookie', parts.join('; '));
}

export function clearCookie(res, name) {
  setCookie(res, name, '', { maxAge: 0 });
}

// ---------- client IP (Render sits behind Cloudflare, which overwrites these headers) ----------
export function clientIp(req) {
  const cf = req.get('cf-connecting-ip') || req.get('true-client-ip');
  if (cf) return cf.trim().slice(0, 64);
  const xff = req.get('x-forwarded-for');
  if (xff) {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1].slice(0, 64);
  }
  return String(req.socket?.remoteAddress || '').slice(0, 64);
}

export function deviceLabel(ua = '') {
  let os = 'جهاز غير معروف';
  if (/iPhone/i.test(ua)) os = 'iPhone';
  else if (/iPad/i.test(ua)) os = 'iPad';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Macintosh|Mac OS X/i.test(ua)) os = 'Mac';
  else if (/CrOS/i.test(ua)) os = 'ChromeOS';
  else if (/Linux/i.test(ua)) os = 'Linux';
  let br = 'متصفح';
  if (/Edg\//.test(ua)) br = 'Edge';
  else if (/OPR\//.test(ua)) br = 'Opera';
  else if (/SamsungBrowser/.test(ua)) br = 'Samsung Internet';
  else if (/Firefox\/|FxiOS/.test(ua)) br = 'Firefox';
  else if (/CriOS|Chrome\//.test(ua)) br = 'Chrome';
  else if (/Safari\//.test(ua)) br = 'Safari';
  return `${br} على ${os}`;
}

// ---------- rate limiting (fixed window, in memory) ----------
const buckets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k);
}, 60_000).unref();

// Returns null when allowed, otherwise the number of seconds to wait.
export function hit(key, limit, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset <= now) {
    b = { count: 0, reset: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  return b.count <= limit ? null : Math.max(1, Math.ceil((b.reset - now) / 1000));
}

export function rateLimit(name, limit, windowMs, keyFn = (req) => clientIp(req)) {
  return (req, res, next) => {
    const wait = hit(`${name}:${keyFn(req)}`, limit, windowMs);
    if (wait) {
      res.setHeader('Retry-After', String(wait));
      return res.status(429).json({ error: 'rate_limited', retryAfter: wait });
    }
    next();
  };
}

// ---------- security headers on every response ----------
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "require-trusted-types-for 'script'",
  "trusted-types 'none'",
  ...(IS_PROD ? ['upgrade-insecure-requests'] : []),
].join('; ');

export function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  if (IS_PROD) res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Cache-Control', 'no-store');
  next();
}

export function notFound(res) {
  res.status(404).type('text/plain').send('Not Found');
}
