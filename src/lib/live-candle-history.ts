import { canonicalCandleTime, type LiveCandlePrint } from './live-candles';
import { fetchLastTicks } from './shioaji';
import type { ContractBase } from './types/contract';
import { nowWallClockUtc } from './utils/kbars';

const INITIAL_COUNT = 512;
const MAX_COUNT = 65_536;
const NORMALIZE_CHUNK = 1024;
const DAY_SECONDS = 86_400;
const inFlight = new Map<string, Promise<LiveCandlePrint[]>>();

interface NormalizedTail {
    prints: LiveCandlePrint[];
    rawCount: number;
    oldest: number | null;
    newest: number | null;
}

function dateAt(wallSeconds: number): string {
    return new Date(wallSeconds * 1000).toISOString().slice(0, 10);
}

function dateCandidates(contract: ContractBase): string[] {
    const now = nowWallClockUtc();
    const dayStart = Math.floor(now / DAY_SECONDS) * DAY_SECONDS;
    const today = dateAt(dayStart);
    if (contract.security_type !== 'FUT' && contract.security_type !== 'OPT') return [today];
    const tomorrow = dayStart + DAY_SECONDS;
    let nextWeekday = tomorrow;
    while ([0, 6].includes(new Date(nextWeekday * 1000).getUTCDay())) nextWeekday += DAY_SECONDS;
    const order = now - dayStart >= 15 * 3600
        ? [dateAt(nextWeekday), dateAt(tomorrow), today]
        : [today, dateAt(nextWeekday), dateAt(tomorrow)];
    return order.filter((date, index) => order.indexOf(date) === index);
}

function numeric(value: unknown, label: string): number {
    if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && value.trim() === '')) {
        throw new Error(`Invalid live candle tick ${label}`);
    }
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`Invalid live candle tick ${label}`);
    return number;
}

async function yieldToBrowser(): Promise<void> {
    const scheduler = (globalThis as typeof globalThis & { scheduler?: { yield?: () => Promise<void> } }).scheduler;
    if (typeof scheduler?.yield === 'function') await scheduler.yield();
    else await new Promise<void>(resolve => setTimeout(resolve, 0));
}

async function normalize(response: unknown, requested: number, from: number): Promise<NormalizedTail> {
    if (response === null || typeof response !== 'object' || Array.isArray(response)) throw new Error('Invalid live candle tick response');
    const columns = response as Record<string, unknown>;
    const required = ['datetime', 'close', 'volume', 'tick_type'] as const;
    for (const name of required) {
        if (!Array.isArray(columns[name])) throw new Error(`Invalid live candle tick ${name} array`);
    }
    const datetimes = columns.datetime as unknown[];
    const count = datetimes.length;
    if (count > requested || count > MAX_COUNT) throw new Error('Live candle tick response exceeds the requested bound');
    for (const name of [...required, 'bid_price', 'bid_volume', 'ask_price', 'ask_volume']) {
        const column = columns[name];
        if (column !== undefined && (!Array.isArray(column) || column.length !== count)) throw new Error(`Invalid live candle tick ${name} length`);
    }
    const closes = columns.close as unknown[];
    const volumes = columns.volume as unknown[];
    const types = columns.tick_type as unknown[];
    let oldest: number | null = null;
    let newest: number | null = null;
    const prints: LiveCandlePrint[] = [];
    for (let index = 0; index < count; index++) {
        if (index > 0 && index % NORMALIZE_CHUNK === 0) await yieldToBrowser();
        const rawDatetime = datetimes[index];
        const datetime = typeof rawDatetime === 'string' ? canonicalCandleTime(rawDatetime) : null;
        if (!datetime) throw new Error('Invalid live candle tick datetime');
        // Only the whole-second boundary determines inclusion; retain the full
        // canonical fraction for ordering and REST/live identity reconciliation.
        const time = Date.parse(`${datetime.slice(0, 19)}Z`) / 1000;
        oldest = oldest === null ? time : Math.min(oldest, time);
        newest = newest === null ? time : Math.max(newest, time);
        const close = numeric(closes[index], 'close');
        const volume = numeric(volumes[index], 'volume');
        const tickType = numeric(types[index], 'tick_type');
        if (close < 0 || volume < 0 || !Number.isInteger(tickType) || tickType < 0) throw new Error('Invalid live candle tick values');
        if (volume === 0) continue; // zero-volume status prints are not fills
        if (close === 0) throw new Error('Invalid live candle tick price');
        if (time >= from) prints.push({ datetime, close, volume, tickType });
    }
    prints.sort((a, b) => a.datetime < b.datetime ? -1 : a.datetime > b.datetime ? 1 : 0);
    return { prints, rawCount: count, oldest, newest };
}

async function loadTail(contract: ContractBase, from: number): Promise<LiveCandlePrint[]> {
    let hadValidResponse = false;
    let lastError: unknown;
    let incompleteError: unknown;
    for (const date of dateCandidates(contract)) {
        let sawRelevantRows = false;
        for (let count = INITIAL_COUNT; count <= MAX_COUNT; count *= 2) {
            let response: unknown;
            try {
                response = await fetchLastTicks(contract, count, date);
            } catch (error) {
                lastError = error;
                if (sawRelevantRows) incompleteError = error;
                break;
            }
            // A malformed payload must fail loudly, even if another date could
            // return an empty success and hide the invalid market-data response.
            const tail = await normalize(response, count, from);
            hadValidResponse = true;
            if (tail.newest === null || tail.newest < from) {
                if (sawRelevantRows) incompleteError = new Error('Live candle tick coverage changed during bootstrap');
                break;
            }
            sawRelevantRows = true;
            if (tail.oldest! < from) return tail.prints;
            // A server may silently cap LastCount below the requested count.
            // A short response alone cannot certify the missing candle prefix.
            if (tail.rawCount < count) throw new Error('Live candle tick coverage has no strictly older cutoff witness');
            if (count === MAX_COUNT) throw new Error('Live candle tick coverage exceeds the bounded LastCount limit');
        }
    }
    if (incompleteError) throw incompleteError;
    if (hadValidResponse) return [];
    throw lastError ?? new Error('Live candle tick tail is unavailable');
}

/**
 * Fetch only the uncovered candle tail, certified by a row before its cutoff.
 * Requests share work while in flight, then discard both successful and failed
 * promises so reconnects stay fresh. A nonempty first-session-minute response
 * without an earlier row remains uncertified even if it appears exhaustive.
 */
export function loadLiveCandleTail(
    contract: ContractBase,
    fromWallSeconds: number,
    revision?: number | string,
): Promise<LiveCandlePrint[]> {
    if (!Number.isSafeInteger(fromWallSeconds)) return Promise.reject(new Error('Live candle tail cutoff must be whole wall-clock seconds'));
    const key = JSON.stringify([
        contract.region ?? 'TW', contract.exchange, contract.security_type,
        contract.code, contract.target_code ?? null, fromWallSeconds, revision ?? null,
    ]);
    const existing = inFlight.get(key);
    if (existing) return existing;
    const request = loadTail(contract, fromWallSeconds).finally(() => {
        if (inFlight.get(key) === request) inFlight.delete(key);
    });
    inFlight.set(key, request);
    return request;
}
