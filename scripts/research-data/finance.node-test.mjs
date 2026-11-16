import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FINANCE_LIMITS, materializeFinance, parseFinanceArgs } from './finance.mjs';
import { readCatalog, readDataFile } from './store.mjs';

const COMMIT = '526c518249a3c5bdaa74d63684c0358db7c248e6';
const RAW = `https://raw.githubusercontent.com/Sinotrade/shioaji-data/${COMMIT}/`;
const HEAD = 'https://api.github.com/repos/Sinotrade/shioaji-data/commits/main';
const NOW = '2026-11-16T04:05:31.833Z';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value));

function officialSource(id) {
    return { id, name: `官方 ${id}`, url: 'https://data.gov.tw/dataset/91998',
        license_url: 'https://data.gov.tw/license', license: '政府資料開放授權條款－第1版',
        attribution: `資料提供機關 2026 ${id}；政府資料開放授權條款第1版` };
}
function financial(code = '2330') {
    // Small projection of independently checked public numbers, not a raw
    // upstream dump. Q3 revenue/EPS are reported YTD vs derived single-quarter.
    return {
        code, name: code === '2891' ? '中信金' : code === '6488' ? '環球晶' : '台積電',
        market: code === '6488' ? 'tpex' : 'twse', summary_long: 'RAW_AI_TEXT_MUST_NOT_PERSIST',
        monthly_revenue: [{ period: '2026-10', revenue_thousand_twd: 586890319, yoy_pct: 59.7098,
            note: 'RAW_FREE_TEXT_MUST_NOT_PERSIST', ytd_thousand_twd: 4485617293 }],
        statements: {
            periods: ['2026Q1', '2026Q2', '2026Q3'],
            format: Array(3).fill(code === '2891' ? 'holding' : 'general'),
            income_ytd: {
                '基本每股盈餘（元）': [22.08, 49.33, 78.75], '營業收入': [1134103440, 2404483690, 3898726974],
                '營業毛利（毛損）淨額': [751295421, 1611606116, 2603984766],
            },
            income_quarter: {
                '基本每股盈餘（元）': [22.08, 27.25, 29.42],
                '營業收入': [1134103440, 1270380250, 1494243284],
                '營業毛利（毛損）淨額': [751295421, 860310695, 992378650],
            },
            balance: {}, cash_flow_quarter: {}, cash_flow_ytd: {},
        },
    };
}
function networkFixture({ codes = ['2330'], changeManifest, changeFinancial, changeRegistry } = {}) {
    const responses = new Map();
    const registry = { version: 1, sources: [officialSource('twse-openapi-revenue'), officialSource('tpex-openapi-revenue'),
        officialSource('mops-ifrs-statements'), { id: 'curated-research', name: 'AI_RESEARCH_MUST_NOT_PERSIST', license: '待定' }] };
    changeRegistry?.(registry);
    const registryBytes = encode(registry);
    const manifest = {
        manifest_schema_version: '1.0.0', financials_schema_version: '1.1.0', release_id: '2026.11.13.2328',
        built_at: '2026-11-13T23:27:57+0800', official_fetched_at: '2026-11-13', revocations: [],
        files: { 'global/sources': { path: 'v1/global/sources/sources.json', sha256: sha(registryBytes), schema_version: '1.0.0' } },
        financials: {},
    };
    responses.set(`${RAW}v1/global/sources/sources.json`, registryBytes);
    for (const code of codes) {
        const raw = financial(code);
        changeFinancial?.(raw, code);
        const bytes = encode(raw);
        manifest.financials[code] = { path: `v1/tw/financials/json/${code}.json`, sha256: sha(bytes), as_of: '2026-10' };
        responses.set(`${RAW}v1/tw/financials/json/${code}.json`, bytes);
    }
    changeManifest?.(manifest);
    responses.set(`${RAW}v1/manifest.json`, encode(manifest));
    responses.set(HEAD, encode({ sha: COMMIT }));
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push({ url, options });
        assert.equal(options.redirect, 'error');
        assert.ok(options.signal instanceof AbortSignal);
        assert.ok(url === HEAD || url.startsWith(RAW), 'only pinned official URLs');
        assert.ok(responses.has(url), `unexpected fetch ${url}`);
        const response = responses.get(url);
        if (response instanceof Error) throw response;
        if (typeof response === 'function') return response(url, options);
        return new Response(response);
    };
    return { responses, calls, fetchImpl, manifest };
}
function publisherSpy() {
    const calls = [];
    return { calls, publishImpl: async (input, options) => {
        calls.push({ input, options });
        return { release: { id: input.id, firstSeenAt: typeof options.now === 'function' ? options.now() : options.now }, catalog: {}, unchanged: false };
    } };
}
const args = fixture => ({ commit: COMMIT, symbols: ['2330'], root: 'unused-test-root', now: NOW, fetchImpl: fixture.fetchImpl });

test('projects official numeric finance fields, provenance, units and explicit EPS basis', async () => {
    const fixture = networkFixture(); const publisher = publisherSpy();
    const result = await materializeFinance({ ...args(fixture), ...publisher });
    const publication = publisher.calls[0].input;
    const data = publication.items[0].data;
    assert.equal(publication.kind, 'finance');
    assert.equal(data.market, 'TSE');
    assert.equal(data.upstreamBuiltAt, '2026-11-13T15:27:57.000Z');
    assert.deepEqual(data.revenue, [{ period: '2026-10', revenueThousands: 586890319, yoyPercent: 59.7098 }]);
    assert.equal(data.quarters[2].eps, 29.42, 'single-quarter derived EPS must not become reported YTD EPS 78.75');
    assert.equal(data.quarters[2].epsBasis, 'quarter_derived_from_ytd');
    assert.equal(data.quarters[0].epsBasis, 'quarter_reported_q1');
    assert.equal(data.quarters[2].grossMarginPercent, 66.4135);
    assert.equal(data.provenance.sourceSchema, '1.1.0');
    assert.equal(data.provenance.sourceSha256, fixture.manifest.financials['2330'].sha256);
    assert.equal(data.provenance.sourceUrl, `${RAW}v1/tw/financials/json/2330.json`);
    assert.deepEqual(data.provenance.sources.map(source => source.id), ['mops-ifrs-statements', 'twse-openapi-revenue']);
    assert.equal(data.provenance.sourceRegistry.checkedAgainstCommit, COMMIT);
    assert.equal(data.provenance.calculations.revenueUnit, 'thousand_TWD');
    assert.equal(data.provenance.calculations.epsUnit, 'TWD_per_share');
    assert.equal(Object.hasOwn(data, 'firstSeenAt'), false);
    assert.equal(Object.hasOwn(data, 'releaseId'), false);
    assert.equal(result.verifiedAt, NOW);
    assert.equal(result.upstreamCommit, COMMIT);
    assert.equal(JSON.stringify(publication).includes('MUST_NOT_PERSIST'), false);
    assert.equal(publisher.calls[0].options.now(), NOW);
});

test('Q2 uses same-period quarterly amounts, neither YTD totals nor differenced margin percentages', async () => {
    const fixture = networkFixture(); const publisher = publisherSpy();
    await materializeFinance({ ...args(fixture), ...publisher });
    const q2 = publisher.calls[0].input.items[0].data.quarters[1];
    assert.equal(q2.period, '2026Q2');
    assert.equal(q2.eps, 27.25, 'must not use Q2 reported YTD EPS 49.33');
    assert.equal(q2.grossMarginPercent, 67.7207);
    assert.notEqual(q2.grossMarginPercent, Math.round(1611606116 / 2404483690 * 1_000_000) / 10_000);
    const differencedRatios = (1611606116 / 2404483690 - 751295421 / 1134103440) * 100;
    assert.ok(Math.abs(q2.grossMarginPercent - differencedRatios) > 60);
    const source = financial().statements;
    assert.equal(source.income_quarter['營業收入'][1], source.income_ytd['營業收入'][1] - source.income_ytd['營業收入'][0]);
    assert.equal(source.income_quarter['營業毛利（毛損）淨額'][1], source.income_ytd['營業毛利（毛損）淨額'][1] - source.income_ytd['營業毛利（毛損）淨額'][0]);
});

test('margin remains null with a missing or zero quarterly denominator', async () => {
    const fixture = networkFixture({ changeFinancial: raw => {
        raw.statements.income_quarter['營業收入'][0] = 0;
        raw.statements.income_quarter['營業收入'][1] = null;
        raw.gross_margin = [99, 99, 99]; // unverified upstream convenience field is never consumed
    } });
    const publisher = publisherSpy();
    await materializeFinance({ ...args(fixture), ...publisher });
    const quarters = publisher.calls[0].input.items[0].data.quarters;
    assert.equal(quarters[0].grossMarginPercent, null);
    assert.equal(quarters[1].grossMarginPercent, null);
    assert.equal(quarters[2].grossMarginPercent, 66.4135);
});

test('keeps finance formats nullable and preserves valid missing numeric values', async () => {
    const fixture = networkFixture({ codes: ['2891', '6488'], changeFinancial: (raw, code) => {
        if (code === '6488') {
            raw.monthly_revenue[0].revenue_thousand_twd = null;
            raw.monthly_revenue[0].yoy_pct = null;
            raw.statements.income_quarter['基本每股盈餘（元）'][2] = null;
        }
    } });
    const publisher = publisherSpy();
    await materializeFinance({ ...args(fixture), symbols: ['6488', '2891'], ...publisher });
    const [bank, otc] = publisher.calls[0].input.items.map(item => item.data);
    assert.equal(bank.market, 'TSE');
    assert.ok(bank.quarters.every(row => row.grossMarginPercent === null));
    assert.equal(otc.market, 'OTC');
    assert.deepEqual(otc.revenue[0], { period: '2026-10', revenueThousands: null, yoyPercent: null });
    assert.equal(otc.quarters[2].eps, null);
    assert.deepEqual(otc.provenance.sources.map(source => source.id), ['mops-ifrs-statements', 'tpex-openapi-revenue']);
});

test('resolves main once and pins all raw requests to the resulting immutable commit', async () => {
    const fixture = networkFixture(); const publisher = publisherSpy();
    const options = args(fixture); delete options.commit;
    await materializeFinance({ ...options, ...publisher });
    assert.equal(fixture.calls[0].url, HEAD);
    assert.equal(fixture.calls.filter(call => call.url === HEAD).length, 1);
    assert.ok(fixture.calls.slice(1).every(call => call.url.startsWith(RAW)));
});

test('keeps release identity stable across clock changes, duplicate symbols and ordering', async () => {
    const fixture = networkFixture({ codes: ['2330', '6488'] }); const publisher = publisherSpy();
    await materializeFinance({ ...args(fixture), symbols: ['6488', '2330', '2330'], ...publisher });
    await materializeFinance({ ...args(fixture), symbols: ['2330', '6488'], now: '2026-11-17T00:00:00Z', ...publisher });
    assert.equal(publisher.calls[0].input.id, publisher.calls[1].input.id);
    assert.deepEqual(publisher.calls[0].input.items, publisher.calls[1].input.items);
});

test('reports unknown manifest symbols without borrowing another company', async () => {
    const fixture = networkFixture(); const publisher = publisherSpy();
    const result = await materializeFinance({ ...args(fixture), symbols: ['9999', '2330'], ...publisher });
    assert.deepEqual(result.missingSymbols, ['9999']);
    assert.deepEqual(publisher.calls[0].input.items.map(item => item.symbol), ['2330']);
    assert.ok(fixture.calls.every(call => !call.url.includes('/9999.json')));
});

for (const [label, changeManifest] of [
    ['new manifest major', m => { m.manifest_schema_version = '2.0.0'; }],
    ['new finance major', m => { m.financials_schema_version = '2.0.0'; }],
    ['new sources major', m => { m.files['global/sources'].schema_version = '2.0.0'; }],
    ['traversal path', m => { m.financials['2330'].path = 'v1/../../secret.json'; }],
    ['external path', m => { m.financials['2330'].path = 'https://example.com/data.json'; }],
    ['encoded traversal path', m => { m.financials['2330'].path = 'v1/%2e%2e/secret.json'; }],
    ['invalid source hash', m => { m.files['global/sources'].sha256 = '0'.repeat(64); }],
]) {
    test(`rejects ${label} without publishing`, async () => {
        const fixture = networkFixture({ changeManifest }); const publisher = publisherSpy();
        await assert.rejects(materializeFinance({ ...args(fixture), ...publisher }));
        assert.equal(publisher.calls.length, 0);
    });
}

for (const [label, changeFinancial] of [
    ['mismatched symbol', raw => { raw.code = '9999'; }],
    ['wrong money type', raw => { raw.monthly_revenue[0].revenue_thousand_twd = '586890319'; }],
    ['missing percentage field', raw => { delete raw.monthly_revenue[0].yoy_pct; }],
    ['duplicate revenue period', raw => { raw.monthly_revenue.push({ ...raw.monthly_revenue[0] }); }],
    ['invalid month', raw => { raw.monthly_revenue[0].period = '2026-13'; }],
    ['future month', raw => { raw.monthly_revenue[0].period = '2026-12'; }],
    ['misaligned series', raw => { raw.statements.income_quarter['基本每股盈餘（元）'].pop(); }],
    ['future statement', raw => { raw.statements.periods[2] = '2026Q4'; }],
    ['missing format', raw => { raw.statements.format.pop(); }],
    ['invalid statement number', raw => { raw.statements.income_ytd['基本每股盈餘（元）'][0] = '25'; }],
]) {
    test(`rejects ${label} even when its byte hash matches the manifest`, async () => {
        const fixture = networkFixture({ changeFinancial }); const publisher = publisherSpy();
        await assert.rejects(materializeFinance({ ...args(fixture), ...publisher }));
        assert.equal(publisher.calls.length, 0);
    });
}

test('checks original bytes rather than a reserialized JSON hash', async () => {
    const fixture = networkFixture(); const publisher = publisherSpy();
    const url = `${RAW}v1/tw/financials/json/2330.json`;
    fixture.responses.set(url, Buffer.concat([fixture.responses.get(url), Buffer.from(' ')]));
    await assert.rejects(materializeFinance({ ...args(fixture), ...publisher }), /sha256 mismatch/);
    assert.equal(publisher.calls.length, 0);
});

test('a required later download failure leaves an already published catalog unchanged', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'neo-finance-failure-'));
    try {
        const first = networkFixture();
        await materializeFinance({ ...args(first), root });
        const before = await readFile(path.join(root, 'catalog.json'));
        const failed = networkFixture({ codes: ['2330', '6488'] });
        failed.responses.set(`${RAW}v1/tw/financials/json/6488.json`, new Error('network unavailable'));
        await assert.rejects(materializeFinance({ ...args(failed), root, symbols: ['2330', '6488'] }), /network unavailable/);
        assert.deepEqual(await readFile(path.join(root, 'catalog.json')), before);
        assert.ok((await readdir(root)).every(name => !name.startsWith('.staging')));
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('same-content publication preserves the first successful local observation time', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'neo-finance-repeat-'));
    try {
        const fixture = networkFixture();
        const first = await materializeFinance({ ...args(fixture), root });
        const second = await materializeFinance({ ...args(fixture), root, now: '2026-11-17T00:00:00Z' });
        assert.equal(second.unchanged, true);
        assert.equal(second.release.id, first.release.id);
        assert.equal(second.release.firstSeenAt, NOW);
        assert.equal((await readCatalog(root)).financeReleases.length, 1);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('firstSeenAt is sampled only after the last required download and verification finish', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'neo-finance-observation-'));
    try {
        const fixture = networkFixture({ codes: ['2330', '6488'] });
        const startedAt = '2026-11-16T04:00:00.000Z';
        const completedAt = '2026-11-16T04:01:00.000Z';
        let clock = startedAt;
        let requiredDelivered = false;
        const fetchImpl = async (url, options) => {
            const response = await fixture.fetchImpl(url, options);
            if (url.endsWith('/6488.json')) {
                // Simulate a slow last required response; the sync started
                // before this instant but the release did not yet exist.
                await Promise.resolve();
                clock = completedAt;
                requiredDelivered = true;
            }
            return response;
        };
        const result = await materializeFinance({ ...args(fixture), root, symbols: ['2330', '6488'], fetchImpl,
            now: () => { assert.equal(requiredDelivered, true, 'clock sampled before complete data delivery'); return clock; } });
        assert.equal(result.verifiedAt, completedAt);
        assert.equal(result.release.firstSeenAt, completedAt);
        assert.notEqual(result.release.firstSeenAt, startedAt);
        const payload = JSON.parse(await readDataFile(root, result.release.items[0].path));
        assert.equal(payload.firstSeenAt, completedAt);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('unmapped upstream revocation blocks every older finance read, including pinned catalogs', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'neo-finance-revoke-'));
    try {
        const fixture = networkFixture();
        const first = await materializeFinance({ ...args(fixture), root });
        const oldCatalog = first.catalog;
        const payloadPath = first.release.items[0].path;
        assert.ok((await readDataFile(root, payloadPath, oldCatalog)).length > 0);
        const withdrawn = networkFixture({ changeManifest: m => { m.revocations = [{ id: 'unknown-upstream-id' }]; } });
        await assert.rejects(materializeFinance({ ...args(withdrawn), root }), /existing finance releases revoked/);
        assert.ok((await readCatalog(root)).revoked.includes(first.release.id));
        await assert.rejects(readDataFile(root, payloadPath), /revoked/);
        await assert.rejects(readDataFile(root, payloadPath, oldCatalog), /revoked/);
        await assert.rejects(materializeFinance({ ...args(fixture), root }), /revoked release cannot be republished/);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('upstream revocation reports failure loudly when the withdrawal cannot be persisted', async () => {
    const fixture = networkFixture({ changeManifest: m => { m.revocations = { unexpected: true }; } });
    const publisher = publisherSpy();
    await assert.rejects(materializeFinance({ ...args(fixture), ...publisher,
        revokeImpl: async () => { throw new Error('writer locked'); } }), /stopping existing finance failed: writer locked/);
    assert.equal(publisher.calls.length, 0);
});

test('rejects HTTP redirects and oversized advertised responses', async () => {
    for (const response of [
        () => new Response(null, { status: 302, headers: { location: 'https://example.com/' } }),
        () => new Response('{}', { headers: { 'content-length': String(FINANCE_LIMITS.manifestBytes + 1) } }),
    ]) {
        const fixture = networkFixture(); const publisher = publisherSpy();
        fixture.responses.set(`${RAW}v1/manifest.json`, response);
        await assert.rejects(materializeFinance({ ...args(fixture), ...publisher }), /HTTP failure|byte limit/);
        assert.equal(publisher.calls.length, 0);
    }
});

test('enforces the byte limit while streaming when no content length is declared', async () => {
    const fixture = networkFixture(); const publisher = publisherSpy();
    fixture.responses.set(`${RAW}v1/manifest.json`, () => new Response(new ReadableStream({
        start(controller) {
            controller.enqueue(new Uint8Array(FINANCE_LIMITS.manifestBytes));
            controller.enqueue(new Uint8Array(1)); controller.close();
        },
    })));
    await assert.rejects(materializeFinance({ ...args(fixture), ...publisher }), /byte limit/);
});

test('times out an unresponsive fetch instead of leaving a sync pending', async () => {
    const publisher = publisherSpy();
    await assert.rejects(materializeFinance({ commit: COMMIT, symbols: ['2330'], now: NOW,
        timeoutMs: 5, fetchImpl: async () => new Promise(() => {}), ...publisher }), /timed out/);
    assert.equal(publisher.calls.length, 0);
});

test('unknown or unlicensed official source metadata never reaches publication', async () => {
    for (const changeRegistry of [
        registry => { registry.sources = registry.sources.filter(source => source.id !== 'mops-ifrs-statements'); },
        registry => { registry.sources[0].license = '待定'; },
        registry => { registry.sources[0].url = 'http://data.gov.tw/dataset/18420'; },
    ]) {
        const fixture = networkFixture({ changeRegistry }); const publisher = publisherSpy();
        await assert.rejects(materializeFinance({ ...args(fixture), ...publisher }));
        assert.equal(publisher.calls.length, 0);
    }
});

test('CLI accepts explicit immutable input and rejects URL overrides or ambiguous options', () => {
    assert.deepEqual(parseFinanceArgs(['--root', '.research-data', '--symbols', '6488,2330,2330', '--commit', COMMIT]),
        { root: '.research-data', symbols: ['2330', '6488'], commit: COMMIT });
    assert.deepEqual(parseFinanceArgs(['--help']), { help: true });
    for (const argv of [['--url', 'https://example.com'], ['--commit', 'main'], ['--symbols', '2330,../secret'],
        ['--root'], ['--root', 'one', '--root', 'two']]) assert.throws(() => parseFinanceArgs(argv));
});
