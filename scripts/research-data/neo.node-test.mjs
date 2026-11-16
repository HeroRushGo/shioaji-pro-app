import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { materializeNeo, neoSampleTimes } from './neo.mjs';
import { readCatalog, readDataFile } from './store.mjs';

const neoCommit = 'a'.repeat(40);
const now = '2026-11-16T03:00:00.000Z';
const date = '2026-11-13';
const identity = { symbol: '2330', name: '台積電', market: 'TSE' };
const base = { neoCommit, now, dates: [date], symbols: [identity] };
const epoch = (date, time) => Date.parse(`${date}T${time}:00Z`) / 1000;

function reader(calls = [], patch = (_route, _params, response) => response) {
    return async (route, params) => {
        calls.push({ route, params: { ...params } });
        let body;
        if (route === '/api/session') body = {
            schema_version: 2, symbol: params.symbol, date: params.date,
            observer: true, decision_capable: false, status: 'ready', source: 'neo_wss',
            coverage: 'complete', books_available: true, reason_codes: [], repair_recommended: false,
            // Source qualification is whole-day metadata. These arbitrary
            // unapproved fields must never become numerical replay values.
            last: 9999, account: 'never-copy', lineage: { arbitrary: 'never-copy' },
        };
        else if (route.startsWith('/api/bars/')) {
            const symbol = route.split('/').at(-1);
            const time = params.as_of.slice(0, 5);
            const price = 100 + Number(time.slice(0, 2)) - 9;
            body = {
                meta: { symbol, date: params.date, name: identity.name, last: price, vwap_last: price - 0.5, cum_volume: 1_000 },
                bars: [{ t: epoch(params.date, time), o: price, h: price, l: price, c: price, v: 10 }],
                vwap: [price - 0.5], obv: [10],
            };
        } else if (route.startsWith('/api/vp/')) {
            const price = 90 + Number(params.as_of.slice(0, 2));
            body = { rows: [[price, 100]], poc: price, vah: price + 1, val: price - 1, tick_count: 10, bin_strategy: 'actual_traded_price' };
        } else throw new Error('Unexpected route');
        return patch(route, params, { status: 200, body });
    };
}

async function temporary(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-research-export-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return directory;
}

test('requests exact prefix GETs at ten 30-minute cutoffs and publishes only projected values', async t => {
    const root = await temporary(t), calls = [];
    const result = await materializeNeo({ ...base, root, readerFn: reader(calls) });
    assert.equal(result.published, true);
    assert.equal(calls.length, 22);
    assert.deepEqual(calls[0], { route: '/api/session', params: { symbol: '2330', date } });
    assert.deepEqual(calls[1], { route: '/api/bars/2330', params: { date, as_of: '09:00:00', interval: 60 } });
    assert.deepEqual(calls[2], { route: '/api/vp/2330', params: { date, as_of: '09:00:00' } });
    assert.deepEqual(calls.at(-2), { route: '/api/vp/2330', params: { date, as_of: '13:30:00' } });
    assert.deepEqual(calls.at(-1), { route: '/api/session', params: { symbol: '2330', date } });
    assert.ok(calls.every(call => Object.keys(call.params).every(key => ['symbol', 'date', 'as_of', 'interval'].includes(key))));
    const item = result.release.items[0];
    const bytes = await readDataFile(root, item.path);
    const payload = JSON.parse(bytes);
    assert.equal(payload.kind, 'replay');
    assert.equal(payload.neoCommit, neoCommit);
    assert.equal(payload.samplingMinutes, 30);
    assert.deepEqual(payload.points[0], { time: '09:00', price: 100, vwap: 99.5, poc: 99 });
    assert.equal(payload.points.at(-1).time, '13:30');
    assert.equal(payload.points.length, 10);
    assert.equal(payload.provenance.session.scope, 'whole_day_source_metadata');
    assert.equal(payload.provenance.session.observer, true);
    assert.equal(payload.provenance.session.decisionCapable, false);
    assert.equal(payload.provenance.decisionEligible, false);
    assert.ok(!bytes.toString().includes('never-copy'));
    assert.ok(!bytes.toString().includes('cum_volume'));
    assert.ok(!bytes.toString().includes('exportedAt'));
    assert.deepEqual(payload.provenance.sampling, { minutes: 30, timeZone: 'Asia/Taipei', exactCutoff: 'HH:mm:00', inclusive: true });
});

test('same source and derived content retain stable release identity and firstSeenAt on rerun', async t => {
    const root = await temporary(t);
    const first = await materializeNeo({ ...base, root, readerFn: reader() });
    const again = await materializeNeo({ ...base, root, now: '2026-11-17T01:00:00.000Z', readerFn: reader() });
    assert.equal(again.release.id, first.release.id);
    assert.equal(again.release.firstSeenAt, now);
    assert.equal(again.unchanged, true);
    assert.equal((await readCatalog(root)).replayReleases.length, 1);
});

test('real-store firstSeenAt is sampled only after the delayed reader and final validation complete', async t => {
    const root = await temporary(t);
    const completedAt = '2026-11-16T03:01:20.000Z';
    let clock = now, phase = 'reading', sessionCalls = 0;
    const clockPhases = [];
    let enterReader, finishReader;
    const entered = new Promise(resolve => { enterReader = resolve; });
    const delayed = new Promise(resolve => { finishReader = resolve; });
    const source = reader();
    const readerFn = async (route, params) => {
        if (route === '/api/session' && ++sessionCalls === 1) {
            enterReader();
            await delayed;
        }
        const result = await source(route, params);
        if (route === '/api/session' && sessionCalls === 2) {
            // Advance only once the last reader response has completed. The
            // exporter still has to validate all returned schemas and values.
            phase = 'reader-complete';
            clock = completedAt;
        }
        return result;
    };
    const request = materializeNeo({ ...base, root, readerFn, now: () => { clockPhases.push(phase); return clock; } });
    await entered;
    assert.deepEqual(clockPhases, ['reading']);
    finishReader();
    const result = await request;
    assert.equal(result.release.firstSeenAt, completedAt);
    assert.ok(Date.parse(result.release.firstSeenAt) >= Date.parse(completedAt));
    assert.ok(clockPhases.slice(1).length > 0 && clockPhases.slice(1).every(value => value === 'reader-complete'));
    const stored = JSON.parse(await readDataFile(root, result.release.items[0].path));
    assert.equal(stored.firstSeenAt, completedAt);
});

test('a clock function is checked again at publication instead of trusting its initial value', async t => {
    const root = await temporary(t);
    let reads = 0;
    await assert.rejects(materializeNeo({ ...base, root, readerFn: reader(),
        now: () => ++reads === 1 ? now : 'invalid completion clock',
    }), /invalid export clock/);
    assert.deepEqual((await readCatalog(root)).replayReleases, []);
});

test('a missing exact-cutoff response stays null and does not borrow later or session values', async t => {
    const root = await temporary(t);
    const source = reader([], (route, params, result) => params.as_of === '09:00:00'
        ? { status: 404, body: { detail: 'no ticks' } } : result);
    const result = await materializeNeo({ ...base, root, readerFn: source });
    const payload = JSON.parse(await readDataFile(root, result.release.items[0].path));
    assert.deepEqual(payload.points[0], { time: '09:00', price: null, vwap: null, poc: null });
    assert.equal(payload.points[1].price, 100);
});

test('a completely absent symbol/date returns missing without publishing false data', async t => {
    const root = await temporary(t);
    const source = reader([], (_route, _params, result) => result.body.schema_version === 2
        ? result : { status: 404, body: { detail: 'no ticks' } });
    const result = await materializeNeo({ ...base, root, readerFn: source });
    assert.equal(result.published, false);
    assert.deepEqual(result.missing, [{ symbol: '2330', date, status: 'ready' }]);
    assert.deepEqual((await readCatalog(root)).replayReleases, []);
});

test('only past Taipei dates and verified symbol identities may reach a reader', async t => {
    const root = await temporary(t);
    let called = false;
    const readerFn = async () => { called = true; throw new Error('must not execute'); };
    for (const patch of [{ dates: ['2026-11-16'] }, { dates: ['2026-02-30'] }, { dates: ['2026-11-17'] },
        { symbols: [{ ...identity, symbol: '../2330' }] }, { symbols: [{ ...identity, market: 'US' }] },
        { symbols: [{ ...identity, symbol: 2330 }] },
        { symbols: [identity, identity] }, { samplingMinutes: 0 }]) {
        await assert.rejects(materializeNeo({ ...base, ...patch, root, readerFn }));
    }
    // UTC midnight is not the day boundary used by the export gate.
    await assert.rejects(materializeNeo({ ...base, now: '2026-11-15T16:01:00Z', dates: ['2026-11-16'], root, readerFn }), /past Asia\/Taipei/);
    assert.equal(called, false);
});

test('future-point pollution is rejected before a release is published', async t => {
    const root = await temporary(t);
    const source = reader([], (route, params, result) => {
        if (route.startsWith('/api/bars/')) result.body.bars[0].t = epoch(params.date, '13:30');
        return result;
    });
    await assert.rejects(materializeNeo({ ...base, root, readerFn: source }), /future or wrong-day/);
    assert.deepEqual((await readCatalog(root)).replayReleases, []);
});

test('wrong source identity, non-observer sessions and summary/vector mismatches fail closed', async t => {
    const root = await temporary(t);
    for (const modify of [
        (route, _params, result) => { if (route === '/api/session') result.body.observer = false; return result; },
        (route, _params, result) => { if (route === '/api/session') result.body.decision_capable = true; return result; },
        (route, _params, result) => { if (route.startsWith('/api/bars/')) result.body.meta.symbol = '2891'; return result; },
        (route, _params, result) => { if (route.startsWith('/api/bars/')) result.body.meta.last = 9999; return result; },
        (route, _params, result) => { if (route.startsWith('/api/vp/')) result.body.poc = NaN; return result; },
        (route, _params, result) => route === '/api/session' ? { status: 503, body: { detail: 'busy' } } : result,
    ]) await assert.rejects(materializeNeo({ ...base, root, readerFn: reader([], modify) }));
    assert.deepEqual((await readCatalog(root)).replayReleases, []);
});

test('sampling interval is explicit, bounded and includes the closing auction cutoff', () => {
    assert.equal(neoSampleTimes(1).length, 271);
    assert.equal(neoSampleTimes(30).length, 10);
    assert.deepEqual(neoSampleTimes(60), ['09:00', '10:00', '11:00', '12:00', '13:00', '13:30']);
    assert.throws(() => neoSampleTimes('30'));
});

test('a repair or source change during a batch is rejected before publication', async t => {
    const root = await temporary(t);
    let sessionCalls = 0;
    const source = reader([], (route, _params, result) => {
        if (route === '/api/session' && ++sessionCalls === 2) result.body.source = 'shioaji_l1';
        return result;
    });
    await assert.rejects(materializeNeo({ ...base, root, readerFn: source }), /source or coverage changed/);
    assert.deepEqual((await readCatalog(root)).replayReleases, []);
});
