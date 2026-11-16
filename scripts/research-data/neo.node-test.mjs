import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { materializeNeo, neoSampleTimes, runOfflineNeoHelper } from './neo.mjs';
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

async function waitForFile(filename, milliseconds = 5_000) {
    const until = Date.now() + milliseconds;
    while (Date.now() < until) {
        try { return await fs.readFile(filename, 'utf8'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        await delay(10);
    }
    throw new Error(`Timed out waiting for owned helper fixture ${path.basename(filename)}`);
}

function processExists(pid) {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function supervisedFixture(t, mode) {
    const root = await temporary(t);
    const names = Object.fromEntries(['pid', 'ready', 'args', 'term', 'outcome', 'published'].map(name => [name, path.join(root, name)]));
    const fakePython = path.join(root, 'fake-python.mjs');
    // This executable never imports Python, neo-client, or a database. It
    // accepts the production interpreter argv and simulates slow/ignored TERM.
    await fs.writeFile(fakePython, `#!${process.execPath}\n`
        + `import fs from 'node:fs';\n`
        + `const files = ${JSON.stringify(names)};\n`
        + `fs.writeFileSync(files.pid, String(process.pid));\n`
        + `if (${JSON.stringify(mode)} === 'SIGTERM') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);\n`
        + `fs.writeFileSync(files.args, JSON.stringify(process.argv.slice(2)));\n`
        + `process.stdin.resume();\n`
        + `if (${JSON.stringify(mode)} === 'normal') setTimeout(() => console.log(JSON.stringify({ complete: true })), 20);\n`
        + `else {\n`
        + `  const keepAlive = setInterval(() => {}, 1000);\n`
        + `  process.on('SIGTERM', () => {\n`
        + `    fs.writeFileSync(files.term, 'TERM received');\n`
        + `    console.log(JSON.stringify({ complete: true, afterStop: true }));\n`
        + `    if (${JSON.stringify(mode)} !== 'timeout') setTimeout(() => { clearInterval(keepAlive); process.exitCode = 0; }, 500);\n`
        + `  });\n`
        + `}\n`
        + `fs.writeFileSync(files.ready, 'signal listeners installed');\n`, { mode: 0o700 });
    const runnerPath = path.join(root, 'runner.mjs');
    await fs.writeFile(runnerPath,
        `import fs from 'node:fs';\n`
        + `import { runOfflineNeoHelper } from ${JSON.stringify(new URL('./neo.mjs', import.meta.url).href)};\n`
        + `const files = ${JSON.stringify(names)};\n`
        + `let unrelatedSignals = 0;\n`
        + `const sentinel = () => { unrelatedSignals++; };\n`
        + `process.on('SIGINT', sentinel); process.on('SIGTERM', sentinel);\n`
        + `const before = ['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal));\n`
        + `let outcome;\n`
        + `try {\n`
        + `  const value = await runOfflineNeoHelper(${JSON.stringify(fakePython)}, { fixture: true }, { timeoutMs: ${mode === 'timeout' ? 1_000 : 5_000}, killGraceMs: ${mode === 'timeout' ? 100 : 1_000} });\n`
        + `  fs.writeFileSync(files.published, JSON.stringify(value));\n`
        + `  outcome = { success: true, value };\n`
        + `} catch (error) {\n`
        + `  outcome = { success: false, code: error.code, signal: error.signal };\n`
        + `  process.exitCode = error.signal === 'SIGINT' ? 130 : error.signal === 'SIGTERM' ? 143 : 1;\n`
        + `}\n`
        + `const pid = Number(fs.readFileSync(files.pid, 'utf8'));\n`
        + `try { process.kill(pid, 0); outcome.childGone = false; } catch (error) { if (error.code !== 'ESRCH') throw error; outcome.childGone = true; }\n`
        + `outcome.before = before; outcome.after = ['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal));\n`
        + `outcome.unrelatedSignals = unrelatedSignals;\n`
        + `outcome.openTimeouts = process.getActiveResourcesInfo().filter(type => type === 'Timeout').length;\n`
        + `fs.writeFileSync(files.outcome, JSON.stringify(outcome));\n`);
    const startedAt = Date.now();
    const runner = spawn(process.execPath, [runnerPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { HOME: os.homedir(), PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', TZ: 'Asia/Taipei' },
    });
    let stderr = '', helperPid;
    runner.stderr.on('data', chunk => { stderr += chunk; });
    runner.stdout.resume();
    const closed = new Promise((resolve, reject) => {
        runner.once('error', reject);
        runner.once('close', (code, signal) => resolve({ code, signal, elapsed: Date.now() - startedAt }));
    });
    t.after(async () => {
        // Failure cleanup only targets PIDs created and recorded by this test.
        if (helperPid && processExists(helperPid)) process.kill(helperPid, 'SIGKILL');
        if (runner.exitCode === null && runner.signalCode === null) runner.kill('SIGKILL');
        await closed.catch(() => {});
    });
    helperPid = Number(await waitForFile(names.pid));
    await waitForFile(names.ready);
    assert.ok(Number.isInteger(helperPid) && helperPid > 0);
    return { names, runner, helperPid, closed, stderr: () => stderr };
}

for (const signal of ['SIGINT', 'SIGTERM']) {
    test(`offline supervisor forwards ${signal} and waits for helper/pipes before rejecting`, { timeout: 10_000 }, async t => {
        const fixture = await supervisedFixture(t, signal);
        fixture.runner.kill(signal);
        await waitForFile(fixture.names.term);
        assert.equal(processExists(fixture.helperPid), true, 'fake helper must still be in its graceful shutdown delay');
        assert.equal(processExists(fixture.runner.pid), true, 'parent exited before helper shutdown');
        await assert.rejects(fs.access(fixture.names.outcome), { code: 'ENOENT' });
        const exit = await fixture.closed;
        assert.equal(exit.code, signal === 'SIGINT' ? 130 : 143, fixture.stderr());
        assert.equal(exit.signal, null);
        const outcome = JSON.parse(await fs.readFile(fixture.names.outcome, 'utf8'));
        assert.equal(outcome.code, 'NEO_HELPER_INTERRUPTED');
        assert.equal(outcome.signal, signal);
        assert.equal(outcome.childGone, true);
        assert.deepEqual(outcome.after, outcome.before, 'supervisor leaked or removed another signal listener');
        assert.equal(outcome.unrelatedSignals, 1);
        assert.equal(outcome.openTimeouts, 0, 'supervisor left a deadline or kill timer alive');
        assert.equal(processExists(fixture.helperPid), false);
        await assert.rejects(fs.access(fixture.names.published), { code: 'ENOENT' });
    });
}

test('offline supervisor escalates a timed-out helper that ignores TERM and never publishes its output', { timeout: 10_000 }, async t => {
    const fixture = await supervisedFixture(t, 'timeout');
    const exit = await fixture.closed;
    assert.equal(exit.code, 1, fixture.stderr());
    assert.equal(await fs.readFile(fixture.names.term, 'utf8'), 'TERM received');
    const outcome = JSON.parse(await fs.readFile(fixture.names.outcome, 'utf8'));
    assert.equal(outcome.code, 'NEO_HELPER_TIMEOUT');
    assert.equal(outcome.childGone, true);
    assert.deepEqual(outcome.after, outcome.before);
    assert.equal(outcome.unrelatedSignals, 0);
    assert.equal(outcome.openTimeouts, 0);
    assert.equal(processExists(fixture.helperPid), false);
    await assert.rejects(fs.access(fixture.names.published), { code: 'ENOENT' });
});

test('offline supervisor normal completion reaps helper and clears its deadline/listeners', { timeout: 10_000 }, async t => {
    const fixture = await supervisedFixture(t, 'normal');
    const exit = await fixture.closed;
    assert.equal(exit.code, 0, fixture.stderr());
    const outcome = JSON.parse(await fs.readFile(fixture.names.outcome, 'utf8'));
    assert.deepEqual(outcome.value, { complete: true });
    assert.equal(outcome.childGone, true);
    assert.deepEqual(outcome.after, outcome.before);
    assert.equal(outcome.unrelatedSignals, 0);
    assert.equal(outcome.openTimeouts, 0, 'normal completion retained its deadline');
    const args = JSON.parse(await fs.readFile(fixture.names.args, 'utf8'));
    assert.deepEqual(args.slice(0, 2), ['-P', '-B']);
    assert.equal(path.basename(args[2]), 'neo-export.py', 'production helper path must remain fixed');
    assert.equal(processExists(fixture.helperPid), false);
    assert.deepEqual(JSON.parse(await fs.readFile(fixture.names.published, 'utf8')), { complete: true });
});

test('offline supervisor spawn failure also removes its signal listeners', async () => {
    const before = ['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal));
    await assert.rejects(runOfflineNeoHelper(path.join(os.tmpdir(), 'no-such-neo-python'), {}), { code: 'NEO_HELPER_PROCESS_ERROR' });
    assert.deepEqual(['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal)), before);
});
