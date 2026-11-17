import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ subscribe: vi.fn(), unsubscribe: vi.fn(), status: 'live', epoch: 1, changed: undefined as (() => void) | undefined, owner: false, ownerChanged: undefined as (() => void) | undefined, contractChanged: undefined as ((event: { action: string }) => void) | undefined }));
vi.mock('./runtime', () => ({ getApiBase: () => 'test-api' }));
vi.mock('./shioaji', () => ({ subscribeQuote: mocks.subscribe, unsubscribeQuote: mocks.unsubscribe }));
vi.mock('./stream', () => ({ getStreamStatus: () => mocks.status, streamConnectionEpoch: () => mocks.status === 'live' ? mocks.epoch : -1, subscribeStatusStore: (fn: () => void) => { mocks.changed = fn; return () => {}; }, isStreamOwner: () => mocks.owner, subscribeStreamOwner: (fn: () => void) => { mocks.ownerChanged = fn; return () => {}; }, onContractEvent: (fn: (event: { action: string }) => void) => { mocks.contractChanged = fn; return () => {}; } }));
const contract = { code: '2330', security_type: 'STK' as const, exchange: 'TSE' as const, target_code: null };

describe('quote ownership shared consumers', () => {
    beforeEach(() => {
        vi.resetModules(); vi.clearAllMocks(); vi.stubGlobal('BroadcastChannel', undefined);
        mocks.status = 'live'; mocks.epoch = 1; mocks.changed = undefined; mocks.owner = false; mocks.ownerChanged = undefined; mocks.contractChanged = undefined;
        mocks.subscribe.mockResolvedValue({ success: true }); mocks.unsubscribe.mockResolvedValue({ success: true });
    });
    afterEach(() => vi.unstubAllGlobals());
    it('shares alias and physical-contract ownership in one broker subscription', async () => {
        const { retainQuote } = await import('./quote-ownership');
        const physical = { ...contract, code: 'TXFI6', security_type: 'FUT' as const, exchange: 'TAIFEX' as const };
        const alias = { ...physical, code: 'TXFR1', target_code: 'TXFI6' };
        const a = retainQuote(alias, 'Tick');
        const b = retainQuote(physical, 'Tick');
        await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(1));
        a(); await Promise.resolve(); await Promise.resolve();
        expect(mocks.unsubscribe).not.toHaveBeenCalled();
        b(); await vi.waitFor(() => expect(mocks.unsubscribe).toHaveBeenCalledTimes(1), { timeout: 4000 });
    });
    it('keeps a protection trigger Tick held by the main-window engine when the last panel closes (#102)', async () => {
        const { retainQuote } = await import('./quote-ownership');
        const engineHold = retainQuote(contract, 'Tick'); // trigger-engine syncQuotes()
        const tick = retainQuote(contract, 'Tick'); const book = retainQuote(contract, 'BidAsk');
        await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(2));
        tick(); book();
        await vi.waitFor(() => expect(mocks.unsubscribe).toHaveBeenCalledTimes(1), { timeout: 4000 });
        expect(mocks.unsubscribe).toHaveBeenCalledWith(contract, 'BidAsk');
        engineHold();
        await vi.waitFor(() => expect(mocks.unsubscribe).toHaveBeenCalledTimes(2), { timeout: 4000 });
        expect(mocks.unsubscribe).toHaveBeenLastCalledWith(contract, 'Tick');
    });
    it('a quote pinned for the background engine survives the page going away (#201)', async () => {
        const handlers: Record<string, () => void> = {};
        vi.stubGlobal('window', { addEventListener: (name: string, fn: () => void) => { handlers[name] = fn; } });
        const { pinQuote, retainQuote } = await import('./quote-ownership');
        pinQuote(contract, 'Tick');
        retainQuote(contract, 'BidAsk');
        await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(2));
        handlers.pagehide!();
        await vi.waitFor(() => expect(mocks.unsubscribe).toHaveBeenCalledTimes(1));
        expect(mocks.unsubscribe).toHaveBeenCalledWith(contract, 'BidAsk');
        await new Promise(r => setTimeout(r, 50));
        expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
    });
    it('subscribes once and releases only when the last local consumer leaves', async () => {
        const { retainQuote } = await import('./quote-ownership');
        const first = retainQuote(contract, 'Tick');
        const second = retainQuote(contract, 'Tick');
        await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(1));
        first();
        await Promise.resolve(); await Promise.resolve();
        expect(mocks.unsubscribe).not.toHaveBeenCalled();
        second();
        await vi.waitFor(() => expect(mocks.unsubscribe).toHaveBeenCalledTimes(1), { timeout: 4000 });
        second();
        expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
    });
    it('retries an initially failed subscription when the stream becomes live', async () => {
        mocks.subscribe.mockRejectedValueOnce(new Error('temporary unavailable'));
        const { retainQuote } = await import('./quote-ownership');
        const release = retainQuote(contract, 'Tick');
        await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(1));
        mocks.changed?.();
        await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(2));
        release();
        await vi.waitFor(() => expect(mocks.unsubscribe).toHaveBeenCalledTimes(1), { timeout: 4000 });
    });
    it('does not churn unsubscribe+subscribe when a consumer re-retains within the grace (reconnect remount)', async () => {
        vi.useFakeTimers();
        try {
            const { retainQuote, RELEASE_GRACE_MS } = await import('./quote-ownership');
            const first = retainQuote(contract, 'Tick');
            await vi.advanceTimersByTimeAsync(0);
            expect(mocks.subscribe).toHaveBeenCalledTimes(1);
            first(); // remount: release now, re-retain after an async lookup
            await vi.advanceTimersByTimeAsync(RELEASE_GRACE_MS / 3);
            const again = retainQuote(contract, 'Tick');
            await vi.advanceTimersByTimeAsync(RELEASE_GRACE_MS * 2);
            expect(mocks.unsubscribe).not.toHaveBeenCalled();
            expect(mocks.subscribe).toHaveBeenCalledTimes(1);
            again();
            await vi.advanceTimersByTimeAsync(RELEASE_GRACE_MS + 10);
            expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
        } finally { vi.useRealTimers(); }
    });
    it('lets a popout subscribe its quotes after it becomes the SSE owner', async () => {
        vi.stubGlobal('location', { search: '?popout=chart' });
        const { retainQuote } = await import('./quote-ownership');
        const release = retainQuote(contract, 'Tick');
        await Promise.resolve();
        expect(mocks.subscribe).not.toHaveBeenCalled();
        mocks.owner = true;
        mocks.ownerChanged?.();
        await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledWith(contract, 'Tick'));
        release();
    });
    it('counts 盤中零股 consumers apart from regular-lot ones of the same code (#204)', async () => {
        vi.useFakeTimers();
        try {
            const { retainQuote, retainContractQuotes, RELEASE_GRACE_MS } = await import('./quote-ownership');
            const round = retainQuote(contract, 'Tick');
            const oddA = retainQuote(contract, 'Tick', { oddLot: true });
            const oddB = retainQuote(contract, 'Tick', { oddLot: true });
            await vi.advanceTimersByTimeAsync(0);
            expect(mocks.subscribe.mock.calls).toEqual([[contract, 'Tick'], [contract, 'Tick', { oddLot: true }]]);
            oddA();
            await vi.advanceTimersByTimeAsync(RELEASE_GRACE_MS + 10);
            expect(mocks.unsubscribe).not.toHaveBeenCalled(); // oddB still holds the odd feed
            oddB();
            await vi.advanceTimersByTimeAsync(RELEASE_GRACE_MS + 10);
            // only the odd-lot feed goes; the round-lot panel keeps its feed
            expect(mocks.unsubscribe.mock.calls).toEqual([[contract, 'Tick', { oddLot: true }]]);
            round();
            await vi.advanceTimersByTimeAsync(RELEASE_GRACE_MS + 10);
            expect(mocks.unsubscribe.mock.calls.at(-1)).toEqual([contract, 'Tick']);
            // futures have no odd-lot feed
            retainContractQuotes({ ...contract, code: 'TXFJ6', security_type: 'FUT' as const, exchange: 'TAIFEX' as const }, { oddLot: true })();
            await vi.advanceTimersByTimeAsync(0);
            expect(mocks.subscribe).toHaveBeenCalledTimes(2);
        } finally { vi.useRealTimers(); }
    });
    describe('broker subscription readiness', () => {
        let pagehide: (() => void)[];
        const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
        const deferred = () => {
            let resolve!: (value: { success: boolean }) => void;
            const promise = new Promise<{ success: boolean }>(res => { resolve = res; });
            return { promise, resolve };
        };
        beforeEach(() => {
            vi.useFakeTimers();
            pagehide = [];
            vi.stubGlobal('window', { addEventListener: (name: string, fn: () => void) => { if (name === 'pagehide') pagehide.push(fn); } });
        });
        afterEach(async () => {
            for (const dispose of pagehide) dispose();
            await vi.advanceTimersByTimeAsync(32_000);
            vi.clearAllTimers();
            vi.useRealTimers();
        });

        it('does not resolve before the delayed broker ACK already in the ownership queue', async () => {
            const pending = deferred();
            mocks.subscribe.mockReturnValueOnce(pending.promise);
            const { retainQuoteWithReady } = await import('./quote-ownership');
            const held = retainQuoteWithReady(contract, 'Tick');
            let settled = false;
            void held.ready.then(() => { settled = true; });
            await flush();
            expect(mocks.subscribe).toHaveBeenCalledOnce();
            expect(settled).toBe(false);
            pending.resolve({ success: true });
            await held.ready;
            expect(mocks.subscribe).toHaveBeenCalledOnce();
            held.release();
        });

        it('rejects a failed broker ACK instead of declaring readiness or silently retrying', async () => {
            mocks.subscribe.mockRejectedValueOnce(new Error('broker rejected'));
            const { retainQuoteWithReady } = await import('./quote-ownership');
            const held = retainQuoteWithReady(contract, 'Tick');
            await expect(held.ready).rejects.toThrow('broker rejected');
            expect(mocks.subscribe).toHaveBeenCalledOnce();
            held.release();
        });

        it('shares a successful same-epoch ACK among concurrent and later holders', async () => {
            const { retainQuoteWithReady } = await import('./quote-ownership');
            const first = retainQuoteWithReady(contract, 'Tick');
            const second = retainQuoteWithReady(contract, 'Tick');
            await Promise.all([first.ready, second.ready]);
            const third = retainQuoteWithReady(contract, 'Tick');
            await third.ready;
            expect(mocks.subscribe).toHaveBeenCalledOnce();
            first.release(); second.release(); third.release();
        });

        it('waits for LIVE and confirms again when an earlier ACK happened while connecting', async () => {
            mocks.status = 'connecting';
            const { retainQuoteWithReady } = await import('./quote-ownership');
            const held = retainQuoteWithReady(contract, 'Tick');
            let settled = false;
            void held.ready.then(() => { settled = true; });
            await flush();
            expect(settled).toBe(false);
            expect(mocks.subscribe).toHaveBeenCalledOnce(); // old retain behavior is preserved
            mocks.status = 'live'; mocks.changed?.();
            await held.ready;
            expect(mocks.subscribe).toHaveBeenCalledTimes(2);
            held.release();
        });

        it('requires a fresh ACK after reconnect despite the existing active refcount', async () => {
            const { retainQuoteWithReady } = await import('./quote-ownership');
            const first = retainQuoteWithReady(contract, 'Tick');
            await first.ready;
            mocks.status = 'connecting'; mocks.changed?.();
            mocks.epoch = 2; mocks.status = 'live'; mocks.changed?.();
            const pending = deferred();
            mocks.subscribe.mockReturnValueOnce(pending.promise);
            const next = retainQuoteWithReady(contract, 'Tick');
            let settled = false;
            void next.ready.then(() => { settled = true; });
            await flush();
            expect(mocks.subscribe).toHaveBeenCalledTimes(2);
            expect(settled).toBe(false);
            pending.resolve({ success: true });
            await next.ready;
            first.release(); next.release();
        });

        it('invalidates a same-epoch ACK on maintenance without changing old holder behavior', async () => {
            const { retainQuoteWithReady } = await import('./quote-ownership');
            const first = retainQuoteWithReady(contract, 'Tick');
            await first.ready;
            mocks.contractChanged?.({ action: 'MAINTENANCE' });
            await flush();
            expect(mocks.subscribe).toHaveBeenCalledOnce();
            const next = retainQuoteWithReady(contract, 'Tick');
            await next.ready;
            expect(mocks.subscribe).toHaveBeenCalledTimes(2);
            first.release(); next.release();
        });

        it('does not reuse a pre-maintenance pending ACK for a new readiness generation', async () => {
            let reject!: (error: Error) => void;
            mocks.subscribe.mockReturnValueOnce(new Promise((_resolve, rej) => { reject = rej; }));
            const { retainQuoteWithReady } = await import('./quote-ownership');
            const first = retainQuoteWithReady(contract, 'Tick');
            const invalidated = expect(first.ready).rejects.toThrow(/世代/);
            await flush();
            mocks.contractChanged?.({ action: 'MAINTENANCE' });
            await invalidated;
            const next = retainQuoteWithReady(contract, 'Tick');
            reject(new Error('old generation failed'));
            await next.ready;
            expect(mocks.subscribe).toHaveBeenCalledTimes(2);
            first.release(); next.release();
        });

        it.each(['abort', 'release'])('%s cancels only that waiter and preserves another holder', async action => {
            const pending = deferred();
            mocks.subscribe.mockReturnValueOnce(pending.promise);
            const { retainQuote, retainQuoteWithReady, RELEASE_GRACE_MS } = await import('./quote-ownership');
            const other = retainQuote(contract, 'Tick');
            const controller = new AbortController();
            const held = retainQuoteWithReady(contract, 'Tick', { signal: controller.signal });
            const cancelled = expect(held.ready).rejects.toMatchObject({ name: 'AbortError' });
            if (action === 'abort') controller.abort(); else held.release();
            await cancelled;
            pending.resolve({ success: true });
            await flush();
            await vi.advanceTimersByTimeAsync(RELEASE_GRACE_MS + 1);
            expect(mocks.unsubscribe).not.toHaveBeenCalled();
            other();
            await vi.advanceTimersByTimeAsync(RELEASE_GRACE_MS + 1);
            expect(mocks.unsubscribe).toHaveBeenCalledOnce();
        });

        it('rejects a pending ACK that crosses a stream epoch', async () => {
            const pending = deferred();
            mocks.subscribe.mockReturnValueOnce(pending.promise);
            const { retainQuoteWithReady } = await import('./quote-ownership');
            const held = retainQuoteWithReady(contract, 'Tick');
            const rejected = expect(held.ready).rejects.toThrow(/世代/);
            await flush();
            mocks.status = 'connecting'; mocks.changed?.();
            await rejected;
            mocks.epoch = 2; mocks.status = 'live'; mocks.changed?.();
            pending.resolve({ success: true });
            await flush();
            held.release();
        });

        it('requests a targeted follower ACK through the owner and never subscribes locally', async () => {
            const channels: { listeners: ((event: { data: unknown }) => void)[] }[] = [];
            const sent: { kind: string; to?: string; nonce?: string }[] = [];
            vi.stubGlobal('BroadcastChannel', class {
                listeners: ((event: { data: unknown }) => void)[] = [];
                constructor() { channels.push(this); }
                addEventListener(_name: string, listener: (event: { data: unknown }) => void) { this.listeners.push(listener); }
                postMessage(data: { kind: string }) {
                    sent.push(data);
                    for (const channel of channels) if (channel !== this) for (const listener of channel.listeners) void Promise.resolve().then(() => listener({ data }));
                }
                close() { channels.splice(channels.indexOf(this), 1); }
            });
            await import('./quote-ownership'); // main owner, before creating the mirror
            vi.resetModules();
            vi.stubGlobal('location', { search: '?popout=chart' });
            const { retainQuoteWithReady } = await import('./quote-ownership');
            const pending = deferred();
            mocks.subscribe.mockReturnValueOnce(pending.promise);
            const held = retainQuoteWithReady(contract, 'Tick');
            let settled = false;
            void held.ready.then(() => { settled = true; });
            await flush();
            expect(mocks.subscribe).toHaveBeenCalledOnce(); // main owner only
            expect(settled).toBe(false);
            expect(sent.findIndex(message => message.kind === 'desired')).toBeLessThan(sent.findIndex(message => message.kind === 'quote-ready?'));
            pending.resolve({ success: true });
            await held.ready;
            expect(sent).toContainEqual(expect.objectContaining({ kind: 'quote-ready', ok: true, to: expect.any(String), nonce: expect.any(String) }));
            expect(mocks.subscribe).toHaveBeenCalledOnce();
            held.release();
        });

        it('bounds a missing follower owner ACK and removes its nonce/listener after release', async () => {
            let listener!: (event: { data: unknown }) => void;
            const sent: Record<string, unknown>[] = [];
            vi.stubGlobal('BroadcastChannel', class {
                addEventListener(_name: string, fn: (event: { data: unknown }) => void) { listener = fn; }
                postMessage(data: Record<string, unknown>) { sent.push(data); }
                close() {}
            });
            vi.stubGlobal('location', { search: '?popout=chart' });
            const { retainQuoteWithReady, QUOTE_READY_TIMEOUT_MS } = await import('./quote-ownership');
            const held = retainQuoteWithReady(contract, 'Tick');
            const rejected = expect(held.ready).rejects.toThrow(/逾時/);
            const request = sent.find(message => message.kind === 'quote-ready?')!;
            listener({ data: { ...request, kind: 'quote-ready', to: request.client, nonce: 'wrong nonce', ok: true, ownerEpoch: 1 } });
            await vi.advanceTimersByTimeAsync(QUOTE_READY_TIMEOUT_MS);
            await rejected;
            expect(mocks.subscribe).not.toHaveBeenCalled();
            held.release();
            listener({ data: { ...request, kind: 'quote-ready', to: request.client, ok: true, ownerEpoch: 1 } });
            await flush();
            expect(mocks.subscribe).not.toHaveBeenCalled();
        });

        it('disposes pending readiness listeners and timeouts', async () => {
            const pending = deferred();
            mocks.subscribe.mockReturnValueOnce(pending.promise);
            const { retainQuoteWithReady } = await import('./quote-ownership');
            const held = retainQuoteWithReady(contract, 'Tick');
            const rejected = expect(held.ready).rejects.toMatchObject({ name: 'AbortError' });
            await flush();
            pagehide[0]!();
            await rejected;
            pending.resolve({ success: true });
            await flush();
        });
    });
    describe('subscriptions left behind by a reload (#386)', () => {
        let session: Map<string, string>;
        const other = { ...contract, code: '2317' };
        const reload = async () => { vi.resetModules(); return import('./quote-ownership'); };
        beforeEach(() => {
            session = new Map();
            vi.stubGlobal('sessionStorage', { getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => { session.set(k, v); } });
            vi.useFakeTimers();
        });
        afterEach(() => { vi.useRealTimers(); });
        const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
        const subscribeOne = async (c: typeof contract) => {
            const mod = await import('./quote-ownership');
            mod.retainQuote(c, 'Tick');
            await flush();
            return mod;
        };
        it('after a reload, unsubscribes what the old page held and nobody wants now', async () => {
            await subscribeOne(contract);
            expect(mocks.unsubscribe).not.toHaveBeenCalled(); // the page unloaded before it could release
            const next = await reload();
            await vi.advanceTimersByTimeAsync(next.ORPHAN_SWEEP_DELAY_MS - 1);
            expect(mocks.unsubscribe).not.toHaveBeenCalled(); // consumers still mounting
            await vi.advanceTimersByTimeAsync(1);
            expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
            expect(mocks.unsubscribe.mock.calls[0]!.slice(0, 2)).toEqual([expect.objectContaining({ code: '2330' }), 'Tick']);
            await reload();
            await vi.advanceTimersByTimeAsync(10_000);
            expect(mocks.unsubscribe).toHaveBeenCalledTimes(1); // cleared from the ledger, no repeat
        });
        it('keeps what the new page wants again', async () => {
            await subscribeOne(contract);
            const next = await reload();
            next.retainQuote(contract, 'Tick');
            await vi.advanceTimersByTimeAsync(next.ORPHAN_SWEEP_DELAY_MS + 1);
            expect(mocks.unsubscribe).not.toHaveBeenCalled();
        });
        it('never touches a subscription this page did not make', async () => {
            await subscribeOne(contract);
            session.clear(); // a different tab or a fresh start has its own ledger
            const next = await reload();
            next.retainQuote(other, 'Tick');
            await vi.advanceTimersByTimeAsync(next.ORPHAN_SWEEP_DELAY_MS + 1);
            expect(mocks.unsubscribe).not.toHaveBeenCalled();
        });
        it('leaves a quote pinned for the background engine', async () => {
            const handlers: Record<string, () => void> = {};
            vi.stubGlobal('window', { addEventListener: (name: string, fn: () => void) => { handlers[name] = fn; } });
            const { pinQuote } = await import('./quote-ownership');
            pinQuote(contract, 'Tick');
            await flush();
            handlers.pagehide!();
            await flush();
            const next = await reload();
            await vi.advanceTimersByTimeAsync(next.ORPHAN_SWEEP_DELAY_MS + 1);
            expect(mocks.unsubscribe).not.toHaveBeenCalled();
        });
        it('waits for the stream, and retries on a later load if the unsubscribe fails', async () => {
            await subscribeOne(contract);
            mocks.status = 'connecting';
            mocks.unsubscribe.mockRejectedValueOnce(new Error('down'));
            let next = await reload();
            await vi.advanceTimersByTimeAsync(next.ORPHAN_SWEEP_DELAY_MS + 1);
            expect(mocks.unsubscribe).not.toHaveBeenCalled();
            mocks.status = 'live'; mocks.changed!();
            await vi.advanceTimersByTimeAsync(next.ORPHAN_SWEEP_DELAY_MS + 1);
            expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
            next = await reload();
            await vi.advanceTimersByTimeAsync(next.ORPHAN_SWEEP_DELAY_MS + 1);
            expect(mocks.unsubscribe).toHaveBeenCalledTimes(2);
        });
        it('keeps a quote another page still holds, and stops tracking it', async () => {
            await subscribeOne(contract);
            const key = (JSON.parse([...session.values()][0]!) as [string][])[0]![0];
            const sent: unknown[] = [];
            let listener: ((e: { data: unknown }) => void) | undefined;
            vi.stubGlobal('BroadcastChannel', class {
                addEventListener(_: string, fn: (e: { data: unknown }) => void) { listener = fn; }
                postMessage(data: { kind: string }) { sent.push(data); if (data.kind === 'held?') queueMicrotask(() => listener!({ data: { kind: 'held', keys: [key] } })); }
                close() {}
            });
            const next = await reload();
            await vi.advanceTimersByTimeAsync(next.ORPHAN_SWEEP_DELAY_MS + 1);
            expect(sent).toContainEqual({ kind: 'held?' });
            expect(mocks.unsubscribe).not.toHaveBeenCalled();
            expect(JSON.parse([...session.values()][0]!)).toEqual([]);
        });
        it('answers another page that is about to sweep', async () => {
            const sent: { kind: string; keys?: string[] }[] = [];
            let listener: ((e: { data: unknown }) => void) | undefined;
            vi.stubGlobal('BroadcastChannel', class {
                addEventListener(_: string, fn: (e: { data: unknown }) => void) { listener = fn; }
                postMessage(data: { kind: string }) { sent.push(data); }
                close() {}
            });
            await subscribeOne(contract);
            listener!({ data: { kind: 'held?' } });
            expect(sent.find(m => m.kind === 'held')!.keys!.length).toBeGreaterThan(0);
        });
        it('announces a new subscription, so a sweep in progress elsewhere leaves it alone', async () => {
            const sent: { kind: string; keys?: string[] }[] = [];
            vi.stubGlobal('BroadcastChannel', class {
                addEventListener() {}
                postMessage(data: { kind: string }) { sent.push(data); }
                close() {}
            });
            await subscribeOne(contract);
            expect(sent.filter(m => m.kind === 'held').map(m => m.keys)).toHaveLength(1);
        });
        it('does not unsubscribe a quote wanted while the sweep is waiting on an earlier one', async () => {
            await subscribeOne(contract);
            await subscribeOne(other);
            let finish!: (v: unknown) => void;
            mocks.unsubscribe.mockImplementationOnce(() => new Promise(r => { finish = r; }));
            const next = await reload();
            await vi.advanceTimersByTimeAsync(next.ORPHAN_SWEEP_DELAY_MS + 1);
            expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
            next.pinQuote(other, 'Tick');
            finish({ success: true });
            await flush();
            expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
        });
        it('a popout leaves the ledger alone', async () => {
            await subscribeOne(contract);
            vi.stubGlobal('location', { search: '?popout=1' });
            mocks.owner = true;
            const next = await reload();
            await vi.advanceTimersByTimeAsync(next.ORPHAN_SWEEP_DELAY_MS + 1);
            expect(mocks.unsubscribe).not.toHaveBeenCalled();
        });
    });
});
