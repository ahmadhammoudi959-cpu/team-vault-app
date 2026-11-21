// A tiny stand-in for the Hostinger and Render APIs, used by the tests.
//   node test/mock_apis.mjs <port> <hostingerToken> <renderToken>
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const DAY = 86_400_000;
const at = (days) => new Date(Date.now() + days * DAY).toISOString();
// Hostinger reports a domain's end as the last second of a UTC day.
const endOfDay = (days) => {
  const d = new Date(Date.now() + days * DAY);
  d.setUTCHours(23, 59, 59, 0);
  return d.toISOString();
};

export function startMockApis({ port = 0, hostingerToken, renderToken } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET') return send(405, { error: 'method' });
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) {
      if (req.headers.authorization !== `Bearer ${hostingerToken}`) return send(401, { message: 'Unauthenticated' });
      if (url.pathname === '/api/domains/v1/portfolio') {
        return send(200, [
          { id: 1, domain: 'starstyle.com', type: 'domain', status: 'active', created_at: at(-355), expires_at: at(10) },
          { id: 2, domain: 'nilefoods.net', type: 'domain', status: 'active', created_at: at(-100), expires_at: at(265) },
          { id: 3, domain: 'old-client.com', type: 'domain', status: 'expired', created_at: at(-400), expires_at: at(-5) },
          { id: 4, domain: 'xn--bcher-kva.de', type: 'domain', status: 'active', created_at: at(-356), expires_at: endOfDay(9) },
          { id: 5, domain: 'nilefoods.de', type: 'domain', status: 'active', created_at: at(-320), expires_at: endOfDay(45) },
          { id: 6, domain: 'nilefoods.de', type: 'free_domain', status: 'active', created_at: at(-320), expires_at: null },
        ]);
      }
      if (url.pathname === '/api/billing/v1/subscriptions') {
        return send(200, [
          { id: 'sub-1', name: 'Business Web Hosting', status: 'active', billing_period: 12, billing_period_unit: 'month', currency_code: 'USD', total_price: 4788, renewal_price: 15588, is_auto_renewed: false, created_at: at(-345), expires_at: at(20), next_billing_at: null },
          { id: 'sub-2', name: '.net Domain', status: 'active', billing_period: 1, billing_period_unit: 'year', currency_code: 'USD', total_price: 999, renewal_price: 1799, is_auto_renewed: true, created_at: at(-200), expires_at: at(165), next_billing_at: at(165) },
          { id: 'sub-3', name: '.COM Domain', status: 'non_renewing', billing_period: 1, billing_period_unit: 'year', currency_code: 'USD', total_price: 999, renewal_price: 2019, is_auto_renewed: false, created_at: at(-355), expires_at: at(10), next_billing_at: null },
          { id: 'sub-4', name: '.COM Domain', status: 'cancelled', billing_period: 1, billing_period_unit: 'year', currency_code: 'USD', total_price: 999, renewal_price: 2019, is_auto_renewed: false, created_at: at(-400), expires_at: at(-5), next_billing_at: null },
          { id: 'sub-5', name: '.DE Domain', status: 'active', billing_period: 1, billing_period_unit: 'year', currency_code: 'EUR', total_price: 499, renewal_price: 1199, is_auto_renewed: true, created_at: at(-345), expires_at: null, next_billing_at: at(20) },
          { id: 'sub-6', name: 'Premium Web Hosting', status: 'active', billing_period: 1, billing_period_unit: 'month', currency_code: 'EUR', total_price: 299, renewal_price: 299, is_auto_renewed: true, created_at: at(-200), expires_at: null, next_billing_at: at(5) },
          { id: 'sub-7', name: 'Starter Business Email', status: 'active', billing_period: 1, billing_period_unit: 'year', currency_code: 'EUR', total_price: 1908, renewal_price: 3816, is_auto_renewed: true, created_at: at(-315), expires_at: null, next_billing_at: at(50) },
        ]);
      }
      if (url.pathname === '/api/hosting/v1/websites') {
        return send(200, {
          data: [
            { domain: 'starstyle.com', website_type: 'wordpress', is_enabled: true, username: 'u1001', client_id: 9, order_id: 101, created_at: at(-345), root_directory: null, parent_domain: null, vhost_type: null, horizons_uuid: null },
            { domain: 'nilefoods.de', website_type: 'builder', is_enabled: false, username: 'u1002', client_id: 9, order_id: 102, created_at: at(-200), root_directory: null, parent_domain: null, vhost_type: null, horizons_uuid: null },
          ],
          meta: { current_page: Number(url.searchParams.get('page') || 1), per_page: 25, total: 2 },
        });
      }
      if (url.pathname === '/api/hosting/v1/orders') {
        return send(200, {
          data: [
            { id: 101, client_id: 9, subscription_id: 'sub-1', created_at: at(-345), plan: { name: 'Business' }, status: 'active' },
            { id: 102, client_id: 9, subscription_id: 'sub-6', created_at: at(-200), plan: { name: 'Premium' }, status: 'active' },
          ],
          meta: { current_page: 1, per_page: 25, total: 2 },
        });
      }
      if (url.pathname === '/api/mail/v1/orders') {
        return send(200, {
          data: [
            { id: 'mo-1', status: 'active', is_trial: false, seats: 3, domain: { id: 'd1', name: 'starstyle.com' }, plan: { name: 'starter', title: 'Starter Business Email' }, has_pending_upgrade: false, created_at: at(-315), expires_at: endOfDay(52) },
            { id: 'mo-2', status: 'active', is_trial: true, seats: 1, domain: { id: 'd2', name: 'nilefoods.net' }, plan: { name: 'premium', title: 'Premium Business Email' }, has_pending_upgrade: false, created_at: at(-5), expires_at: endOfDay(25) },
          ],
          meta: { current_page: 1, per_page: 25, total: 2 },
        });
      }
      if (url.pathname === '/api/billing/v1/payment-methods') {
        return send(200, [
          { id: 1, name: 'Visa', identifier: 'visa_ending_4242', payment_method: 'card', is_default: true, is_expired: false, is_suspended: false, created_at: at(-700), expires_at: endOfDay(40), suspended_at: null },
        ]);
      }
      return send(404, { message: 'not found' });
    }
    if (url.pathname.startsWith('/v1/')) {
      if (req.headers.authorization !== `Bearer ${renderToken}`) return send(401, { message: 'unauthorized' });
      if (url.pathname === '/v1/services') {
        return send(200, [
          { cursor: 'c1', service: { id: 'srv-1', name: 'star-style', type: 'web_service', suspended: 'not_suspended', ownerId: 'tea-1', dashboardUrl: 'https://dashboard.render.com/web/srv-1', createdAt: at(-90), updatedAt: at(-1), serviceDetails: { plan: 'free', region: 'frankfurt', runtime: 'node', url: 'https://star-style.onrender.com' } } },
          { cursor: 'c2', service: { id: 'srv-2', name: 'ai-gateway', type: 'web_service', suspended: 'suspended', ownerId: 'tea-1', dashboardUrl: 'https://dashboard.render.com/web/srv-2', createdAt: at(-60), updatedAt: at(-3), serviceDetails: { plan: 'starter', region: 'frankfurt', runtime: 'python', url: 'https://ai-gateway.onrender.com' } } },
          { cursor: 'c3', service: { id: 'srv-3', name: 'nile-api', type: 'web_service', suspended: 'not_suspended', ownerId: 'tea-1', dashboardUrl: 'https://dashboard.render.com/web/srv-3', createdAt: at(-120), updatedAt: at(-2), serviceDetails: { plan: 'standard', region: 'oregon', runtime: 'node', url: 'https://nile-api.onrender.com' } } },
        ]);
      }
      if (url.pathname === '/v1/services/srv-1/custom-domains') {
        return send(200, [{ cursor: 'cd1', customDomain: { id: 'cdm-1', name: 'www.starstyle.com', domainType: 'subdomain', verificationStatus: 'verified', createdAt: at(-80) } }]);
      }
      if (/^\/v1\/services\/srv-\d+\/custom-domains$/.test(url.pathname)) return send(200, []);
      if (url.pathname === '/v1/key-value') {
        return send(200, [{ cursor: 'k1', keyValue: { id: 'red-1', name: 'star-cache', plan: 'starter', status: 'available', region: 'frankfurt', createdAt: at(-30), dashboardUrl: 'https://dashboard.render.com/r/red-1' } }]);
      }
      if (url.pathname === '/v1/owners') {
        return send(200, [{ cursor: 'o1', owner: { id: 'tea-1', name: 'GoTrend', email: 'team@example.com', type: 'team' } }]);
      }
      if (url.pathname === '/v1/postgres') {
        return send(200, [
          { cursor: 'p1', postgres: { id: 'dpg-1', name: 'star-style-db', plan: 'free', status: 'available', region: 'frankfurt', expiresAt: at(3), suspended: 'not_suspended', dashboardUrl: 'https://dashboard.render.com/d/dpg-1', createdAt: at(-27) } },
          { cursor: 'p2', postgres: { id: 'dpg-2', name: 'ai-gateway-db', plan: 'basic_256mb', status: 'available', region: 'frankfurt', suspended: 'not_suspended', dashboardUrl: 'https://dashboard.render.com/d/dpg-2', createdAt: at(-19) } },
        ]);
      }
      return send(404, { message: 'not found' });
    }
    return send(404, { message: 'not found' });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ port: server.address().port, calls, close: () => server.close() }));
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [port, hostingerToken, renderToken] = process.argv.slice(2);
  startMockApis({ port: Number(port), hostingerToken, renderToken }).then((m) => console.log(`mock apis on ${m.port}`));
}
