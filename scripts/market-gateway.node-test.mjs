import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMarketGateway, MarketEvents } from './market-gateway.mjs';
import { marketWatchlists } from './market-watchlists.mjs';
import { allowedMarketRequest, allowedMarketBody } from '../src/lib/market-policy.mjs';

test('market method/path/query/body allowlist rejects authority and aliases', () => {
    for (const route of ['/api/v1/auth/accounts', '/api/v1/order/place_order', '/api/v1/portfolio/position_unit', '/api/v1/admin/harness', '//api/v1/info', '/api/v1/data/../order/place_order', '/api/v1/%64ata/snapshots', '/api/v1/info?secret=x']) {
        assert.equal(allowedMarketRequest('GET', route), false, route);
        assert.equal(allowedMarketRequest('POST', route), false, route);
    }
    assert.equal(allowedMarketRequest('GET', '/api/v1/data/contracts/2330/info?security_type=STK&region=TW'), true);
    assert.equal(allowedMarketRequest('POST', '/api/v1/data/snapshots'), true);
    assert.equal(allowedMarketRequest('DELETE', '/api/v1/data/contracts/2330'), false);
    assert.equal(allowedMarketBody({ contract: { code: '2330', security_type: 'STK', exchange: 'TSE', region: 'TW' }, start: '2026-11-13', end: '2026-11-13' }), true);
    for (const body of [null, [], { contracts: false }, { contract: '2330' }, { account: 'private' }, { contract: { code: '2330', api_key: 'private' } }]) assert.equal(allowedMarketBody(body), false);
});

test('SSE projects only named market frames, across split UTF8/CRLF boundaries', async () => {
    const filter = new MarketEvents(); let result = '';
    filter.on('data', chunk => result += chunk);
    const done = once(filter, 'end');
    const bytes = Buffer.from('event: order_event\r\ndata: {"account_id":"private"}\r\n\r\nevent: tick_stk\r\ndata: {"code":"2330","name":"台積電","close":"100","private":"drop"}\r\n\r\nevent: unknown\ndata: {}\n\nevent: heartbeat\ndata: {"timestamp":"fresh","account_id":"drop"}\n\n');
    for (const byte of bytes) filter.write(Buffer.from([byte]));
    filter.end(); await done;
    assert.match(result, /台積電/); assert.match(result, /heartbeat/);
    assert.doesNotMatch(result, /account_id|private|drop|unknown|order_event/);
});

test('real 1.7.11 night-session market payloads preserve quote values through projection', async () => {
    const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/market-sse-1.7.11.json', import.meta.url), 'utf8'));
    const filter = new MarketEvents(); let wire = '';
    filter.on('data', chunk => wire += chunk);
    const done = once(filter, 'end');
    for (const [event, data] of Object.entries(fixture.events)) filter.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    filter.end(); await done;
    const decoded = Object.fromEntries(wire.trim().split('\n\n').map(frame => {
        const [event, data] = frame.split('\n'); return [event.slice(7), JSON.parse(data.slice(6))];
    }));
    assert.deepEqual(decoded, fixture.events);
    assert.equal(typeof decoded.tick_fop.close, 'string', 'SDK decimal strings must not lose precision');
});

test('gateway rejects before forwarding, authenticates privately and removes info metadata', async t => {
    const seen = [];
    const upstream = http.createServer((req, res) => {
        seen.push({ path: req.url, auth: req.headers.authorization, cookie: req.headers.cookie });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ version: '1.7.11', simulation: false, account_id: 'private', secret: 'private' }));
    });
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    const gateway = createMarketGateway({ upstreamPort: upstream.address().port, authorization: 'Bearer fixture-only', uiOrigin: 'http://127.0.0.1:5173' });
    gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
    t.after(() => { gateway.closeAllConnections(); gateway.close(); upstream.closeAllConnections(); upstream.close(); });
    const request = (path, headers = {}, method = 'GET', body = '') => new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: gateway.address().port, path, method, headers: { Host: '127.0.0.1:21323', ...headers } }, res => {
            let data = ''; res.on('data', chunk => data += chunk); res.on('end', () => resolve({ status: res.statusCode, data }));
        }); req.on('error', reject); req.end(body);
    });
    for (const path of ['/api/v1/order/place_order', '/api/v1/auth/accounts', '/api/v1/portfolio/position_unit', '/api/v1/%69nfo']) assert.equal((await request(path)).status, 403);
    for (const headers of [{ Host: 'evil.test' }, { Origin: 'https://evil.test' }, { 'Sec-Fetch-Site': 'cross-site' }]) assert.equal((await request('/api/v1/info', headers)).status, 403);
    assert.equal((await request('/api/v1/data/snapshots', {}, 'POST', '{"account_id":"x"}')).status, 403);
    assert.equal(seen.length, 0, 'forbidden routes must never reach upstream');
    const info = await request('/api/v1/info', { Cookie: 'secret', Authorization: 'client-secret' });
    assert.equal(info.status, 200);
    assert.deepEqual(JSON.parse(info.data), { version: '1.7.11', simulation: false });
    assert.deepEqual(seen, [{ path: '/api/v1/info', auth: 'Bearer fixture-only', cookie: undefined }]);
});

test('watchlist display preferences persist without any SDK request', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pro-market-preferences-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const file = path.join(root, 'watchlists.json');
    const store = marketWatchlists(file);
    const contract = { code: '2330', security_type: 'STK', exchange: 'TSE', region: 'TW', target_code: null };
    const created = await store('POST', '/api/v1/watchlist', { name: '研究', contracts: [contract] });
    assert.match(created.id, /^[a-z0-9-]+$/);
    assert.equal((await fs.stat(file)).mode & 0o077, 0);
    const reopened = marketWatchlists(file);
    assert.deepEqual(await reopened('GET', '/api/v1/watchlist', {}), [created]);
    const updated = await reopened('PUT', `/api/v1/watchlist/${created.id}`, { contracts: [] });
    assert.deepEqual(updated.contracts, []);
    await reopened('DELETE', `/api/v1/watchlist/${created.id}`, {});
    assert.deepEqual(await reopened('GET', '/api/v1/watchlist', {}), []);
});
