import { useEffect, useId, useState } from 'react';
import { loadResearchSnapshot, type DatasetInfo, type ResearchQuery, type ResearchSnapshot } from './model';
import './panel.css';

type ResearchTab = 'overview' | 'financials' | 'replay' | 'sources';
const TABS: readonly { id: ResearchTab; label: string }[] = [
    { id: 'overview', label: '概覽' }, { id: 'financials', label: '財務' },
    { id: 'replay', label: '重播' }, { id: 'sources', label: '來源' },
];
const STATUS_LABELS: Record<DatasetInfo['status'], string> = {
    ready: '可用', missing: '缺資料', 'not-retained': '當時版本未留存',
    invalid: '資料驗證未通過', unavailable: '來源暫時不可用', revoked: '此版本已撤回',
};
function number(value: number | null | undefined, digits = 2): string {
    return value == null || !Number.isFinite(value) ? '—'
        : value.toLocaleString('zh-TW', { maximumFractionDigits: digits });
}
function queryKey(query: ResearchQuery): string {
    return JSON.stringify([query.symbol, query.date, query.cutoff,
        query.sourceMode ?? 'fixture', query.financeMode ?? 'as_of']);
}
function epsBasis(value: string | undefined, fixture: boolean): string {
    if (fixture) return '合成示範資料';
    if (value === 'quarter_derived_from_ytd') return '單季，累計相減推算';
    if (value === 'quarter_reported_q1') return '第一季公告值';
    return value || '未提供 EPS 口徑';
}
interface PanelResult { key: string; snapshot?: ResearchSnapshot; error?: string }

export function NeoResearchPanel({
    symbol, date = '2026-11-13', cutoff = '13:30', sourceMode = 'fixture', financeMode = 'as_of',
}: {
    symbol: string; date?: string; cutoff?: string;
    sourceMode?: 'real' | 'fixture'; financeMode?: 'latest' | 'as_of';
}) {
    const [tab, setTab] = useState<ResearchTab>('overview');
    const [result, setResult] = useState<PanelResult | null>(null);
    const key = queryKey({ symbol, date, cutoff, sourceMode, financeMode });
    const contentId = useId();
    useEffect(() => {
        const controller = new AbortController();
        let active = true;
        void loadResearchSnapshot({ symbol, date, cutoff, sourceMode, financeMode }, controller.signal)
            .then(snapshot => {
                if (!active || controller.signal.aborted) return;
                if (queryKey(snapshot.query) !== key || snapshot.source !== sourceMode) {
                    setResult({ key, error: '資料身分或來源不一致，請重新選擇商品、日期或資料模式。' });
                    return;
                }
                setResult({ key, snapshot });
            })
            .catch((error: unknown) => {
                if (!active || controller.signal.aborted) return;
                setResult({ key, error: error instanceof Error ? error.message : '研究資料暫時無法載入。' });
            });
        return () => { active = false; controller.abort(); };
    }, [symbol, date, cutoff, sourceMode, financeMode, key]);
    // The identity includes both modes. A previous real or synthetic result is
    // hidden synchronously, before the new effect or request can complete.
    const current = result?.key === key ? result : null;
    const snapshot = current?.snapshot;
    const loading = !current;
    return <div className='nr-panel' aria-busy={loading} data-source-mode={sourceMode} data-finance-mode={financeMode}>
        <div className='nr-fixture-notice'><span className='nr-fixture-dot' aria-hidden='true' />
            {sourceMode === 'fixture' ? '示範資料，非真實行情或財報' : '真實資料 · 唯讀本機已驗快照'}
        </div>
        <div className='nr-query-line'><span>{symbol || '未選商品'} · {date}</span><span>重播截至 {cutoff} · 台北</span></div>
        <div className='nr-query-line'>財務：{sourceMode === 'fixture' ? '示範資料'
            : financeMode === 'latest' ? '最新可用版本，與重播時點不同' : '跟隨重播時點，只讀當時已留存版本'}</div>
        <nav className='nr-tabs' aria-label='研究資料分頁'>
            {TABS.map(({ id, label }) => <button key={id} type='button'
                className={`nr-tab${tab === id ? ' nr-tab-active' : ''}`}
                aria-pressed={tab === id} aria-controls={contentId} onClick={() => setTab(id)}>{label}</button>)}
        </nav>
        <section id={contentId} className='nr-content' aria-label={TABS.find(({ id }) => id === tab)?.label}>
            {loading && <p className='nr-state' role='status'>載入研究資料…</p>}
            {current?.error && <p className='nr-state nr-error' role='alert'>{current.error}</p>}
            {snapshot && <>
                <div className='nr-entity'><h2>{snapshot.name}</h2><span>{snapshot.market} · {snapshot.query.symbol}</span></div>
                {snapshot.source === 'fixture' && snapshot.status === 'missing'
                    && <div className='nr-state' role='status'><strong>此查詢沒有示範資料</strong><p>{snapshot.notice}</p></div>}
                {tab === 'overview' && <Overview snapshot={snapshot} />}
                {tab === 'financials' && <Financials snapshot={snapshot} />}
                {tab === 'replay' && <Replay snapshot={snapshot} />}
                {tab === 'sources' && <Sources snapshot={snapshot} />}
            </>}
        </section>
        <div className='nr-status-line'><span>觀察用途</span><span>不具決策資格</span></div>
    </div>;
}

function DatasetStatus({ label, info }: { label: string; info: DatasetInfo }) {
    return <div className={info.status === 'ready' ? 'nr-note' : 'nr-state'}
        role={info.status === 'ready' ? undefined : 'status'} data-dataset={label} data-status={info.status}>
        <strong>{label}：{STATUS_LABELS[info.status]}</strong>
        {info.notice && <p>{info.notice}</p>}
    </div>;
}
function FinanceTime({ snapshot }: { snapshot: ResearchSnapshot }) {
    return <p className={snapshot.source === 'real' && snapshot.query.financeMode === 'latest' ? 'nr-source-notice' : 'nr-note'}>
        {snapshot.source === 'fixture' ? '財務數字為合成示範資料。'
            : snapshot.query.financeMode === 'latest'
                ? '最新可用財務，與重播時點不同；不是當時已知資料。'
                : `歷史財務截止 ${snapshot.asOf}，只讀此前已留存版本；沒有留存就保持缺資料。`}
        <br />首次留存：{snapshot.finance.firstSeenAt ?? '未留存'}
    </p>;
}
function ReplayTime({ snapshot }: { snapshot: ResearchSnapshot }) {
    const last = snapshot.replay[snapshot.replay.length - 1];
    return <p className='nr-note'>要求截止：{snapshot.asOf}<br />
        實際最後時點：{snapshot.replayInfo.actualAsOf ?? (last ? `${snapshot.query.date}T${last.time}:00+08:00` : '游標前無資料')}
        {' · '}{snapshot.replayInfo.samplingMinutes == null ? '採樣間隔未提供' : `採樣 ${number(snapshot.replayInfo.samplingMinutes)} 分鐘`}
        <br />{snapshot.source === 'fixture' ? '合成資料，僅供介面驗證。' : '數值直接取自 neo 的因果前綴輸出；此頁不重算 VWAP／POC。'}
    </p>;
}
function Overview({ snapshot }: { snapshot: ResearchSnapshot }) {
    const last = snapshot.replay[snapshot.replay.length - 1];
    const revenue = snapshot.revenue[snapshot.revenue.length - 1];
    const quarter = snapshot.quarters[snapshot.quarters.length - 1];
    return <>
        <p className='nr-eyebrow'>重播與財務採不同資料時點</p>
        <DatasetStatus label='neo 重播' info={snapshot.replayInfo} />
        {snapshot.replayInfo.status === 'ready' && <>
            <dl className='nr-metrics'>
                <div><dt>{snapshot.source === 'fixture' ? '示範價格' : '價格'}</dt><dd>{number(last?.price)}<small>元</small></dd></div>
                <div><dt>VWAP</dt><dd className='nr-teal'>{number(last?.vwap)}<small>元</small></dd></div>
                <div><dt>POC</dt><dd className='nr-amber'>{number(last?.poc)}<small>元</small></dd></div>
            </dl>
            <ReplayChart rows={snapshot.replay} cutoff={snapshot.query.cutoff} fixture={snapshot.source === 'fixture'} />
        </>}
        <ReplayTime snapshot={snapshot} />
        <div className='nr-section-heading'><h3>公司財務摘要</h3><span>{snapshot.source === 'fixture' ? '合成範例' : '已驗公開資料'}</span></div>
        <DatasetStatus label='財務' info={snapshot.finance} /><FinanceTime snapshot={snapshot} />
        {snapshot.finance.status === 'ready' && <dl className='nr-facts'>
            <div><dt>營收月份</dt><dd>{revenue?.period ?? '—'}</dd></div>
            <div><dt>月營收（千元）</dt><dd>{number(revenue?.revenueThousands, 0)}</dd></div>
            <div><dt>年增率</dt><dd>{revenue?.yoyPercent == null ? '—' : `${number(revenue.yoyPercent)}%`}</dd></div>
            <div><dt>財報季別</dt><dd>{quarter?.period ?? '—'}</dd></div>
            <div><dt>每股盈餘（元）</dt><dd>{number(quarter?.eps)}</dd></div>
            <div><dt>EPS 口徑</dt><dd>{epsBasis(quarter?.epsBasis, snapshot.source === 'fixture')}</dd></div>
        </dl>}
    </>;
}
function Financials({ snapshot }: { snapshot: ResearchSnapshot }) {
    const fixture = snapshot.source === 'fixture';
    return <>
        <DatasetStatus label='財務' info={snapshot.finance} /><FinanceTime snapshot={snapshot} />
        {snapshot.finance.status === 'ready' && <>
            <div className='nr-section-heading'><h3>月營收</h3><span>單位：千元新台幣</span></div>
            <div className='nr-table-region' tabIndex={0} role='region'
                aria-label={`${fixture ? '示範' : '真實'}月營收表，可水平與垂直捲動`}>
                <table className='nr-table'><caption>月營收與年增率（{fixture ? '合成資料' : '公開資料快照'}）</caption>
                    <thead><tr><th scope='col'>月份</th><th scope='col'>營收（千元）</th><th scope='col'>年增率</th></tr></thead>
                    <tbody>{snapshot.revenue.map(row => <tr key={row.period}><th scope='row'>{row.period}</th>
                        <td>{number(row.revenueThousands, 0)}</td><td>{row.yoyPercent == null ? '—' : `${number(row.yoyPercent)}%`}</td></tr>)}</tbody>
                </table>
            </div>
            <div className='nr-section-heading'><h3>季度財報</h3><span>EPS：元／股</span></div>
            <div className='nr-table-region' tabIndex={0} role='region'
                aria-label={`${fixture ? '示範' : '真實'}季度財報表，可水平與垂直捲動`}>
                <table className='nr-table'><caption>季度財務指標（{fixture ? '合成資料' : '公開資料快照'}）</caption>
                    <thead><tr><th scope='col'>季別</th><th scope='col'>EPS（元）</th><th scope='col'>EPS 口徑</th><th scope='col'>毛利率</th></tr></thead>
                    <tbody>{snapshot.quarters.map(row => <tr key={row.period}><th scope='row'>{row.period}</th><td>{number(row.eps)}</td>
                        <td>{epsBasis(row.epsBasis, fixture)}</td><td>{row.grossMarginPercent == null ? '—' : `${number(row.grossMarginPercent)}%`}</td></tr>)}</tbody>
                </table>
            </div>
            <p className='nr-note'>「—」保留缺值或不適用項目；金融股不套一般產業毛利率。
                {fixture ? '所有財務數字與 EPS 口徑均為合成範例。' : 'EPS 依逐列口徑區分第一季公告值與由累計數相減推算的單季值。'}</p>
        </>}
    </>;
}
function Replay({ snapshot }: { snapshot: ResearchSnapshot }) {
    const fixture = snapshot.source === 'fixture';
    return <>
        <div className='nr-section-heading'><h3>重播對照</h3><span>截至 {snapshot.query.cutoff}</span></div>
        <DatasetStatus label='neo 重播' info={snapshot.replayInfo} /><ReplayTime snapshot={snapshot} />
        {snapshot.replayInfo.status === 'ready' && <>
            <ReplayChart rows={snapshot.replay} cutoff={snapshot.query.cutoff} fixture={fixture} />
            <div className='nr-table-region' tabIndex={0} role='region'
                aria-label={`截至游標的${fixture ? '示範' : 'neo'}重播讀數，可水平與垂直捲動`}>
                <table className='nr-table'><caption>逐時讀數（元，{fixture ? '合成資料' : 'neo 匯出前綴'}）</caption>
                    <thead><tr><th scope='col'>台北時間</th><th scope='col'>價格</th><th scope='col'>VWAP</th><th scope='col'>POC</th></tr></thead>
                    <tbody>{snapshot.replay.map(row => <tr key={row.time}><th scope='row'>{row.time}</th>
                        <td>{number(row.price)}</td><td className='nr-teal'>{number(row.vwap)}</td><td className='nr-amber'>{number(row.poc)}</td></tr>)}</tbody>
                </table>
            </div>
            {!snapshot.replay.length && <p className='nr-state' role='status'>游標前沒有重播資料。</p>}
            <p className='nr-note'>缺值維持「—」，圖線在缺值處中斷；不從後續資料補值。</p>
        </>}
    </>;
}
function Metadata({ label, info }: { label: string; info: DatasetInfo }) {
    return <>
        <div className='nr-section-heading'><h3>{label}來源</h3><span>{STATUS_LABELS[info.status]}</span></div>
        <dl className='nr-facts nr-source-facts'>
            <div><dt>來源</dt><dd>{info.source}</dd></div>
            <div><dt>版本</dt><dd><code>{info.releaseId || '未選取版本'}</code></dd></div>
            <div><dt>首次留存</dt><dd>{info.firstSeenAt ?? '未留存'}</dd></div>
            {info.actualAsOf && <div><dt>實際最後時點</dt><dd>{info.actualAsOf}</dd></div>}
            {info.samplingMinutes != null && <div><dt>採樣間隔</dt><dd>{number(info.samplingMinutes)} 分鐘</dd></div>}
            {Object.entries(info.provenance ?? {}).map(([key, value]) => <div key={key}><dt>{key}</dt>
                <dd><code>{typeof value === 'string' ? value : JSON.stringify(value)}</code></dd></div>)}
        </dl>
        <p className='nr-note'>{info.notice}</p>
    </>;
}
function Sources({ snapshot }: { snapshot: ResearchSnapshot }) {
    return <>
        <FinanceTime snapshot={snapshot} />
        <Metadata label='財務' info={snapshot.finance} /><Metadata label='neo 重播' info={snapshot.replayInfo} />
        <dl className='nr-facts nr-source-facts'>
            <div><dt>重播要求截止</dt><dd><time dateTime={snapshot.asOf}>{snapshot.asOf}</time></dd></div>
            <div><dt>使用邊界</dt><dd><code>decision_use={snapshot.decisionUse}</code></dd></div>
            <div><dt>資料資格</dt><dd><code>decision_eligible={String(snapshot.decisionEligible)}</code></dd></div>
        </dl>
        <p className='nr-source-notice'>{snapshot.source === 'fixture'
            ? '公司名稱僅用於測試選股連動；價格、財務與 VWAP／POC 數字全部為合成範例。'
            : '只讀本機核准發布的公開財務與 neo 重播匯出。缺資料不替換成示範值，歷史財務不以今次下載回填過去。'}</p>
    </>;
}
function ReplayChart({ rows, cutoff, fixture }: { rows: ResearchSnapshot['replay']; cutoff: string; fixture: boolean }) {
    const titleId = useId();
    if (!rows.length) return null;
    const values = rows.flatMap(row => [row.price, row.vwap, row.poc]).filter((value): value is number => value != null && Number.isFinite(value));
    if (!values.length) return <p className='nr-note'>游標前的讀數皆為缺值，保留空圖。</p>;
    const low = Math.min(...values), high = Math.max(...values);
    const padding = Math.max((high - low) * 0.2, 0.5), min = low - padding, max = high + padding;
    const minute = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
    const start = minute(rows[0]!.time), end = minute(rows[rows.length - 1]!.time);
    const x = (time: string) => 48 + ((minute(time) - start) / Math.max(end - start, 1)) * 544;
    const y = (value: number) => 144 - ((value - min) / (max - min)) * 120;
    const segments = (field: 'price' | 'vwap' | 'poc') => {
        const parts: string[] = [];
        let current: string[] = [];
        for (const row of rows) {
            const value = row[field];
            if (value == null || !Number.isFinite(value)) {
                if (current.length) parts.push(current.join(' '));
                current = [];
            } else current.push(`${x(row.time)},${y(value)}`);
        }
        if (current.length) parts.push(current.join(' '));
        return parts;
    };
    return <figure className='nr-chart'>
        <svg viewBox='0 0 640 180' role='img' aria-labelledby={titleId}>
            <title id={titleId}>截至 {cutoff} 的{fixture ? '示範' : 'neo 匯出'}價格、VWAP 與 POC；缺值不補線，詳細數值可見重播分頁</title>
            {[0, 0.5, 1].map(fraction => <g key={fraction}>
                <line x1='48' x2='592' y1={24 + 120 * fraction} y2={24 + 120 * fraction} className='nr-chart-grid' />
                <text x='42' y={28 + 120 * fraction} textAnchor='end' className='nr-chart-label'>{number(max - (max - min) * fraction, 1)}</text>
            </g>)}
            {(['price', 'vwap', 'poc'] as const).map(field => <g key={field}>
                {segments(field).map((points, index) => <polyline key={index} points={points} className={`nr-chart-${field}`} />)}
                {rows.map(row => row[field] == null || !Number.isFinite(row[field]) ? null : <circle key={row.time} cx={x(row.time)} cy={y(row[field]!)} r='2'
                    style={{ fill: field === 'vwap' ? '#83d4c3' : field === 'poc' ? '#ebc17a' : '#c9d0d1' }} />)}
            </g>)}
            <text x='48' y='168' className='nr-chart-label'>{rows[0]?.time}</text>
            <text x='592' y='168' textAnchor='end' className='nr-chart-label'>{rows[rows.length - 1]?.time}</text>
        </svg>
        <figcaption><span>價格</span><span className='nr-teal'>VWAP</span><span className='nr-amber'>POC</span>
            <span>{fixture ? '合成資料' : 'neo 匯出'} · 元</span></figcaption>
    </figure>;
}
