import { useEffect, useId, useState } from 'react';
import {
    loadResearchSnapshot,
    type ResearchSnapshot,
} from './model';
import './panel.css';

type ResearchTab = 'overview' | 'financials' | 'replay' | 'sources';

const TABS: readonly { id: ResearchTab; label: string }[] = [
    { id: 'overview', label: '概覽' },
    { id: 'financials', label: '財務' },
    { id: 'replay', label: '重播' },
    { id: 'sources', label: '來源' },
];

function number(value: number | null | undefined, digits = 2): string {
    return value == null || !Number.isFinite(value)
        ? '—'
        : value.toLocaleString('zh-TW', { maximumFractionDigits: digits });
}

function queryKey(symbol: string, date: string, cutoff: string): string {
    return JSON.stringify([symbol, date, cutoff]);
}

interface PanelResult {
    key: string;
    snapshot?: ResearchSnapshot;
    error?: string;
}

export function NeoResearchPanel({
    symbol,
    date = '2026-11-13',
    cutoff = '13:30',
}: {
    symbol: string;
    date?: string;
    cutoff?: string;
}) {
    const [tab, setTab] = useState<ResearchTab>('overview');
    const [result, setResult] = useState<PanelResult | null>(null);
    const key = queryKey(symbol, date, cutoff);
    const contentId = useId();

    useEffect(() => {
        const controller = new AbortController();
        let active = true;
        void loadResearchSnapshot({ symbol, date, cutoff }, controller.signal)
            .then((snapshot) => {
                if (!active || controller.signal.aborted) return;
                const returned = snapshot.query;
                if (queryKey(returned.symbol, returned.date, returned.cutoff) !== key) {
                    setResult({ key, error: '資料身分不一致，請重新選擇商品或日期。' });
                    return;
                }
                setResult({ key, snapshot });
            })
            .catch((error: unknown) => {
                if (!active || controller.signal.aborted) return;
                setResult({
                    key,
                    error: error instanceof Error ? error.message : '研究資料暫時無法載入。',
                });
            });
        return () => {
            active = false;
            controller.abort();
        };
    }, [symbol, date, cutoff, key]);

    // Props may change before an effect runs: never relabel the previous
    // symbol/date's values as the newly requested identity, even for one frame.
    const current = result?.key === key ? result : null;
    const snapshot = current?.snapshot;
    const loading = !current;

    return (
        <div className='nr-panel' aria-busy={loading}>
            <div className='nr-fixture-notice'>
                <span className='nr-fixture-dot' aria-hidden='true' />
                示範資料，非真實行情或財報
            </div>
            <div className='nr-query-line'>
                <span>{symbol || '未選商品'} · {date}</span>
                <span>截至 {cutoff} · 台北</span>
            </div>
            <nav className='nr-tabs' aria-label='研究資料分頁'>
                {TABS.map(({ id, label }) => (
                    <button
                        key={id}
                        type='button'
                        className={`nr-tab${tab === id ? ' nr-tab-active' : ''}`}
                        aria-pressed={tab === id}
                        aria-controls={contentId}
                        onClick={() => setTab(id)}
                    >
                        {label}
                    </button>
                ))}
            </nav>
            <section
                id={contentId}
                className='nr-content'
                aria-label={TABS.find(({ id }) => id === tab)?.label}
            >
                {loading && <p className='nr-state' role='status'>載入研究資料…</p>}
                {current?.error && <p className='nr-state nr-error' role='alert'>{current.error}</p>}
                {snapshot?.status === 'missing' && (
                    <div className='nr-state' role='status'>
                        <strong>此查詢沒有示範資料</strong>
                        <p>{snapshot.notice}</p>
                        <p>請從研究清單選擇商品與示範交易日。</p>
                    </div>
                )}
                {snapshot?.status === 'ready' && (
                    <>
                        <div className='nr-entity'>
                            <h2>{snapshot.name}</h2>
                            <span>{snapshot.market} · {snapshot.query.symbol}</span>
                        </div>
                        {tab === 'overview' && <Overview snapshot={snapshot} />}
                        {tab === 'financials' && <Financials snapshot={snapshot} />}
                        {tab === 'replay' && <Replay snapshot={snapshot} />}
                        {tab === 'sources' && <Sources snapshot={snapshot} />}
                    </>
                )}
            </section>
            <div className='nr-status-line'>
                <span>觀察用途</span>
                <span>不具決策資格</span>
            </div>
        </div>
    );
}

function Overview({ snapshot }: { snapshot: ResearchSnapshot }) {
    const last = snapshot.replay[snapshot.replay.length - 1];
    const revenue = snapshot.revenue[snapshot.revenue.length - 1];
    const quarter = snapshot.quarters[snapshot.quarters.length - 1];
    return (
        <>
            <p className='nr-eyebrow'>截至游標的研究讀數</p>
            <dl className='nr-metrics'>
                <div><dt>示範價格</dt><dd>{number(last?.price)}<small>元</small></dd></div>
                <div><dt>VWAP</dt><dd className='nr-teal'>{number(last?.vwap)}<small>元</small></dd></div>
                <div><dt>POC</dt><dd className='nr-amber'>{number(last?.poc)}<small>元</small></dd></div>
            </dl>
            <p className='nr-note'>
                {last ? `最後一筆示範讀數 ${last.time}；圖表只保留 ${snapshot.query.cutoff} 前的資料。` : '游標前尚無示範成交，保留空值。'}
            </p>
            <ReplayChart rows={snapshot.replay} cutoff={snapshot.query.cutoff} />
            <div className='nr-section-heading'><h3>公司財務摘要</h3><span>合成範例</span></div>
            <dl className='nr-facts'>
                <div><dt>營收月份</dt><dd>{revenue?.period ?? '—'}</dd></div>
                <div><dt>月營收（千元）</dt><dd>{number(revenue?.revenueThousands, 0)}</dd></div>
                <div><dt>年增率</dt><dd>{revenue?.yoyPercent == null ? '—' : `${number(revenue.yoyPercent)}%`}</dd></div>
                <div><dt>財報季別</dt><dd>{quarter?.period ?? '—'}</dd></div>
                <div><dt>每股盈餘（元）</dt><dd>{number(quarter?.eps)}</dd></div>
            </dl>
            <p className='nr-note'>{snapshot.notice}</p>
        </>
    );
}

function Financials({ snapshot }: { snapshot: ResearchSnapshot }) {
    return (
        <>
            <div className='nr-section-heading'><h3>月營收</h3><span>單位：千元新台幣</span></div>
            <div className='nr-table-region' tabIndex={0} role='region' aria-label='示範月營收表，可水平與垂直捲動'>
                <table className='nr-table'>
                    <caption>月營收與年增率（合成資料）</caption>
                    <thead><tr><th scope='col'>月份</th><th scope='col'>營收（千元）</th><th scope='col'>年增率</th></tr></thead>
                    <tbody>
                        {snapshot.revenue.map((row) => <tr key={row.period}>
                            <th scope='row'>{row.period}</th>
                            <td>{number(row.revenueThousands, 0)}</td>
                            <td>{row.yoyPercent == null ? '—' : `${number(row.yoyPercent)}%`}</td>
                        </tr>)}
                    </tbody>
                </table>
            </div>
            <div className='nr-section-heading'><h3>季度財報</h3><span>EPS：元／股</span></div>
            <div className='nr-table-region' tabIndex={0} role='region' aria-label='示範季度財報表，可水平與垂直捲動'>
                <table className='nr-table'>
                    <caption>季度財務指標（合成資料）</caption>
                    <thead><tr><th scope='col'>季別</th><th scope='col'>EPS（元）</th><th scope='col'>毛利率</th></tr></thead>
                    <tbody>
                        {snapshot.quarters.map((row) => <tr key={row.period}>
                            <th scope='row'>{row.period}</th>
                            <td>{number(row.eps)}</td>
                            <td>{row.grossMarginPercent == null ? '—' : `${number(row.grossMarginPercent)}%`}</td>
                        </tr>)}
                    </tbody>
                </table>
            </div>
            <p className='nr-note'>「—」保留缺值或不適用項目；金融股不套一般產業毛利率。所有數字均為介面測試資料。</p>
        </>
    );
}

function Replay({ snapshot }: { snapshot: ResearchSnapshot }) {
    return (
        <>
            <div className='nr-section-heading'><h3>重播對照</h3><span>截至 {snapshot.query.cutoff}</span></div>
            <ReplayChart rows={snapshot.replay} cutoff={snapshot.query.cutoff} />
            <div className='nr-table-region' tabIndex={0} role='region' aria-label='截至游標的示範重播讀數，可水平與垂直捲動'>
                <table className='nr-table'>
                    <caption>逐時讀數（元，合成資料）</caption>
                    <thead><tr><th scope='col'>台北時間</th><th scope='col'>價格</th><th scope='col'>VWAP</th><th scope='col'>POC</th></tr></thead>
                    <tbody>{snapshot.replay.map((row) => <tr key={row.time}>
                        <th scope='row'>{row.time}</th>
                        <td>{number(row.price)}</td>
                        <td className='nr-teal'>{number(row.vwap)}</td>
                        <td className='nr-amber'>{number(row.poc)}</td>
                    </tr>)}</tbody>
                </table>
            </div>
            {!snapshot.replay.length && <p className='nr-state' role='status'>游標前沒有示範成交資料。</p>}
            <p className='nr-note'>此處展示資料契約與游標行為，尚未連接 neo 的真實重播匯出。</p>
        </>
    );
}

function Sources({ snapshot }: { snapshot: ResearchSnapshot }) {
    return (
        <>
            <div className='nr-section-heading'><h3>資料出處</h3><span>可追溯的研究切面</span></div>
            <dl className='nr-facts nr-source-facts'>
                <div><dt>來源類型</dt><dd>本機合成 fixture</dd></div>
                <div><dt>來源檔</dt><dd><code>src/features/neo-research/fixtures.ts</code></dd></div>
                <div><dt>版本</dt><dd><code>{snapshot.releaseId}</code></dd></div>
                <div><dt>交易日</dt><dd>{snapshot.query.date}</dd></div>
                <div><dt>查詢截止</dt><dd><time dateTime={snapshot.asOf}>{snapshot.asOf}</time></dd></div>
                <div><dt>使用邊界</dt><dd><code>decision_use={snapshot.decisionUse}</code></dd></div>
                <div><dt>資料資格</dt><dd><code>decision_eligible={String(snapshot.decisionEligible)}</code></dd></div>
            </dl>
            <p className='nr-source-notice'>
                這些資料未取自券商、公開財報或 neo 原始行情。公司名稱僅用於測試選股連動；價格、財務與 VWAP／POC 數字全部為合成範例。
            </p>
            <p className='nr-note'>後續接入公開財務快照與 neo 匯出時，將保留來源、版本、期別、單位與截止時間；目前沒有外部資料來源或券商連線。</p>
        </>
    );
}

function ReplayChart({ rows, cutoff }: { rows: ResearchSnapshot['replay']; cutoff: string }) {
    const titleId = useId();
    if (!rows.length) return null;
    const values = rows.flatMap((row) => [row.price, row.vwap, row.poc]);
    const low = Math.min(...values);
    const high = Math.max(...values);
    const padding = Math.max((high - low) * 0.2, 0.5);
    const min = low - padding;
    const max = high + padding;
    const x = (index: number) => 48 + (index / Math.max(rows.length - 1, 1)) * 544;
    const y = (value: number) => 144 - ((value - min) / (max - min)) * 120;
    const points = (field: 'price' | 'vwap' | 'poc') => rows.map((row, index) => `${x(index)},${y(row[field])}`).join(' ');
    return (
        <figure className='nr-chart'>
            <svg viewBox='0 0 640 180' role='img' aria-labelledby={titleId}>
                <title id={titleId}>截至 {cutoff} 的示範價格、VWAP 與 POC 走勢，詳細數值可見重播分頁</title>
                {[0, 0.5, 1].map((fraction) => <g key={fraction}>
                    <line x1='48' x2='592' y1={24 + 120 * fraction} y2={24 + 120 * fraction} className='nr-chart-grid' />
                    <text x='42' y={28 + 120 * fraction} textAnchor='end' className='nr-chart-label'>{number(max - (max - min) * fraction, 1)}</text>
                </g>)}
                <polyline points={points('price')} className='nr-chart-price' />
                <polyline points={points('vwap')} className='nr-chart-vwap' />
                <polyline points={points('poc')} className='nr-chart-poc' />
                {rows.map((row, index) => <circle key={row.time} cx={x(index)} cy={y(row.vwap)} r='2.5' className='nr-chart-point' />)}
                <text x='48' y='168' className='nr-chart-label'>{rows[0]?.time}</text>
                <text x='592' y='168' textAnchor='end' className='nr-chart-label'>{rows[rows.length - 1]?.time}</text>
            </svg>
            <figcaption><span>價格</span><span className='nr-teal'>VWAP</span><span className='nr-amber'>POC</span><span>合成資料 · 元</span></figcaption>
        </figure>
    );
}
