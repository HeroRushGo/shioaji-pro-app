#!/usr/bin/env node
// Download only official financial projections. Upstream raw files, including
// unselected free text, are verified in memory and never written to this store.
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { publishRelease, revokeReleases } from './store.mjs';

export const DEFAULT_FINANCE_SYMBOLS = ['2330', '2377', '6488', '2891'];
export const FINANCE_LIMITS = Object.freeze({
    timeoutMs: 20_000, commitBytes: 64 * 1024, manifestBytes: 2 * 1024 * 1024,
    sourcesBytes: 128 * 1024, financialBytes: 512 * 1024, symbols: 50,
});
const COMMIT_URL = 'https://api.github.com/repos/Sinotrade/shioaji-data/commits/main';
const RAW_ROOT = 'https://raw.githubusercontent.com/Sinotrade/shioaji-data/';
const LICENSE_URL = 'https://data.gov.tw/license';
const SOURCE_HOSTS = new Set(['data.gov.tw', 'mopsov.twse.com.tw', 'openapi.twse.com.tw', 'www.tpex.org.tw']);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) => Object.hasOwn(object, key);
const finiteOrNull = value => value === null || (typeof value === 'number' && Number.isFinite(value));

function requireThat(condition, message) {
    if (!condition) throw new Error(`Finance materializer: ${message}`);
}
function text(value, field, maximum = 300) {
    requireThat(typeof value === 'string' && value.trim().length > 0 && value.length <= maximum, `invalid ${field}`);
    return value;
}
function majorOne(value, field) {
    requireThat(typeof value === 'string' && /^1\.\d+\.\d+$/.test(value), `unsupported ${field}: ${String(value)}`);
    return value;
}
function commitSha(value) {
    requireThat(typeof value === 'string' && /^[0-9a-f]{40}$/.test(value), 'commit must be a complete lowercase 40-character SHA');
    return value;
}
function upstreamPath(value) {
    requireThat(typeof value === 'string' && /^v1\/[A-Za-z0-9_/-]+\.json$/.test(value)
        && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'), 'unsafe manifest relative path');
    return value;
}
function fileEntry(value, label) {
    requireThat(record(value), `missing ${label} entry`);
    upstreamPath(value.path);
    requireThat(typeof value.sha256 === 'string' && /^[0-9a-f]{64}$/.test(value.sha256), `invalid ${label} sha256`);
    return value;
}
function officialUrl(value, field) {
    let url;
    try { url = new URL(value); } catch { throw new Error(`Finance materializer: invalid ${field}`); }
    requireThat(url.protocol === 'https:' && SOURCE_HOSTS.has(url.hostname) && !url.username && !url.password
        && !url.port && !url.hash, `unapproved ${field}`);
    return url.href;
}

/** The only network endpoints are this exact commit API and pinned raw files. */
async function fetchBytes(url, fetchImpl, maxBytes, timeoutMs) {
    requireThat(url === COMMIT_URL || new RegExp(`^${RAW_ROOT.replaceAll('.', '\\.')}[0-9a-f]{40}/v1/[A-Za-z0-9_/-]+\\.json$`).test(url), 'unapproved download URL');
    const controller = new AbortController();
    let reader;
    let timedOut = false;
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
            reject(new Error(`Finance materializer: download timed out after ${timeoutMs}ms`));
        }, timeoutMs);
    });
    try {
        return await Promise.race([timeout, (async () => {
            const response = await fetchImpl(url, {
                redirect: 'error', signal: controller.signal,
                headers: { Accept: 'application/json', 'User-Agent': 'neo-research-finance-materializer' },
            });
            requireThat(response.status === 200 && !response.redirected
                && (!response.url || response.url === url), 'HTTP failure or redirected source');
            const length = response.headers.get('content-length');
            if (length !== null) requireThat(/^\d+$/.test(length) && Number(length) <= maxBytes, 'download exceeds byte limit');
            requireThat(response.body && typeof response.body.getReader === 'function', 'missing response body');
            reader = response.body.getReader();
            const chunks = [];
            let bytes = 0;
            while (true) {
                const chunk = await reader.read();
                if (chunk.done) break;
                bytes += chunk.value.byteLength;
                requireThat(bytes <= maxBytes, 'download exceeds byte limit');
                chunks.push(Buffer.from(chunk.value));
            }
            return Buffer.concat(chunks, bytes);
        })()]);
    } finally {
        clearTimeout(timer);
        if (reader) {
            if (timedOut || controller.signal.aborted) void reader.cancel().catch(() => {});
            else { try { await reader.cancel(); } catch { /* already closed */ } }
        }
        controller.abort();
    }
}

function decodeJson(bytes, label) {
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new Error(`Finance materializer: ${label} is not valid UTF-8 JSON`); }
}
function symbolsList(value) {
    const symbols = typeof value === 'string' ? value.split(',') : value;
    requireThat(Array.isArray(symbols) && symbols.length > 0 && symbols.length <= FINANCE_LIMITS.symbols
        && symbols.every(symbol => typeof symbol === 'string' && /^\d{4}$/.test(symbol)), 'symbols must be 1–50 four-digit codes');
    return [...new Set(symbols)].sort();
}
function selectSources(registry, markets) {
    requireThat(record(registry) && registry.version === 1 && Array.isArray(registry.sources)
        && registry.sources.length <= 100, 'invalid source registry');
    const ids = new Set(['mops-ifrs-statements', ...[...markets].map(market => `${market}-openapi-revenue`)]);
    const selected = [];
    for (const id of [...ids].sort()) {
        const matches = registry.sources.filter(source => record(source) && source.id === id);
        requireThat(matches.length === 1, `missing or duplicate official source ${id}`);
        const source = matches[0];
        requireThat(source.license_url === LICENSE_URL && typeof source.license === 'string'
            && source.license.includes('政府資料開放授權條款'), `unconfirmed license for ${id}`);
        selected.push({
            id, name: text(source.name, 'source name'), url: officialUrl(source.url, 'source URL'),
            licenseUrl: LICENSE_URL, attribution: text(source.attribution, 'source attribution', 2000),
        });
    }
    return selected;
}

function validateFinancial(raw, symbol, builtAt) {
    requireThat(record(raw) && raw.code === symbol && ['twse', 'tpex'].includes(raw.market), `financial identity mismatch for ${symbol}`);
    text(raw.name, 'company name', 100);
    requireThat(Array.isArray(raw.monthly_revenue) && raw.monthly_revenue.length <= 1200, 'invalid monthly revenue rows');
    let previous = '';
    for (const row of raw.monthly_revenue) {
        requireThat(record(row) && typeof row.period === 'string' && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(row.period)
            && row.period > previous && row.period <= builtAt.slice(0, 7), 'invalid, unordered or future revenue period');
        requireThat(finiteOrNull(row.revenue_thousand_twd) && (row.revenue_thousand_twd === null || row.revenue_thousand_twd >= 0)
            && finiteOrNull(row.yoy_pct), 'invalid revenue values (expected thousand TWD and percentage numbers/null)');
        previous = row.period;
    }
    const statements = raw.statements;
    requireThat(record(statements) && Array.isArray(statements.periods) && statements.periods.length <= 400
        && Array.isArray(statements.format) && statements.format.length === statements.periods.length, 'invalid statement periods/formats');
    previous = '';
    for (const [index, period] of statements.periods.entries()) {
        requireThat(typeof period === 'string' && /^\d{4}Q[1-4]$/.test(period) && period > previous, 'invalid or unordered statement period');
        const year = Number(period.slice(0, 4));
        const quarter = Number(period.at(-1));
        const quarterEnd = new Date(Date.UTC(year, quarter * 3, 0)).toISOString().slice(0, 10);
        requireThat(quarterEnd <= builtAt.slice(0, 10), 'future financial statement period');
        text(statements.format[index], 'statement format', 40);
        previous = period;
    }
    for (const kind of ['income_quarter', 'income_ytd', 'balance', 'cash_flow_quarter', 'cash_flow_ytd']) {
        const table = statements[kind];
        requireThat(record(table) && Object.keys(table).length <= 400, `invalid ${kind} table`);
        for (const series of Object.values(table)) {
            requireThat(Array.isArray(series) && series.length === statements.periods.length
                && series.every(finiteOrNull), `invalid ${kind} series shape/number`);
        }
    }
    return raw;
}

function projectFinancial(raw, context) {
    const table = raw.statements.income_quarter;
    const valueAt = (key, index) => own(table, key) ? table[key][index] : null;
    return {
        schemaVersion: 1, kind: 'finance', symbol: raw.code, name: raw.name,
        market: raw.market === 'twse' ? 'TSE' : 'OTC', upstreamBuiltAt: context.upstreamBuiltAt,
        provenance: {
            upstreamCommit: context.commit, sourceSchema: context.sourceSchema,
            sourceSha256: context.sourceSha256, manifestSha256: context.manifestSha256,
            sourceUrl: context.sourceUrl, sources: context.sources,
            sourceRegistry: { sha256: context.registrySha256, schema: context.registrySchema, checkedAgainstCommit: context.commit },
            calculations: {
                revenueUnit: 'thousand_TWD', epsUnit: 'TWD_per_share', grossMarginUnit: 'percent',
                eps: 'income_quarter[基本每股盈餘（元）]; Q1 reported, Q2–Q4 upstream derived by income_ytd differencing',
                grossMargin: '(income_quarter[營業毛利（毛損）淨額] ?? income_quarter[營業毛利（毛損）]) / income_quarter[營業收入] * 100; same period; general format only; rounded to 4 decimals',
            },
        },
        revenue: raw.monthly_revenue.map(row => ({
            period: row.period, revenueThousands: row.revenue_thousand_twd, yoyPercent: row.yoy_pct,
        })),
        quarters: raw.statements.periods.map((period, index) => {
            const revenue = valueAt('營業收入', index);
            const gross = valueAt('營業毛利（毛損）淨額', index) ?? valueAt('營業毛利（毛損）', index);
            return {
                period, eps: valueAt('基本每股盈餘（元）', index),
                grossMarginPercent: raw.statements.format[index] === 'general' && revenue !== null && revenue > 0 && gross !== null
                    ? Math.round(gross / revenue * 1_000_000) / 10_000 : null,
                epsBasis: period.endsWith('Q1') ? 'quarter_reported_q1' : 'quarter_derived_from_ytd',
            };
        }),
    };
}

export async function materializeFinance({
    root = '.research-data', commit, symbols = DEFAULT_FINANCE_SYMBOLS,
    fetchImpl = globalThis.fetch, now = () => new Date().toISOString(),
    publishImpl = publishRelease, revokeImpl = revokeReleases, timeoutMs = FINANCE_LIMITS.timeoutMs,
} = {}) {
    const requestedSymbols = symbolsList(symbols);
    requireThat(typeof fetchImpl === 'function', 'fetch is unavailable');
    requireThat(Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120_000, 'invalid timeout');
    requireThat(typeof now === 'function' || typeof now === 'string', 'invalid clock');
    const checkedNow = () => {
        const value = typeof now === 'function' ? now() : now;
        requireThat(typeof value === 'string' && Number.isFinite(Date.parse(value)), 'invalid verification time');
        return value;
    };
    if (commit === undefined) {
        const head = decodeJson(await fetchBytes(COMMIT_URL, fetchImpl, FINANCE_LIMITS.commitBytes, timeoutMs), 'commit metadata');
        commit = commitSha(head.sha);
    } else commit = commitSha(commit);
    const base = `${RAW_ROOT}${commit}/`;
    const manifestBytes = await fetchBytes(`${base}v1/manifest.json`, fetchImpl, FINANCE_LIMITS.manifestBytes, timeoutMs);
    const manifestSha256 = sha256(manifestBytes);
    const manifest = decodeJson(manifestBytes, 'manifest');
    requireThat(record(manifest), 'invalid manifest');
    if (manifest.revocations !== undefined && (!Array.isArray(manifest.revocations) || manifest.revocations.length > 0)) {
        // Upstream has no published per-release revocation mapping. Until one
        // exists, revoke the local finance family rather than keep serving an
        // older possibly withdrawn snapshot or guess at an identifier.
        try {
            await revokeImpl({ root, kind: 'finance', reason: `upstream-revocations-${commit}` }, { now: checkedNow });
        } catch (error) {
            throw new Error(`Finance materializer: upstream revocations found; stopping existing finance failed: ${error.message}`, { cause: error });
        }
        throw new Error('Finance materializer: upstream revocations found; existing finance releases revoked; mapping requires review');
    }
    majorOne(manifest.manifest_schema_version, 'manifest schema');
    const sourceSchema = majorOne(manifest.financials_schema_version, 'financial schema');
    requireThat(typeof manifest.built_at === 'string' && /(?:Z|[+-]\d{2}:?\d{2})$/.test(manifest.built_at)
        && Number.isFinite(Date.parse(manifest.built_at)), 'invalid upstream built_at');
    const upstreamBuiltAt = new Date(manifest.built_at).toISOString();
    requireThat(record(manifest.files) && record(manifest.financials), 'missing manifest indexes');
    const sourceEntry = fileEntry(manifest.files['global/sources'], 'global/sources');
    const registrySchema = majorOne(sourceEntry.schema_version, 'source registry schema');
    const registryBytes = await fetchBytes(`${base}${sourceEntry.path}`, fetchImpl, FINANCE_LIMITS.sourcesBytes, timeoutMs);
    requireThat(sha256(registryBytes) === sourceEntry.sha256, 'source registry sha256 mismatch');
    const registry = decodeJson(registryBytes, 'source registry');
    const normalized = [];
    const missingSymbols = [];
    for (const symbol of requestedSymbols) {
        if (!own(manifest.financials, symbol)) { missingSymbols.push(symbol); continue; }
        const entry = fileEntry(manifest.financials[symbol], `${symbol} financial`);
        const sourceUrl = `${base}${entry.path}`;
        const bytes = await fetchBytes(sourceUrl, fetchImpl, FINANCE_LIMITS.financialBytes, timeoutMs);
        requireThat(sha256(bytes) === entry.sha256, `${symbol} financial sha256 mismatch`);
        normalized.push({ raw: validateFinancial(decodeJson(bytes, `${symbol} financial`), symbol, upstreamBuiltAt), entry, sourceUrl });
    }
    const sources = selectSources(registry, new Set(normalized.map(item => item.raw.market)));
    const items = normalized.map(({ raw, entry, sourceUrl }) => {
        const payloadSources = sources.filter(source => source.id === 'mops-ifrs-statements' || source.id === `${raw.market}-openapi-revenue`);
        const data = projectFinancial(raw, {
            commit, upstreamBuiltAt, sourceSchema, sourceSha256: entry.sha256, manifestSha256, sourceUrl,
            sources: payloadSources, registrySha256: sourceEntry.sha256, registrySchema,
        });
        return { symbol: data.symbol, name: data.name, market: data.market, data };
    });
    requireThat(items.length > 0, 'none of the requested symbols are listed in the financial manifest');
    const id = `finance-${sha256(JSON.stringify({ commit, manifestSha256, requestedSymbols, items })).slice(0, 32)}`;
    // Observation is only possible after the complete selected release has
    // passed verification. The publisher obtains firstSeenAt inside its lock,
    // never from the time the first network request started.
    const verifiedAt = checkedNow();
    const published = await publishImpl({ root, kind: 'finance', id, metadata: { upstreamCommit: commit, upstreamBuiltAt }, items }, { now: checkedNow });
    return { ...published, upstreamCommit: commit, verifiedAt, missingSymbols };
}

export function parseFinanceArgs(argv) {
    const options = {};
    const seen = new Set();
    for (let index = 0; index < argv.length; index += 1) {
        const option = argv[index];
        if (option === '--help') return { help: true };
        requireThat(['--root', '--symbols', '--commit'].includes(option) && !seen.has(option), `unknown or duplicate argument ${option}`);
        seen.add(option);
        const value = argv[++index];
        requireThat(typeof value === 'string' && value.length > 0 && !value.startsWith('--'), `missing value for ${option}`);
        if (option === '--root') options.root = value;
        if (option === '--symbols') options.symbols = symbolsList(value);
        if (option === '--commit') options.commit = commitSha(value);
    }
    return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try {
        const options = parseFinanceArgs(process.argv.slice(2));
        if (options.help) console.log('Usage: node scripts/research-data/finance.mjs [--commit <40-char SHA>] [--symbols 2330,2377,6488,2891] [--root .research-data]');
        else {
            const result = await materializeFinance(options);
            console.log(JSON.stringify({ releaseId: result.release.id, upstreamCommit: result.upstreamCommit, verifiedAt: result.verifiedAt, missingSymbols: result.missingSymbols }));
        }
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
