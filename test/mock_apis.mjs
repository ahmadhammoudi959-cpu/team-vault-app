// A tiny stand-in for the Hostinger and Render APIs, used by the tests.
//   node test/mock_apis.mjs <port> <hostingerToken> <renderToken>
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const DAY = 86_400_000;
const at = (days) => new Date(Date.now() + days * DAY).toISOString();

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
        ]);
      }
      if (url.pathname === '/api/billing/v1/subscriptions') {
        return send(200, [
          { id: 'sub-1', name: 'Business Web Hosting', status: 'active', billing_period: 12, billing_period_unit: 'month', currency_code: 'USD', total_price: 4788, renewal_price: 15588, is_auto_renewed: false, created_at: at(-345), expires_at: at(20), next_billing_at: null },
          { id: 'sub-2', name: '.com Domain', status: 'active', billing_period: 1, billing_period_unit: 'year', currency_code: 'USD', total_price: 999, renewal_price: 1799, is_auto_renewed: true, created_at: at(-200), expires_at: at(165), next_billing_at: at(165) },
        ]);
      }
      return send(404, { message: 'not found' });
    }
    if (url.pathname.startsWith('/v1/')) {
      if (req.headers.authorization !== `Bearer ${renderToken}`) return send(401, { message: 'unauthorized' });
      if (url.pathname === '/v1/services') {
        return send(200, [
          { cursor: 'c1', service: { id: 'srv-1', name: 'star-style', type: 'web_service', suspended: 'not_suspended', dashboardUrl: 'https://dashboard.render.com/web/srv-1', updatedAt: at(-1), serviceDetails: { plan: 'free', url: 'https://star-style.onrender.com' } } },
          { cursor: 'c2', service: { id: 'srv-2', name: 'ai-gateway', type: 'web_service', suspended: 'suspended', dashboardUrl: 'https://dashboard.render.com/web/srv-2', updatedAt: at(-3), serviceDetails: { plan: 'starter', url: 'https://ai-gateway.onrender.com' } } },
        ]);
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
