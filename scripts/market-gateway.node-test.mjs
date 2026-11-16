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
    // Query shapes from shioaji.ts fetchFutures/Options/Warrants helpers.
    for (const query of [
        'futures?root=TXF&delivery_month=202611&underlying_code=2330&region=TW',
        'options?root=TXO&delivery_month=202611&option_right=Call&strike_min=20000&strike_max=30000&expiry_weekday=3&region=TW',
        'warrants?underlying_code=2330&call_put=Call&strike_min=100&strike_max=1000&expiry_from=2026-01-01&expiry_to=2026-12-31&region=TW',
        'warrants/underlyings?region=TW&include_name=true',
    ]) assert.equal(allowedMarketRequest('GET', `/api/v1/data/contracts/${query}`), true, query);
    assert.equal(allowedMarketRequest('DELETE', '/api/v1/data/contracts/2330'), false);
    assert.equal(allowedMarketBody({ contract: { code: '2330', security_type: 'STK', exchange: 'TSE', region: 'TW' }, start: '2026-11-13', end: '2026-11-13' }), true);
    for (const body of [null, [], { contracts: false }, { contract: '2330' }, { account: 'private' }, { contract: { code: '2330', api_key: 'private' } }]) assert.equal(allowedMarketBody(body), false);
});

test('real frontend capability payloads reach only the selected market upstream path', async t => {
    const seen = [];
    const upstream = http.createServer(async (req, res) => {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        seen.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString()), auth: req.headers.authorization });
        res.setHeader('Content-Type', 'application/json'); res.end('{"success":true}');
    });
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    const gateway = createMarketGateway({ upstreamPort: upstream.address().port, authorization: 'Bearer fixture', uiOrigin: 'http://127.0.0.1:5173' });
    gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
    t.after(() => { gateway.closeAllConnections(); gateway.close(); upstream.closeAllConnections(); upstream.close(); });
    const index = { security_type: 'IND', exchange: 'TSE', code: 'IX0001', target_code: null };
    const samples = [
        ['calculated_index', { index }], ['index_contribution', { index, ranking: 'top10' }],
        ['index_components', { index, projection: { kind: 'ranking', target: 'component', metric: 'contribution', order: 'negative_asc', limit: 25 } }],
        ['kbars', { stocks: [{ security_type: 'STK', exchange: 'TSE', code: '2330', target_code: null }] }],
        ['scanner', { scanner: { kind: 'preset_rule', id: 'trade_price_surge' }, region: 'TW', security_type: 'STK', exchange: 'TSE' }],
    ];
    for (const [capability, body] of samples) {
        const pathname = `/api/v1/stream/subscribe/${capability}`;
        const status = await new Promise((resolve, reject) => {
            const req = http.request({ host: '127.0.0.1', port: gateway.address().port, path: pathname, method: 'POST', headers: { Host: '127.0.0.1:21323' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
            req.on('error', reject); req.end(JSON.stringify(body));
        });
        assert.equal(status, 200); assert.deepEqual(seen.at(-1), { path: pathname, body, auth: 'Bearer fixture' });
    }
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

test('full Pro market subscription request shapes remain usable through the market policy', () => {
    // Actual builders: src/lib/shioaji.ts streamContractKey (96),
    // subscribeEnrichedIndex (680), subscribeKbars (721),
    // subscribeIndexComponents (743), scannerSubscriptionBody (768).
    // The scanner preset/state bodies also have upstream regression fixtures
    // in src/lib/shioaji-1.7.1.test.ts:14-30. No provider call is made here.
    const index = { security_type: 'IND', exchange: 'TSE', code: 'IX0001', target_code: null };
    const stock = { security_type: 'STK', exchange: 'TSE', code: '2330', target_code: null };
    const projection = { kind: 'ranking', target: 'component', metric: 'contribution', order: 'negative_asc', limit: 25 };
    const samples = [
        ['calculated_index', { index }],
        ['index_components', { index, projection }],
        ['kbars', { stocks: [stock] }],
        ['scanner', { scanner: { kind: 'preset_rule', id: 'trade_price_drop' }, region: 'TW', security_type: 'STK', exchange: 'OTC' }],
        ['scanner', { scanner: 'suspend', region: 'TW', security_type: 'STK', exchange: 'TSE' }],
    ];
    for (const action of ['subscribe', 'unsubscribe']) for (const [capability, body] of samples) {
        const route = `/api/v1/stream/${action}/${capability}`;
        assert.equal(allowedMarketRequest('POST', route), true, route);
        assert.equal(allowedMarketBody(body), true, `${route}: ${JSON.stringify(body)}`);
    }
});

async function projectedFrames(frames) {
    const filter = new MarketEvents(); let wire = '';
    filter.on('data', chunk => { wire += chunk; });
    const done = once(filter, 'end');
    for (const { event, data } of frames) filter.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    filter.end(); await done;
    return wire.trim().split('\n\n').map(frame => {
        const [event, data] = frame.split('\n');
        return { event: event.slice(7), data: JSON.parse(data.slice(6)) };
    });
}

test('scanner rule, plural state and reconnect-gap fixtures keep the consumer identity and detail', async () => {
    // Existing upstream fixtures, copied without adding wire fields:
    // src/lib/shioaji-1.7.1.test.ts:179-191, 202-206, 215-225.
    // Consumers: market-pulse.ts parseScannerMessages/scannerSignalKey;
    // market-pulse-panel.tsx signal rows and dropped_count notice.
    const frames = [
        { event: 'scanner', data: {
            scanner: 'trade_price_surge', region: 'TW', security_type: 'STK', exchange: 'TSE',
            quote: { code: '2330', date: '2026-07-31', time: '09:00:01.000000', close: '1040' },
            extra: { change_percent: '1.25' },
        } },
        { event: 'scanner', data: {
            scanners: ['simtrade'], region: 'TW', security_type: 'STK', exchange: 'OTC',
            quote: { code: '6488', date: '2026-07-31', time: '08:59:00.000000', simtrade: true },
        } },
        { event: 'scanner', data: {
            dropped_count: 7, first_time: '09:00:00', last_time: '09:00:03', subscriptions: [],
        } },
    ];
    const projected = await projectedFrames(frames);
    assert.deepEqual(projected, frames);
    const rule = projected[0].data;
    assert.equal(`${rule.exchange}:${rule.scanner}:${rule.quote.code}:${rule.quote.date}:${rule.quote.time}`,
        'TSE:trade_price_surge:2330:2026-07-31:09:00:01.000000');
    assert.equal(typeof projected[2].data.dropped_count, 'number');
});

test('family schemas drop private nested metadata while keeping public scanner diagnostic scalars', async () => {
    const [frame] = await projectedFrames([{ event: 'scanner', data: {
        scanner: 'trade_price_surge', exchange: 'TSE', account_id: 'drop',
        quote: { code: '2330', date: '2026-07-31', time: '09:00:01', close: '1040', secret: 'drop' },
        extra: { change_percent: '1.25', trigger_price: '1040', account_id: 'drop', secret_token: 'drop', nested: { password: 'drop' } },
    } }]);
    assert.deepEqual(frame.data.extra, { change_percent: '1.25', trigger_price: '1040' });
    assert.doesNotMatch(JSON.stringify(frame), /account_id|secret|password|nested|drop/);
});

test('index-components projections retain the nested identity required by parseIcEvent', async () => {
    // Real 1.7.4 raw samples retained upstream at
    // src/lib/index-components.test.ts:42-77 and 93-104 (header documents capture).
    // parseIcEvent requires contract.code, projection and its key fields;
    // decimals and reference_weight_ppm feed the displayed ranking rows.
    const ranking = {
        contract: { security_type: 'IND', region: 'TW', exchange: 'TSE', code: 'IX0001' },
        projection: { kind: 'ranking', target: 'component', metric: 'contribution', order: 'negative_asc', limit: 25 },
        date: '2026-08-28', time: '09:28:00.000000', calculated_at: '2026-08-28T09:28:00.000000+08:00',
        reference_date: '2026-08-28', market_phase: 'continuous_trading', simtrade: false,
        entries: [{ code: '8046', category: '28', value: '-5.94', price: '1265.00', reference: '1295.00',
            price_chg: '-30.00', pct_chg: '-2.32', reference_weight_ppm: 5577,
            price_source: 'regular', trading_status: 'active', data_status: 'live' }],
    };
    const grouped = {
        contract: { code: 'IX0001' }, projection: { kind: 'group_metric', metric: 'contribution' },
        date: '2026-08-28', time: '09:28:01.000000', calculated_at: '2026-08-28T09:28:01.000000+08:00',
        market_phase: 'continuous_trading', simtrade: false, unit: 'points',
        groups: [{ category: '1', name: '水泥工業', item_count: 7, value: '-0.32' }],
    };
    const projected = await projectedFrames([
        { event: 'index_components', data: ranking }, { event: 'index_components', data: grouped },
    ]);
    for (const [position, original] of [ranking, grouped].entries()) {
        const result = projected[position].data;
        assert.deepEqual(result.contract, original.contract);
        assert.deepEqual(result.projection, original.projection);
        for (const field of ['date', 'time', 'calculated_at', 'market_phase', 'simtrade']) assert.deepEqual(result[field], original[field]);
    }
    assert.deepEqual(projected[0].data.entries, ranking.entries);
    assert.deepEqual(projected[1].data.groups, grouped.groups);
    const identity = projected[0].data.projection;
    assert.equal(`rk:${identity.metric}:${identity.order}:${identity.limit}`, 'rk:contribution:negative_asc:25');
});

test('official PascalCase quote_idx fixture remains compatible with stream normalization', async () => {
    // Existing QuoteIdxV1 raw sample: src/lib/stream-index-close.test.ts:39.
    const data = { Code: 'IX0001', Exchange: 'TSE', Date: '2026/10/19', Time: '13:33:00.000000',
        Reference: '47111.26', Open: '46844.64', High: '46844.64', Low: '46170.0', Close: '46822.08',
        Raise: 160, Flat: 72, Fall: 862, RaiseStop: 7, FallStop: 2 };
    assert.deepEqual(await projectedFrames([{ event: 'quote_idx', data }]), [{ event: 'quote_idx', data }]);
});

test('kbar SSE framing preserves parser-supported batches, root arrays and timestamp aliases', async () => {
    // Existing batch fixture: src/lib/chain-flow.test.ts:82-90. The rows
    // wrapper and root arrays are already tested upstream; sibling wrapper
    // names come from parseKbarEvent at chain-flow.ts:128-152.
    const rows = [
        { code: '2330', time: '09:01:00', close: 1000, amount: 1 },
        { code: '2317', datetime: '2026-10-21 09:02:00', close: 200, amount: 2 },
        { code: '2454', time: '14:00:00', close: 1, amount: 1 },
        { code: '1101', time: '09:03:00', close: 0, amount: 1 },
        { time: '09:03:00', close: 1, amount: 1 },
    ];
    const frames = ['rows', 'bars', 'data', 'kbars'].map(wrapper => ({
        event: 'kbar', data: { date: '2026/10/21', [wrapper]: rows },
    }));
    frames.push({ event: 'kbar', data: rows });
    // Same existing timestamp using parseRow's documented ts alias
    // (chain-flow.ts:98-99/106), not a newly captured vendor sample.
    frames.push({ event: 'kbar', data: { code: '2317', ts: '2026-10-21 09:02:00', close: 200, amount: 2 } });
    assert.deepEqual(await projectedFrames(frames), frames);
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
