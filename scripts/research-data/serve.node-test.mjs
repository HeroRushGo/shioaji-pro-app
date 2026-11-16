import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { researchDataMiddleware } from './serve.mjs';
import { canonical, publishRelease, publishedFiles, readCatalog, readDataFile, revokeReleases } from './store.mjs';

// The fallback deliberately serves a canary whenever next() is called. These
// are control-flow assertions, independent of how a particular static server
// chooses to decode an attacker-controlled URL.
async function invoke(middleware, url, { method = 'GET', headers = {} } = {}) {
    let nextCalls = 0;
    let result;
    const response = {
        statusCode: 200, headers: {},
        setHeader(name, value) { this.headers[name] = value; },
        end(body) { result = { status: this.statusCode, headers: this.headers, body: body?.toString() }; },
    };
    await middleware({ url, method, headers }, response, () => {
        nextCalls += 1;
        response.statusCode = 200;
        response.end('STATIC_FALLBACK_CANARY');
    });
    return { ...result, nextCalls };
}

const aliases = [
    ['encoded first prefix character', '/%72esearch-data/releases/finance-a/2330.json'],
    ['encoded hyphen', '/research%2ddata/releases/finance-a/2330.json'],
    ['uppercase encoded prefix', '/%52ESEARCH-DATA/releases/finance-a/2330.json'],
    ['mixed-case prefix', '/Research-Data/releases/finance-a/2330.json'],
    ['double encoded prefix', '/%2572esearch-data/releases/finance-a/2330.json'],
    ['double encoded hyphen', '/research%252ddata/releases/finance-a/2330.json'],
    ['deeper encoding is ambiguous', '/%252572esearch-data/releases/finance-a/2330.json'],
    ['deep encoding cannot be delegated', '/%2525252572esearch-data/releases/finance-a/2330.json'],
    ['repeated leading slash', '//research-data/releases/finance-a/2330.json'],
    ['protocol-relative target with authority', '//127.0.0.1:5175/research-data/releases/finance-a/2330.json'],
    ['encoded protocol-relative authority', '/%2f127.0.0.1:5175/research-data/releases/finance-a/2330.json'],
    ['extra namespace slash', '/research-data//releases/finance-a/2330.json'],
    ['literal dot segment before prefix', '/x/../research-data/releases/finance-a/2330.json'],
    ['literal dot segment after prefix', '/research-data/./releases/finance-a/2330.json'],
    ['encoded dot segment', '/x/%2e%2e/research-data/releases/finance-a/2330.json'],
    ['double encoded dot segment', '/x/%252e%252e/research-data/releases/finance-a/2330.json'],
    ['encoded leading slash lowercase', '/%2fresearch-data/releases/finance-a/2330.json'],
    ['encoded leading slash uppercase', '/%2Fresearch-data/releases/finance-a/2330.json'],
    ['encoded Windows separator', '/%5cresearch-data%5creleases%5cfinance-a%5c2330.json'],
    ['literal Windows separator', '/research-data\\releases\\finance-a\\2330.json'],
    ['Windows dot-segment alias', '/x\\..\\research-data\\releases\\finance-a\\2330.json'],
    ['encoded filename', '/research-data/releases/finance-a/%32%33%33%30.json'],
    ['query on data URL', '/research-data/releases/finance-a/2330.json?raw'],
    ['encoded query delimiter', '/%72esearch-data/releases/finance-a/2330.json%3fraw'],
    ['fragment on data URL', '/research-data/releases/finance-a/2330.json#raw'],
    ['absolute-form target', 'http://127.0.0.1:5175/research-data/releases/finance-a/2330.json'],
    ['encoded absolute-form target', 'http://127.0.0.1:5175/%72esearch-data/releases/finance-a/2330.json'],
    ['absolute-form uppercase host and prefix', 'HTTP://LOCALHOST:5175/RESEARCH-DATA/releases/finance-a/2330.json'],
    ['encoded namespace root', '/%72esearch-data'],
    ['namespace root without file', '/research-data'],
    ['incomplete percent escape', '/%7research-data/releases/finance-a/2330.json'],
    ['encoded zero byte', '/%00research-data/releases/finance-a/2330.json'],
];

for (const [label, url] of aliases) {
    test(`noncanonical research URL never reaches static fallback: ${label}`, async () => {
        const result = await invoke(researchDataMiddleware('/not-used-for-rejected-targets'), url);
        assert.equal(result.nextCalls, 0, `next() bypassed the ledger for ${url}`);
        assert.equal(result.status, 404);
        assert.notEqual(result.body, 'STATIC_FALLBACK_CANARY');
        assert.equal(result.headers['Cache-Control'], 'no-store');
    });
}

test('normal non-data Vite assets preserve the original target and reach next()', async () => {
    const middleware = researchDataMiddleware('/not-used-for-normal-assets');
    for (const url of ['/research.html', '/@vite/client', '/@react-refresh',
        '/src/research/main.tsx?t=123', '/assets/research-a1.js?v=1',
        '/assets/icon%20name.svg', '/assets/%E7%A0%94%E7%A9%B6.svg',
        '/assets/logo.svg?next=/%72esearch-data/catalog.json']) {
        const result = await invoke(middleware, url);
        assert.equal(result.nextCalls, 1, `ordinary Vite asset was blocked: ${url}`);
        assert.equal(result.body, 'STATIC_FALLBACK_CANARY');
    }
});

test('ambiguous extra encodings outside data cannot be passed to an unbounded later decoder', async () => {
    for (const url of ['/assets/%25252572.svg', '/assets/%zz.svg', '/assets/%3fdata.svg']) {
        const result = await invoke(researchDataMiddleware('/unused'), url);
        assert.equal(result.nextCalls, 0);
        assert.equal(result.status, 404);
    }
});

async function directory(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'research-serve-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return root;
}
function publication(root, id = 'finance-a') {
    return { root, kind: 'finance', id,
        metadata: { upstreamCommit: 'a'.repeat(40), upstreamBuiltAt: '2026-11-13T23:27:57+08:00' },
        items: [{ symbol: '2330', name: '台積電', market: 'TSE', data: {
            schemaVersion: 1, kind: 'finance', symbol: '2330', name: '台積電', market: 'TSE', revenue: [], quarters: [],
        } }],
    };
}

test('canonical catalog and approved payload use the ledger gate without static fallback', async t => {
    const root = await directory(t);
    const published = await publishRelease(publication(root), { now: '2026-11-16T04:00:00Z' });
    const middleware = researchDataMiddleware(root);
    for (const url of ['/research-data/catalog.json', `/research-data/${published.release.items[0].path}`]) {
        const result = await invoke(middleware, url);
        assert.equal(result.status, 200);
        assert.equal(result.nextCalls, 0);
        assert.doesNotThrow(() => JSON.parse(result.body));
        const head = await invoke(middleware, url, { method: 'HEAD' });
        assert.equal(head.status, 200);
        assert.equal(head.nextCalls, 0);
        assert.equal(head.body, undefined);
    }
});

test('build then family withdrawal then restart denies canonical and encoded aliases even with a rolled-back old catalog', async t => {
    const source = await directory(t);
    const built = await directory(t);
    const published = await publishRelease(publication(source), { now: '2026-11-16T04:00:00Z' });
    for (const file of await publishedFiles(source)) {
        await fs.mkdir(path.dirname(path.join(built, file.path)), { recursive: true });
        await fs.writeFile(path.join(built, file.path), file.bytes);
    }
    const url = `/research-data/${published.release.items[0].path}`;
    assert.equal((await invoke(researchDataMiddleware(built, { withdrawalRoot: source }), url)).status, 200);
    await revokeReleases({ root: source, kind: 'finance', reason: 'unknown upstream withdrawal' });
    await fs.writeFile(path.join(source, 'catalog.json'), canonical(published.catalog));
    const restarted = researchDataMiddleware(built, { withdrawalRoot: source });
    for (const candidate of [url, ...aliases.map(([, alias]) => alias)]) {
        const result = await invoke(restarted, candidate);
        assert.equal(result.nextCalls, 0, `withdrawn build delegated ${candidate} to static serving`);
        assert.equal(result.status, 404);
        assert.notEqual(result.body, 'STATIC_FALLBACK_CANARY');
    }
    const ledger = await readCatalog(source);
    assert.ok(ledger.blockedKinds.includes('finance'));
    await assert.rejects(readDataFile(source, published.release.items[0].path, published.catalog), /revoked/);
    const servedCatalog = await invoke(restarted, '/research-data/catalog.json');
    assert.equal(servedCatalog.nextCalls, 0);
    assert.ok(JSON.parse(servedCatalog.body).revoked.includes(published.release.id));
});
