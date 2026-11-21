// Read-only connections to Hostinger and Render: websites, domains, e-mail, subscriptions,
// payment cards, services and databases, for alerts, the provider screens and the monthly report.
// Tokens come only from the server's environment, are sent only to the two fixed API hosts,
// only with GET requests, and are never logged or returned to the browser.
import { domainToUnicode } from 'node:url';

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
// Domains with non-Latin letters arrive in punycode ("xn--..."); show them the way people type them.
const domainName = (v) => {
  const raw = str(v).trim();
  if (!raw.toLowerCase().includes('xn--')) return raw;
  try {
    return domainToUnicode(raw) || raw;
  } catch {
    return raw;
  }
};

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

const DAY = 86_400_000;
const lower = (v) => str(v).toLowerCase();
const cents = (n) => (Number.isFinite(n) ? Math.round(n) / 100 : null);
const ms = (iso) => (iso ? Date.parse(iso) : NaN);

// Paginated Hostinger lists answer { data, meta: { total } }; 25 per page is the documented default.
async function hostingerPages(path, token) {
  const out = [];
  for (let page = 1; page <= 40 && out.length < MAX_ITEMS; page += 1) {
    const body = await getJson(`${HOSTINGER_BASE}${path}?page=${page}`, token);
    const items = listOf(body);
    out.push(...items);
    const total = Number(body && !Array.isArray(body) && body.meta ? body.meta.total : NaN);
    if (!items.length || !Number.isFinite(total) || out.length >= total) break;
  }
  return out.slice(0, MAX_ITEMS);
}

// What a Hostinger subscription is, from its name (".DE Domain", "Starter Business Email", "Business Web Hosting"...).
export function subscriptionKind(name) {
  const n = lower(name);
  if (/\bdomain\b/.test(n)) return 'domain';
  if (/e-?mail/.test(n)) return 'email';
  if (/monitor|\bssl\b|backup|\bcdn\b|security|protect/.test(n)) return 'addon';
  if (/\bvps\b|\bkvm/.test(n)) return 'vps';
  if (/host|cloud|\bweb\b|wordpress|website|builder|agency/.test(n)) return 'hosting';
  return 'other';
}

// Hostinger reports both spellings in practice.
export const LIVE_SUBSCRIPTION = new Set(['active', 'not_renewing', 'non_renewing', 'in_trial', 'paused']);

// The date a subscription next costs money (auto-renewal) or ends (no auto-renewal).
export const subscriptionDate = (s) => (s.autoRenew && s.nextBillingAt) || s.expiresAt || s.nextBillingAt || null;

// Pairs items with subscriptions where the pairing is unambiguous: an item with a single
// candidate takes it, unless another item also has only that candidate.
function pairUnique(items, subs, fits) {
  const pairs = new Map();
  const taken = new Set();
  for (let round = 0; round < 8; round += 1) {
    const left = items.filter((it) => !pairs.has(it));
    const cand = new Map(left.map((it) => [it, subs.filter((s) => !taken.has(s) && fits(it, s))]));
    let changed = false;
    for (const it of left) {
      const c = cand.get(it);
      if (c.length !== 1 || taken.has(c[0])) continue;
      if (left.some((o) => o !== it && !pairs.has(o) && cand.get(o).length === 1 && cand.get(o)[0] === c[0])) continue;
      pairs.set(it, c[0]);
      taken.add(c[0]);
      changed = true;
    }
    if (!changed) break;
  }
  return pairs;
}

// Same end date (two days either way).
const sameDay = (end, s) => {
  const a = ms(end);
  const b = ms(subscriptionDate(s));
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 2 * DAY;
};
// Hostinger charges an auto-renewing domain or mailbox up to a month before it ends; a
// subscription that does not renew carries the real end date, so it has to match exactly.
const chargedFor = (end, s) => {
  if (!(s.autoRenew && s.nextBillingAt)) return sameDay(end, s);
  const a = ms(end);
  const b = ms(s.nextBillingAt);
  return Number.isFinite(a) && Number.isFinite(b) && b >= a - 31 * DAY && b <= a + 2 * DAY;
};
// Exact dates first, then the looser charging window for what is left.
function pairByDate(items, subs, endOf, extra = () => true) {
  const exact = pairUnique(items, subs, (it, s) => extra(it, s) && sameDay(endOf(it), s));
  const used = new Set(exact.values());
  const loose = pairUnique(items.filter((it) => !exact.has(it)), subs.filter((s) => !used.has(s)), (it, s) => extra(it, s) && chargedFor(endOf(it), s));
  return new Map([...exact, ...loose]);
}
// Hostinger's temporary addresses (before a real domain is attached).
export const isTemporaryDomain = (d) => /\.hostingersite\.com$|\.hostingersite\.[a-z]+$|\.preview-domain\.com$/i.test(d || '');
// "hostinger_business_v3" -> "Business"
const planName = (v) => {
  const t = str(v, 80).replace(/^hostinger_/i, '').replace(/_v\d+$/i, '').replace(/_/g, ' ').trim();
  return t ? t.replace(/\b\w/g, (c) => c.toUpperCase()) : '';
};
const tldOf = (name) => {
  const m = /^\.([a-z0-9-]+)\s+domain/i.exec(name || '');
  return m ? `.${m[1].toLowerCase()}` : null;
};

export async function hostingerSnapshot(token) {
  const errors = [];
  const [d, s, w, o, m, p] = await Promise.allSettled([
    getJson(`${HOSTINGER_BASE}/api/domains/v1/portfolio`, token),
    getJson(`${HOSTINGER_BASE}/api/billing/v1/subscriptions`, token),
    hostingerPages('/api/hosting/v1/websites', token),
    hostingerPages('/api/hosting/v1/orders', token),
    hostingerPages('/api/mail/v1/orders', token),
    getJson(`${HOSTINGER_BASE}/api/billing/v1/payment-methods`, token),
  ]);
  const domains = listOf(settle(d, errors, 'domains')).slice(0, MAX_ITEMS).map((x) => ({
    id: str(x.id, 40),
    name: domainName(x.domain),
    type: str(x.type, 40),
    status: str(x.status, 40),
    expiresAt: date(x.expires_at),
    createdAt: date(x.created_at),
  }));
  const subscriptions = listOf(settle(s, errors, 'subscriptions')).slice(0, MAX_ITEMS).map((x) => ({
    id: str(x.id, 60),
    name: str(x.name),
    kind: subscriptionKind(x.name),
    status: str(x.status, 40),
    autoRenew: x.is_auto_renewed === true,
    renewalPrice: cents(x.renewal_price),
    totalPrice: cents(x.total_price),
    currency: str(x.currency_code, 8),
    period: x.billing_period ? `${Number(x.billing_period)} ${str(x.billing_period_unit, 20)}` : '',
    periodCount: Number(x.billing_period) || 0,
    periodUnit: lower(x.billing_period_unit).replace(/s$/, ''),
    createdAt: date(x.created_at),
    expiresAt: date(x.expires_at),
    nextBillingAt: date(x.next_billing_at),
  }));
  const websites = (settle(w, errors, 'websites') || []).map((x) => ({
    domain: domainName(x.domain),
    type: str(x.website_type, 20),
    enabled: x.is_enabled !== false,
    username: str(x.username, 60),
    orderId: x.order_id === null || x.order_id === undefined ? null : str(x.order_id, 40),
    parentDomain: domainName(x.parent_domain),
    temporary: isTemporaryDomain(x.domain),
    createdAt: date(x.created_at),
  }));
  const hostingOrders = (settle(o, errors, 'hosting_orders') || []).map((x) => ({
    id: str(x.id, 40),
    subscriptionId: x.subscription_id ? str(x.subscription_id, 60) : null,
    plan: planName(x.plan && x.plan.name),
    status: str(x.status, 40),
    createdAt: date(x.created_at),
  }));
  const mailOrders = (settle(m, errors, 'mail') || []).map((x) => ({
    id: str(x.id, 60),
    domain: domainName(x.domain && x.domain.name),
    plan: str(x.plan && (x.plan.title || x.plan.name), 80),
    status: str(x.status, 40),
    trial: x.is_trial === true,
    seats: Number(x.seats) || 0,
    createdAt: date(x.created_at),
    expiresAt: date(x.expires_at),
  }));
  const paymentMethods = listOf(settle(p, errors, 'payment_methods')).slice(0, 50).map((x) => ({
    id: str(x.id, 40),
    name: str(x.name, 60),
    identifier: str(x.identifier, 80),
    method: str(x.payment_method, 40),
    isDefault: x.is_default === true,
    expired: x.is_expired === true,
    suspended: x.is_suspended === true,
    expiresAt: date(x.expires_at),
  }));
  if (!d.value && !s.value) throw new IntegrationError(errors[0].split(':')[1]);

  // Websites -> hosting order -> subscription (exact ids from Hostinger).
  const subById = new Map(subscriptions.map((x) => [x.id, x]));
  const orderById = new Map(hostingOrders.map((x) => [x.id, x]));
  for (const ord of hostingOrders) {
    const sub = ord.subscriptionId && subById.get(ord.subscriptionId);
    if (sub && ord.plan) sub.plan = ord.plan;
  }
  for (const site of websites) {
    const ord = site.orderId && orderById.get(site.orderId);
    if (!ord) continue;
    site.plan = ord.plan;
    const sub = ord.subscriptionId && subById.get(ord.subscriptionId);
    if (!sub) continue;
    site.subscriptionId = sub.id;
    if (site.domain) (sub.websites ||= []).push(site.domain);
  }

  // Domains and mailboxes carry no subscription id, so they are matched by date (and TLD).
  // Live subscriptions are matched first, so an old cancelled one never takes a domain from a live one.
  const named = domains.filter((x) => x.name && x.expiresAt && !['deleted', 'failed'].includes(x.status));
  const domainSubs = subscriptions.filter((x) => x.kind === 'domain');
  const fitsDomain = (dm, sub) => {
    const tld = tldOf(sub.name);
    return !tld || lower(dm.name).endsWith(tld);
  };
  const endOf = (x) => x.expiresAt;
  const livePairs = pairByDate(named, domainSubs.filter((x) => LIVE_SUBSCRIPTION.has(x.status)), endOf, fitsDomain);
  const restPairs = pairByDate(named.filter((x) => !livePairs.has(x)), domainSubs.filter((x) => !LIVE_SUBSCRIPTION.has(x.status)), endOf, fitsDomain);
  for (const [dm, sub] of [...livePairs, ...restPairs]) {
    sub.domain = dm.name;
    dm.subscriptionId = sub.id;
  }
  // A TLD held by a single domain and a single subscription is the same thing.
  for (const sub of domainSubs.filter((x) => !x.domain)) {
    const tld = tldOf(sub.name);
    if (!tld) continue;
    const doms = [...new Set(domains.filter((x) => lower(x.name).endsWith(tld)).map((x) => x.name))];
    const subsOfTld = domainSubs.filter((x) => tldOf(x.name) === tld);
    if (doms.length !== 1 || subsOfTld.length !== 1 || domains.some((x) => x.name === doms[0] && x.subscriptionId)) continue;
    sub.domain = doms[0];
    for (const dm of domains) if (dm.name === doms[0]) dm.subscriptionId = sub.id;
  }
  // A mailbox on trial belongs to a subscription on trial, and the other way round.
  const mailPairs = pairByDate(
    mailOrders.filter((x) => x.expiresAt && x.status !== 'suspended'),
    subscriptions.filter((x) => x.kind === 'email' && LIVE_SUBSCRIPTION.has(x.status)),
    (x) => x.expiresAt,
    (mo, sub) => mo.trial === (sub.status === 'in_trial'),
  );
  for (const [mo, sub] of mailPairs) {
    sub.mailDomain = mo.domain;
    mo.subscriptionId = sub.id;
  }
  // A hosting plan with one website is named after it; with many, the screens show the count.
  for (const sub of subscriptions) {
    const sites = sub.websites || [];
    const site = sites.length === 1 ? sites[0] : null;
    const target = sub.domain || sub.mailDomain || (site && !isTemporaryDomain(site) ? site : '');
    sub.title = target ? `${target} (${sub.name})` : sub.name;
  }
  return { fetchedAt: new Date().toISOString(), domains, subscriptions, websites, hostingOrders, mailOrders, paymentMethods, errors };
}

async function renderList(path, token, key) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 10; page += 1) {
    const url = `${RENDER_BASE}${path}${path.includes('?') ? '&' : '?'}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const body = await getJson(url, token);
    const items = Array.isArray(body) ? body : [];
    for (const it of items) if (it && (it[key] || it.id)) out.push(it[key] || it);
    if (items.length < 100) break;
    cursor = items[items.length - 1].cursor;
    if (!cursor) break;
  }
  return out;
}

// Runs fn over items, a few at a time.
async function eachLimited(items, limit, fn) {
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const it = items[i];
      i += 1;
      await fn(it);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export async function renderSnapshot(token) {
  const errors = [];
  const keyValueList = () => renderList('/key-value', token, 'keyValue').catch((e) => {
    if (e && e.code === 'http_404') return renderList('/redis', token, 'redis');
    throw e;
  });
  const [sv, pg, kv, ow] = await Promise.allSettled([
    renderList('/services', token, 'service'),
    renderList('/postgres', token, 'postgres'),
    keyValueList(),
    renderList('/owners', token, 'owner'),
  ]);
  const services = (settle(sv, errors, 'services') || []).slice(0, MAX_ITEMS).map((x) => {
    const det = x.serviceDetails || {};
    return {
      id: str(x.id, 60),
      name: str(x.name),
      type: str(x.type, 40),
      suspended: x.suspended === 'suspended',
      plan: str(det.plan, 40),
      region: str(det.region || x.region, 40),
      runtime: str(det.runtime || det.env, 40),
      instances: Number(det.numInstances) || null,
      url: str(det.url, 300),
      repo: str(x.repo, 300),
      branch: str(x.branch, 120),
      ownerId: str(x.ownerId, 60),
      dashboardUrl: str(x.dashboardUrl, 300),
      createdAt: date(x.createdAt),
      updatedAt: date(x.updatedAt),
    };
  });
  const databases = (settle(pg, errors, 'postgres') || []).slice(0, MAX_ITEMS).map((x) => ({
    id: str(x.id, 60),
    name: str(x.name),
    plan: str(x.plan, 40),
    status: str(x.status, 40),
    region: str(x.region, 40),
    version: str(x.version, 10),
    diskSizeGB: Number(x.diskSizeGB) || null,
    expiresAt: date(x.expiresAt),
    suspended: x.suspended === 'suspended',
    ownerId: str((x.owner && x.owner.id) || x.ownerId, 60),
    dashboardUrl: str(x.dashboardUrl, 300),
    createdAt: date(x.createdAt),
  }));
  const keyValues = (settle(kv, errors, 'key_value') || []).slice(0, MAX_ITEMS).map((x) => ({
    id: str(x.id, 60),
    name: str(x.name),
    plan: str(x.plan, 40),
    status: str(x.status, 40),
    region: str(x.region, 40),
    ownerId: str((x.owner && x.owner.id) || x.ownerId, 60),
    dashboardUrl: str(x.dashboardUrl, 300),
    createdAt: date(x.createdAt),
  }));
  const owners = (settle(ow, errors, 'owners') || []).slice(0, 50).map((x) => ({
    id: str(x.id, 60),
    name: str(x.name, 120),
    email: str(x.email, 200),
    type: str(x.type, 20),
  }));
  if (!sv.value && !pg.value) throw new IntegrationError(errors[0].split(':')[1]);
  // Custom domains people reach each website on.
  const withDomains = services.filter((x) => ['web_service', 'static_site'].includes(x.type)).slice(0, 60);
  let domainError = null;
  await eachLimited(withDomains, 4, async (svc) => {
    try {
      const list = await renderList(`/services/${encodeURIComponent(svc.id)}/custom-domains`, token, 'customDomain');
      svc.customDomains = list.slice(0, 50).map((c) => ({ name: domainName(c.name), verified: c.verificationStatus === 'verified', type: str(c.domainType, 20) }));
    } catch (e) {
      domainError ||= (e && e.code) || 'failed';
    }
  });
  if (domainError) errors.push(`custom_domains:${domainError}`);
  return { fetchedAt: new Date().toISOString(), services, databases, keyValues, owners, errors };
}

// Everything that ends, renews or needs attention within `windowDays` (or already did), for alerts.
// Days are whole calendar days to the end date as the provider shows it (its UTC date):
// a domain ending 2026-11-30T23:59:59Z is "9 days" on 2026-11-21, as in hPanel.
export function upcoming({ hostinger, render }, windowDays = 60, now = Date.now()) {
  const items = [];
  const push = (key, title, at, source, extra = {}) => {
    const t = Date.parse(at);
    if (!Number.isFinite(t)) return;
    const days = Math.floor(t / DAY) - Math.floor(now / DAY);
    if (days <= windowDays) items.push({ key, title, at, source, days, ...extra });
  };
  if (hostinger && !hostinger.error) {
    const live = (hostinger.subscriptions || []).filter((x) => LIVE_SUBSCRIPTION.has(x.status));
    const coveredDomains = new Set(live.filter((x) => x.domain).map((x) => x.domain));
    const coveredMail = new Set(live.filter((x) => x.mailDomain).map((x) => x.mailDomain));
    const seen = new Set();
    for (const x of hostinger.domains || []) {
      if (!x.expiresAt || coveredDomains.has(x.name) || seen.has(x.name) || ['deleted', 'failed', 'requested'].includes(x.status)) continue;
      seen.add(x.name);
      push(`hd:${x.name}`, x.name, x.expiresAt, 'hostinger_domain');
    }
    for (const x of live) {
      push(`hs:${x.id}`, x.title || x.name, subscriptionDate(x), 'hostinger_subscription', { autoRenew: x.autoRenew, price: x.renewalPrice, currency: x.currency });
    }
    for (const x of hostinger.mailOrders || []) {
      if (x.subscriptionId || coveredMail.has(x.domain) || x.status === 'suspended') continue;
      push(`hm:${x.id}`, `${x.domain || 'E-mail'} (${x.plan || 'E-mail'})`, x.expiresAt, 'hostinger_mail');
    }
    for (const x of hostinger.paymentMethods || []) {
      const title = [x.name, x.identifier].filter(Boolean).join(' ');
      if (x.expired || x.suspended) push(`hp:${x.id}`, title, new Date(now).toISOString(), 'hostinger_card', { problem: x.expired ? 'expired' : 'suspended' });
      else if (x.expiresAt) push(`hp:${x.id}`, title, x.expiresAt, 'hostinger_card', { isDefault: x.isDefault });
    }
  }
  if (render && !render.error) {
    for (const p of render.databases || []) if (p.expiresAt) push(`rp:${p.id}`, p.name, p.expiresAt, 'render_database', { link: p.dashboardUrl || null });
  }
  return items.sort((a, b) => a.days - b.days);
}
