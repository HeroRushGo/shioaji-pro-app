import { getApiBase } from './runtime';
import { subscribeQuote, unsubscribeQuote } from './shioaji';
import { getStreamStatus, isStreamOwner, onContractEvent, streamConnectionEpoch, subscribeStatusStore, subscribeStreamOwner } from './stream';
import type { ContractBase } from './types/contract';
import type { QuoteTypeName } from './types/market';

// The main WebView owns broker subscriptions. Popouts publish their desired
// sets, so closing one consumer cannot unsubscribe another panel's quote.
const mirror = typeof location !== 'undefined' && new URLSearchParams(location.search).has('popout');
const client = typeof crypto !== 'undefined' ? crypto.randomUUID() : String(Math.random());
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(`sj-quote-owners:${getApiBase()}`) : null;
// `odd`: 盤中零股 feed (intraday_odd) — a separate broker subscription with
// its own consumers; releasing the last odd-lot panel never touches the
// regular-lot feed of the same code and vice versa (#204).
type Desired = { contract: ContractBase; type: QuoteTypeName; odd?: boolean };
const local = new Map<string, { desired: Desired; refs: number }>();
const clients = new Map<string, Map<string, Desired>>();
const active = new Map<string, Desired>();
const canOwn = () => !mirror || isStreamOwner();
let disposed = false;
let ackSerial = 0;
let ackGeneration = 0;
const ackEpochs = new Map<string, number>();
const ackAttempts = new Map<string, { epoch: number; generation: number; serial: number; pending?: boolean; error?: unknown }>();
const confirming = new Map<string, Promise<number>>();
const readinessChecks = new Set<() => void>();
const readinessCancels = new Set<(error: Error) => void>();
const remoteReadiness = new Map<string, { receive: (message: Record<string, unknown>) => void }>();
export const QUOTE_READY_TIMEOUT_MS = 30_000;
// #386 pagehide 時退訂是一筆接一筆 await，實測頁面卸載後只送得出第一筆，重新整理
// 留下的訂閱會在 sidecar 累積。所以記下這個頁面訂閱過什麼（sessionStorage：重新
// 整理還在、分頁之間不共用），下一次載入等消費者都掛上後，只退掉記錄裡沒人要的。
// 不向 sidecar 查全部訂閱來對帳：Agent、外部程式與其他分頁的訂閱不是我們的。
export const ORPHAN_SWEEP_DELAY_MS = 5000;
const HELD_REPLY_MS = 300;
const LEDGER_KEY = `sj-quote-ledger:${getApiBase()}`;
type LedgerEntry = { contract: ContractBase; type: QuoteTypeName; odd?: boolean };
function readLedger(): Map<string, LedgerEntry> {
    try {
        const raw = JSON.parse(sessionStorage.getItem(LEDGER_KEY) ?? '[]') as [string, LedgerEntry][];
        return new Map(Array.isArray(raw) ? raw : []);
    } catch {
        return new Map();
    }
}
const ledger = mirror ? new Map<string, LedgerEntry>() : readLedger();
// 上一次載入留下、這次還沒處理的訂閱
const orphans = new Map(ledger);
function saveLedger() {
    if (mirror) return; // 彈出視窗不訂閱，接手 SSE 後也沒有下一次載入可以清
    try {
        sessionStorage.setItem(LEDGER_KEY, JSON.stringify([...ledger]));
    } catch {
        // 無法寫入時只是少了下次的清理
    }
}
function remember(key: string, { contract, type, odd }: Desired) {
    const { security_type, exchange, code, target_code, region, combo } = contract as ContractBase & { combo?: unknown };
    ledger.set(key, { contract: { security_type, exchange, code, target_code, region, ...(combo ? { combo } : {}) } as ContractBase, type, ...(odd ? { odd } : {}) });
    saveLedger();
}
function forget(key: string) {
    if (ledger.delete(key)) saveLedger();
}
let queue = Promise.resolve();
const keyOf = (d: Desired) => JSON.stringify([d.contract.security_type, d.contract.exchange, d.contract.target_code || d.contract.code, d.type, ...(d.odd ? ['odd'] : [])]);
const oddOpts = (d: Desired) => (d.odd ? [{ oddLot: true }] as const : [] as const);
async function subscribeOwned(key: string, desired: Desired): Promise<void> {
    const epoch = streamConnectionEpoch();
    const generation = ackGeneration;
    const serial = ++ackSerial;
    if (!disposed) ackAttempts.set(key, { epoch, generation, serial, pending: true });
    try {
        const response = await subscribeQuote(desired.contract, desired.type, ...oddOpts(desired));
        if (!response.success) throw new Error(response.message || '行情訂閱失敗');
        if (!disposed) ackAttempts.set(key, { epoch, generation, serial });
        if (!disposed && generation === ackGeneration && epoch >= 0 && getStreamStatus() === 'live' && streamConnectionEpoch() === epoch && canOwn()) ackEpochs.set(key, epoch);
    } catch (error) {
        ackEpochs.delete(key);
        if (!disposed) ackAttempts.set(key, { epoch, generation, serial, error });
        throw error;
    }
}
// A consumer that remounts (e.g. contract metadata refreshed after a
// reconnect) releases and re-retains asynchronously. Unsubscribing in that
// gap caused an unsubscribe+subscribe pair per quote on every reconnect, on
// top of the registry replay. Releases therefore wait briefly and only
// unsubscribe what is still unwanted.
export const RELEASE_GRACE_MS = 1500;
// #201: quotes the App's background engine watches. A page going away
// (reload, closed main window) never unsubscribes them: the engine keeps
// watching while no window is open.
const pinned = new Map<string, { desired: Desired; refs: number }>();
function desiredNow() {
    const desired = new Map<string, Desired>();
    for (const set of clients.values()) for (const [key, value] of set) desired.set(key, value);
    for (const [key, value] of pinned) desired.set(key, value.desired);
    // #102: protection triggers hold their Tick feed explicitly through
    // retainQuote() in the main-window trigger engine (no localStorage peek).
    return desired;
}
function sync(immediate = false) {
    if (!canOwn()) { channel?.postMessage({ kind: 'desired', client, desired: [...local.values()].map(v => v.desired) }); return; }
    clients.set(client, new Map([...local].map(([k, v]) => [k, v.desired])));
    queue = queue.catch(() => undefined).then(async () => {
        if (!canOwn()) return;
        const desired = desiredNow();
        for (const [key, value] of desired) if (!active.has(key)) {
            if (!canOwn()) return;
            // 先記再送：請求送出後頁面才卸載，訂閱也不會漏記
            remember(key, value);
            channel?.postMessage({ kind: 'held', keys: [key] }); // 別的分頁正準備清理時也要看得到
            try { await subscribeOwned(key, value); active.set(key, value); } catch { /* reconnect registry/manual re-acquire retries */ }
        }
        if (![...active.keys()].some(key => !desired.has(key))) return;
        if (!immediate) await new Promise(resolve => setTimeout(resolve, RELEASE_GRACE_MS));
        const still = immediate ? desired : desiredNow();
        for (const [key, value] of active) if (!still.has(key)) {
            if (!canOwn()) return;
            try { await unsubscribeQuote(value.contract, value.type, ...oddOpts(value)); active.delete(key); ackEpochs.delete(key); forget(key); } catch { /* preserve ownership for a later retry */ }
        }
    });
}
let sweepTimer: ReturnType<typeof setTimeout> | undefined;
// 其他分頁還在用的不能退：sidecar 的訂閱不分頁面，退了對方也斷。退之前先問一聲
const heldElsewhere = new Set<string>();
function sweepOrphans() {
    sweepTimer = undefined;
    queue = queue.catch(() => undefined).then(async () => {
        if (!canOwn()) return;
        for (const [key, entry] of orphans) {
            orphans.delete(key);
            // 每一筆都重看：退訂在等回應的時候，可能又有人要了這個商品
            if (desiredNow().has(key) || active.has(key)) continue;
            if (heldElsewhere.has(key)) { forget(key); continue; }
            try {
                await unsubscribeQuote(entry.contract, entry.type, ...oddOpts(entry));
                forget(key);
            } catch { /* 留在記錄裡，下一次載入再試 */ }
        }
    });
}
function scheduleOrphanSweep() {
    if (orphans.size === 0 || sweepTimer !== undefined || getStreamStatus() !== 'live') return;
    sweepTimer = setTimeout(() => {
        channel?.postMessage({ kind: 'held?' });
        sweepTimer = setTimeout(sweepOrphans, HELD_REPLY_MS);
    }, ORPHAN_SWEEP_DELAY_MS - HELD_REPLY_MS);
}
function readinessError(message: string): Error { return new Error(`行情訂閱尚未就緒：${message}`); }
function abortedReadiness(): Error { const error = readinessError('已取消'); error.name = 'AbortError'; return error; }
function readinessSerial(desired: Desired): number {
    const attempt = ackAttempts.get(keyOf(desired));
    return attempt?.pending ? attempt.serial - 1 : ackSerial;
}

function confirmOwned(desired: Desired, epoch: number, afterSerial: number): Promise<number> {
    const key = keyOf(desired);
    const generation = ackGeneration;
    const identity = JSON.stringify([key, epoch, generation]);
    const existing = confirming.get(identity);
    if (existing) return existing;
    const request = queue.catch(() => undefined).then(async () => {
        if (disposed || generation !== ackGeneration || !canOwn() || getStreamStatus() !== 'live' || streamConnectionEpoch() !== epoch) throw readinessError('串流世代已變更');
        if (!desiredNow().has(key)) throw abortedReadiness();
        if (ackEpochs.get(key) === epoch) return epoch;
        const attempt = ackAttempts.get(key);
        if (attempt?.epoch === epoch && attempt.generation === generation && attempt.serial > afterSerial && attempt.error !== undefined) throw attempt.error;
        remember(key, desired);
        channel?.postMessage({ kind: 'held', keys: [key] });
        await subscribeOwned(key, desired);
        if (disposed || !canOwn() || getStreamStatus() !== 'live' || streamConnectionEpoch() !== epoch || ackEpochs.get(key) !== epoch) throw readinessError('訂閱回應跨越串流世代');
        active.set(key, desired);
        return epoch;
    });
    queue = request.then(() => undefined, () => undefined);
    confirming.set(identity, request);
    const cleanup = () => { if (confirming.get(identity) === request) confirming.delete(identity); };
    void request.then(cleanup, cleanup);
    return request;
}

function waitUntilReady(desired: Desired, afterSerial: number, ownerOnly = false): { ready: Promise<void>; cancel: (error: Error) => void } {
    let settled = false;
    let started = false;
    let epoch = -1;
    let generation = -1;
    let owned = false;
    let nonce: string | undefined;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const ready = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    const timer = setTimeout(() => finish(readinessError('等待訂閱確認逾時')), QUOTE_READY_TIMEOUT_MS);
    const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        readinessChecks.delete(check);
        readinessCancels.delete(cancel);
        if (nonce) remoteReadiness.delete(nonce);
        if (error !== undefined) reject(error); else resolve();
    };
    const cancel = (error: Error) => finish(error);
    const check = () => {
        if (settled) return;
        if (disposed || (ownerOnly && !canOwn())) { finish(readinessError('訂閱擁有者已變更')); return; }
        if (started) {
            if (generation !== ackGeneration || getStreamStatus() !== 'live' || streamConnectionEpoch() !== epoch || canOwn() !== owned) finish(readinessError('串流世代已變更'));
            return;
        }
        if (getStreamStatus() !== 'live') return;
        epoch = streamConnectionEpoch();
        generation = ackGeneration;
        if (epoch < 0) return;
        owned = canOwn();
        started = true;
        if (owned) {
            void confirmOwned(desired, epoch, afterSerial).then(() => {
                if (generation === ackGeneration && getStreamStatus() === 'live' && streamConnectionEpoch() === epoch && canOwn()) finish();
                else finish(readinessError('串流世代已變更'));
            }, error => finish(error));
        } else {
            if (!channel) { finish(readinessError('無訂閱擁有者通道')); return; }
            nonce = typeof crypto !== 'undefined' ? crypto.randomUUID() : `${client}:${Math.random()}`;
            const key = keyOf(desired);
            remoteReadiness.set(nonce, { receive(message) {
                if (message.key !== key || message.epoch !== epoch) return;
                if (generation !== ackGeneration || getStreamStatus() !== 'live' || streamConnectionEpoch() !== epoch || canOwn()) { finish(readinessError('串流世代已變更')); return; }
                if (message.ok === true && Number.isSafeInteger(message.ownerEpoch) && Number(message.ownerEpoch) >= 0) finish();
                else finish(readinessError(typeof message.error === 'string' ? message.error : '擁有者拒絕確認'));
            } });
            // retainQuote already published this client's desired set. Channel
            // FIFO ordering makes that ownership visible before this request.
            channel.postMessage({ kind: 'quote-ready?', client, nonce, key, epoch });
        }
    };
    readinessChecks.add(check);
    readinessCancels.add(cancel);
    check();
    return { ready, cancel };
}

channel?.addEventListener('message', e => {
    if (e.data?.kind === 'quote-ready' && e.data.to === client && typeof e.data.nonce === 'string') {
        remoteReadiness.get(e.data.nonce)?.receive(e.data);
        return;
    }
    if (e.data?.kind === 'quote-ready?' && canOwn() && typeof e.data.client === 'string' && typeof e.data.nonce === 'string' && typeof e.data.key === 'string' && Number.isSafeInteger(e.data.epoch)) {
        const { client: to, nonce, key, epoch } = e.data;
        const desired = clients.get(to)?.get(key);
        if (!desired) { channel?.postMessage({ kind: 'quote-ready', to, nonce, key, epoch, ok: false, error: '請求端尚未持有此訂閱' }); return; }
        const pending = waitUntilReady(desired, readinessSerial(desired), true);
        void pending.ready.then(() => {
            if (!disposed) channel?.postMessage({ kind: 'quote-ready', to, nonce, key, epoch, ok: true, ownerEpoch: streamConnectionEpoch() });
        }, error => {
            if (!disposed) channel?.postMessage({ kind: 'quote-ready', to, nonce, key, epoch, ok: false, error: error instanceof Error ? error.message : String(error) });
        });
        return;
    }
    if (e.data?.kind === 'hello') { if (!canOwn()) sync(); return; }
    if (e.data?.kind === 'held?') {
        if (canOwn()) channel?.postMessage({ kind: 'held', keys: [...active.keys(), ...desiredNow().keys()] });
        return;
    }
    if (e.data?.kind === 'held') {
        if (Array.isArray(e.data.keys)) for (const key of e.data.keys) if (typeof key === 'string') heldElsewhere.add(key);
        return;
    }
    if (!canOwn() || e.data?.kind !== 'desired' || typeof e.data.client !== 'string' || !Array.isArray(e.data.desired)) return;
    const desired = (e.data.desired as Desired[]).filter(d => d?.contract?.code && ['Tick', 'BidAsk', 'Quote'].includes(d.type))
        .map((d): Desired => (d.odd === true ? { contract: d.contract, type: d.type, odd: true } : { contract: d.contract, type: d.type }));
    clients.set(e.data.client, new Map(desired.map(d => [keyOf(d), d])));
    sync();
});
if (!mirror) channel?.postMessage({ kind: 'hello' });
const stopStatus = subscribeStatusStore(() => {
    if (getStreamStatus() !== 'live') { ackEpochs.clear(); ackGeneration++; }
    if (getStreamStatus() === 'live') { sync(); scheduleOrphanSweep(); }
    for (const check of readinessChecks) check();
});
const stopOwner = subscribeStreamOwner(() => {
    ackEpochs.clear();
    ackGeneration++;
    if (!canOwn()) { active.clear(); clients.clear(); ackEpochs.clear(); }
    if (canOwn()) channel?.postMessage({ kind: 'hello' });
    sync();
    for (const check of readinessChecks) check();
});
const stopContract = onContractEvent(event => {
    if (event.action !== 'MAINTENANCE') return;
    ackEpochs.clear();
    ackGeneration++;
    for (const check of readinessChecks) check();
});
scheduleOrphanSweep();
export interface RetainOptions {
    /** 盤中零股行情（intraday_odd），與整股分開計數 */
    oddLot?: boolean;
}
export function retainQuote(contract: ContractBase, type: QuoteTypeName, options?: RetainOptions): () => void {
    const desired: Desired = options?.oddLot ? { contract, type, odd: true } : { contract, type };
    const key = keyOf(desired);
    const old = local.get(key);
    local.set(key, { desired, refs: (old?.refs ?? 0) + 1 });
    sync();
    let released = false;
    return () => {
        if (released) return;
        released = true;
        const current = local.get(key);
        if (current && current.refs > 1) current.refs--;
        else local.delete(key);
        sync();
    };
}
/** Retain shared ownership and await a broker ACK from the same LIVE epoch. */
export function retainQuoteWithReady(contract: ContractBase, type: QuoteTypeName, options?: RetainOptions & { signal?: AbortSignal }): { ready: Promise<void>; release: () => void } {
    const desired: Desired = options?.oddLot ? { contract, type, odd: true } : { contract, type };
    const afterSerial = readinessSerial(desired);
    const releaseHold = retainQuote(contract, type, options);
    const pending = waitUntilReady(desired, afterSerial);
    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        options?.signal?.removeEventListener('abort', release);
        pending.cancel(abortedReadiness());
        releaseHold();
    };
    if (options?.signal?.aborted) release();
    else options?.signal?.addEventListener('abort', release, { once: true });
    const cleanupSignal = () => options?.signal?.removeEventListener('abort', release);
    void pending.ready.then(cleanupSignal, cleanupSignal);
    return { ready: pending.ready, release };
}
/** Like retainQuote, but kept when this page goes away (main window only;
 * for the background engine's watched contracts). */
export function pinQuote(contract: ContractBase, type: QuoteTypeName, options?: { oddLot?: boolean }): () => void {
    // 盤中零股 (#226 背景零股條件): a separate subscription, stocks only
    const desired: Desired = options?.oddLot && contract.security_type === 'STK' ? { contract, type, odd: true } : { contract, type };
    const key = keyOf(desired);
    pinned.set(key, { desired, refs: (pinned.get(key)?.refs ?? 0) + 1 });
    sync();
    let released = false;
    return () => {
        if (released) return;
        released = true;
        const current = pinned.get(key);
        if (current && current.refs > 1) current.refs--;
        else pinned.delete(key);
        sync();
    };
}
export function retainContractQuotes(contract: ContractBase, options?: RetainOptions): () => void {
    // 零股只有股票（Tick／BidAsk）；其他商品沒有零股行情
    if (options?.oddLot && contract.security_type !== 'STK') return () => undefined;
    const releases = (contract.security_type === 'IND' ? ['Quote'] as const : ['Tick', 'BidAsk'] as const).map(t => retainQuote(contract, t, options));
    return () => releases.forEach(release => release());
}
function dispose() {
    disposed = true;
    ackGeneration++;
    for (const cancel of readinessCancels) cancel(abortedReadiness());
    remoteReadiness.clear();
    ackEpochs.clear();
    ackAttempts.clear();
    confirming.clear();
    stopStatus();
    stopOwner();
    stopContract();
    clearTimeout(sweepTimer);
    // 釘住的留給背景引擎，不算孤兒
    for (const key of pinned.keys()) ledger.delete(key);
    saveLedger();
    local.clear();
    sync(true);
    channel?.close();
}
if (typeof window !== 'undefined') window.addEventListener('pagehide', dispose, { once: true });
import.meta.hot?.dispose(dispose);
