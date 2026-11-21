// Matching Hostinger domains, mailboxes and websites to their subscriptions, on data shaped
// like a real agency account (eleven .de domains, eight mailboxes, one hosting plan).
//   node --test test/integrations.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const end = (d) => `${d}T23:59:59.000Z`;
const at = (d) => `${d}T10:00:00.000Z`;
const sub = (id, name, status, auto, date, years = 1) => ({
  id, name, status, is_auto_renewed: auto, billing_period: years, billing_period_unit: 'year', currency_code: 'EUR',
  total_price: 499, renewal_price: 1199, created_at: at('2025-11-01'),
  expires_at: auto ? null : at(date), next_billing_at: auto ? at(date) : null,
});
const mail = (id, domain, date, { trial = false, status = 'active' } = {}) => ({
  id, status, is_trial: trial, seats: 1, domain: domain ? { id: `d-${id}`, name: domain } : null,
  plan: { name: 'starter', title: trial ? 'Starter Business Email Free Trial' : 'Starter Business Email' }, created_at: at('2025-11-01'), expires_at: end(date),
});

const DATA = {
  '/api/domains/v1/portfolio': [
    { id: 1, domain: 'agentur-beispiel.de', type: 'free_domain', status: 'active', created_at: at('2025-10-16'), expires_at: null },
    { id: 2, domain: 'agentur-beispiel.de', type: 'domain', status: 'active', created_at: at('2025-10-16'), expires_at: end('2027-10-31') },
    { id: 3, domain: 'xn--bckerei-beispiel-vnb.de', type: 'domain', status: 'active', created_at: at('2025-11-20'), expires_at: end('2026-11-30') },
    { id: 4, domain: 'baeckerei-beispiel.de', type: 'domain', status: 'active', created_at: at('2025-11-28'), expires_at: end('2027-11-30') },
    { id: 5, domain: 'bau-beispiel.de', type: 'domain_transfer', status: 'pending_setup', created_at: at('2026-10-08'), expires_at: null },
    { id: 6, domain: 'hausservice-beispiel.de', type: 'domain', status: 'active', created_at: at('2026-07-28'), expires_at: end('2027-07-31') },
    { id: 7, domain: 'moebel-beispiel.de', type: 'domain', status: 'active', created_at: at('2026-08-26'), expires_at: end('2027-08-31') },
    { id: 8, domain: 'show-beispiel.de', type: 'domain', status: 'active', created_at: at('2026-09-30'), expires_at: end('2027-09-30') },
    { id: 9, domain: 'mode-beispiel.de', type: 'domain', status: 'active', created_at: at('2026-11-05'), expires_at: end('2027-11-30') },
    { id: 10, domain: 'sport-beispiel.de', type: 'domain', status: 'active', created_at: at('2026-11-17'), expires_at: end('2027-11-30') },
  ],
  '/api/billing/v1/subscriptions': [
    sub('E1', 'Starter Business Email', 'active', true, '2030-11-03', 4),
    sub('D1', '.DE Domain', 'active', true, '2027-11-03'),
    sub('E2', 'Starter Business Email', 'in_trial', true, '2027-11-05'),
    sub('E3', 'Starter Business Email', 'active', true, '2027-10-22'),
    sub('D2', '.DE Domain', 'active', true, '2027-11-03'),
    sub('D3', '.DE Domain', 'non_renewing', false, '2027-10-08'),
    sub('E4', 'Starter Business Email', 'active', true, '2027-09-16'),
    sub('D4', '.DE Domain', 'active', true, '2027-09-03'),
    sub('E5', 'Starter Business Email', 'active', true, '2030-08-12', 4),
    sub('D5', '.DE Domain', 'active', true, '2027-08-04'),
    sub('D6', '.DE Domain', 'active', true, '2027-07-04'),
    sub('H1', 'Business Web Hosting', 'active', true, '2028-04-14'),
    sub('E6', 'Starter Business Email', 'active', true, '2027-11-14'),
    sub('D7', '.DE Domain', 'active', true, '2027-11-03'),
    sub('E7', 'Starter Business Email', 'non_renewing', false, '2027-11-20'),
    sub('D8', '.DE Domain', 'non_renewing', false, '2026-11-30'),
    sub('D9', '.DE Domain', 'active', true, '2027-10-04'),
    sub('E8', 'Premium Business Email', 'active', true, '2026-12-17'),
  ],
  '/api/mail/v1/orders': {
    data: [
      mail('A', null, '2030-11-17', { status: 'pending_setup' }),
      mail('B', 'mode-beispiel.de', '2027-11-05', { trial: true }),
      mail('C', null, '2027-11-05', { status: 'pending_setup' }),
      mail('D', 'show-beispiel.de', '2027-09-30'),
      mail('E', 'moebel-beispiel.de', '2030-08-26'),
      mail('F', 'baeckerei-beispiel.de', '2027-11-28'),
      mail('G', 'xn--bckerei-beispiel-vnb.de', '2027-11-20'),
      mail('H', 'agentur-beispiel.de', '2026-12-17'),
    ],
    meta: { current_page: 1, per_page: 25, total: 8 },
  },
  '/api/hosting/v1/websites': {
    data: [
      { domain: 'quiet-blue-otter-12.hostingersite.com', website_type: 'other', is_enabled: true, order_id: 77, created_at: at('2026-04-14') },
      { domain: 'sport-beispiel.de', website_type: 'wordpress', is_enabled: true, order_id: 77, created_at: at('2026-11-17') },
      { domain: 'moebel-beispiel.de', website_type: 'nodejs', is_enabled: true, order_id: 77, created_at: at('2026-08-26') },
    ],
    meta: { current_page: 1, per_page: 25, total: 3 },
  },
  '/api/hosting/v1/orders': { data: [{ id: 77, subscription_id: 'H1', plan: { name: 'hostinger_business_v3' }, status: 'active', created_at: at('2025-04-14') }], meta: { total: 1 } },
  '/api/billing/v1/payment-methods': [{ id: 9, name: 'Card', identifier: 'visa_ending_0000', payment_method: 'card', is_default: true, is_expired: false, is_suspended: false, expires_at: at('2030-08-01') }],
};

test('real-world matching: exact dates first, trial with trial, no guessing when ambiguous', async (t) => {
  const server = http.createServer((req, res) => {
    const body = DATA[new URL(req.url, 'http://x').pathname];
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body || { message: 'not found' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  process.env.HOSTINGER_API_BASE = `http://127.0.0.1:${server.address().port}`;
  const { hostingerSnapshot, isTemporaryDomain } = await import(`../src/integrations.js?${Date.now()}`);
  const snap = await hostingerSnapshot('token');
  assert.deepEqual(snap.errors, []);
  const subs = Object.fromEntries(snap.subscriptions.map((x) => [x.id, x]));

  // domains
  assert.equal(subs.D8.domain, 'bäckerei-beispiel.de', 'same end date');
  assert.equal(subs.D6.domain, 'hausservice-beispiel.de');
  assert.equal(subs.D5.domain, 'moebel-beispiel.de');
  assert.equal(subs.D4.domain, 'show-beispiel.de');
  assert.equal(subs.D9.domain, 'agentur-beispiel.de', 'the not-renewing one ends on another date, so it cannot be this domain');
  for (const id of ['D1', 'D2', 'D7']) assert.equal(subs[id].domain, undefined, 'three domains, three identical charges: left unmatched');
  assert.equal(subs.D3.domain, undefined);

  // mailboxes
  const mo = Object.fromEntries(snap.mailOrders.map((x) => [x.id, x]));
  assert.equal(mo.B.subscriptionId, 'E2', 'trial mailbox ↔ trial subscription');
  assert.equal(mo.G.subscriptionId, 'E7', 'exact end date wins');
  assert.equal(mo.H.subscriptionId, 'E8');
  assert.equal(mo.A.subscriptionId, 'E1');
  assert.equal(mo.C.subscriptionId, 'E3');
  assert.equal(mo.D.subscriptionId, 'E4');
  assert.equal(mo.E.subscriptionId, 'E5');
  assert.equal(mo.F.subscriptionId, 'E6');
  assert.equal(subs.E7.title, 'bäckerei-beispiel.de (Starter Business Email)');
  assert.equal(subs.E1.title, 'Starter Business Email', 'mailbox without a domain yet');

  // hosting
  assert.equal(subs.H1.title, 'Business Web Hosting', 'many websites: no single name');
  assert.deepEqual(subs.H1.websites.sort(), ['moebel-beispiel.de', 'quiet-blue-otter-12.hostingersite.com', 'sport-beispiel.de']);
  assert.equal(subs.H1.plan, 'Business');
  assert.ok(snap.websites.every((w) => w.subscriptionId === 'H1'));
  assert.equal(snap.websites.find((w) => w.domain.startsWith('quiet-blue')).temporary, true);
  assert.equal(isTemporaryDomain('sport-beispiel.de'), false);
});
