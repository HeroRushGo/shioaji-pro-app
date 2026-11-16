import {
    FIXTURE_NOTICE,
    FIXTURE_RELEASE_ID,
    RESEARCH_SYMBOLS,
    fixtureFor,
} from './fixtures';

export { RESEARCH_SYMBOLS, RESEARCH_DATES } from './fixtures';

export interface ResearchQuery {
    symbol: string;
    date: string;
    /** Zero-padded local time on the selected Asia/Taipei trading date. */
    cutoff: string;
}

export interface ResearchSnapshot {
    query: ResearchQuery;
    name: string;
    market: string;
    status: 'ready' | 'missing';
    source: 'fixture';
    releaseId: string;
    asOf: string;
    notice: string;
    revenue: { period: string; revenueThousands: number; yoyPercent: number | null }[];
    quarters: { period: string; eps: number | null; grossMarginPercent: number | null }[];
    replay: { time: string; price: number; vwap: number; poc: number }[];
    decisionUse: 'awareness_only';
    decisionEligible: false;
}

function validateQuery(query: ResearchQuery): void {
    if (!/^\d{4}$/.test(query.symbol)) {
        throw new RangeError('研究代號必須是 4 碼數字。');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(query.date)) {
        throw new RangeError('研究日期必須是 YYYY-MM-DD。');
    }
    const date = new Date(`${query.date}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== query.date) {
        throw new RangeError('研究日期不是有效的日曆日期。');
    }
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(query.cutoff)) {
        throw new RangeError('截止時間必須是 HH:mm（00:00–23:59，Asia/Taipei）。');
    }
}

/** Pure adapter: query identity is preserved, including when data is absent. */
export function snapshotForQuery(query: ResearchQuery): ResearchSnapshot {
    validateQuery(query);
    const company = RESEARCH_SYMBOLS.find(entry => entry.symbol === query.symbol);
    const fixture = fixtureFor(query.symbol, query.date);
    return {
        query: { ...query },
        name: company?.name ?? '未收錄商品',
        market: company?.market ?? '未收錄',
        status: fixture ? 'ready' : 'missing',
        source: 'fixture',
        releaseId: FIXTURE_RELEASE_ID,
        asOf: `${query.date}T${query.cutoff}:00+08:00`,
        notice: fixture ? FIXTURE_NOTICE : `${FIXTURE_NOTICE} 此代號／日期沒有示範資料。`,
        revenue: fixture?.revenue ?? [],
        quarters: fixture?.quarters ?? [],
        replay: fixture?.replay.filter(row => row.time <= query.cutoff) ?? [],
        decisionUse: 'awareness_only',
        decisionEligible: false,
    };
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw signal.reason ?? new DOMException('研究查詢已取消。', 'AbortError');
    }
}

/**
 * Async boundary for a future snapshot adapter. The fixture path performs no
 * fetch, SSE, SDK call or storage access. Abort is checked on both sides of the
 * microtask boundary so a superseded selection cannot publish a result.
 */
export async function loadResearchSnapshot(
    query: ResearchQuery,
    signal?: AbortSignal,
): Promise<ResearchSnapshot> {
    throwIfAborted(signal);
    // Capture the identity before yielding; callers may reuse their query object.
    const requested = { ...query };
    await Promise.resolve();
    throwIfAborted(signal);
    return snapshotForQuery(requested);
}
