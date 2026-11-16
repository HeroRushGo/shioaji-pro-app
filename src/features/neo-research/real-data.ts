import type { DatasetInfo, ResearchQuery, ResearchSnapshot } from './model';
import { validateQuery } from './model';

export interface ResearchItem {
    symbol: string; name: string; market: 'TSE' | 'OTC'; date?: string; path: string; sha256: string;
}
export interface ResearchRelease {
    id: string; firstSeenAt: string; items: ResearchItem[];
    upstreamCommit?: string; upstreamBuiltAt?: string; neoCommit?: string;
}
export interface ResearchCatalog {
    schemaVersion: 1; updatedAt: string; revoked: string[];
    financeReleases: ResearchRelease[]; replayReleases: ResearchRelease[];
}
type Row = Record<string, unknown>;
const record = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);
const revision = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(value);
const time = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:?\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
const date = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const numeric = (value: unknown): value is number | null => value === null || typeof value === 'number' && Number.isFinite(value);
const dataPath = (value: unknown): value is string => typeof value === 'string'
    && /^releases\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}\/[a-zA-Z0-9_-]+\.json$/.test(value);
const assert: (condition: unknown, reason: string) => asserts condition = (condition, reason) => {
    if (!condition) throw new Error(reason);
};

export function parseResearchCatalog(value: unknown): ResearchCatalog {
    assert(record(value) && value.schemaVersion === 1 && time(value.updatedAt), '未知研究目錄格式。');
    assert(Array.isArray(value.revoked) && value.revoked.every(identifier), '撤回清單無效。');
    const ids = new Set<string>();
    for (const kind of ['finance', 'replay'] as const) {
        const releases = value[`${kind}Releases`];
        assert(Array.isArray(releases) && releases.length <= 1000, '研究版本目錄無效。');
        for (const release of releases) {
            assert(record(release) && identifier(release.id) && !ids.has(release.id) && time(release.firstSeenAt), '研究版本識別無效。');
            ids.add(release.id);
            assert(revision(kind === 'finance' ? release.upstreamCommit : release.neoCommit), '資料來源未釘選版本。');
            if (kind === 'finance') assert(time(release.upstreamBuiltAt), '財務來源時間無效。');
            assert(Array.isArray(release.items) && release.items.length > 0 && release.items.length <= 2000, '研究版本沒有合法資料清單。');
            const seen = new Set<string>();
            for (const item of release.items) {
                assert(record(item) && typeof item.symbol === 'string' && /^\d{4}$/.test(item.symbol)
                    && typeof item.name === 'string' && item.name.length > 0 && item.name.length <= 100
                    && ['TSE', 'OTC'].includes(String(item.market)) && dataPath(item.path)
                    && item.path.startsWith(`releases/${release.id}/`) && typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/.test(item.sha256), '研究檔案索引無效。');
                if (kind === 'replay') assert(date(item.date), '重播資料日期無效。');
                const key = `${item.symbol}/${item.date ?? ''}`;
                assert(!seen.has(key), '研究索引重複。'); seen.add(key);
            }
        }
    }
    return value as unknown as ResearchCatalog;
}

function abort(signal?: AbortSignal) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('研究查詢已取消。', 'AbortError');
}
async function readJson(relative: string, signal?: AbortSignal, expectedHash?: string): Promise<unknown> {
    assert(relative === 'catalog.json' || dataPath(relative), '資料讀取路徑無效。');
    abort(signal);
    const response = await fetch(`/research-data/${relative}`, {
        signal, cache: 'no-store', credentials: 'omit', redirect: 'error',
        headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`本機資料尚未匯入或無法讀取（HTTP ${response.status}）。`);
    assert(response.headers.get('content-type')?.includes('application/json'), '本機資料回應不是 JSON。');
    const bytes = await response.arrayBuffer();
    abort(signal);
    assert(bytes.byteLength <= (relative === 'catalog.json' ? 4 : 16) * 1024 * 1024, '研究檔案超過大小限制。');
    if (expectedHash) {
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        const actual = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
        assert(actual === expectedHash, '研究檔案 SHA-256 不符，已拒絕顯示。');
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

export async function loadResearchCatalog(signal?: AbortSignal): Promise<ResearchCatalog> {
    return parseResearchCatalog(await readJson('catalog.json', signal));
}

function info(status: DatasetInfo['status'], source: string, notice: string, release?: ResearchRelease): DatasetInfo {
    return { status, source, notice, releaseId: release?.id ?? '', firstSeenAt: release?.firstSeenAt ?? null };
}
function sortReleases(releases: ResearchRelease[]) {
    return [...releases].sort((a, b) => Date.parse(b.firstSeenAt) - Date.parse(a.firstSeenAt) || b.id.localeCompare(a.id));
}
function selectRelease(catalog: ResearchCatalog, kind: 'finance' | 'replay', query: ResearchQuery) {
    const candidates = sortReleases(catalog[`${kind}Releases`]).filter(release => release.items.some(item => item.symbol === query.symbol
        && (kind === 'finance' || item.date === query.date)));
    const eligible = kind === 'finance' && query.financeMode === 'as_of'
        ? candidates.filter(release => Date.parse(release.firstSeenAt) <= Date.parse(`${query.date}T${query.cutoff}:00+08:00`)) : candidates;
    const selected = eligible.find(release => !catalog.revoked.includes(release.id));
    if (selected) return { release: selected, metadata: info('ready', kind === 'finance' ? 'shioaji-public' : 'neo-replay', '', selected) };
    if (eligible.length) return { metadata: info('revoked', kind, '符合查詢的本機版本已撤回，無法顯示。') };
    if (kind === 'finance' && query.financeMode === 'as_of') return { metadata: info('not-retained', kind, '當時版本未留存；不以今日取得資料回填歷史。') };
    return { metadata: info('missing', kind, kind === 'finance' ? '此代號尚無已驗證財務快照。' : '此代號／交易日尚無 neo 唯讀重播匯出。') };
}

function parsePayload(value: unknown, kind: 'finance' | 'replay', release: ResearchRelease, item: ResearchItem): Row {
    assert(record(value) && value.schemaVersion === 1 && value.kind === kind && value.releaseId === release.id
        && value.symbol === item.symbol && value.market === item.market && value.name === item.name
        && value.firstSeenAt === release.firstSeenAt && record(value.provenance), '研究資料格式或商品身分不符。');
    if (kind === 'finance') {
        assert(value.upstreamBuiltAt === release.upstreamBuiltAt && value.provenance.upstreamCommit === release.upstreamCommit, '財務來源版本不一致。');
        assert(Array.isArray(value.revenue) && value.revenue.length <= 1000 && Array.isArray(value.quarters) && value.quarters.length <= 200, '財務期間陣列無效。');
        const months = new Set<string>();
        for (const row of value.revenue) {
            assert(record(row) && typeof row.period === 'string' && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(row.period)
                && !months.has(row.period) && numeric(row.revenueThousands) && numeric(row.yoyPercent), '營收期別或單位值無效。');
            months.add(row.period);
        }
        const quarters = new Set<string>();
        for (const row of value.quarters) {
            assert(record(row) && typeof row.period === 'string' && /^\d{4}Q[1-4]$/.test(row.period) && !quarters.has(row.period)
                && numeric(row.eps) && numeric(row.grossMarginPercent)
                && ['quarter_derived_from_ytd', 'quarter_reported_q1'].includes(String(row.epsBasis)), '財報期別或推算口徑無效。');
            quarters.add(row.period);
        }
    } else {
        assert(value.date === item.date && value.neoCommit === release.neoCommit
            && typeof value.samplingMinutes === 'number' && [1, 5, 15, 30, 60].includes(value.samplingMinutes)
            && Array.isArray(value.points) && value.points.length <= 600, '重播版本或採樣格式無效。');
        let previous = '';
        for (const point of value.points) {
            assert(record(point) && typeof point.time === 'string' && /^(?:09|1[0-3]):[0-5]\d$/.test(point.time)
                && point.time <= '13:30' && point.time > previous
                && numeric(point.price) && numeric(point.vwap) && numeric(point.poc), '重播資料不是合法因果時間序列。');
            previous = point.time;
        }
    }
    return value;
}

export async function loadRealResearchSnapshot(query: ResearchQuery, signal?: AbortSignal): Promise<ResearchSnapshot> {
    const requested = { ...query }; validateQuery(requested); abort(signal);
    const result: ResearchSnapshot = {
        query: requested, name: '未收錄商品', market: '未收錄', status: 'missing', source: 'real',
        releaseId: '', asOf: `${requested.date}T${requested.cutoff}:00+08:00`,
        notice: '真實資料 · 最新財務與歷史重播分別標示時點 · 僅供觀察',
        revenue: [], quarters: [], replay: [],
        finance: info('unavailable', 'shioaji-public', '尚未載入本機財務快照。'),
        replayInfo: info('unavailable', 'neo-replay', '尚未載入本機重播匯出。'),
        decisionUse: 'awareness_only', decisionEligible: false,
    };
    let catalog: ResearchCatalog;
    try { catalog = await loadResearchCatalog(signal); }
    catch (error) {
        abort(signal);
        const notice = error instanceof Error ? error.message : '本機研究目錄無法讀取。';
        result.finance = info('unavailable', 'shioaji-public', notice);
        result.replayInfo = info('unavailable', 'neo-replay', notice);
        return result;
    }
    const selections = { finance: selectRelease(catalog, 'finance', requested), replay: selectRelease(catalog, 'replay', requested) };
    const identity = selections.finance.release?.items.find(item => item.symbol === requested.symbol)
        ?? selections.replay.release?.items.find(item => item.symbol === requested.symbol && item.date === requested.date);
    if (identity) { result.name = identity.name; result.market = identity.market; }
    await Promise.all((['finance', 'replay'] as const).map(async kind => {
        const selection = selections[kind];
        const key = kind === 'finance' ? 'finance' : 'replayInfo';
        result[key] = selection.metadata;
        const release = selection.release;
        if (!release) return;
        const item = release.items.find(item => item.symbol === requested.symbol && (kind === 'finance' || item.date === requested.date))!;
        if (identity && item.market !== identity.market) {
            result[key] = info('invalid', kind, '資料來源的商品市場不一致，已拒絕混用。', release); return;
        }
        try {
            const payload = parsePayload(await readJson(item.path, signal, item.sha256), kind, release, item);
            // Re-read withdrawals after payload validation; a pointer switch must not revive a withdrawn pinned version.
            const current = await loadResearchCatalog(signal);
            if (current.revoked.includes(release.id)) { result[key] = info('revoked', kind, '資料在載入期間撤回，已拒絕顯示。', release); return; }
            result[key] = { ...selection.metadata, provenance: payload.provenance as Row,
                notice: kind === 'finance' ? requested.financeMode === 'as_of' ? '依本機當時已留存版本顯示。' : '最新可用財務；不是重播當時已知資料。' : 'neo 原始前綴輸出，瀏覽器不重算 VWAP／POC。' };
            if (kind === 'finance') {
                result.revenue = [...payload.revenue as ResearchSnapshot['revenue']].sort((a, b) => a.period.localeCompare(b.period));
                result.quarters = [...payload.quarters as ResearchSnapshot['quarters']].sort((a, b) => a.period.localeCompare(b.period));
            } else {
                result.replay = (payload.points as ResearchSnapshot['replay']).filter(point => point.time <= requested.cutoff);
                result.replayInfo.samplingMinutes = payload.samplingMinutes as number;
                const last = result.replay.at(-1);
                result.replayInfo.actualAsOf = last ? `${requested.date}T${last.time}:00+08:00` : undefined;
                if (!last) result.replayInfo.notice = '游標前沒有已匯出的 neo 讀數。';
            }
        } catch (error) {
            abort(signal);
            result[key] = info('invalid', kind, error instanceof Error ? error.message : '資料驗證失敗。', release);
        }
    }));
    abort(signal);
    result.status = result.finance.status === 'ready' || result.replayInfo.status === 'ready' ? 'ready' : 'missing';
    result.releaseId = [result.finance.releaseId, result.replayInfo.releaseId].filter(Boolean).join(' / ');
    return result;
}
