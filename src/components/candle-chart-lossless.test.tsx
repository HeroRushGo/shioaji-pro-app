// Regression at the real stream → chart seam: quote notifications remain batched,
// while every trade contributes to the candlestick, histogram and OHLC readout.
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { created, crosshairHandlers, logicalRangeHandlers, kbars, T as wall } from './chart-session.test-harness';
import type { SseIndexQuote, SseTick } from '../lib/types/market';
import type { LiveCandlePrint } from '../lib/live-candles';
import type { StreamWire } from '../lib/shared-stream';

const m = vi.hoisted(() => {
    const store = new Map<string, string>();
    const localStorage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value), removeItem: (key: string) => store.delete(key), key: () => null, length: 0 };
    (globalThis as any).localStorage = localStorage;
    (globalThis as any).window = Object.assign(globalThis, { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, location: { search: '', href: 'http://fixture.invalid/' } });
    (globalThis as any).document = { addEventListener() {}, removeEventListener() {}, createElement: () => ({ style: {}, getContext: () => null }), body: {} };
    return {
        options: null as null | { onWire: (wire: StreamWire) => void },
        revision: 0,
        ticks: new Set<(tick: SseTick) => void>(),
        indices: new Set<(quote: SseIndexQuote) => void>(),
        history: vi.fn(),
        tail: vi.fn(),
    };
});
vi.mock('../lib/trade', () => ({ notify: () => {}, placeQuickOrder: async () => {} }));
vi.mock('../lib/shioaji', () => ({ cancelOrder: async () => {}, updateOrderPrice: async () => {} }));
vi.mock('../lib/runtime', async (importOriginal) => ({ ...await importOriginal<typeof import('../lib/runtime')>(), getApiBase: () => 'http://fixture.invalid', getStreamBase: () => 'http://fixture.invalid' }));
vi.mock('../lib/api', async (importOriginal) => ({ ...await importOriginal<typeof import('../lib/api')>(), apiPost: vi.fn(async () => ({ success: true })) }));
vi.mock('../lib/server-info-store', async (importOriginal) => ({ ...await importOriginal<typeof import('../lib/server-info-store')>(), forgetServerInfo: vi.fn(), knownServerInfo: () => undefined }));
vi.mock('../lib/index-close-quote', () => ({ rememberIndexClose: vi.fn() }));
vi.mock('../lib/shared-stream', () => ({ createSharedStream: (options: typeof m.options) => {
    m.options = options;
    return { isOwner: () => false, publish: () => undefined, close: () => undefined };
} }));
vi.mock('../lib/stream', async (importOriginal) => {
    const real = await importOriginal<typeof import('../lib/stream')>();
    return {
        ...real,
        onAnyTick: (listener: (tick: SseTick) => void) => {
            m.ticks.add(listener);
            const stop = real.onAnyTick(listener);
            return () => { m.ticks.delete(listener); stop(); };
        },
        onAnyIndexQuote: (listener: (quote: SseIndexQuote) => void) => {
            m.indices.add(listener);
            const stop = real.onAnyIndexQuote(listener);
            return () => { m.indices.delete(listener); stop(); };
        },
    };
});
vi.mock('../hooks/use-stream', async () => {
    const React = await import('react');
    const stream = await import('../lib/stream');
    return { useQuote: (code: string) => React.useSyncExternalStore(
        (listener) => stream.subscribeQuoteStore(code, listener),
        () => stream.getQuote(code),
    ) };
});
vi.mock('../lib/chart-history', () => ({ fetchChartHistory: (...args: unknown[]) => m.history(...args), nextChartHistoryRevision: () => ++m.revision }));
vi.mock('../lib/live-candle-history', () => ({ loadLiveCandleTail: (...args: unknown[]) => m.tail(...args) }));
vi.mock('lightweight-charts', async () => (await import('./chart-session.test-harness')).lwMock());

import { CandleChart } from './candle-chart';
import { ensureStream, subscribeQuoteStore } from '../lib/stream';

const stock = { code: '2330', security_type: 'STK', exchange: 'TSE', target_code: null, tick: 1 } as any;
const future = { code: 'TXFR1', security_type: 'FUT', exchange: 'TAIFEX', target_code: 'TXFJ6', tick: 1 } as any;
const mounted = new Set<ReactTestRenderer>();
let fixtureNumber = 0;
const initial = () => kbars([['2026-10-08T08:59:00', '2026-10-08T09:00:00', () => 100]]);
const setNow = (time: string) => vi.setSystemTime(new Date(`${time}+08:00`));
const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => {}); };
const draw = async (ms = 50) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); await settle(); };
function mount(props: Record<string, unknown> = {}) {
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(createElement(CandleChart, { contract: stock, interval: '1m', ...props } as any), {
        createNodeMock: () => ({ clientWidth: 800, clientHeight: 400, getBoundingClientRect: () => ({ width: 800, height: 400, left: 0, top: 0 }), addEventListener() {}, removeEventListener() {}, style: {} }),
    }); });
    mounted.add(renderer);
    return renderer;
}
const candles = () => created.filter((series) => series.kind === 'Candlestick').at(-1)!;
const histogram = () => created.filter((series) => series.kind === 'Histogram').at(-1)!;
const candleAt = (time: string) => (candles().last as any[]).find((bar) => bar.time === wall(time));
const volumeAt = (time: string) => (histogram().last as any[]).find((bar) => bar.time === wall(time))?.value;
const text = (node: ReactTestInstance): string => node.children.map((child) => typeof child === 'string' ? child : text(child)).join('');
const readout = (renderer: ReactTestRenderer, field: string) => text(renderer.root.findAll((node) => typeof node.type === 'string' && node.props['data-ohlc'] === field)[0]!);
const wire = (name: string, body: unknown) => m.options!.onWire({ kind: 'event', name, raw: JSON.stringify(body) });
function tick(time: string, close: number, volume: number, code = stock.code, extra: Partial<SseTick> = {}) {
    wire(code.startsWith('TXFR') ? 'tick_fop' : 'tick_stk', { code, date: '2026/10/08', time, close: String(close), volume, tick_type: 1, ...extra });
}
const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
};

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    setNow('2026-10-08T09:00:30');
    // The real stream keeps its quote store across mounts; isolate test symbols.
    stock.code = String(2330 + fixtureNumber);
    future.code = `TXFR${++fixtureNumber}`;
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value), removeItem: (key: string) => store.delete(key), key: () => null, length: 0 });
    vi.stubGlobal('requestAnimationFrame', (callback: any) => setTimeout(callback, 0));
    vi.stubGlobal('cancelAnimationFrame', (id: any) => clearTimeout(id));
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    created.length = 0;
    crosshairHandlers.length = 0;
    logicalRangeHandlers.length = 0;
    m.revision = 0;
    m.history.mockReset().mockImplementation(async () => initial());
    m.tail.mockReset().mockResolvedValue([]);
    ensureStream(); // follower fixture: feeds the same wire handler as a real shared SSE.
});
afterEach(async () => {
    for (const renderer of mounted) act(() => renderer.unmount());
    mounted.clear();
    // Flush quote-store notifications too, so its module-level coalescer is idle.
    await draw();
    expect(m.ticks.size).toBe(0);
    expect(m.indices.size).toBe(0);
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('CandleChart lossless raw trade aggregation', () => {
    it('keeps the middle low/high and every lot when the real stream emits only one quote notification', async () => {
        const renderer = mount();
        await settle();
        const notified = vi.fn();
        const stop = subscribeQuoteStore(stock.code, notified);
        const before = candles().update.mock.calls.length;
        act(() => {
            tick('09:00:31.000001', 100, 2);
            tick('09:00:31.000002', 80, 3);
            tick('09:00:31.000003', 120, 5);
            tick('09:00:31.000004', 105, 7);
        });
        expect(notified).not.toHaveBeenCalled();
        expect(candles().update.mock.calls.length).toBe(before);
        await draw(49);
        expect(candles().update.mock.calls.length).toBe(before);
        await draw(1);
        expect(notified).toHaveBeenCalledTimes(1);
        expect(candles().update.mock.calls.length).toBe(before + 1);
        expect(candleAt('2026-10-08T09:01:00')).toMatchObject({ open: 100, high: 120, low: 80, close: 105 });
        expect(volumeAt('2026-10-08T09:01:00')).toBe(17);
        expect(readout(renderer, 'high')).toBe('高120.0');
        expect(readout(renderer, 'low')).toBe('低80.0');
        expect(readout(renderer, 'volume')).toBe('量17');
        stop();
    });

    it('draws each crossed minute, retains identical timestamp trades, and excludes simtrade and odd lots', async () => {
        mount();
        await settle();
        act(() => {
            tick('09:00:59.999999', 100, 2);
            tick('09:00:59.999999', 100, 2); // two legitimate indistinguishable prints
            tick('09:01:00.000001', 105, 3);
            tick('09:01:20.000001', 1, 999, stock.code, { simtrade: true });
            tick('09:01:21.000001', 2, 888, stock.code, { intraday_odd: true });
            tick('09:01:59.999999', 95, 5);
            tick('09:02:00.000001', 110, 7);
        });
        await draw();
        expect(candleAt('2026-10-08T09:01:00')).toMatchObject({ open: 100, high: 100, low: 100, close: 100 });
        expect(volumeAt('2026-10-08T09:01:00')).toBe(4);
        expect(candleAt('2026-10-08T09:02:00')).toMatchObject({ open: 105, high: 105, low: 95, close: 95 });
        expect(volumeAt('2026-10-08T09:02:00')).toBe(8);
        expect(candleAt('2026-10-08T09:03:00')).toMatchObject({ open: 110, high: 110, low: 110, close: 110 });
        expect(volumeAt('2026-10-08T09:03:00')).toBe(7);
    });

    it('reconciles a delayed history plus REST prefix with microsecond and multiset overlap exactly once', async () => {
        const history = deferred<ReturnType<typeof kbars>>();
        const prefix = deferred<LiveCandlePrint[]>();
        m.history.mockReturnValueOnce(history.promise);
        m.tail.mockReturnValueOnce(prefix.promise);
        mount();
        await settle();
        act(() => {
            tick('09:00:10.000001', 100, 2);
            tick('09:00:10.000002', 80, 3);
            tick('09:00:10.000002', 80, 3);
            tick('09:00:10.000002', 80, 3);
            tick('09:00:12.000003', 110, 5);
        });
        await draw();
        expect(candleAt('2026-10-08T09:01:00')).toBeUndefined();
        // Server includes a partial current minute, which must be replaced by
        // the exact print prefix instead of being counted a second time.
        history.resolve(kbars([['2026-10-08T08:59:00', '2026-10-08T09:01:00', () => 50]]));
        await settle();
        expect(m.tail).toHaveBeenCalledWith(expect.objectContaining({ code: stock.code }), wall('2026-10-08T09:00:00'), expect.anything());
        prefix.resolve([
            { datetime: '2026-10-08T09:00:05.000000', close: 90, volume: 7 },
            { datetime: '2026-10-08T09:00:10.000001', close: 100, volume: 2, tickType: 1 },
            { datetime: '2026-10-08T09:00:10.000002', close: 80, volume: 3, tickType: 1 },
            { datetime: '2026-10-08T09:00:10.000002', close: 80, volume: 3, tickType: 1 },
        ]);
        await settle();
        await draw();
        expect(candleAt('2026-10-08T09:00:00')).toMatchObject({ open: 50, high: 50, low: 50, close: 50 });
        expect(volumeAt('2026-10-08T09:00:00')).toBe(10);
        expect(candleAt('2026-10-08T09:01:00')).toMatchObject({ open: 90, high: 110, low: 80, close: 110 });
        expect(volumeAt('2026-10-08T09:01:00')).toBe(23);
    });


    it.each(['missing', 'old', 'simtrade'] as const)('rejects an empty REST prefix after a real buffered print with a %s request-start quote', async (seed) => {
        const history = deferred<ReturnType<typeof kbars>>();
        m.history.mockReturnValueOnce(history.promise);
        if (seed === 'old') act(() => tick('08:59:59.000001', 100, 3));
        if (seed === 'simtrade') act(() => tick('09:00:00.000001', 1, 999, stock.code, { simtrade: true }));
        const renderer = mount();
        await settle();
        act(() => tick('09:00:31.000001', 105, 7));
        history.resolve(initial());
        await settle();
        await draw();
        const incomplete = () => renderer.root.findAll((node) => typeof node.type === 'string' && node.props['data-live-candle-status'] === 'incomplete');
        expect(m.tail).toHaveBeenCalledTimes(1);
        expect(incomplete()).toHaveLength(1);
        expect(candleAt('2026-10-08T09:01:00')).toBeUndefined();
        expect(volumeAt('2026-10-08T09:00:00')).toBe(10);
        act(() => tick('09:00:59.000001', 120, 9));
        await draw();
        expect(candleAt('2026-10-08T09:01:00')).toBeUndefined();
        expect(incomplete()).toHaveLength(1);
        setNow('2026-10-08T09:01:00');
        act(() => tick('09:01:00.000001', 110, 4));
        await draw();
        expect(candleAt('2026-10-08T09:02:00')).toMatchObject({ open: 110, high: 110, low: 110, close: 110 });
        expect(volumeAt('2026-10-08T09:02:00')).toBe(4);
        expect(incomplete()).toHaveLength(0);
    });

    it('rejects a nonempty REST prefix that omits the known real request-start print', async () => {
        setNow('2026-10-08T10:00:30');
        m.history.mockResolvedValueOnce(kbars([['2026-10-08T09:59:00', '2026-10-08T10:00:00', () => 100]]));
        m.tail.mockResolvedValueOnce([
            { datetime: '2026-10-08T10:00:05.000001', close: 100, volume: 2, tickType: 1 },
        ]);
        // This known low cannot disappear behind an older, lagging REST response.
        act(() => tick('10:00:20.000001', 90, 7));
        const renderer = mount();
        await settle();
        await draw();
        expect(m.tail).toHaveBeenCalledTimes(1);
        expect(renderer.root.findAll((node) => typeof node.type === 'string' && node.props['data-live-candle-status'] === 'incomplete')).toHaveLength(1);
        expect(candleAt('2026-10-08T10:01:00')).toBeUndefined();
        expect(volumeAt('2026-10-08T10:00:00')).toBe(10);
        expect((histogram().last as any[]).reduce((sum, bar) => sum + bar.value, 0)).toBe(10);
    });

    it('does not revive an incomplete 15m bar with a closing auction at the recovery cutoff', async () => {
        setNow('2026-10-08T13:20:30');
        m.history.mockResolvedValueOnce(kbars([
            ['2026-10-07T13:00:00', '2026-10-07T13:15:00', () => 100],
            ['2026-10-08T13:15:00', '2026-10-08T13:21:00', () => 50],
        ]));
        m.tail.mockRejectedValueOnce(new Error('fixture auction prefix unavailable'));
        const renderer = mount({ interval: '15m' });
        await settle();
        expect(candleAt('2026-10-08T13:30:00')).toBeUndefined();
        expect(volumeAt('2026-10-07T13:15:00')).toBe(150);
        setNow('2026-10-08T13:30:00');
        act(() => tick('13:30:00.000000', 110, 6801));
        await draw();
        expect(candleAt('2026-10-08T13:30:00')).toBeUndefined();
        expect(candleAt('2026-10-08T13:45:00')).toBeUndefined();
        expect((histogram().last as any[]).reduce((sum, bar) => sum + bar.value, 0)).toBe(150);
        expect(renderer.root.findAll((node) => typeof node.type === 'string' && node.props['data-live-candle-status'] === 'incomplete')).toHaveLength(1);
    });

    it.each(['1m', '1D'])('counts the 13:30 stock closing auction exactly once in %s history and REST handoff', async (interval) => {
        setNow('2026-10-08T13:30:20');
        const history = deferred<ReturnType<typeof kbars>>();
        m.history.mockReturnValueOnce(history.promise);
        m.tail.mockResolvedValueOnce([
            { datetime: '2026-10-08T13:29:05.000001', close: 101, volume: 2, tickType: 1 },
            { datetime: '2026-10-08T13:29:55.000002', close: 95, volume: 5, tickType: 1 },
            { datetime: '2026-10-08T13:30:00.000000', close: 110, volume: 5, tickType: 1 },
        ]);
        const renderer = mount({ interval });
        await settle();
        // The same auction may arrive on SSE while the history request is open.
        act(() => tick('13:30:00.000000', 110, 5));
        history.resolve({
            datetime: ['2026-10-08 13:29:00', '2026-10-08 13:30:00'],
            Open: [100, 101], High: [100, 110], Low: [100, 95], Close: [100, 110],
            // The 13:30 minute already combines continuous trades (7) and auction (5).
            Volume: [3, 12], Amount: [300, 1227],
        });
        await settle();
        await draw();
        expect(m.tail).toHaveBeenCalledWith(expect.objectContaining({ code: stock.code }), wall('2026-10-08T13:29:00'), expect.anything());
        expect((histogram().last as any[]).reduce((sum, bar) => sum + bar.value, 0)).toBe(15);
        if (interval === '1m') {
            expect(candleAt('2026-10-08T13:29:00')).toMatchObject({ open: 100, high: 100, low: 100, close: 100 });
            expect(volumeAt('2026-10-08T13:29:00')).toBe(3);
            expect(candleAt('2026-10-08T13:30:00')).toMatchObject({ open: 101, high: 110, low: 95, close: 110 });
            expect(volumeAt('2026-10-08T13:30:00')).toBe(12);
            expect(candleAt('2026-10-08T13:31:00')).toBeUndefined();
            expect(readout(renderer, 'volume')).toBe('量12');
        } else {
            expect(candleAt('2026-10-08T00:00:00')).toMatchObject({ open: 100, high: 110, low: 95, close: 110 });
            expect(volumeAt('2026-10-08T00:00:00')).toBe(15);
            expect(readout(renderer, 'volume')).toBe('量15');
        }
    });

    it('does not mix an incomplete minute into a live bar when the REST tail fails', async () => {
        setNow('2026-10-08T09:02:30');
        m.history.mockResolvedValueOnce(kbars([
            ['2026-10-07T09:00:00', '2026-10-07T09:05:00', () => 100],
            ['2026-10-08T09:00:00', '2026-10-08T09:03:00', () => 50],
        ]));
        m.tail.mockRejectedValueOnce(new Error('fixture tail unavailable'));
        mount({ interval: '5m' });
        await settle();
        expect(candleAt('2026-10-08T09:05:00')).toBeUndefined();
        act(() => tick('09:03:00.000001', 1, 999));
        await draw();
        expect(candleAt('2026-10-08T09:05:00')).toBeUndefined();
        setNow('2026-10-08T09:05:00');
        act(() => tick('09:05:00.000001', 110, 4));
        await draw();
        expect(candleAt('2026-10-08T09:10:00')).toMatchObject({ open: 110, high: 110, low: 110, close: 110 });
        expect(volumeAt('2026-10-08T09:10:00')).toBe(4);
    });

    it('does not promote an old partial target bar when the tail request fails after its closing boundary', async () => {
        setNow('2026-10-08T09:03:30');
        let rejectTail!: (error: Error) => void;
        const tail = new Promise<LiveCandlePrint[]>((_resolve, reject) => { rejectTail = reject; });
        m.history.mockResolvedValueOnce(kbars([
            ['2026-10-07T09:00:00', '2026-10-07T09:05:00', () => 100],
            ['2026-10-08T09:00:00', '2026-10-08T09:04:00', () => 50],
        ]));
        m.tail.mockReturnValueOnce(tail);
        const renderer = mount({ interval: '5m' });
        await settle();
        expect(m.tail).toHaveBeenCalledTimes(1);
        // Clock time passing cannot fill the missing 09:04/09:05 source data.
        setNow('2026-10-08T09:07:00');
        rejectTail(new Error('fixture slow tail unavailable'));
        await settle();
        await draw();
        const incomplete = () => renderer.root.findAll((node) => typeof node.type === 'string' && node.props['data-live-candle-status'] === 'incomplete');
        expect(incomplete()).toHaveLength(1);
        expect(candleAt('2026-10-07T09:05:00')).toMatchObject({ open: 100, close: 100 });
        expect(volumeAt('2026-10-07T09:05:00')).toBe(50);
        expect(candleAt('2026-10-08T09:05:00')).toBeUndefined();
        expect(volumeAt('2026-10-08T09:05:00')).toBeUndefined();
        act(() => tick('09:07:30.000001', 1, 999));
        await draw();
        expect(candleAt('2026-10-08T09:10:00')).toBeUndefined();
        setNow('2026-10-08T09:10:00');
        act(() => tick('09:10:00.000001', 110, 4));
        await draw();
        expect(candleAt('2026-10-08T09:05:00')).toBeUndefined();
        expect(candleAt('2026-10-08T09:10:00')).toBeUndefined();
        expect(candleAt('2026-10-08T09:15:00')).toMatchObject({ open: 110, high: 110, low: 110, close: 110 });
        expect(volumeAt('2026-10-08T09:15:00')).toBe(4);
        expect(readout(renderer, 'volume')).toBe('量4');
        expect(incomplete()).toHaveLength(0);
    });

    it.each(['contract', 'timeframe', 'session', 'unmount'] as const)('clears the pending draw and raw subscription when %s changes', async (change) => {
        m.history.mockResolvedValueOnce(initial()).mockReturnValue(new Promise(() => {}));
        const props = { contract: future, interval: '1m', onIntervalChange: () => {}, sessionMode: 'all', onSessionModeChange: () => {} };
        const renderer = mount(props);
        await settle();
        const oldListeners = new Set(m.ticks);
        act(() => tick('09:00:35.000001', 111, 7, future.code));
        const before = candles().update.mock.calls.length;
        if (change === 'unmount') {
            act(() => renderer.unmount());
            mounted.delete(renderer);
        } else {
            const next = change === 'contract' ? { contract: { ...future, code: 'MXFR1' } }
                : change === 'timeframe' ? { interval: '5m' } : { sessionMode: 'day' };
            act(() => renderer.update(createElement(CandleChart, { ...props, ...next } as any)));
        }
        for (const listener of oldListeners) expect(m.ticks.has(listener)).toBe(false);
        await draw();
        expect(candles().update.mock.calls.length).toBe(before);
        if (change !== 'unmount') {
            expect(candles().last).toEqual([]);
            expect(histogram().last).toEqual([]);
            act(() => tick('09:00:36.000001', 222, 9, future.code));
            await draw();
            expect(candles().last).toEqual([]);
        }
    });


    it('preserves the current live tail when an older history page resolves', async () => {
        const page = deferred<ReturnType<typeof kbars>>();
        m.history.mockResolvedValueOnce(initial()).mockReturnValueOnce(page.promise);
        mount();
        await settle();
        act(() => tick('09:00:31.000001', 101, 4));
        await draw();
        act(() => logicalRangeHandlers.forEach((handler) => handler({ from: 0, to: 20 })));
        await settle();
        expect(m.history).toHaveBeenCalledTimes(2);
        act(() => {
            tick('09:00:32.000001', 80, 3);
            tick('09:00:33.000001', 120, 5);
        });
        await draw();
        page.resolve(kbars([['2026-10-06T09:00:00', '2026-10-06T09:01:00', () => 70]]));
        await settle();
        expect(candleAt('2026-10-06T09:01:00')).toMatchObject({ open: 70, close: 70 });
        expect(candleAt('2026-10-08T09:01:00')).toMatchObject({ open: 101, high: 120, low: 80, close: 120 });
        expect(volumeAt('2026-10-08T09:01:00')).toBe(12);
        act(() => tick('09:00:34.000001', 110, 7));
        await draw();
        expect(candleAt('2026-10-06T09:01:00')).toMatchObject({ open: 70, close: 70 });
        expect(candleAt('2026-10-08T09:01:00')).toMatchObject({ open: 101, high: 120, low: 80, close: 110 });
        expect(volumeAt('2026-10-08T09:01:00')).toBe(19);
    });

    it('does not restore an incomplete target bar when paging after a tail failure', async () => {
        setNow('2026-10-08T09:03:30');
        const page = deferred<ReturnType<typeof kbars>>();
        m.history.mockResolvedValueOnce(kbars([
            ['2026-10-07T09:00:00', '2026-10-07T09:05:00', () => 100],
            ['2026-10-08T09:00:00', '2026-10-08T09:04:00', () => 50],
        ])).mockReturnValueOnce(page.promise);
        m.tail.mockRejectedValueOnce(new Error('fixture tail unavailable'));
        mount({ interval: '5m' });
        await settle();
        expect(candleAt('2026-10-08T09:05:00')).toBeUndefined();
        act(() => logicalRangeHandlers.forEach((handler) => handler({ from: 0, to: 20 })));
        await settle();
        expect(m.history).toHaveBeenCalledTimes(2);
        page.resolve(kbars([['2026-10-06T09:00:00', '2026-10-06T09:05:00', () => 70]]));
        await settle();
        expect(candleAt('2026-10-06T09:05:00')).toMatchObject({ open: 70, close: 70 });
        expect(candleAt('2026-10-07T09:05:00')).toMatchObject({ open: 100, close: 100 });
        expect(candleAt('2026-10-08T09:05:00')).toBeUndefined();
        expect(volumeAt('2026-10-08T09:05:00')).toBeUndefined();
        expect((histogram().last as any[]).reduce((sum, bar) => sum + bar.value, 0)).toBe(100);
        setNow('2026-10-08T09:05:00');
        act(() => tick('09:05:00.000001', 110, 4));
        await draw();
        expect(candleAt('2026-10-08T09:05:00')).toBeUndefined();
        expect(candleAt('2026-10-08T09:10:00')).toMatchObject({ open: 110, high: 110, low: 110, close: 110 });
        expect(volumeAt('2026-10-08T09:10:00')).toBe(4);
    });

    it('reconciles after reconnect and prevents an older pending generation from publishing', async () => {
        const stale = deferred<ReturnType<typeof kbars>>();
        const recovered = deferred<ReturnType<typeof kbars>>();
        m.history.mockResolvedValueOnce(initial()).mockReturnValueOnce(stale.promise).mockReturnValueOnce(recovered.promise);
        m.tail.mockResolvedValueOnce([]).mockResolvedValueOnce([
            { datetime: '2026-10-08T09:00:31.000001', close: 101, volume: 4, tickType: 1 },
            // A real trade seen during DOWN is recovered from the authoritative tail.
            { datetime: '2026-10-08T09:00:32.000001', close: 1, volume: 999, tickType: 1 },
            { datetime: '2026-10-08T09:00:34.000001', close: 109, volume: 3, tickType: 1 },
        ]);
        act(() => m.options!.onWire({ kind: 'status', status: 'live', heartbeat: Date.now() }));
        const renderer = mount();
        await settle();
        act(() => tick('09:00:31.000001', 101, 4));
        await draw();
        expect(volumeAt('2026-10-08T09:01:00')).toBe(4);
        const refresh = renderer.root.find((node) => node.type === 'button' && node.props['aria-label'] === '更新歷史');
        act(() => refresh.props.onClick());
        await settle();
        expect(m.history).toHaveBeenCalledTimes(2);
        act(() => {
            m.options!.onWire({ kind: 'status', status: 'down', heartbeat: Date.now() });
            tick('09:00:32.000001', 1, 999);
        });
        const updates = candles().update.mock.calls.length;
        await draw();
        expect(candles().update.mock.calls.length).toBe(updates);
        act(() => m.options!.onWire({ kind: 'status', status: 'live', heartbeat: Date.now() }));
        await settle();
        expect(m.history).toHaveBeenCalledTimes(3);
        act(() => tick('09:00:34.000001', 109, 3));
        recovered.resolve(initial());
        await settle();
        await draw();
        expect(candleAt('2026-10-08T09:01:00')).toMatchObject({ open: 101, high: 109, low: 1, close: 109 });
        expect(volumeAt('2026-10-08T09:01:00')).toBe(1006);
        const sets = candles().setData.mock.calls.length;
        stale.resolve(kbars([['2026-10-08T08:59:00', '2026-10-08T09:01:00', () => 999]]));
        await settle();
        await draw();
        expect(candles().setData.mock.calls.length).toBe(sets);
        expect(candleAt('2026-10-08T09:01:00')).toMatchObject({ open: 101, high: 109, low: 1, close: 109 });
        expect(volumeAt('2026-10-08T09:01:00')).toBe(1006);
    });

    it('aggregates index prices through the raw quote_idx stream with zero trade volume', async () => {
        const index = { code: 'IX0001', security_type: 'IND', exchange: 'TSE', target_code: null };
        mount({ contract: index });
        await settle();
        act(() => wire('quote_idx', { Code: index.code, Exchange: 'TSE', Date: '2026/10/08', Time: '09:00:31.000001', Open: '1', High: '1', Low: '1', Close: '1', Reference: '100' }));
        await draw();
        expect(candleAt('2026-10-08T09:01:00')).toBeUndefined();
        setNow('2026-10-08T09:01:00');
        act(() => {
            for (const [time, close] of [['09:01:00.000001', 100], ['09:01:00.000002', 80], ['09:01:00.000003', 120], ['09:01:00.000004', 105]]) {
                wire('quote_idx', { Code: index.code, Exchange: 'TSE', Date: '2026/10/08', Time: time, Open: '100', High: '120', Low: '80', Close: String(close), Reference: '100' });
            }
        });
        await draw();
        expect(candleAt('2026-10-08T09:02:00')).toMatchObject({ open: 100, high: 120, low: 80, close: 105 });
        expect(volumeAt('2026-10-08T09:02:00')).toBe(0);
        expect(m.tail).not.toHaveBeenCalled();
    });
});
