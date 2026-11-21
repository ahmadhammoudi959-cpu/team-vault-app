// Pure logic for the subscriptions screens: prices, charge dates, alert stages, clients,
// the monthly report and its CSV. No DOM and no network, so it runs (and is tested) in Node too.

export const DAY_MS = 86_400_000;

// Monthly list prices from render.com/pricing (USD), keyed by the plan names the Render API returns.
// Estimates only: bandwidth, build minutes, disks and the workspace plan are billed on top.
export const RENDER_PRICES = {
  service: { free: 0, starter: 7, standard: 25, pro: 85, pro_plus: 175, pro_max: 225, pro_ultra: 450 },
  postgres: {
    free: 0,
    basic_256mb: 6,
    basic_1gb: 19,
    basic_4gb: 75,
    pro_4gb: 55,
    pro_8gb: 100,
    pro_16gb: 200,
    pro_32gb: 400,
    pro_64gb: 800,
    pro_128gb: 1700,
    accelerated_16gb: 160,
    accelerated_32gb: 350,
    accelerated_64gb: 750,
    accelerated_128gb: 1500,
    // older plans, storage included
    starter: 7,
    standard: 20,
    pro: 95,
    pro_plus: 185,
  },
  keyValue: { free: 0, starter: 10 },
};
// Storage on the newer Postgres plans is billed per GB on top of the instance.
export const POSTGRES_GB_PRICE = 0.3;

export function renderPrice(kind, plan, diskGB = null) {
  const table = RENDER_PRICES[kind];
  const k = String(plan || '').toLowerCase().replace(/-/g, '_');
  if (!table || !Object.hasOwn(table, k)) return null;
  let p = table[k];
  if (kind === 'postgres' && p > 0 && diskGB && /^(basic|pro|accelerated)_\d/.test(k)) p += diskGB * POSTGRES_GB_PRICE;
  return Math.round(p * 100) / 100;
}

// Hostinger subscription states that still count (both spellings occur in practice).
export const LIVE = new Set(['active', 'not_renewing', 'non_renewing', 'in_trial', 'paused']);
const AUTO = new Set(['active', 'in_trial']);

// The date a subscription next costs money (auto-renewal) or ends (no auto-renewal).
export const subDate = (s) => (s.autoRenew && s.nextBillingAt) || s.expiresAt || s.nextBillingAt || null;

// ---------------------------------------------------------------------------
// days and months (provider dates are counted by their UTC calendar day, as the providers show them)
// ---------------------------------------------------------------------------
export function dayOf(v) {
  if (v === null || v === undefined || v === '') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T[\d:.]+Z)?$/.exec(String(v));
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

export const dayMs = (v) => {
  const d = dayOf(v);
  return d ? Date.parse(`${d}T00:00:00Z`) : null;
};

// Whole days from today (the viewer's calendar day) to that day; negative when it has passed.
export function daysFrom(v, now = new Date()) {
  const t = dayMs(v);
  if (t === null) return null;
  return Math.round((t - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / DAY_MS);
}

export const todayMs = (now = new Date()) => Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());

export const monthKey = (now = new Date()) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

export function shiftMonth(key, n) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function monthRange(key) {
  const [y, m] = key.split('-').map(Number);
  return { start: Date.UTC(y, m - 1, 1), end: Date.UTC(y, m, 1) };
}

// Same day n months later (clamped to the month's last day), at UTC midnight.
export function addMonths(ms, n) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + n;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(d.getUTCDate(), last));
}

export function periodMonths(count, unit) {
  const c = Number(count) || 0;
  const u = String(unit || '').toLowerCase().replace(/s$/, '');
  if (c <= 0) return null;
  if (u === 'month') return c;
  if (u === 'year') return c * 12;
  return null;
}

// Days inside the month on which a recurring charge falls: the anchor plus or minus whole periods.
export function datesInMonth(anchor, months, range, { from = -Infinity, until = Infinity } = {}) {
  if (!Number.isFinite(anchor)) return [];
  const ok = (t) => t >= range.start && t < range.end && t >= from && t <= until;
  if (!months) return ok(anchor) ? [anchor] : [];
  const a = new Date(anchor);
  const r = new Date(range.start);
  const diff = (r.getUTCFullYear() - a.getUTCFullYear()) * 12 + (r.getUTCMonth() - a.getUTCMonth());
  const k0 = Math.floor(diff / months);
  const out = [];
  for (let k = k0 - 1; k <= k0 + 1; k += 1) {
    const t = addMonths(anchor, k * months);
    if (ok(t) && !out.includes(t)) out.push(t);
  }
  return out;
}

// The first day on or after `today` a recurring charge falls on (or its single date).
export function nextOn(anchor, months, today) {
  if (!Number.isFinite(anchor)) return null;
  if (!months || anchor >= today) return anchor;
  const a = new Date(anchor);
  const t = new Date(today);
  let k = Math.max(0, Math.floor(((t.getUTCFullYear() - a.getUTCFullYear()) * 12 + (t.getUTCMonth() - a.getUTCMonth())) / months) - 1);
  for (let i = 0; i < 4; i += 1, k += 1) {
    const d = addMonths(anchor, k * months);
    if (d >= today) return d;
  }
  return addMonths(anchor, k * months);
}

// ---------------------------------------------------------------------------
// alerts: first two months ahead, again one month ahead, again in the last week, then when due
// ---------------------------------------------------------------------------
export const ALERT_WINDOW = 60;

export function stageOf(days) {
  if (days === null || days === undefined) return null;
  if (days <= 0) return 'due';
  if (days <= 7) return 'week';
  if (days <= 30) return 'month';
  if (days <= ALERT_WINDOW) return 'two_months';
  return null;
}

// `renewals` come from the server (Hostinger, Render); `entries` are vault dates; `extras` are
// recurring costs typed in by admins.
export function alertItems({ renewals = [], entries = [], extras = [], now = new Date() }) {
  const today = todayMs(now);
  const out = [];
  for (const x of renewals) out.push({ ...x, day: dayOf(x.at) });
  for (const e of entries) {
    if (e.renewAt) out.push({ key: `e:${e.id}`, title: e.title, at: e.renewAt, source: 'entry', entryId: e.id, client: e.client, day: dayOf(e.renewAt) });
  }
  for (const x of extras) {
    const next = nextOn(dayMs(x.start), Number(x.periodMonths) || null, today);
    if (next !== null) out.push({ key: `x:${x.id}`, title: x.title, at: dayOf(next), source: 'extra', price: num(x.cost), currency: x.currency || '', client: x.client || '', day: dayOf(next) });
  }
  return out
    .map((x) => ({ ...x, days: daysFrom(x.day, now) }))
    .filter((x) => x.days !== null && x.days <= ALERT_WINDOW)
    .map((x) => ({ ...x, stage: stageOf(x.days) }))
    .sort((a, b) => a.days - b.days || String(a.title).localeCompare(String(b.title)));
}

// What gets marked as seen: the thing, its date and the stage. A new stage alerts again.
export const alertLabel = (x) => `${x.key}|${x.day}|${x.stage}`;

// ---------------------------------------------------------------------------
// clients
// ---------------------------------------------------------------------------
// A client whose vault accounts mention this domain (website address, username, hosting...).
export function guessClient(domain, entries) {
  const d = String(domain || '').toLowerCase().replace(/^www\./, '').trim();
  if (!d || !d.includes('.')) return null;
  const hits = new Set();
  for (const e of entries) {
    const hay = [e.url, e.username, e.label, e.hosting].filter(Boolean).join(' ').toLowerCase();
    if (hay.includes(d)) hits.add(e.client);
  }
  return hits.size === 1 ? [...hits][0] : null;
}

export const domainOf = (s) => s.domain || s.mailDomain || (s.websites && s.websites[0]) || null;

// ---------------------------------------------------------------------------
// the monthly report
// ---------------------------------------------------------------------------
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export const emptyDoc = (salt) => ({ v: 1, noticeSalt: salt, items: {}, extras: [] });

// One row per charge in `month` (YYYY-MM). `doc` is the admins' billing document.
export function monthCharges({ hostinger = null, render = null, doc = null, entries = [], month, now = new Date() }) {
  const range = monthRange(month);
  const notes = (doc && doc.items) || {};
  const today = todayMs(now);
  const rows = [];
  const add = (row) => {
    const a = notes[row.key] || {};
    const costSet = num(a.cost) !== null;
    rows.push({
      ...row,
      cost: costSet ? num(a.cost) : row.cost,
      currency: costSet ? a.costCurrency || row.currency : row.currency,
      costEdited: costSet,
      client: a.client || row.client || row.guess || '',
      clientGuessed: !a.client && !row.client && !!row.guess,
      sell: num(a.sell) ?? num(row.sell),
      sellCurrency: a.sellCurrency || row.sellCurrency || row.currency || '',
      note: a.note || row.note || '',
      state: row.date >= today || row.state === 'monthly' ? row.state : ['auto', 'recurring'].includes(row.state) ? 'charged' : 'past',
    });
  };

  const h = hostinger && !hostinger.error && !hostinger.notConfigured && !hostinger.loading ? hostinger : null;
  for (const s of (h && h.subscriptions) || []) {
    if (!LIVE.has(s.status) && s.status !== 'cancelled') continue;
    const anchor = dayMs(subDate(s));
    if (anchor === null) continue;
    const months = periodMonths(s.periodCount, s.periodUnit);
    const created = dayMs(s.createdAt);
    const auto = s.autoRenew && AUTO.has(s.status);
    // Auto-renewing: past and future charges. Otherwise: past charges, plus the manual renewal
    // date itself while the subscription is still running.
    let until = Infinity;
    if (!auto) until = LIVE.has(s.status) ? anchor : anchor - DAY_MS;
    const from = created !== null ? created - 2 * DAY_MS : -Infinity;
    for (const t of datesInMonth(anchor, months, range, { from, until })) {
      const first = created !== null && Math.abs(t - created) <= 2 * DAY_MS;
      add({
        key: `hs:${s.id}`,
        provider: 'hostinger',
        kind: s.kind || 'other',
        title: s.title || s.name,
        date: t,
        cost: first ? num(s.totalPrice) ?? num(s.renewalPrice) : num(s.renewalPrice),
        currency: s.currency || '',
        state: auto ? 'auto' : 'manual',
        guess: guessClient(domainOf(s), entries),
      });
    }
  }

  const r = render && !render.error && !render.notConfigured && !render.loading ? render : null;
  if (r) {
    const lastDay = range.end - DAY_MS;
    const monthly = (key, kind, title, price, created, suspended, domain) => {
      const a = notes[key];
      const billedByUs = a && (num(a.cost) !== null || num(a.sell) !== null);
      if (price === 0 && !billedByUs) return;
      if (suspended && !billedByUs) return;
      if (created !== null && created >= range.end) return;
      add({ key, provider: 'render', kind, title, date: lastDay, cost: price, currency: 'USD', estimated: price !== null, state: 'monthly', guess: guessClient(domain, entries) });
    };
    for (const x of r.services || []) {
      const price = x.type === 'static_site' ? 0 : x.type === 'cron_job' ? null : renderPrice('service', x.plan);
      const domain = (x.customDomains && x.customDomains[0] && x.customDomains[0].name) || null;
      monthly(`rs:${x.id}`, 'service', x.name, price, dayMs(x.createdAt), x.suspended, domain);
    }
    for (const x of r.databases || []) monthly(`rp:${x.id}`, 'postgres', x.name, renderPrice('postgres', x.plan, x.diskSizeGB), dayMs(x.createdAt), x.suspended, null);
    for (const x of r.keyValues || []) monthly(`rk:${x.id}`, 'key_value', x.name, renderPrice('keyValue', x.plan), dayMs(x.createdAt), false, null);
  }

  for (const x of (doc && doc.extras) || []) {
    const anchor = dayMs(x.start);
    for (const t of datesInMonth(anchor, Number(x.periodMonths) || null, range, { from: anchor })) {
      add({ key: `x:${x.id}`, provider: 'other', providerName: x.provider || '', kind: 'extra', title: x.title, date: t, cost: num(x.cost), currency: x.currency || '', state: 'recurring', client: x.client || '', sell: x.sell, sellCurrency: x.sellCurrency, note: x.note });
    }
  }

  for (const e of entries) {
    if (!e.renewAt) continue;
    for (const t of datesInMonth(dayMs(e.renewAt), null, range)) {
      add({ key: `e:${e.id}`, provider: 'vault', kind: 'reminder', title: e.title, date: t, cost: null, currency: '', state: 'manual', client: e.client });
    }
  }
  return rows.sort((a, b) => a.date - b.date || String(a.title).localeCompare(String(b.title)));
}

function addTo(bag, cur, v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return;
  const k = cur || '—';
  bag[k] = Math.round(((bag[k] || 0) + v) * 100) / 100;
}

export function summarize(rows) {
  const cost = {};
  const sell = {};
  const clients = new Map();
  let unassigned = 0;
  let unknownCost = 0;
  let manual = 0;
  for (const r of rows) {
    addTo(cost, r.currency, r.cost);
    addTo(sell, r.sellCurrency, r.sell);
    if (!r.client) unassigned += 1;
    if (r.cost === null && r.provider !== 'vault') unknownCost += 1;
    if (r.state === 'manual') manual += 1;
    const c = r.client || '';
    if (!clients.has(c)) clients.set(c, { client: c, count: 0, cost: {}, sell: {} });
    const g = clients.get(c);
    g.count += 1;
    addTo(g.cost, r.currency, r.cost);
    addTo(g.sell, r.sellCurrency, r.sell);
  }
  const list = [...clients.values()].sort((a, b) => (a.client ? 0 : 1) - (b.client ? 0 : 1) || a.client.localeCompare(b.client, 'ar'));
  return { cost, sell, unassigned, unknownCost, manual, clients: list };
}

// Excel-friendly CSV (UTF-8 with BOM). Text that a spreadsheet could run as a formula is defused.
export function toCsv(rows, { provider = {}, state = {} } = {}) {
  const text = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  };
  const esc = (s) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const head = ['التاريخ', 'البند', 'المزوّد', 'العميل', 'التكلفة', 'العملة', 'المطلوب من العميل', 'عملة العميل', 'الحالة', 'ملاحظة'];
  const lines = rows.map((r) => [
    dayOf(r.date),
    text(r.title),
    r.providerName || provider[r.provider] || r.provider,
    text(r.client),
    r.cost === null || r.cost === undefined ? '' : String(r.cost),
    r.currency || '',
    r.sell === null || r.sell === undefined ? '' : String(r.sell),
    r.sell === null || r.sell === undefined ? '' : r.sellCurrency || '',
    state[r.state] || r.state,
    text(r.note),
  ]);
  return `﻿${[head, ...lines].map((cols) => cols.map((c) => esc(String(c))).join(',')).join('\r\n')}\r\n`;
}
