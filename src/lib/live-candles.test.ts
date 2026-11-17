import { describe, expect, it } from 'vitest';
import { canonicalCandleTime, LiveCandleAccumulator, type LiveCandlePrint } from './live-candles';
import type { Candle } from './types/market';

const second = (time: string): number => Date.parse(`2026-11-17T${time}Z`) / 1000;
const print = (time: string, close: number, volume: number, tickType?: number): LiveCandlePrint => ({
    datetime: `2026-11-17T${time}`, close, volume, tickType,
});
const candle = (time: string, values: Partial<Candle> = {}): Candle => ({
    time: second(time), open: 100, high: 105, low: 95, close: 102, volume: 50, ...values,
});
const empty = (minutes = 1): LiveCandleAccumulator => {
    const accumulator = new LiveCandleAccumulator(minutes);
    accumulator.seed([], second('09:00:00'), []);
    accumulator.takeChanges();
    return accumulator;
};

// Public 2330 prints copied without changing datetime/close/volume/tick_type
// from pro-web-live-open-20261117/wire/{ticks-today,ticks-today-r2}.json.
// Retain only each observed prefix; no broker/account fields are included.
const captured2330Prefixes = [
    {
        through: '2026-11-17T09:38:25.772000', from: '09:38:00', end: '09:39:00',
        expected: { open: 2230, high: 2230, low: 2225, close: 2230, volume: 84 },
        prints: [
            ['2026-11-17T09:38:05.644916', 2230, 1, 1],
            ['2026-11-17T09:38:08.384773', 2225, 3, 2],
            ['2026-11-17T09:38:11.283188', 2230, 5, 1],
            ['2026-11-17T09:38:11.367611', 2230, 5, 1],
            ['2026-11-17T09:38:11.554672', 2230, 1, 1],
            ['2026-11-17T09:38:11.687396', 2230, 6, 1],
            ['2026-11-17T09:38:11.844549', 2230, 1, 1],
            ['2026-11-17T09:38:18.619551', 2230, 7, 1],
            ['2026-11-17T09:38:20.937612', 2230, 2, 1],
            ['2026-11-17T09:38:20.979894', 2230, 4, 1],
            ['2026-11-17T09:38:21.076710', 2230, 6, 1],
            ['2026-11-17T09:38:21.088600', 2230, 2, 1],
            ['2026-11-17T09:38:21.090611', 2230, 8, 1],
            ['2026-11-17T09:38:21.090659', 2230, 2, 1],
            ['2026-11-17T09:38:21.090683', 2230, 2, 1],
            ['2026-11-17T09:38:21.092515', 2230, 4, 1],
            ['2026-11-17T09:38:21.092566', 2230, 2, 1],
            ['2026-11-17T09:38:21.122096', 2230, 4, 1],
            ['2026-11-17T09:38:21.122322', 2230, 5, 1],
            ['2026-11-17T09:38:21.122712', 2230, 6, 1],
            ['2026-11-17T09:38:21.165374', 2230, 2, 1],
            ['2026-11-17T09:38:21.177367', 2230, 4, 1],
            ['2026-11-17T09:38:22.585963', 2230, 1, 1],
            ['2026-11-17T09:38:24.370896', 2230, 1, 1],
        ],
    },
    {
        through: '2026-11-17T09:40:41.729849', from: '09:40:00', end: '09:41:00',
        expected: { open: 2235, high: 2235, low: 2225, close: 2230, volume: 163 },
        prints: [
            ['2026-11-17T09:40:01.108052', 2235, 2, 1],
            ['2026-11-17T09:40:06.373825', 2230, 4, 2],
            ['2026-11-17T09:40:06.945272', 2235, 1, 1],
            ['2026-11-17T09:40:12.451224', 2230, 1, 2],
            ['2026-11-17T09:40:16.521908', 2230, 87, 2],
            ['2026-11-17T09:40:16.542894', 2230, 2, 1],
            ['2026-11-17T09:40:16.645895', 2230, 1, 1],
            ['2026-11-17T09:40:16.646246', 2230, 1, 1],
            ['2026-11-17T09:40:17.679373', 2230, 5, 1],
            ['2026-11-17T09:40:17.956913', 2230, 1, 1],
            ['2026-11-17T09:40:18.644098', 2230, 11, 1],
            ['2026-11-17T09:40:18.695077', 2230, 1, 2],
            ['2026-11-17T09:40:18.698077', 2230, 11, 2],
            ['2026-11-17T09:40:18.699159', 2230, 2, 1],
            ['2026-11-17T09:40:22.811565', 2225, 2, 2],
            ['2026-11-17T09:40:22.823305', 2230, 1, 1],
            ['2026-11-17T09:40:28.062219', 2230, 1, 1],
            ['2026-11-17T09:40:28.990531', 2230, 1, 1],
            ['2026-11-17T09:40:29.501832', 2230, 1, 1],
            ['2026-11-17T09:40:34.389274', 2230, 2, 1],
            ['2026-11-17T09:40:35.817920', 2230, 5, 1],
            ['2026-11-17T09:40:38.322714', 2230, 1, 1],
            ['2026-11-17T09:40:38.505472', 2230, 5, 1],
            ['2026-11-17T09:40:38.538117', 2230, 7, 1],
            ['2026-11-17T09:40:38.592956', 2230, 4, 1],
            ['2026-11-17T09:40:38.988508', 2230, 1, 2],
            ['2026-11-17T09:40:41.729849', 2230, 2, 2],
        ],
    },
] as const;

describe('canonicalCandleTime', () => {
    it('normalizes Taiwan wall-clock forms without rounding microseconds or nanoseconds', () => {
        expect(canonicalCandleTime('2026-11-17 09:00:00.123456+08:00')).toBe('2026-11-17T09:00:00.123456000');
        expect(canonicalCandleTime('2026/11/17 09:00:00.123456')).toBe('2026-11-17T09:00:00.123456000');
        expect(canonicalCandleTime('2026/11/17T09:00:00.123456+08:00')).toBe('2026-11-17T09:00:00.123456000');
        expect(canonicalCandleTime('2026-11-17T09:00:00.123456789')).toBe('2026-11-17T09:00:00.123456789');
        expect(canonicalCandleTime('2026-11-17T09:00:00')).toBe('2026-11-17T09:00:00.000000000');
        expect(canonicalCandleTime('2026-11-17T09:00:00.123457')).not.toBe(canonicalCandleTime('2026-11-17T09:00:00.123456'));
    });

    it.each(['2026-02-29T09:00:00', '2026-11-31T09:00:00', '2026-11-17T24:00:00',
        '2026-11-17T09:60:00', '2026-11-17T09:00:60', '2026-11-17T09:00:00Z',
        '2026-11-17T09:00:00+09:00', '2026-11-17T09:00:00.1234567890', ''])('rejects invalid or non-Taiwan input %s', datetime => {
        expect(canonicalCandleTime(datetime)).toBeNull();
    });

    it('validates leap days and literal years below 100', () => {
        expect(canonicalCandleTime('2024-02-29T00:00:00')).toBe('2024-02-29T00:00:00.000000000');
        expect(canonicalCandleTime('0099-01-01T00:00:00')).toBe('0099-01-01T00:00:00.000000000');
    });
});

describe('LiveCandleAccumulator', () => {
    it.each(captured2330Prefixes)('preserves the captured 2330 prefix through $through in one undrained burst', ({ from, end, expected, prints }) => {
        const accumulator = new LiveCandleAccumulator(1);
        accumulator.seed([], second(from), []);
        accumulator.takeChanges();
        // Synchronously deliver the complete captured prefix before any 50 ms
        // quote/render notification can drain or coalesce the incoming prints.
        for (const [datetime, close, volume, tickType] of prints) accumulator.push({ datetime, close, volume, tickType });
        const expectedBar = { time: second(end), ...expected };
        expect(accumulator.last).toEqual(expectedBar);
        expect(accumulator.takeChanges()).toEqual({ bars: [expectedBar], reset: false, appended: true });
    });

    it('reconciles the two actually paired 2330 REST/SSE fills across buffered and delayed delivery', () => {
        // Exact public wire fields from the 2026-11-17 capture at
        // wire/rest-sse-same-print.public-fixture.json: multiplicity 1 per pair.
        const pairs = [
            {
                rest: { datetime: '2026-11-17T13:24:58.045389', close: 2175, volume: 1, tick_type: 2 },
                sse: { date: '2026-11-17', time: '13:24:58.045389', close: '2175', volume: 1, tick_type: 2, simtrade: false },
            },
            {
                rest: { datetime: '2026-11-17T13:24:58.755025', close: 2175, volume: 1, tick_type: 2 },
                sse: { date: '2026-11-17', time: '13:24:58.755025', close: '2175', volume: 1, tick_type: 2, simtrade: false },
            },
        ] as const;
        const rest = pairs.map(({ rest: row }) => ({ datetime: row.datetime, close: row.close, volume: row.volume, tickType: row.tick_type }));
        const live = pairs.map(({ sse: row }) => ({ datetime: `${row.date}T${row.time}`, close: Number(row.close), volume: row.volume, tickType: row.tick_type, simtrade: row.simtrade }));
        expect(live.map(row => canonicalCandleTime(row.datetime))).toEqual([
            '2026-11-17T13:24:58.045389000', '2026-11-17T13:24:58.755025000',
        ]);
        expect(rest.map(row => canonicalCandleTime(row.datetime))).toEqual(live.map(row => canonicalCandleTime(row.datetime)));
        const accumulator = new LiveCandleAccumulator(1);
        accumulator.push(live[0]!);
        accumulator.seed([], second('13:24:00'), rest);
        accumulator.push(live[1]!);
        expect(accumulator.last).toEqual({ time: second('13:25:00'), open: 2175, high: 2175, low: 2175, close: 2175, volume: 2 });
    });

    it('retains every burst lot and intermediate high/low before the consumer draws', () => {
        const accumulator = empty();
        const prices = [2235, 2225, 2240, 2230];
        for (let i = 0; i < 1000; i++) accumulator.push(print(`09:00:10.${String(i).padStart(6, '0')}`, prices[i % prices.length]!, i % 3 + 1));
        expect(accumulator.last).toEqual({ time: second('09:01:00'), open: 2235, high: 2240, low: 2225, close: 2230, volume: 1999 });
        expect(accumulator.takeChanges()).toEqual({ bars: [accumulator.last], reset: false, appended: true });
        expect(accumulator.takeChanges()).toEqual({ bars: [], reset: false, appended: false });
    });

    it('returns every changed bucket when a burst crosses the minute, including the final old-bucket update', () => {
        const accumulator = empty();
        accumulator.push(print('09:00:59.990000', 100, 1));
        accumulator.takeChanges();
        accumulator.push(print('09:00:59.999999', 90, 4));
        accumulator.push(print('09:01:00.000000', 110, 3));
        accumulator.push(print('09:01:00.000001', 105, 2));
        expect(accumulator.takeChanges()).toEqual({
            bars: [
                { time: second('09:01:00'), open: 100, high: 100, low: 90, close: 90, volume: 5 },
                { time: second('09:02:00'), open: 110, high: 110, low: 105, close: 105, volume: 5 },
            ], reset: false, appended: true,
        });
    });

    it('counts identical live prints repeatedly and uses arrival order for equal event times', () => {
        const accumulator = empty();
        accumulator.push(print('09:00:10.123456', 100, 2));
        accumulator.push(print('09:00:10.123456', 90, 3));
        accumulator.push(print('09:00:10.123456', 100, 2));
        expect(accumulator.last).toEqual({ time: second('09:01:00'), open: 100, high: 100, low: 90, close: 100, volume: 7 });
    });

    it('buffers before seed and merges REST overlap by exact timestamp and multiset count', () => {
        const accumulator = new LiveCandleAccumulator(1);
        accumulator.push(print('09:00:00.123455', 98, 5, 1)); // unmatched older fill still counts
        for (let i = 0; i < 3; i++) accumulator.push(print('09:00:00.123456', 100, 2, 1));
        accumulator.push(print('09:00:00.123456', 99, 3, 2));
        accumulator.push(print('09:00:00.123456', 101, 4, 1)); // same time, distinct fill
        accumulator.push(print('09:00:00.123457', 102, 7, 1)); // distinct microsecond
        expect(accumulator.pendingCount).toBe(7);
        expect(accumulator.bars).toEqual([]);
        accumulator.seed([], second('09:00:00'), [
            print('09:00:00.123456', 100, 2, 1),
            print('09:00:00.123456', 100, 2, 1),
            print('09:00:00.123456', 99, 3, 2),
        ]);
        expect(accumulator.pendingCount).toBe(0);
        expect(accumulator.last).toEqual({ time: second('09:01:00'), open: 98, high: 102, low: 98, close: 102, volume: 25 });
    });

    it('matches equivalent timezone/fraction forms while keeping distinct tick types at the seam', () => {
        const accumulator = new LiveCandleAccumulator(1);
        accumulator.push(print('09:00:10.123456000+08:00', 100, 2, 1));
        accumulator.push(print('09:00:10.123456', 100, 2, 2));
        accumulator.seed([], second('09:00:00'), [print('09:00:10.123456', 100, 2, 1)]);
        expect(accumulator.last?.volume).toBe(4);
    });

    it('preserves all REST multiplicity even if the live buffer has fewer copies', () => {
        const accumulator = new LiveCandleAccumulator(1);
        accumulator.push(print('09:00:10', 100, 2));
        accumulator.seed([], second('09:00:00'), [print('09:00:10', 100, 2), print('09:00:10', 100, 2)]);
        expect(accumulator.last?.volume).toBe(4);
    });

    it('consumes REST-covered delayed copies after seed at every prefix timestamp', () => {
        const accumulator = new LiveCandleAccumulator(1);
        accumulator.seed([], second('09:00:00'), [print('09:00:10.123456', 100, 2), print('09:00:20.123456', 110, 3)]);
        accumulator.takeChanges();
        accumulator.push(print('09:00:10.123456', 100, 2));
        accumulator.push(print('09:00:20.123456000+08:00', 110, 3));
        expect(accumulator.last?.volume).toBe(5);
        expect(accumulator.takeChanges()).toEqual({ bars: [], reset: false, appended: false });
    });

    it('keeps an unmatched late print older than the REST tail and updates its own bucket', () => {
        const accumulator = new LiveCandleAccumulator(1);
        accumulator.seed([], second('09:00:00'), [print('09:00:30', 100, 2), print('09:01:30', 110, 3)]);
        accumulator.takeChanges();
        accumulator.push(print('09:00:10', 90, 5));
        expect(accumulator.bars[0]).toEqual({ time: second('09:01:00'), open: 90, high: 100, low: 90, close: 100, volume: 7 });
        expect(accumulator.takeChanges()).toMatchObject({ reset: true, appended: false });
    });

    it('consumes matching multiplicity across seed and later delivery, then accepts excess identical live fills', () => {
        const accumulator = new LiveCandleAccumulator(1);
        accumulator.push(print('09:00:10.123456', 100, 2, 1));
        accumulator.seed([], second('09:00:00'), [print('09:00:10.123456', 100, 2, 1), print('09:00:10.123456', 100, 2, 1)]);
        accumulator.push(print('09:00:10.123456', 100, 2, 1));
        expect(accumulator.last?.volume).toBe(4);
        accumulator.push(print('09:00:10.123456', 100, 2, 1));
        accumulator.push(print('09:00:10.123456', 100, 2, 1));
        expect(accumulator.last?.volume).toBe(8);
    });

    it('seeds buffered live without REST, ignoring only prints covered by history', () => {
        const accumulator = new LiveCandleAccumulator(1);
        accumulator.push(print('09:00:59.999999', 1, 999));
        accumulator.push(print('09:01:00.000000', 110, 3));
        const history = [candle('09:01:00')];
        accumulator.seed(history, second('09:01:00'), []);
        expect(accumulator.bars).toEqual([history[0], { time: second('09:02:00'), open: 110, high: 110, low: 110, close: 110, volume: 3 }]);
        accumulator.push(print('09:00:59.999999', 1, 999));
        expect(accumulator.bars[0]).toEqual(history[0]);
    });

    it('retains historical open/volume in a partial five-minute bucket and appends only the uncovered tail', () => {
        const history = [candle('09:05:00', { open: 101, high: 110, low: 95, close: 105, volume: 100 })];
        const accumulator = new LiveCandleAccumulator(5);
        accumulator.push(print('09:02:59.999999', 1, 999));
        accumulator.push(print('09:03:30', 94, 3));
        accumulator.seed(history, second('09:03:00'), [print('09:02:59.999999', 1, 999), print('09:03:00', 107, 4)]);
        expect(accumulator.last).toEqual({ time: second('09:05:00'), open: 101, high: 110, low: 94, close: 94, volume: 107 });
        expect(history[0]?.volume).toBe(100);
        accumulator.push(print('09:03:10', 93, 2));
        expect(accumulator.last).toMatchObject({ open: 101, low: 93, close: 94, volume: 109 });
    });

    it('retains the daily historical prefix and places the next day in its calendar bucket', () => {
        const accumulator = new LiveCandleAccumulator(1440);
        accumulator.seed([candle('00:00:00', { open: 101, volume: 100 })], second('09:03:00'), [print('09:03:00', 106, 5)]);
        accumulator.push(print('09:03:10', 99, 7));
        expect(accumulator.last).toEqual({ time: second('00:00:00'), open: 101, high: 106, low: 95, close: 99, volume: 112 });
        accumulator.push({ datetime: '2026-11-18T09:00:00', close: 110, volume: 3 });
        expect(accumulator.last).toEqual({ time: Date.parse('2026-11-18T00:00:00Z') / 1000, open: 110, high: 110, low: 110, close: 110, volume: 3 });
    });

    it.each([1, 5, 15, 1440])('counts the stock closing auction once in its preceding %i-minute bucket', minutes => {
        const label = minutes >= 1440 ? '00:00:00' : '13:30:00';
        const history = minutes === 1 ? [] : [candle(label, { open: 2170, high: 2180, low: 2160, close: 2175, volume: 100 })];
        const continuous = print('13:29:59.999999', 2175, 7, 1);
        const auction = print('13:30:00.000000', 2170, 6801, 2);
        const accumulator = new LiveCandleAccumulator(minutes, undefined, true);
        accumulator.push(continuous);
        accumulator.seed(history, second('13:29:00'), [continuous, auction]);
        accumulator.push(auction); // REST-covered closing print delivered later by SSE
        expect(accumulator.bars).toEqual([{
            time: second(label), open: minutes === 1 ? 2175 : 2170,
            high: minutes === 1 ? 2175 : 2180, low: minutes === 1 ? 2170 : 2160,
            close: 2170, volume: (minutes === 1 ? 0 : 100) + 7 + 6801,
        }]);
    });

    it('keeps microsecond ordering within the stock closing-auction second', () => {
        const accumulator = new LiveCandleAccumulator(1, undefined, true);
        accumulator.seed([], second('13:29:00'), []);
        accumulator.push(print('13:29:59.999999', 2175, 1));
        accumulator.push(print('13:30:00.123457', 2170, 2));
        accumulator.push(print('13:30:00.123456', 2165, 3));
        expect(accumulator.bars).toEqual([{
            time: second('13:30:00'), open: 2175, high: 2175, low: 2165, close: 2170, volume: 6,
        }]);
    });

    it('keeps regular boundary bucketing when the stock auction option is off or at another time', () => {
        const regular = new LiveCandleAccumulator(1);
        regular.seed([], second('13:29:00'), []);
        regular.push(print('13:30:00', 2170, 1));
        expect(regular.last?.time).toBe(second('13:31:00'));
        const stock = new LiveCandleAccumulator(1, undefined, true);
        stock.seed([], second('13:24:00'), []);
        stock.push(print('13:25:00', 2175, 1));
        expect(stock.last?.time).toBe(second('13:26:00'));
    });

    it('uses event time for late open/close and requests a reset for older-bucket changes', () => {
        const accumulator = empty();
        accumulator.push(print('09:01:40', 120, 1));
        accumulator.takeChanges();
        accumulator.push(print('09:00:40', 102, 2));
        accumulator.push(print('09:00:10', 100, 3));
        accumulator.push(print('09:00:50', 101, 4));
        accumulator.push(print('09:00:30', 90, 5));
        expect(accumulator.takeChanges()).toEqual({
            bars: [{ time: second('09:01:00'), open: 100, high: 102, low: 90, close: 101, volume: 14 }], reset: true, appended: true,
        });
        expect(accumulator.last?.close).toBe(120);
        accumulator.push(print('09:00:20', 103, 6));
        expect(accumulator.takeChanges()).toMatchObject({ reset: true, appended: false });
    });

    it('prepends older history without overwriting the live tail or its event ordering', () => {
        const accumulator = empty();
        accumulator.push(print('09:01:30', 110, 3));
        accumulator.takeChanges();
        accumulator.prepend([candle('09:00:00'), candle('09:02:00', { close: 1, volume: 999 })]);
        expect(accumulator.last).toMatchObject({ open: 110, close: 110, volume: 3 });
        expect(accumulator.takeChanges()).toMatchObject({ reset: true, appended: false });
        accumulator.push(print('09:01:20', 105, 2));
        expect(accumulator.last).toMatchObject({ open: 105, close: 110, volume: 5 });
        expect(accumulator.bars.map(bar => bar.time)).toEqual([second('09:00:00'), second('09:02:00')]);
    });

    it('applies the day-session filter before buffering, REST merging, and live aggregation', () => {
        const accumulator = new LiveCandleAccumulator(1, time => {
            const sinceMidnight = time % 86400;
            return sinceMidnight >= 9 * 3600 && sinceMidnight < 14 * 3600;
        });
        accumulator.push(print('08:59:59', 1, 999));
        accumulator.push(print('09:00:10', 100, 2));
        expect(accumulator.pendingCount).toBe(1);
        accumulator.seed([], second('00:00:00'), [print('08:59:59', 1, 999)]);
        accumulator.push(print('14:00:00', 1, 999));
        expect(accumulator.bars).toEqual([{ time: second('09:01:00'), open: 100, high: 100, low: 100, close: 100, volume: 2 }]);
    });

    it('rejects invalid prices, volumes, dates and simulated prints but accepts zero-volume index updates', () => {
        const accumulator = new LiveCandleAccumulator(1);
        for (const close of [0, -1, NaN, Infinity]) accumulator.push(print('09:00:00', close, 1));
        for (const volume of [-1, NaN, Infinity]) accumulator.push(print('09:00:00', 100, volume));
        accumulator.push({ ...print('09:00:00', 100, 1), simtrade: true });
        accumulator.push({ datetime: 'not-a-date', close: 100, volume: 1 });
        expect(accumulator.pendingCount).toBe(0);
        accumulator.seed([], second('09:00:00'), []);
        accumulator.push(print('09:00:10', 100, 0));
        accumulator.push(print('09:00:20', 110, 0));
        expect(accumulator.last).toMatchObject({ open: 100, high: 110, close: 110, volume: 0 });
    });

    it('bounds pending storage and refuses a seed after any overflow without clearing the failure', () => {
        const accumulator = new LiveCandleAccumulator(1);
        for (let i = 0; i < 50_000; i++) accumulator.push(print('09:00:00', 100, 1));
        expect(accumulator.overflowed).toBe(false);
        accumulator.push(print('09:00:01', 101, 1));
        expect(accumulator.pendingCount).toBe(50_000);
        expect(accumulator.overflowed).toBe(true);
        expect(() => accumulator.seed([], second('09:00:00'), [])).toThrow(/overflow/);
        expect(accumulator.bars).toEqual([]);
        expect(accumulator.pendingCount).toBe(50_000);
        expect(accumulator.overflowed).toBe(true);
    });

    it('fails closed if the REST reconciliation prefix exceeds its bounded capacity', () => {
        const accumulator = new LiveCandleAccumulator(1);
        const prefix = Array.from({ length: 65_537 }, () => print('09:00:00', 100, 1));
        expect(() => accumulator.seed([], second('09:00:00'), prefix)).toThrow(/bounded/);
        expect(accumulator.bars).toEqual([]);
        expect(accumulator.pendingCount).toBe(0);
    });

    it('rejects invalid interval and non-boundary cutoff arguments', () => {
        expect(() => new LiveCandleAccumulator(0)).toThrow();
        expect(() => new LiveCandleAccumulator(1.5)).toThrow();
        const accumulator = new LiveCandleAccumulator(1);
        expect(() => accumulator.seed([], NaN, [])).toThrow(/cutoff/);
        expect(() => accumulator.seed([], second('09:00:00') + 0.5, [])).toThrow(/cutoff/);
    });
});
