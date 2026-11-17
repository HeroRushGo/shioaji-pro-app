import type { Candle } from './types/market';

export interface LiveCandlePrint {
    datetime: string;
    close: number;
    volume: number;
    tickType?: number;
    simtrade?: boolean;
}

interface NormalizedPrint extends LiveCandlePrint {
    datetime: string;
    wallSeconds: number;
}

interface Bucket {
    bar: Candle;
    // Historical OHLCV precedes the seed cutoff, so its open must stay intact.
    historical: boolean;
    firstPrint: string | null;
    lastPrint: string | null;
}

const MAX_PENDING_PRINTS = 50_000;
const MAX_REST_PRINTS = 65_536;
const DAY_SECONDS = 86_400;

/** Taiwan wall-clock ISO, retaining sub-millisecond event identity. */
export function canonicalCandleTime(datetime: string): string | null {
    if (typeof datetime !== 'string') return null;
    const match = /^(\d{4})[-/](\d{2})[-/](\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:\+08:00)?$/.exec(datetime);
    if (!match) return null;
    const [, year, month, day, hour, minute, second, fraction = ''] = match;
    const parts = [year, month, day, hour, minute, second].map(Number);
    const [y, mo, d, h, mi, s] = parts as [number, number, number, number, number, number];
    if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
    // setUTCFullYear avoids Date.UTC's special treatment of years 00–99.
    const date = new Date(0);
    date.setUTCFullYear(y, mo - 1, d);
    date.setUTCHours(h, mi, s, 0);
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
    return `${year}-${month}-${day}T${hour}:${minute}:${second}.${fraction.padEnd(9, '0')}`;
}

function wallSeconds(datetime: string): number {
    const date = new Date(0);
    date.setUTCFullYear(Number(datetime.slice(0, 4)), Number(datetime.slice(5, 7)) - 1, Number(datetime.slice(8, 10)));
    date.setUTCHours(Number(datetime.slice(11, 13)), Number(datetime.slice(14, 16)), Number(datetime.slice(17, 19)), 0);
    return date.getTime() / 1000;
}

function overlapKey(print: NormalizedPrint): string {
    return JSON.stringify([print.datetime, print.close, print.volume, print.tickType ?? null]);
}

/**
 * Every accepted print changes OHLCV immediately. Consumers may independently
 * throttle takeChanges()/drawing without dropping intermediate extrema or lots.
 */
export class LiveCandleAccumulator {
    private readonly bucketSeconds: number;
    private readonly daily: boolean;
    private readonly acceptTime?: (wallSeconds: number) => boolean;
    private readonly buckets = new Map<number, Bucket>();
    private readonly dirty = new Set<number>();
    private currentBars: Candle[] = [];
    private pending: NormalizedPrint[] = [];
    private restOverlap = new Map<string, number>();
    private ready = false;
    private cutoff = 0;
    private didOverflow = false;
    private needsReset = false;
    private didAppend = false;

    constructor(minutes: number, acceptTime?: (wallSeconds: number) => boolean) {
        if (!Number.isSafeInteger(minutes) || minutes <= 0) throw new Error('Candle interval must be a positive integer');
        this.bucketSeconds = minutes * 60;
        this.daily = minutes >= 1440;
        this.acceptTime = acceptTime;
    }

    get bars(): Candle[] { return this.currentBars; }
    get last(): Candle | null { return this.currentBars.at(-1) ?? null; }
    get pendingCount(): number { return this.pending.length; }
    get overflowed(): boolean { return this.didOverflow; }

    push(print: LiveCandlePrint): void {
        const normalized = this.normalize(print);
        if (!normalized) return;
        if (this.ready) {
            if (normalized.wallSeconds < this.cutoff || this.consumeOverlap(normalized, this.restOverlap)) return;
            this.apply(normalized);
        } else if (this.pending.length < MAX_PENDING_PRINTS) {
            this.pending.push(normalized);
        } else {
            // The bounded queue cannot prove continuity after this point. A new
            // accumulator and a new seed are required; never silently draw loss.
            this.didOverflow = true;
        }
    }

    /**
     * cutoff is the closed-minute boundary in Taiwan wall-clock Unix seconds.
     * History may already contain a partial larger bucket ending after cutoff.
     * REST multiplicity is retained. Its exact event identities form a bounded
     * matching budget for buffered live and delayed live copies arriving later.
     */
    seed(history: readonly Candle[], cutoff: number, prefix: readonly LiveCandlePrint[]): void {
        if (this.didOverflow) throw new Error('Live candle pending buffer overflowed; continuity is unknown');
        if (!Number.isSafeInteger(cutoff)) throw new Error('Candle seed cutoff must be whole wall-clock seconds');
        const rest = prefix.map(print => this.normalize(print)).filter((print): print is NormalizedPrint => print !== null && print.wallSeconds >= cutoff);
        if (rest.length > MAX_REST_PRINTS) throw new Error('Live candle REST prefix exceeds the bounded reconciliation budget');
        rest.sort((a, b) => a.datetime.localeCompare(b.datetime));
        const overlap = new Map<string, number>();
        for (const print of rest) {
            const key = overlapKey(print);
            overlap.set(key, (overlap.get(key) ?? 0) + 1);
        }
        const tail = this.pending.filter(print => {
            if (print.wallSeconds < cutoff) return false;
            return !this.consumeOverlap(print, overlap);
        });
        const prints = [...rest, ...tail].sort((a, b) => a.datetime.localeCompare(b.datetime));

        this.buckets.clear();
        this.dirty.clear();
        this.currentBars = [];
        this.didAppend = false;
        this.cutoff = cutoff;
        this.restOverlap = overlap;
        for (const bar of history) this.buckets.set(bar.time, this.historicalBucket(bar));
        this.currentBars = [...this.buckets.values()].map(bucket => bucket.bar).sort((a, b) => a.time - b.time);
        this.ready = true;
        this.pending = [];
        for (const print of prints) this.apply(print);
        for (const bar of this.currentBars) this.dirty.add(bar.time);
        this.needsReset = true;
    }

    /** Add paged older history while keeping all already-observed live bars. */
    prepend(history: readonly Candle[]): void {
        for (const bar of history) {
            if (!this.buckets.has(bar.time)) {
                this.buckets.set(bar.time, this.historicalBucket(bar));
                this.dirty.add(bar.time);
            }
        }
        this.currentBars = [...this.buckets.values()].map(bucket => bucket.bar).sort((a, b) => a.time - b.time);
        this.needsReset = true;
    }

    takeChanges(): { bars: Candle[]; reset: boolean; appended: boolean } {
        const bars = [...this.dirty].sort((a, b) => a - b).map(time => ({ ...this.buckets.get(time)!.bar }));
        const changes = { bars, reset: this.needsReset, appended: this.didAppend };
        this.dirty.clear();
        this.needsReset = false;
        this.didAppend = false;
        return changes;
    }

    private normalize(print: LiveCandlePrint): NormalizedPrint | null {
        if (print.simtrade || !Number.isFinite(print.close) || print.close <= 0 || !Number.isFinite(print.volume) || print.volume < 0) return null;
        const datetime = canonicalCandleTime(print.datetime);
        if (!datetime) return null;
        const seconds = wallSeconds(datetime);
        if (this.acceptTime && !this.acceptTime(seconds)) return null;
        return { ...print, datetime, wallSeconds: seconds };
    }

    private historicalBucket(bar: Candle): Bucket {
        return { bar: { ...bar }, historical: true, firstPrint: null, lastPrint: null };
    }

    private consumeOverlap(print: NormalizedPrint, budget: Map<string, number>): boolean {
        const key = overlapKey(print);
        const remaining = budget.get(key) ?? 0;
        if (remaining === 0) return false;
        if (remaining === 1) budget.delete(key);
        else budget.set(key, remaining - 1);
        return true;
    }

    private apply(print: NormalizedPrint): void {
        if (print.wallSeconds < this.cutoff) return;
        const time = this.daily
            ? Math.floor(print.wallSeconds / DAY_SECONDS) * DAY_SECONDS
            : Math.floor(print.wallSeconds / this.bucketSeconds) * this.bucketSeconds + this.bucketSeconds;
        let bucket = this.buckets.get(time);
        const priorLastTime = this.last?.time;
        if (!bucket) {
            const bar = { time, open: print.close, high: print.close, low: print.close, close: print.close, volume: print.volume };
            bucket = { bar, historical: false, firstPrint: print.datetime, lastPrint: print.datetime };
            this.buckets.set(time, bucket);
            if (priorLastTime === undefined || time > priorLastTime) {
                this.currentBars.push(bar);
            } else {
                this.currentBars = [...this.currentBars, bar].sort((a, b) => a.time - b.time);
            }
            this.didAppend = true;
        } else {
            const bar = bucket.bar;
            if (!bucket.historical && (bucket.firstPrint === null || print.datetime < bucket.firstPrint)) {
                bar.open = print.close;
                bucket.firstPrint = print.datetime;
            }
            // Equal timestamps follow arrival order rather than deduplicating.
            if (bucket.lastPrint === null || print.datetime >= bucket.lastPrint) {
                bar.close = print.close;
                bucket.lastPrint = print.datetime;
            }
            bar.high = Math.max(bar.high, print.close);
            bar.low = Math.min(bar.low, print.close);
            bar.volume += print.volume;
        }
        this.dirty.add(time);
        if (priorLastTime !== undefined && time < priorLastTime) this.needsReset = true;
    }
}
