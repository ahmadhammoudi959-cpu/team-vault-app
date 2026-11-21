// Read-only connections to Hostinger and Render, used for renewal reminders.
// Tokens come only from the server's environment, are sent only to the two fixed API hosts,
// only with GET requests, and are never logged or returned to the browser.

const HOSTINGER_BASE = (process.env.HOSTINGER_API_BASE || 'https://developers.hostinger.com').replace(/\/+$/, '');
const RENDER_BASE = (process.env.RENDER_API_BASE || 'https://api.render.com/v1').replace(/\/+$/, '');
const MAX_ITEMS = 1000;

export class IntegrationError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const str = (v, max = 200) => (v === null || v === undefined ? '' : String(v).slice(0, max));
const date = (v) => {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const listOf = (body) => (Array.isArray(body) ? body : Array.isArray(body && body.data) ? body.data : []);

async function getJson(url, token) {
  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'team-vault/1.0' },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new IntegrationError(e && e.name === 'TimeoutError' ? 'timeout' : 'network');
  }
  if (res.status === 401 || res.status === 403) throw new IntegrationError('auth');
  if (res.status === 429) throw new IntegrationError('rate_limited');
  if (!res.ok) throw new IntegrationError(`http_${res.status}`);
  const text = await res.text();
  if (text.length > 8_000_000) throw new IntegrationError('too_large');
  try {
    return JSON.parse(text);
  } catch {
    throw new IntegrationError('bad_response');
  }
}

function settle(result, errors, label) {
  if (result.status === 'fulfilled') return result.value;
  errors.push(`${label}:${result.reason && result.reason.code ? result.reason.code : 'failed'}`);
  return null;
}

export async function hostingerSnapshot(token) {
  const errors = [];
  const [d, s] = await Promise.allSettled([
    getJson(`${HOSTINGER_BASE}/api/domains/v1/portfolio`, token),
    getJson(`${HOSTINGER_BASE}/api/billing/v1/subscriptions`, token),
  ]);
  const domains = listOf(settle(d, errors, 'domains')).slice(0, MAX_ITEMS).map((x) => ({
    id: str(x.id, 40),
    name: str(x.domain),
    type: str(x.type, 40),
    status: str(x.status, 40),
    expiresAt: date(x.expires_at),
    createdAt: date(x.created_at),
  }));
  const cents = (n) => (Number.isFinite(n) ? Math.round(n) / 100 : null);
  const subscriptions = listOf(settle(s, errors, 'subscriptions')).slice(0, MAX_ITEMS).map((x) => ({
    id: str(x.id, 60),
    name: str(x.name),
    status: str(x.status, 40),
    autoRenew: x.is_auto_renewed === true,
    renewalPrice: cents(x.renewal_price),
    totalPrice: cents(x.total_price),
    currency: str(x.currency_code, 8),
    period: x.billing_period ? `${Number(x.billing_period)} ${str(x.billing_period_unit, 20)}` : '',
    expiresAt: date(x.expires_at),
    nextBillingAt: date(x.next_billing_at),
  }));
  if (errors.length === 2) throw new IntegrationError(errors[0].split(':')[1]);
  return { fetchedAt: new Date().toISOString(), domains, subscriptions, errors };
}

async function renderList(path, token, key) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 10; page += 1) {
    const url = `${RENDER_BASE}${path}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const body = await getJson(url, token);
    const items = Array.isArray(body) ? body : [];
    for (const it of items) if (it && it[key]) out.push(it[key]);
    if (items.length < 100) break;
    cursor = items[items.length - 1].cursor;
    if (!cursor) break;
  }
  return out;
}

export async function renderSnapshot(token) {
  const errors = [];
  const [sv, pg] = await Promise.allSettled([renderList('/services', token, 'service'), renderList('/postgres', token, 'postgres')]);
  const services = (settle(sv, errors, 'services') || []).slice(0, MAX_ITEMS).map((x) => ({
    id: str(x.id, 60),
    name: str(x.name),
    type: str(x.type, 40),
    suspended: x.suspended === 'suspended',
    plan: str(x.serviceDetails && x.serviceDetails.plan, 40),
    url: str(x.serviceDetails && x.serviceDetails.url, 300),
    dashboardUrl: str(x.dashboardUrl, 300),
    updatedAt: date(x.updatedAt),
  }));
  const databases = (settle(pg, errors, 'postgres') || []).slice(0, MAX_ITEMS).map((x) => ({
    id: str(x.id, 60),
    name: str(x.name),
    plan: str(x.plan, 40),
    status: str(x.status, 40),
    region: str(x.region, 40),
    expiresAt: date(x.expiresAt),
    suspended: x.suspended === 'suspended',
    dashboardUrl: str(x.dashboardUrl, 300),
    createdAt: date(x.createdAt),
  }));
  if (errors.length === 2) throw new IntegrationError(errors[0].split(':')[1]);
  return { fetchedAt: new Date().toISOString(), services, databases, errors };
}

const DAY = 86_400_000;

// Items that end within `windowDays` (or already ended), for banners. Small and name-only.
export function upcoming({ hostinger, render }, windowDays = 30, now = Date.now()) {
  const items = [];
  const push = (title, at, source) => {
    const t = Date.parse(at);
    if (!Number.isFinite(t)) return;
    const days = Math.ceil((t - now) / DAY);
    if (days <= windowDays) items.push({ title, at, source, days });
  };
  if (hostinger && !hostinger.error) {
    for (const d of hostinger.domains || []) if (d.expiresAt && !['deleted', 'failed', 'requested'].includes(d.status)) push(d.name, d.expiresAt, 'hostinger_domain');
    for (const s of hostinger.subscriptions || []) {
      if (['active', 'not_renewing', 'in_trial', 'paused'].includes(s.status)) push(s.name, s.expiresAt || s.nextBillingAt, 'hostinger_subscription');
    }
  }
  if (render && !render.error) {
    for (const p of render.databases || []) if (p.expiresAt) push(p.name, p.expiresAt, 'render_database');
  }
  return items.sort((a, b) => a.days - b.days);
}
