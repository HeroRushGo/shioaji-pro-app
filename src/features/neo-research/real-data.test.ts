import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import { loadRealResearchSnapshot, parseResearchCatalog, type ResearchCatalog } from './real-data';
import type { ResearchQuery } from './model';

const observed = '2026-11-16T02:00:00.000Z';
const query: ResearchQuery = { symbol: '2330', date: '2026-11-13', cutoff: '10:00', sourceMode: 'real', financeMode: 'latest' };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function setup() {
    const payloads: Record<string, Record<string, unknown>> = {
        finance: { schemaVersion: 1, kind: 'finance', symbol: '2330', name: '台積電', market: 'TSE',
            releaseId: 'finance-a', firstSeenAt: observed, upstreamBuiltAt: '2026-11-13T15:27:57Z',
            provenance: { upstreamCommit: 'a'.repeat(40) },
            revenue: [{ period: '2026-10', revenueThousands: 586890319, yoyPercent: 20 }],
            quarters: [{ period: '2026Q3', eps: 29.42, grossMarginPercent: 66.4135, epsBasis: 'quarter_derived_from_ytd' }],
        },
        replay: { schemaVersion: 1, kind: 'replay', symbol: '2330', name: '台積電', market: 'TSE', date: query.date,
            releaseId: 'neo-a', firstSeenAt: observed, neoCommit: 'b'.repeat(40), samplingMinutes: 30,
            provenance: { source: 'neo_wss' }, points: [
                { time: '09:00', price: null, vwap: null, poc: null },
                { time: '09:30', price: 1920, vwap: 1918.12345, poc: 1910 },
                { time: '10:00', price: 1935, vwap: 1922.55555, poc: 1920 },
                { time: '13:30', price: 1940, vwap: 1930, poc: 1940 },
            ],
        },
    };
    const catalog: ResearchCatalog = { schemaVersion: 1, updatedAt: observed, revoked: [],
        financeReleases: [{ id: 'finance-a', firstSeenAt: observed, upstreamBuiltAt: '2026-11-13T15:27:57Z', upstreamCommit: 'a'.repeat(40),
            items: [{ symbol: '2330', name: '台積電', market: 'TSE', path: 'releases/finance-a/2330.json', sha256: '' }] }],
        replayReleases: [{ id: 'neo-a', firstSeenAt: observed, neoCommit: 'b'.repeat(40),
            items: [{ symbol: '2330', name: '台積電', market: 'TSE', date: query.date, path: 'releases/neo-a/2330-2026-11-13.json', sha256: '' }] }],
    };
    const files = new Map<string, string>();
    function refresh() {
        for (const kind of ['finance', 'replay'] as const) {
            const release = catalog[`${kind}Releases`][0];
            if (!release) continue;
            const item = release.items[0]!;
            const bytes = JSON.stringify(payloads[kind]);
            item.sha256 = digest(bytes); files.set(`/research-data/${item.path}`, bytes);
        }
    }
    refresh();
    const calls: { url: string; options?: RequestInit }[] = [];
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
        calls.push({ url, options });
        const body = url === '/research-data/catalog.json' ? JSON.stringify(catalog) : files.get(url);
        return new Response(body ?? '{}', { status: body ? 200 : 404, headers: { 'Content-Type': 'application/json' } });
    }));
    return { catalog, payloads, files, calls, refresh };
}
afterEach(() => vi.unstubAllGlobals());

describe('verified local research provider', () => {
    it('keeps latest finance separate from replay time, preserving exact neo values and prefix POC', async () => {
        const { calls } = setup();
        const result = await loadRealResearchSnapshot({ ...query, cutoff: '09:45' });
        expect(result.finance.status).toBe('ready'); expect(result.finance.notice).toContain('不是重播當時');
        expect(result.revenue[0]?.revenueThousands).toBe(586890319);
        expect(result.replay.at(-1)).toEqual({ time: '09:30', price: 1920, vwap: 1918.12345, poc: 1910 });
        expect(result.replayInfo.actualAsOf).toBe('2026-11-13T09:30:00+08:00');
        expect(result.replayInfo.samplingMinutes).toBe(30); expect(result.decisionEligible).toBe(false);
        expect(calls.every(call => call.url.startsWith('/research-data/') && call.options?.credentials === 'omit' && call.options.redirect === 'error')).toBe(true);
    });
    it('does not use freshly downloaded finance for an earlier replay', async () => {
        setup(); const result = await loadRealResearchSnapshot({ ...query, financeMode: 'as_of' });
        expect(result.finance.status).toBe('not-retained'); expect(result.revenue).toEqual([]);
        expect(result.replayInfo.status).toBe('ready'); expect(result.replay).toHaveLength(3);
    });
    it.each([-1, 1])('uses the first successful observation boundary, offset %d ms', async offset => {
        const data = setup();
        const firstSeen = new Date(Date.parse('2026-11-16T02:00:00Z') + offset).toISOString();
        data.catalog.financeReleases[0]!.firstSeenAt = firstSeen; data.payloads.finance!.firstSeenAt = firstSeen; data.refresh();
        const result = await loadRealResearchSnapshot({ ...query, date: '2026-11-16', financeMode: 'as_of' });
        expect(result.finance.status).toBe(offset < 0 ? 'ready' : 'not-retained');
    });
    it('retains the appropriate old version when a correction is observed later', async () => {
        const data = setup();
        const corrected = structuredClone(data.catalog.financeReleases[0]!);
        corrected.id = 'finance-corrected'; corrected.firstSeenAt = '2026-11-17T02:00:00Z';
        const item = corrected.items[0]!; item.path = 'releases/finance-corrected/2330.json';
        const body = JSON.stringify({ ...data.payloads.finance, releaseId: corrected.id, firstSeenAt: corrected.firstSeenAt,
            revenue: [{ period: '2026-10', revenueThousands: 999, yoyPercent: null }] });
        item.sha256 = digest(body); data.files.set(`/research-data/${item.path}`, body); data.catalog.financeReleases.push(corrected);
        const old = await loadRealResearchSnapshot({ ...query, date: '2026-11-16', cutoff: '10:01', financeMode: 'as_of' });
        const latest = await loadRealResearchSnapshot(query);
        expect(old.revenue[0]?.revenueThousands).toBe(586890319); expect(latest.revenue[0]?.revenueThousands).toBe(999);
    });
    it('rejects corrupted finance independently of valid replay and never supplies fixture values', async () => {
        const data = setup(); data.files.set('/research-data/releases/finance-a/2330.json', '{}');
        const result = await loadRealResearchSnapshot(query);
        expect(result.finance.status).toBe('invalid'); expect(result.finance.notice).toContain('SHA-256');
        expect(result.revenue).toEqual([]); expect(result.replayInfo.status).toBe('ready'); expect(result.source).toBe('real');
    });
    it('rejects wrong symbol, schema, units, duplicated periods, unsupported EPS basis and future-day bars', async () => {
        const invalids = [
            (p: Record<string, unknown>) => { p.symbol = '2377'; },
            (p: Record<string, unknown>) => { p.schemaVersion = 2; },
            (p: Record<string, unknown>) => { p.revenue = [{ period: '2026-10', revenueThousands: '586,890,319', yoyPercent: null }]; },
            (p: Record<string, unknown>) => { p.revenue = [...p.revenue as unknown[], ...p.revenue as unknown[]]; },
            (p: Record<string, unknown>) => { p.quarters = [{ period: '2026Q3', eps: 78.75, grossMarginPercent: 60, epsBasis: 'ytd' }]; },
        ];
        for (const mutate of invalids) {
            const data = setup(); mutate(data.payloads.finance!); data.refresh();
            expect((await loadRealResearchSnapshot(query)).finance.status).toBe('invalid');
        }
        const data = setup(); data.payloads.replay!.points = [{ time: '14:00', price: 1, vwap: 1, poc: 1 }]; data.refresh();
        expect((await loadRealResearchSnapshot(query)).replayInfo.status).toBe('invalid');
    });
    it('applies withdrawals to historical queries and refuses a withdrawal appearing during load', async () => {
        const data = setup(); data.catalog.revoked.push('finance-a');
        expect((await loadRealResearchSnapshot(query)).finance.status).toBe('revoked');
        data.catalog.revoked = [];
        const original = vi.mocked(fetch).getMockImplementation()!;
        vi.stubGlobal('fetch', vi.fn(async (...args: Parameters<typeof fetch>) => {
            const response = await original(...args);
            if (String(args[0]).includes('releases/finance-a/')) data.catalog.revoked.push('finance-a');
            return response;
        }));
        expect((await loadRealResearchSnapshot(query)).finance.status).toBe('revoked');
    });
    it('keeps missing symbols/dates and pre-open samples empty', async () => {
        setup(); const missing = await loadRealResearchSnapshot({ ...query, symbol: '9999' });
        expect(missing.revenue).toEqual([]); expect(missing.replay).toEqual([]); expect(missing.status).toBe('missing');
        const preopen = await loadRealResearchSnapshot({ ...query, cutoff: '08:59' });
        expect(preopen.replay).toEqual([]); expect(preopen.finance.status).toBe('ready');
    });
    it('does not combine the same code from different market identities', async () => {
        const data = setup(); data.catalog.replayReleases[0]!.items[0]!.market = 'OTC'; data.payloads.replay!.market = 'OTC'; data.refresh();
        const result = await loadRealResearchSnapshot(query);
        expect(result.market).toBe('TSE'); expect(result.finance.status).toBe('ready');
        expect(result.replayInfo.status).toBe('invalid'); expect(result.replay).toEqual([]);
    });
    it('rejects unknown catalog and malicious paths before any payload fetch', async () => {
        const data = setup(); data.catalog.financeReleases[0]!.items[0]!.path = 'https://evil.invalid/data.json';
        const result = await loadRealResearchSnapshot(query);
        expect(result.status).toBe('missing'); expect(data.calls).toHaveLength(1);
        expect(() => parseResearchCatalog({ ...data.catalog, schemaVersion: 2 })).toThrow();
    });
    it('aborts even when an old fetch ignores its AbortSignal', async () => {
        setup(); const controller = new AbortController(); const original = vi.mocked(fetch).getMockImplementation()!;
        vi.stubGlobal('fetch', vi.fn(async (...args: Parameters<typeof fetch>) => {
            const response = await original(...args); controller.abort(); return response;
        }));
        await expect(loadRealResearchSnapshot(query, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    });
});
