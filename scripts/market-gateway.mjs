import http from 'node:http';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { allowedMarketRequest, allowedMarketEvent, allowedMarketBody, projectMarketEvent } from '../src/lib/market-policy.mjs';
import { marketWatchlists } from './market-watchlists.mjs';

const MAX_BODY = 1024 * 1024;
const MAX_REPLY = 32 * 1024 * 1024;
const healthFields = ['status', 'version', 'timestamp', 'token_expires_in_seconds', 'token_stale', 'contract_count', 'next_maintenance', 'session_recovering', 'session_recovery_attempts'];
const infoFields = ['name', 'version', 'description', 'protocols', 'scheme', 'simulation', 'instance_id'];

// No account/order/unknown event, unnamed data frame, retry directive or ID
// from the aggregate upstream stream may cross the market-only boundary.
export class MarketEvents extends Transform {
    pending = '';
    decoder = new StringDecoder('utf8');
    _transform(chunk, _encoding, done) {
        this.pending += this.decoder.write(chunk);
        this.pending = this.pending.replace(/\r\n/g, '\n');
        let end;
        while ((end = this.pending.indexOf('\n\n')) !== -1) {
            const frame = this.pending.slice(0, end);
            if (Buffer.byteLength(frame) > MAX_BODY) { done(new Error('SSE frame limit')); return; }
            this.pending = this.pending.slice(end + 2);
            const lines = frame.split('\n');
            const names = lines.filter(line => line.startsWith('event:')).map(line => line.slice(6).trim());
            if (names.length !== 1 || !allowedMarketEvent(names[0])) continue;
            const data = lines.filter(line => line.startsWith('data:'));
            if (data.length) {
                try {
                    const parsed = JSON.parse(data.map(line => line.slice(5).trimStart()).join('\n'));
                    this.push(`event: ${names[0]}\ndata: ${JSON.stringify(projectMarketEvent(parsed, names[0]))}\n\n`);
                } catch { /* Malformed market data cannot cross the projection. */ }
            }
        }
        if (Buffer.byteLength(this.pending) > MAX_BODY) done(new Error('SSE frame limit'));
        else done();
    }
}

function reply(res, status, message) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify({ error: message }));
}

/** Testable gateway; the production launcher pins upstream and UI addresses. */
export function createMarketGateway({ upstreamPort, authorization, uiOrigin, watchlists }) {
    return http.createServer(async (req, res) => {
        // Check authority before opening an authenticated upstream connection.
        if (req.headers['sec-fetch-site'] === 'cross-site'
            || (req.headers.origin && req.headers.origin !== uiOrigin)
            || !['127.0.0.1:21323', new URL(uiOrigin).host].includes(req.headers.host ?? '')
            || !allowedMarketRequest(req.method, req.url)) {
            reply(res, 403, 'market_only'); return;
        }
        try {
            const chunks = []; let size = 0;
            for await (const chunk of req) {
                size += chunk.length;
                if (size > MAX_BODY) { reply(res, 413, 'request_limit'); return; }
                chunks.push(chunk);
            }
            const body = Buffer.concat(chunks);
            if (body.length && !allowedMarketBody(JSON.parse(body.toString('utf8')))) {
                reply(res, 403, 'market_parameters_only'); return;
            }
            if (req.url.startsWith('/api/v1/watchlist')) {
                if (!watchlists) { reply(res, 403, 'local_watchlists_unavailable'); return; }
                const data = await watchlists(req.method, req.url, body.length ? JSON.parse(body.toString('utf8')) : {});
                res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
                res.end(JSON.stringify(data)); return;
            }
            const streaming = req.url.split('?')[0] === '/api/v1/stream/data';
            const upstream = http.request({ hostname: '127.0.0.1', port: upstreamPort, path: req.url,
                method: req.method, headers: { Authorization: authorization,
                    Accept: streaming ? 'text/event-stream' : 'application/json',
                    'Content-Type': 'application/json', 'Content-Length': body.length },
            });
            const timer = setTimeout(() => upstream.destroy(new Error('upstream timeout')), 30000);
            res.on('close', () => { clearTimeout(timer); upstream.destroy(); });
            upstream.on('error', () => {
                clearTimeout(timer);
                if (!res.headersSent) reply(res, 502, 'market_backend_unavailable');
                else res.destroy();
            });
            upstream.on('response', async incoming => {
                try {
                    if (incoming.statusCode < 200 || incoming.statusCode >= 300) {
                        incoming.destroy(); clearTimeout(timer);
                        reply(res, incoming.statusCode >= 400 && incoming.statusCode < 600 ? incoming.statusCode : 502, 'market_request_failed'); return;
                    }
                    if (streaming) {
                        if (!incoming.headers['content-type']?.startsWith('text/event-stream')) throw new Error('SSE type');
                        clearTimeout(timer);
                        // Heartbeats must arrive before an idle stream is trusted again.
                        incoming.setTimeout(90000, () => incoming.destroy());
                        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
                        res.flushHeaders();
                        await pipeline(incoming, new MarketEvents(), res);
                    } else {
                        let bytes = 0; const result = [];
                        for await (const chunk of incoming) {
                            bytes += chunk.length;
                            if (bytes > MAX_REPLY) throw new Error('reply limit');
                            result.push(chunk);
                        }
                        clearTimeout(timer);
                        const data = bytes ? JSON.parse(Buffer.concat(result).toString('utf8')) : null;
                        const pathname = req.url.split('?')[0];
                        const fields = pathname === '/api/v1/info' ? infoFields : pathname === '/api/v1/health' ? healthFields : null;
                        const safe = fields ? Object.fromEntries(fields.filter(k => Object.hasOwn(data, k)).map(k => [k, data[k]])) : data;
                        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
                        res.end(JSON.stringify(safe));
                    }
                } catch {
                    clearTimeout(timer); incoming.destroy();
                    if (!res.headersSent) reply(res, 502, 'market_response_invalid');
                    else res.destroy();
                }
            });
            upstream.end(body);
        } catch { if (!res.headersSent) reply(res, 400, 'market_request_invalid'); }
    });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
    const key = process.env.SJ_API_KEY; const secret = process.env.SJ_SEC_KEY;
    delete process.env.SJ_API_KEY; delete process.env.SJ_SEC_KEY;
    if (!key || !secret) throw new Error('canonical credentials required');
    if (!process.env.PRO_MARKET_STATE) throw new Error('private preference path required');
    createMarketGateway({ upstreamPort: 21324, authorization: `Bearer ${key}:${secret}`, uiOrigin: 'http://127.0.0.1:5173', watchlists: marketWatchlists(process.env.PRO_MARKET_STATE) })
        .listen(21323, '127.0.0.1', () => process.stdout.write('market gateway ready: 127.0.0.1:21323\n'));
}
