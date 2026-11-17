import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractBase } from './types/contract';

const mocks = vi.hoisted(() => ({ fetchLastTicks: vi.fn(), yield: vi.fn() }));
vi.mock('./shioaji', () => ({ fetchLastTicks: mocks.fetchLastTicks }));
import { loadLiveCandleTail } from './live-candle-history';

const stock: ContractBase = { exchange: 'TSE', security_type: 'STK', code: '2330', target_code: null };
const future: ContractBase = { exchange: 'TAIFEX', security_type: 'FUT', code: 'TXFK6', target_code: null };
const at = (time: string, date = '2026-11-17'): string => `${date}T${time}`;
const seconds = (time: string, date = '2026-11-17'): number => Date.parse(`${at(time, date)}Z`) / 1000;
function response(datetimes: string[], close: unknown[] = datetimes.map(() => 100), volume: unknown[] = datetimes.map(() => 1), tickType: unknown[] = datetimes.map(() => 1)) {
    return { datetime: datetimes, close, volume, tick_type: tickType };
}
function covered(datetimes: string[], close: unknown[] = datetimes.map(() => 100), volume: unknown[] = datetimes.map(() => 1), tickType: unknown[] = datetimes.map(() => 1)) {
    return response([at('08:59:59'), ...datetimes], [100, ...close], [1, ...volume], [1, ...tickType]);
}
const repeated = (count: number, time = '09:00:10') => response(Array.from({ length: count }, () => at(time)));
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-17T01:00:00Z')); // Taiwan 09:00 regardless of host timezone
    mocks.fetchLastTicks.mockReset();
    mocks.yield.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal('scheduler', { yield: mocks.yield });
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('loadLiveCandleTail coverage', () => {
    it('doubles LastCount until a strictly older row proves the cutoff is covered', async () => {
        mocks.fetchLastTicks.mockResolvedValueOnce(repeated(512)).mockResolvedValueOnce(response([
            at('08:59:59.999999'), ...Array.from({ length: 1023 }, () => at('09:00:10.123456')),
        ]));
        const prints = await loadLiveCandleTail(stock, seconds('09:00:00'));
        expect(mocks.fetchLastTicks.mock.calls.map(call => call[1])).toEqual([512, 1024]);
        expect(mocks.fetchLastTicks).toHaveBeenNthCalledWith(1, stock, 512, '2026-11-17');
        expect(prints).toHaveLength(1023);
        expect(prints[0]?.datetime).toBe('2026-11-17T09:00:10.123456000');
    });

    it('does not treat an exactly equal oldest timestamp as complete even after a short response', async () => {
        mocks.fetchLastTicks.mockResolvedValueOnce(repeated(512, '09:00:00')).mockResolvedValueOnce(repeated(513, '09:00:00'));
        await expect(loadLiveCandleTail(stock, seconds('09:00:00'))).rejects.toThrow(/strictly older/);
        expect(mocks.fetchLastTicks.mock.calls.map(call => call[1])).toEqual([512, 1024]);
    });

    it('rejects a hidden server cap instead of mistaking a short tail for complete coverage', async () => {
        mocks.fetchLastTicks.mockResolvedValue(repeated(37)); // server cap hides earlier missing fills
        await expect(loadLiveCandleTail(stock, seconds('09:00:00'))).rejects.toThrow(/strictly older/);
        expect(mocks.fetchLastTicks).toHaveBeenCalledExactlyOnceWith(stock, 512, '2026-11-17');
    });

    it('keeps an opening-minute tail uncertified when no pre-cutoff print exists', async () => {
        mocks.fetchLastTicks.mockResolvedValue(response([at('09:00:00'), at('09:00:00.123456')]));
        await expect(loadLiveCandleTail(stock, seconds('09:00:00'))).rejects.toThrow(/strictly older/);
    });

    it('preserves identical fills, exact microseconds and numeric wire fields without deduplicating', async () => {
        mocks.fetchLastTicks.mockResolvedValue(covered([
            at('09:00:00.123456'), at('09:00:00.123456'), at('09:00:00.123457+08:00'),
        ], ['100', 100, '99.5'], ['2', 2, 3], ['1', 1, 2]));
        const prints = await loadLiveCandleTail(stock, seconds('09:00:00'));
        expect(prints).toEqual([
            { datetime: at('09:00:00.123456000'), close: 100, volume: 2, tickType: 1 },
            { datetime: at('09:00:00.123456000'), close: 100, volume: 2, tickType: 1 },
            { datetime: at('09:00:00.123457000'), close: 99.5, volume: 3, tickType: 2 },
        ]);
    });

    it('fails closed at 65,536 rather than returning an unproven partial prefix', async () => {
        mocks.fetchLastTicks.mockImplementation((_contract: ContractBase, count: number) => Promise.resolve(repeated(count)));
        await expect(loadLiveCandleTail(stock, seconds('09:00:00'))).rejects.toThrow(/bounded LastCount/);
        expect(mocks.fetchLastTicks.mock.calls.map(call => call[1])).toEqual([512, 1024, 2048, 4096, 8192, 16384, 32768, 65536]);
    });

    it('ignores zero-volume status prints but uses their raw row count for coverage', async () => {
        mocks.fetchLastTicks.mockResolvedValueOnce(response(Array.from({ length: 512 }, () => at('09:00:00')), Array(512).fill(0), Array(512).fill(0)))
            .mockResolvedValueOnce(response([at('08:59:59'), at('09:00:00.123456')], [0, 100], [0, 3]));
        expect(await loadLiveCandleTail(stock, seconds('09:00:00'))).toEqual([
            { datetime: at('09:00:00.123456000'), close: 100, volume: 3, tickType: 1 },
        ]);
        expect(mocks.fetchLastTicks).toHaveBeenCalledTimes(2);
    });

    it('yields between 1024-row normalization chunks using scheduler.yield when available', async () => {
        mocks.fetchLastTicks.mockResolvedValueOnce(repeated(512)).mockResolvedValueOnce(repeated(1024)).mockResolvedValueOnce(covered(Array.from({ length: 1025 }, () => at('09:00:10'))));
        expect(await loadLiveCandleTail(stock, seconds('09:00:00'))).toHaveLength(1025);
        expect(mocks.yield).toHaveBeenCalledOnce();
    });

    it('falls back to a timer yield without the scheduler API', async () => {
        vi.stubGlobal('scheduler', undefined);
        const timer = vi.spyOn(globalThis, 'setTimeout');
        try {
            mocks.fetchLastTicks.mockResolvedValueOnce(repeated(512)).mockResolvedValueOnce(repeated(1024)).mockResolvedValueOnce(covered(Array.from({ length: 1025 }, () => at('09:00:10'))));
            expect(await loadLiveCandleTail(stock, seconds('09:00:00'))).toHaveLength(1025);
            expect(timer).toHaveBeenCalledOnce();
            expect(timer.mock.calls[0]?.[1]).toBe(0);
        } finally { timer.mockRestore(); }
    });
});

describe('loadLiveCandleTail session dates', () => {
    it('queries stock only on the Taiwan calendar date', async () => {
        vi.setSystemTime(new Date('2026-11-16T16:30:00Z')); // Tuesday 00:30 Taiwan
        mocks.fetchLastTicks.mockResolvedValue(response([]));
        expect(await loadLiveCandleTail(stock, seconds('00:00:00'))).toEqual([]);
        expect(mocks.fetchLastTicks).toHaveBeenCalledExactlyOnceWith(stock, 512, '2026-11-17');
    });

    it('prefers the next weekday at night, then calendar tomorrow, skipping entirely older responses', async () => {
        vi.setSystemTime(new Date('2026-11-20T08:00:00Z')); // Friday 16:00 Taiwan
        mocks.fetchLastTicks.mockResolvedValueOnce(response([at('14:59:59', '2026-11-20')]))
            .mockResolvedValueOnce(response([at('14:59:59', '2026-11-20'), at('15:00:01', '2026-11-20')]));
        const prints = await loadLiveCandleTail(future, seconds('15:00:00', '2026-11-20'));
        expect(mocks.fetchLastTicks.mock.calls.map(call => call[2])).toEqual(['2026-11-23', '2026-11-21']);
        expect(prints[0]?.datetime).toBe(at('15:00:01.000000000', '2026-11-20'));
    });

    it('prefers today during day/early morning and keeps only unique candidate dates', async () => {
        mocks.fetchLastTicks.mockResolvedValueOnce(response([])).mockResolvedValueOnce(covered([at('09:00:10')]));
        const option = { ...future, security_type: 'OPT' as const };
        expect(await loadLiveCandleTail(option, seconds('09:00:00'))).toHaveLength(1);
        expect(mocks.fetchLastTicks.mock.calls.map(call => call[2])).toEqual(['2026-11-17', '2026-11-18']);
    });

    it('returns empty only after successful candidate responses are all empty or older', async () => {
        vi.setSystemTime(new Date('2026-11-20T01:00:00Z')); // Friday day session: three unique dates
        mocks.fetchLastTicks.mockResolvedValueOnce(response([at('08:59:59', '2026-11-20')]))
            .mockResolvedValueOnce(response([])).mockResolvedValueOnce(response([]));
        expect(await loadLiveCandleTail(future, seconds('09:00:00', '2026-11-20'))).toEqual([]);
        expect(mocks.fetchLastTicks.mock.calls.map(call => call[2])).toEqual(['2026-11-20', '2026-11-23', '2026-11-21']);
    });

    it('throws if every candidate request fails', async () => {
        mocks.fetchLastTicks.mockRejectedValue(new Error('market unavailable'));
        await expect(loadLiveCandleTail(future, seconds('09:00:00'))).rejects.toThrow('market unavailable');
        expect(mocks.fetchLastTicks).toHaveBeenCalledTimes(2);
    });

    it('allows a successful empty candidate when other dates fail', async () => {
        mocks.fetchLastTicks.mockRejectedValueOnce(new Error('wrong session')).mockResolvedValueOnce(response([]));
        expect(await loadLiveCandleTail(future, seconds('09:00:00'))).toEqual([]);
    });

    it('does not hide known incomplete coverage behind an empty fallback date', async () => {
        mocks.fetchLastTicks.mockResolvedValueOnce(repeated(512)).mockRejectedValueOnce(new Error('larger request failed')).mockResolvedValueOnce(response([]));
        await expect(loadLiveCandleTail(future, seconds('09:00:00'))).rejects.toThrow('larger request failed');
    });
});

describe('loadLiveCandleTail request sharing', () => {
    it('deduplicates only in-flight work and fetches fresh data after success settles', async () => {
        const pending = deferred<ReturnType<typeof response>>();
        mocks.fetchLastTicks.mockReturnValueOnce(pending.promise).mockResolvedValue(covered([at('09:00:10')]));
        const first = loadLiveCandleTail(stock, seconds('09:00:00'), 1);
        const second = loadLiveCandleTail({ ...stock, region: 'TW' }, seconds('09:00:00'), 1);
        expect(first).toBe(second);
        expect(mocks.fetchLastTicks).toHaveBeenCalledOnce();
        pending.resolve(response([]));
        await expect(first).resolves.toEqual([]);
        await expect(loadLiveCandleTail(stock, seconds('09:00:00'), 1)).resolves.toHaveLength(1);
        expect(mocks.fetchLastTicks).toHaveBeenCalledTimes(2);
    });

    it('does not retain failed promises', async () => {
        mocks.fetchLastTicks.mockRejectedValueOnce(new Error('temporary')).mockResolvedValueOnce(response([]));
        await expect(loadLiveCandleTail(stock, seconds('09:00:00'))).rejects.toThrow('temporary');
        await expect(loadLiveCandleTail(stock, seconds('09:00:00'))).resolves.toEqual([]);
        expect(mocks.fetchLastTicks).toHaveBeenCalledTimes(2);
    });

    it('keeps cutoff, revision and contract identities separate', async () => {
        mocks.fetchLastTicks.mockResolvedValue(response([]));
        await Promise.all([
            loadLiveCandleTail(stock, seconds('09:00:00'), 1),
            loadLiveCandleTail(stock, seconds('09:01:00'), 1),
            loadLiveCandleTail(stock, seconds('09:00:00'), '1'),
            loadLiveCandleTail({ ...stock, code: '2317' }, seconds('09:00:00'), 1),
        ]);
        expect(mocks.fetchLastTicks).toHaveBeenCalledTimes(4);
    });
});

describe('loadLiveCandleTail validation', () => {
    it.each([
        null,
        { datetime: [], close: [], volume: [] },
        { datetime: [at('09:00:00')], close: [], volume: [1], tick_type: [1] },
        { datetime: ['2026-02-30T09:00:00'], close: [100], volume: [1], tick_type: [1] },
        { datetime: [at('09:00:00')], close: [0], volume: [1], tick_type: [1] },
        { datetime: [at('09:00:00')], close: [100], volume: [-1], tick_type: [1] },
        { datetime: [at('09:00:00')], close: [NaN], volume: [1], tick_type: [1] },
        { datetime: [at('09:00:00')], close: [null], volume: [1], tick_type: [1] },
        { datetime: [at('09:00:00')], close: [100], volume: [1], tick_type: [1.5] },
        { ...response([at('09:00:00')]), bid_volume: [] },
    ])('rejects malformed data rather than reporting an empty successful tail (%#)', async payload => {
        mocks.fetchLastTicks.mockResolvedValue(payload);
        await expect(loadLiveCandleTail(future, seconds('09:00:00'))).rejects.toThrow(/Invalid live candle tick/);
        expect(mocks.fetchLastTicks).toHaveBeenCalledOnce();
    });

    it('rejects a response larger than its requested LastCount bound', async () => {
        mocks.fetchLastTicks.mockResolvedValue(repeated(513));
        await expect(loadLiveCandleTail(stock, seconds('09:00:00'))).rejects.toThrow(/requested bound/);
    });

    it('rejects invalid cutoff arguments before making requests', async () => {
        await expect(loadLiveCandleTail(stock, NaN)).rejects.toThrow(/cutoff/);
        await expect(loadLiveCandleTail(stock, seconds('09:00:00') + 0.5)).rejects.toThrow(/cutoff/);
        expect(mocks.fetchLastTicks).not.toHaveBeenCalled();
    });
});
