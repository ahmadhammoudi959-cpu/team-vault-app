// Unit tests for the pure billing logic used by the subscriptions screens.
//   node --test test/billing.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as b from '../public/js/billing.js';

const NOW = new Date(2026, 10, 21, 18, 30); // 21 Nov 2026, local time
const iso = (d) => `${d}T00:00:00.000Z`;

test('render prices follow the published list and add storage on newer Postgres plans', () => {
  assert.equal(b.renderPrice('service', 'starter'), 7);
  assert.equal(b.renderPrice('service', 'standard'), 25);
  assert.equal(b.renderPrice('service', 'free'), 0);
  assert.equal(b.renderPrice('service', 'mystery'), null);
  assert.equal(b.renderPrice('postgres', 'basic-256mb'), 6);
  assert.equal(b.renderPrice('postgres', 'basic_1gb', 10), 22);
  assert.equal(b.renderPrice('postgres', 'standard', 10), 20, 'older plans include storage');
  assert.equal(b.renderPrice('keyValue', 'starter'), 10);
  assert.equal(b.renderPrice('postgres', 'toString'), null, 'no prototype lookups');
});

test('days count by the provider calendar day', () => {
  assert.equal(b.daysFrom('2026-11-30T23:59:59.000Z', NOW), 9);
  assert.equal(b.daysFrom('2026-11-30', NOW), 9);
  assert.equal(b.daysFrom('2026-11-21', NOW), 0);
  assert.equal(b.daysFrom('2026-11-16T10:00:00.000Z', NOW), -5);
  assert.equal(b.daysFrom('', NOW), null);
});

test('alert stages: two months, one month, last week, due', () => {
  assert.equal(b.stageOf(61), null);
  assert.equal(b.stageOf(60), 'two_months');
  assert.equal(b.stageOf(31), 'two_months');
  assert.equal(b.stageOf(30), 'month');
  assert.equal(b.stageOf(8), 'month');
  assert.equal(b.stageOf(7), 'week');
  assert.equal(b.stageOf(1), 'week');
  assert.equal(b.stageOf(0), 'due');
  assert.equal(b.stageOf(-3), 'due');
});

test('months: shifting, ranges and clamped month-end dates', () => {
  assert.equal(b.monthKey(NOW), '2026-11');
  assert.equal(b.shiftMonth('2026-11', 2), '2027-01');
  assert.equal(b.shiftMonth('2026-01', -1), '2025-12');
  const r = b.monthRange('2026-02');
  assert.equal(new Date(r.start).toISOString().slice(0, 10), '2026-02-01');
  assert.equal(new Date(r.end).toISOString().slice(0, 10), '2026-03-01');
  assert.equal(new Date(b.addMonths(Date.parse(iso('2026-01-31')), 1)).toISOString().slice(0, 10), '2026-02-28');
  assert.equal(b.periodMonths(4, 'year'), 48);
  assert.equal(b.periodMonths(12, 'months'), 12);
  assert.equal(b.periodMonths(7, 'day'), null);
});

test('recurring dates are found before and after the anchor', () => {
  const anchor = Date.parse(iso('2027-11-03'));
  const nov26 = b.monthRange('2026-11');
  assert.deepEqual(b.datesInMonth(anchor, 12, nov26).map((t) => new Date(t).toISOString().slice(0, 10)), ['2026-11-03']);
  assert.deepEqual(b.datesInMonth(anchor, 12, nov26, { from: Date.parse(iso('2026-12-01')) }), [], 'not before the purchase');
  assert.deepEqual(b.datesInMonth(anchor, 12, b.monthRange('2027-05')), []);
  assert.equal(b.datesInMonth(anchor, 1, b.monthRange('2027-02')).length, 1);
  const next = b.nextOn(Date.parse(iso('2026-01-15')), 1, b.todayMs(NOW));
  assert.equal(new Date(next).toISOString().slice(0, 10), '2026-12-15');
});

const hostinger = {
  subscriptions: [
    // auto-renewing yearly domain, next charge 3 Nov 2027 → charged 3 Nov 2026 too (bought before)
    { id: 's1', name: '.DE Domain', kind: 'domain', title: 'mode-beispiel.de (.DE Domain)', domain: 'mode-beispiel.de', status: 'active', autoRenew: true, renewalPrice: 11.99, totalPrice: 4.99, currency: 'EUR', periodCount: 1, periodUnit: 'year', createdAt: '2025-11-05T10:00:00.000Z', nextBillingAt: '2027-11-03T10:00:00.000Z', expiresAt: null },
    // not renewing: ends 30 Nov 2026 → a manual renewal in November, nothing after
    { id: 's2', name: '.DE Domain', kind: 'domain', title: 'bäckerei-beispiel.de (.DE Domain)', domain: 'bäckerei-beispiel.de', status: 'non_renewing', autoRenew: false, renewalPrice: 11.99, totalPrice: 4.99, currency: 'EUR', periodCount: 1, periodUnit: 'year', createdAt: '2025-11-20T10:00:00.000Z', nextBillingAt: null, expiresAt: '2026-11-30T23:59:59.000Z' },
    // monthly hosting, charged on the 17th
    { id: 's3', name: 'Premium Business Email', kind: 'email', title: 'Premium Business Email', status: 'active', autoRenew: true, renewalPrice: 5.99, totalPrice: 5.99, currency: 'EUR', periodCount: 1, periodUnit: 'month', createdAt: '2026-09-17T14:44:02.000Z', nextBillingAt: '2026-12-17T14:44:02.000Z', expiresAt: null },
    // cancelled: past charges only
    { id: 's4', name: '.COM Domain', kind: 'domain', title: '.COM Domain', status: 'cancelled', autoRenew: false, renewalPrice: 20.19, totalPrice: 9.99, currency: 'USD', periodCount: 1, periodUnit: 'year', createdAt: '2025-11-16T10:00:00.000Z', nextBillingAt: null, expiresAt: '2026-11-16T10:00:00.000Z' },
  ],
};
const render = {
  services: [
    { id: 'srv-1', name: 'star-style', type: 'web_service', plan: 'free', createdAt: '2026-01-01T00:00:00Z', customDomains: [{ name: 'www.mode-beispiel.de' }] },
    { id: 'srv-2', name: 'nile-api', type: 'web_service', plan: 'standard', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'srv-3', name: 'old-api', type: 'web_service', plan: 'starter', suspended: true, createdAt: '2026-01-01T00:00:00Z' },
    { id: 'srv-4', name: 'nightly', type: 'cron_job', plan: 'starter', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'srv-5', name: 'future', type: 'web_service', plan: 'pro', createdAt: '2026-12-02T00:00:00Z' },
  ],
  databases: [
    { id: 'dpg-1', name: 'free-db', plan: 'free', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'dpg-2', name: 'nile-db', plan: 'basic_256mb', diskSizeGB: 5, createdAt: '2026-01-01T00:00:00Z' },
  ],
  keyValues: [{ id: 'red-1', name: 'cache', plan: 'starter', createdAt: '2026-01-01T00:00:00Z' }],
};
const entries = [
  { id: 'e1', client: 'Mode Beispiel', title: 'Mode Beispiel: Website', url: 'https://mode-beispiel.de', renewAt: '2026-11-25' },
  { id: 'e2', client: 'Nile Foods', title: 'Nile Foods: Domain', url: 'https://nilefoods.net' },
];

test('the November report has every charge, with clients and prices', () => {
  const doc = {
    v: 1,
    items: {
      'hs:s2': { client: 'Bäckerei Beispiel', sell: 25, sellCurrency: 'EUR' },
      'rs:srv-2': { client: 'Nile Foods', sell: 40, sellCurrency: 'USD' },
      'rs:srv-4': { cost: 3.5 },
    },
    extras: [{ id: 'x1', title: 'Meta ads management', client: 'Mode Beispiel', cost: 0, currency: 'EUR', sell: 300, sellCurrency: 'EUR', periodMonths: 1, start: '2026-01-10' }],
  };
  const rows = b.monthCharges({ hostinger, render, doc, entries, month: '2026-11', now: NOW });
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));

  assert.equal(by['hs:s1'].cost, 11.99, 'renewal price on renewals');
  assert.equal(by['hs:s1'].state, 'charged', 'already charged on 3 Nov');
  assert.equal(by['hs:s1'].client, 'Mode Beispiel', 'client found from the vault by domain');
  assert.equal(by['hs:s1'].clientGuessed, true);

  assert.equal(by['hs:s2'].state, 'manual');
  assert.equal(b.dayOf(by['hs:s2'].date), '2026-11-30');
  assert.equal(by['hs:s2'].client, 'Bäckerei Beispiel');
  assert.equal(by['hs:s2'].sell, 25);

  assert.equal(by['hs:s3'].cost, 5.99);
  assert.equal(b.dayOf(by['hs:s3'].date), '2026-11-17');
  assert.ok(!by['hs:s4'], 'a cancelled subscription has no charge on its end date');

  assert.ok(!by['rs:srv-1'], 'free services cost nothing');
  assert.equal(by['rs:srv-2'].cost, 25);
  assert.equal(by['rs:srv-2'].sell, 40);
  assert.equal(by['rs:srv-2'].estimated, true);
  assert.ok(!by['rs:srv-3'], 'suspended services are not billed');
  assert.equal(by['rs:srv-4'].cost, 3.5, 'a typed-in cost overrides');
  assert.ok(!by['rs:srv-5'], 'not created yet');
  assert.equal(by['rp:dpg-2'].cost, 7.5, '6 + 5 GB × 0.30');
  assert.ok(!by['rp:dpg-1']);
  assert.equal(by['rk:red-1'].cost, 10);

  assert.equal(by['x:x1'].sell, 300);
  assert.equal(by['x:x1'].state, 'charged');
  assert.equal(b.dayOf(by['x:x1'].date), '2026-11-10');
  assert.equal(by['e:e1'].cost, null);
  assert.equal(by['e:e1'].client, 'Mode Beispiel');

  const s = b.summarize(rows);
  assert.equal(s.cost.EUR, Math.round((11.99 + 11.99 + 5.99 + 0) * 100) / 100);
  assert.equal(s.cost.USD, 25 + 3.5 + 7.5 + 10);
  assert.equal(s.sell.EUR, 325);
  assert.equal(s.sell.USD, 40);
  const star = s.clients.find((c) => c.client === 'Mode Beispiel');
  assert.equal(star.sell.EUR, 300);
  assert.ok(s.unassigned >= 3, 'database, cache and the monthly email have no client yet');
});

test('the December report projects auto-renewals and stops after a manual end date', () => {
  const rows = b.monthCharges({ hostinger, render, doc: null, entries, month: '2026-12', now: NOW });
  const keys = rows.map((r) => r.key);
  assert.ok(keys.includes('hs:s3'), 'monthly email again on 17 Dec');
  assert.ok(!keys.includes('hs:s2'), 'not renewing: nothing after 30 Nov');
  assert.ok(!keys.includes('hs:s1'), 'yearly domain is not due in December');
  assert.ok(keys.includes('rs:srv-5'), 'created on 2 Dec, billed for December');
});

test('alerts combine server items, vault dates and typed-in costs', () => {
  const list = b.alertItems({
    renewals: [{ key: 'hd:x.de', title: 'x.de', at: '2026-11-30T23:59:59.000Z', source: 'hostinger_domain' }, { key: 'hs:far', title: 'far', at: '2027-03-01T00:00:00.000Z', source: 'hostinger_subscription' }],
    entries: [{ id: 'e1', client: 'Mode Beispiel', title: 'Mode Beispiel: Website', renewAt: '2026-12-31' }],
    extras: [{ id: 'x1', title: 'Ads', periodMonths: 1, start: '2026-01-10', cost: 10, currency: 'EUR' }],
    now: NOW,
  });
  assert.deepEqual(list.map((x) => [x.key, x.days, x.stage]), [
    ['hd:x.de', 9, 'month'],
    ['x:x1', 19, 'month'],
    ['e:e1', 40, 'two_months'],
  ]);
  assert.equal(b.alertLabel(list[0]), 'hd:x.de|2026-11-30|month');
});

test('CSV is Excel-friendly and defuses formulas', () => {
  const csv = b.toCsv([{ date: Date.parse(iso('2026-11-30')), title: '=HYPERLINK("x")', provider: 'hostinger', client: 'A, "B"', cost: 11.99, currency: 'EUR', sell: null, sellCurrency: 'EUR', state: 'manual', note: '' }], { provider: { hostinger: 'Hostinger' }, state: { manual: 'تجديد يدوي' } });
  assert.ok(csv.startsWith('﻿'));
  const line = csv.split('\r\n')[1];
  assert.equal(line, `2026-11-30,"'=HYPERLINK(""x"")",Hostinger,"A, ""B""",11.99,EUR,,,تجديد يدوي,`);
});
