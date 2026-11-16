import { describe, expect, it } from 'vitest';
import {
    RESEARCH_DATES,
    RESEARCH_SYMBOLS,
    loadResearchSnapshot,
    snapshotForQuery,
    type ResearchQuery,
} from './model';

const query: ResearchQuery = { symbol: '2330', date: '2026-11-13', cutoff: '10:00' };

describe('synthetic research snapshot adapter', () => {
    it('keeps source, version, timezone and decision limitations explicit', () => {
        const snapshot = snapshotForQuery(query);
        expect(snapshot).toMatchObject({
            query,
            name: '台積電',
            market: '上市',
            status: 'ready',
            source: 'fixture',
            asOf: '2026-11-13T10:00:00+08:00',
            decisionUse: 'awareness_only',
            decisionEligible: false,
        });
        expect(snapshot.releaseId).toContain('synthetic');
        expect(snapshot.notice).toContain('示範資料，非真實行情或財報');
    });

    it('exposes only the replay prefix available at the requested cutoff', () => {
        const early = snapshotForQuery(query);
        const late = snapshotForQuery({ ...query, cutoff: '13:30' });
        expect(early.replay.map(row => row.time)).toEqual(['09:00', '09:30', '10:00']);
        expect(early.replay).toEqual(late.replay.slice(0, early.replay.length));
        expect(early.replay.every(row => row.time <= query.cutoff)).toBe(true);
        expect(late.replay.at(-1)?.time).toBe('13:30');
    });

    it('retains an empty pre-open replay instead of borrowing later values', () => {
        const snapshot = snapshotForQuery({ ...query, cutoff: '08:59' });
        expect(snapshot.status).toBe('ready');
        expect(snapshot.replay).toEqual([]);
        expect(snapshot.asOf).toBe('2026-11-13T08:59:00+08:00');
    });

    it('keeps distinct symbol and date identities rather than reusing cached rows', () => {
        const original = snapshotForQuery(query);
        const otherDate = snapshotForQuery({ ...query, date: '2026-11-12' });
        const otherSymbol = snapshotForQuery({ ...query, symbol: '6488' });
        expect(otherDate.query.date).toBe('2026-11-12');
        expect(otherDate.asOf).toBe('2026-11-12T10:00:00+08:00');
        expect(otherDate.replay).not.toEqual(original.replay);
        expect(otherSymbol.name).toBe('環球晶');
        expect(otherSymbol.market).toBe('上櫃');
        expect(otherSymbol.replay).not.toEqual(original.replay);
    });

    it.each([
        { symbol: '9999', date: query.date },
        { symbol: query.symbol, date: '2026-11-11' },
    ])('returns missing without substituting another symbol or date: %j', identity => {
        const requested = { ...query, ...identity };
        const snapshot = snapshotForQuery(requested);
        expect(snapshot.query).toEqual(requested);
        expect(snapshot.status).toBe('missing');
        expect(snapshot.replay).toEqual([]);
        expect(snapshot.revenue).toEqual([]);
        expect(snapshot.quarters).toEqual([]);
        expect(snapshot.notice).toContain('沒有示範資料');
        expect(snapshot.asOf).toBe(`${requested.date}T10:00:00+08:00`);
    });

    it.each([
        { symbol: '../2330' },
        { symbol: '2330 ' },
        { date: '2026-11-13T00:00:00Z' },
        { date: '2026-02-30' },
        { date: '2026-13-01' },
        { cutoff: '9:30' },
        { cutoff: '24:00' },
        { cutoff: '13:60' },
        { cutoff: '10:00:00' },
    ])('rejects malformed query fields rather than normalizing their identity: %j', patch => {
        expect(() => snapshotForQuery({ ...query, ...patch })).toThrow(RangeError);
    });

    it('preserves financial-format missing values for the banking example', () => {
        const bank = snapshotForQuery({ ...query, symbol: '2891' });
        expect(bank.quarters.length).toBeGreaterThan(0);
        expect(bank.quarters.every(row => row.grossMarginPercent === null)).toBe(true);
        expect(bank.revenue[0]?.yoyPercent).toBeNull();
    });

    it('does not allow one caller to mutate subsequent snapshots or input identity', () => {
        const input = { ...query };
        const snapshot = snapshotForQuery(input);
        snapshot.query.symbol = '2891';
        snapshot.replay[0]!.price = -1;
        snapshot.revenue[0]!.revenueThousands = -1;
        const next = snapshotForQuery(input);
        expect(input).toEqual(query);
        expect(next.query).toEqual(query);
        expect(next.replay[0]!.price).toBeGreaterThan(0);
        expect(next.revenue[0]!.revenueThousands).toBeGreaterThan(0);
    });

    it('covers all listed fixture symbols and dates with explicit source labels', () => {
        for (const company of RESEARCH_SYMBOLS) {
            for (const date of RESEARCH_DATES) {
                const snapshot = snapshotForQuery({ ...query, symbol: company.symbol, date });
                expect(snapshot.status).toBe('ready');
                expect(snapshot.source).toBe('fixture');
                expect(snapshot.name).toBe(company.name);
            }
        }
    });

    it('rejects an already-aborted request', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(loadResearchSnapshot(query, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('rejects a request superseded before its async result is delivered', async () => {
        const controller = new AbortController();
        const request = loadResearchSnapshot(query, controller.signal);
        controller.abort();
        await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('captures the requested identity before yielding', async () => {
        const input = { ...query };
        const request = loadResearchSnapshot(input);
        input.symbol = '2891';
        const snapshot = await request;
        expect(snapshot.query).toEqual(query);
        expect(snapshot.name).toBe('台積電');
    });
});
