import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { canonical, publishRelease, sha256 } from './store.mjs';

const execFileAsync = promisify(execFile);
export const NEO_ADAPTER_VERSION = 'neo-reader-prefix-v1';
export const DEFAULT_NEO_SYMBOLS = Object.freeze([
    { symbol: '2330', name: '台積電', market: 'TSE' },
    { symbol: '2377', name: '微星', market: 'TSE' },
    { symbol: '2891', name: '中信金', market: 'TSE' },
    { symbol: '6488', name: '環球晶', market: 'OTC' },
]);
const HEX = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(`neo export: ${message}`); };

function isoDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('invalid date');
    const date = new Date(`${value}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) fail('invalid calendar date');
    return value;
}

export function neoSampleTimes(samplingMinutes = 30) {
    if (![1, 5, 15, 30, 60].includes(samplingMinutes)) fail('unsupported samplingMinutes');
    const result = [];
    for (let minute = 9 * 60; minute <= 13 * 60 + 30; minute += samplingMinutes) {
        result.push(`${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`);
    }
    if (result.at(-1) !== '13:30') result.push('13:30');
    return result;
}

function checkedClock(clock) {
    const value = typeof clock === 'function' ? clock() : clock ?? new Date().toISOString();
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)
        || !Number.isFinite(Date.parse(value))) fail('invalid export clock');
    return value;
}

function requestOptions(options) {
    // This instant is only a past-day admission check. It must never become
    // firstSeenAt: the helper and all projection/consistency checks run later.
    const clock = new Date(checkedClock(options.now));
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(clock);
    const dates = [...new Set(options.dates ?? [])].map(isoDate).sort();
    if (!dates.length || dates.length > 10 || dates.some(date => date >= today)) fail('only past Asia/Taipei dates are allowed');
    const input = options.symbols ?? DEFAULT_NEO_SYMBOLS;
    if (!Array.isArray(input) || !input.length || input.length > 20) fail('expected 1 to 20 verified symbol identities');
    const seen = new Set();
    const symbols = input.map(item => {
        if (!object(item) || typeof item.symbol !== 'string' || !/^\d{4}$/.test(item.symbol) || !['TSE', 'OTC'].includes(item.market)
            || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 80 || seen.has(item.symbol)) {
            fail('invalid or duplicate verified symbol identity');
        }
        seen.add(item.symbol);
        return { symbol: item.symbol, name: item.name, market: item.market };
    }).sort((a, b) => a.symbol.localeCompare(b.symbol));
    const samplingMinutes = options.samplingMinutes ?? 30;
    const times = neoSampleTimes(samplingMinutes);
    if (dates.length * symbols.length * times.length > 2_000) fail('batch exceeds 2000 exact-cutoff samples');
    return { dates, symbols, samplingMinutes, times };
}

function response(value, label) {
    if (!object(value) || ![200, 404].includes(value.status) || !object(value.body)) fail(`${label}: invalid or unsuccessful response`);
    return value.status === 404 ? null : value.body;
}

function optionalNumber(value, label) {
    if (value === null) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) fail(`${label}: expected a positive finite price or null`);
    return value;
}

function prefixPoint(sample, identity) {
    const { time } = sample;
    const bars = response(sample.bars, 'bars');
    const vp = response(sample.vp, 'vp');
    let price = null, vwap = null, poc = null;
    if (bars) {
        if (!object(bars.meta) || bars.meta.symbol !== identity.symbol || bars.meta.date !== identity.date) fail('bars query identity mismatch');
        if (!Array.isArray(bars.bars) || !bars.bars.length || !Array.isArray(bars.vwap)
            || bars.vwap.length !== bars.bars.length) fail('bars/vwap schema mismatch');
        let previous = -Infinity;
        const cutoff = `${identity.date}T${time}:00.000Z`; // neo's shifted chart epoch, not a real UTC instant
        for (let index = 0; index < bars.bars.length; index++) {
            const bar = bars.bars[index];
            if (!object(bar) || !Number.isInteger(bar.t) || bar.t <= previous) fail('bar timestamps are not strictly ordered');
            const stamp = new Date(bar.t * 1000).toISOString();
            if (stamp.slice(0, 10) !== identity.date || stamp > cutoff) fail('future or wrong-day bar leaked into an exact-cutoff sample');
            previous = bar.t;
            optionalNumber(bar.c, 'bar close');
            optionalNumber(bars.vwap[index], 'bar vwap');
        }
        price = optionalNumber(bars.bars.at(-1).c, 'last bar close');
        vwap = optionalNumber(bars.vwap.at(-1), 'last bar vwap');
        if (bars.meta.last !== price || bars.meta.vwap_last !== vwap) fail('bars summary differs from its causal vectors');
    }
    if (vp) {
        if (!Array.isArray(vp.rows) || !vp.rows.length || !Number.isInteger(vp.tick_count) || vp.tick_count <= 0) fail('VP schema mismatch');
        poc = optionalNumber(vp.poc, 'prefix poc');
    }
    return { time, price, vwap, poc };
}

function sessionMetadata(value, identity) {
    const session = response(value, 'session');
    if (!session) return { scope: 'whole_day_source_metadata', status: 'missing', source: null, coverage: null };
    if (session.schema_version !== 2 || session.symbol !== identity.symbol || session.date !== identity.date
        || session.observer !== true || session.decision_capable !== false) fail('session must match the read-only observer identity');
    const string = (value, label) => {
        if (value == null) return null;
        if (typeof value !== 'string' || value.length > 500) fail(`invalid session ${label}`);
        return value;
    };
    const reasons = session.reason_codes ?? [];
    if (!Array.isArray(reasons) || reasons.length > 50) fail('invalid session reason codes');
    return {
        scope: 'whole_day_source_metadata', schemaVersion: 2,
        source: string(session.source, 'source'), status: string(session.status, 'status'),
        coverage: string(session.coverage, 'coverage'), reason: string(session.reason, 'reason'),
        reasonCodes: reasons.map(reason => string(reason, 'reason code')),
        repairRecommended: session.repair_recommended === true,
        booksAvailable: session.books_available === true,
        observer: true, decisionCapable: false,
    };
}

/** Only these three fixed GET shapes are ever handed to an injected reader. */
export async function collectNeoResponses({ symbols, dates, times }, readerFn) {
    const results = [];
    for (const { symbol } of symbols) {
        for (const date of dates) {
            const session = await readerFn('/api/session', { symbol, date });
            const samples = [];
            for (const time of times) {
                const params = { date, as_of: `${time}:00` };
                const bars = await readerFn(`/api/bars/${symbol}`, { ...params, interval: 60 });
                const vp = await readerFn(`/api/vp/${symbol}`, params);
                samples.push({ time, bars, vp });
            }
            const sessionAfter = await readerFn('/api/session', { symbol, date });
            results.push({ symbol, date, session, sessionAfter, samples });
        }
    }
    return results;
}

async function checkedRepoState(repo) {
    if (typeof repo !== 'string' || !path.isAbsolute(repo)) fail('--neo-repo must be an absolute checkout path');
    const { stdout } = await execFileAsync('git', ['-C', repo, 'rev-parse', 'HEAD'], { timeout: 10_000 });
    const commit = stdout.trim();
    if (!HEX.test(commit)) fail('invalid neo-client HEAD');
    const dirty = await execFileAsync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', repo, 'status', '--porcelain', '--untracked-files=normal', '--', 'neo_client', 'pyproject.toml', 'uv.lock'], { timeout: 10_000 });
    if (dirty.stdout.trim()) fail('neo-client source or lock is dirty');
    return commit;
}

async function offlineRead(options, request) {
    const neoCommit = await checkedRepoState(options.neoRepo);
    if (options.neoCommit && options.neoCommit !== neoCommit) fail('neo-client HEAD differs from the requested pin');
    if (typeof options.python !== 'string' || !path.isAbsolute(options.python)) fail('--python must explicitly name the existing neo venv interpreter');
    const helper = fileURLToPath(new URL('./neo-export.py', import.meta.url));
    const input = {
        schemaVersion: 1, neoRepo: options.neoRepo, neoCommit,
        dbPath: options.dbPath ?? path.join(os.homedir(), '.neo-watch/tick-store.duckdb'),
        shioajiDbPath: options.shioajiDbPath === null ? null
            : options.shioajiDbPath ?? path.join(os.homedir(), '.trading/marketdata/tick-store.duckdb'),
        symbols: request.symbols.map(item => item.symbol), dates: request.dates,
        samplingMinutes: request.samplingMinutes,
    };
    const result = await new Promise((resolve, reject) => {
        const child = execFile(options.python, ['-P', '-B', helper], {
            env: { HOME: os.homedir(), PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', TZ: 'Asia/Taipei', PYTHONDONTWRITEBYTECODE: '1' },
            timeout: 10 * 60_000, maxBuffer: 128 * 1024 * 1024,
        }, (error, stdout, stderr) => {
            if (error) { reject(new Error(`neo offline helper failed: ${stderr.trim() || error.message}`)); return; }
            try { resolve(JSON.parse(stdout)); } catch { reject(new Error('neo offline helper returned invalid JSON')); }
        });
        child.stdin.end(JSON.stringify(input));
    });
    if (await checkedRepoState(options.neoRepo) !== neoCommit) fail('neo-client HEAD changed while exporting');
    if (result.neoCommit !== neoCommit || result.schemaVersion !== 1 || result.adapterVersion !== NEO_ADAPTER_VERSION
        || !DIGEST.test(result.sourceFingerprint ?? '')) fail('offline helper version receipt mismatch');
    const proof = result.evidence;
    if (!object(proof) || proof.transport !== 'offline_asgi' || proof.readerModule !== 'neo_client.dashboard.reader_app'
        || proof.packageVerified !== true || proof.readerMode !== true || proof.allowOutbound !== false
        || proof.liveEngine !== false || proof.databaseMode !== 'read_only' || proof.networkGuard !== true
        || proof.filesystemWriteGuard !== true || proof.subprocessGuard !== true
        || proof.sourceStable !== true || proof.databasesStable !== true
        || !Array.isArray(proof.stores) || !Number.isInteger(proof.readOnlyConnections)) fail('offline helper guard receipt is incomplete');
    return result;
}

/** Materialize exact-cutoff derived values; no browser-facing HTTP/SDK proxy. */
export async function materializeNeo(options = {}) {
    const request = requestOptions(options);
    let exported;
    if (options.readerFn) {
        if (!HEX.test(options.neoCommit ?? '')) fail('injected reader requires a pinned neoCommit');
        exported = {
            neoCommit: options.neoCommit,
            sourceFingerprint: options.sourceFingerprint ?? sha256(NEO_ADAPTER_VERSION),
            evidence: { transport: 'injected_reader', readerMode: true, allowOutbound: false, databaseMode: 'reader_contract' },
            results: await collectNeoResponses(request, options.readerFn),
        };
    } else exported = await offlineRead(options, request);
    if (!DIGEST.test(exported.sourceFingerprint ?? '')) fail('invalid source fingerprint');
    if (!Array.isArray(exported.results) || exported.results.length !== request.symbols.length * request.dates.length) fail('incomplete offline batch');
    const available = new Map(exported.results.map(item => [`${item.symbol}/${item.date}`, item]));
    if (available.size !== exported.results.length) fail('duplicate offline query identity');
    const items = [], missing = [];
    for (const identity of request.symbols) {
        for (const date of request.dates) {
            const result = available.get(`${identity.symbol}/${date}`);
            if (!result || !Array.isArray(result.samples) || result.samples.length !== request.times.length) fail('missing or extra exact-cutoff samples');
            const points = result.samples.map((sample, index) => {
                if (!object(sample) || sample.time !== request.times[index]) fail('sample timestamps differ from the requested cutoffs');
                return prefixPoint(sample, { ...identity, date });
            });
            const session = sessionMetadata(result.session, { ...identity, date });
            const sessionAfter = sessionMetadata(result.sessionAfter, { ...identity, date });
            if (canonical(session) !== canonical(sessionAfter)) fail('session source or coverage changed while exporting');
            if (!points.some(point => point.price !== null || point.vwap !== null || point.poc !== null)) {
                missing.push({ symbol: identity.symbol, date, status: session.status });
                continue;
            }
            // Connection counters and invocation time belong to the execution
            // receipt, not the content-addressed immutable release identity.
            const { readOnlyConnections: _connections, ...guards } = exported.evidence;
            items.push({ ...identity, date, data: {
                schemaVersion: 1, kind: 'replay', ...identity, date,
                neoCommit: exported.neoCommit, samplingMinutes: request.samplingMinutes,
                provenance: {
                    adapterVersion: NEO_ADAPTER_VERSION, neoCommit: exported.neoCommit,
                    sourceFingerprint: exported.sourceFingerprint,
                    reader: 'neo_client.dashboard.reader_app.create_reader_app',
                    endpoints: ['/api/session', '/api/bars/{symbol}?date=&interval=60&as_of=HH:mm:00', '/api/vp/{symbol}?date=&as_of=HH:mm:00'],
                    sampling: { minutes: request.samplingMinutes, timeZone: 'Asia/Taipei', exactCutoff: 'HH:mm:00', inclusive: true },
                    session, guards, decisionUse: 'awareness_only', decisionEligible: false,
                },
                points,
            } });
        }
    }
    if (!items.length) return { published: false, neoCommit: exported.neoCommit, missing, evidence: exported.evidence };
    const digest = sha256(canonical({ neoCommit: exported.neoCommit, items }));
    const id = `neo-${exported.neoCommit.slice(0, 12)}-${digest.slice(0, 24)}`;
    // Production leaves the clock undefined so the publisher records the
    // first successfully validated observation while holding its writer lock.
    // Test clocks are also sampled here lazily, not captured before reading.
    const publicationClock = options.now === undefined ? {} : { now: () => checkedClock(options.now) };
    const published = await publishRelease({ root: options.root, kind: 'replay', id,
        metadata: { neoCommit: exported.neoCommit }, items }, publicationClock);
    return { ...published, published: true, missing, evidence: exported.evidence };
}

function argumentsFor(argv) {
    const args = {};
    const names = { '--root': 'root', '--neo-repo': 'neoRepo', '--python': 'python', '--neo-commit': 'neoCommit',
        '--db': 'dbPath', '--shioaji-db': 'shioajiDbPath', '--dates': 'dates', '--symbols': 'symbols', '--sampling-minutes': 'samplingMinutes' };
    for (let index = 0; index < argv.length; index += 2) {
        const key = names[argv[index]];
        if (!key || !argv[index + 1] || argv[index + 1].startsWith('--') || key in args) fail(`invalid CLI option ${argv[index]}`);
        args[key] = argv[index + 1];
    }
    if (!args.root || !args.neoRepo || !args.python || !args.dates) fail('--root, --neo-repo, --python and --dates are required');
    args.dates = args.dates.split(',');
    if (args.symbols) args.symbols = args.symbols.split(',').map(symbol => {
        const identity = DEFAULT_NEO_SYMBOLS.find(item => item.symbol === symbol);
        if (!identity) fail('CLI symbols must use the four verified research identities');
        return identity;
    });
    if (args.samplingMinutes) args.samplingMinutes = Number(args.samplingMinutes);
    return args;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    materializeNeo(argumentsFor(process.argv.slice(2))).then(result => {
        console.log(JSON.stringify({ published: result.published, release: result.release?.id, missing: result.missing, evidence: result.evidence }, null, 2));
    }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
