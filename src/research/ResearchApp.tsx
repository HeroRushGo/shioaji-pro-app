import { useEffect, useState } from 'react';
import GridLayout, { useContainerWidth } from 'react-grid-layout';
import { BookOpen, Database, Plus, RotateCcw, ShieldCheck } from 'lucide-react';
import { PanelChrome } from '../components/panel-chrome';
import * as panelStyles from '../components/panel.css';
import { NeoResearchPanel } from '../features/neo-research/NeoResearchPanel';
import { RESEARCH_DATES, RESEARCH_SYMBOLS } from '../features/neo-research/model';
import { loadResearchCatalog } from '../features/neo-research/real-data';
import { defaultWorkspace, DEFAULT_PANEL_SIZE, MAX_PANELS, RESEARCH_GRID_LIMITS, restoreWorkspace, STORAGE_KEY, validResearchDate, validSymbol } from './workspace';
import type { ResearchWorkspace } from './workspace';
import 'react-grid-layout/css/styles.css';
import './research.css';

function initialWorkspace(): ResearchWorkspace {
    try { return restoreWorkspace(localStorage.getItem(STORAGE_KEY)); }
    catch { return defaultWorkspace(); }
}

type Company = { symbol: string; name: string; market: string };
type CatalogState = { phase: 'idle' | 'loading' | 'ready' | 'error'; companies: Company[]; dates: string[]; notice: string };

export function ResearchApp() {
    const [workspace, setWorkspace] = useState(initialWorkspace);
    const [draft, setDraft] = useState(workspace.symbol);
    const [message, setMessage] = useState('');
    const [saved, setSaved] = useState(true);
    const [catalog, setCatalog] = useState<CatalogState>({ phase: 'idle', companies: [], dates: [], notice: '' });
    const { width, containerRef, mounted } = useContainerWidth();
    useEffect(() => {
        if (workspace.sourceMode !== 'real') return;
        const controller = new AbortController();
        let active = true;
        setCatalog(previous => ({ ...previous, phase: 'loading', notice: '讀取本機資料目錄…仍可輸入四碼代號。' }));
        void loadResearchCatalog(controller.signal).then(value => {
            if (!active || controller.signal.aborted) return;
            const revoked = new Set(value.revoked);
            const releases = [...value.financeReleases, ...value.replayReleases]
                .filter(release => !revoked.has(release.id))
                .sort((a, b) => Date.parse(b.firstSeenAt) - Date.parse(a.firstSeenAt));
            const companies = new Map<string, Company>();
            for (const release of releases) for (const item of release.items) {
                if (!companies.has(item.symbol) && (item.market === 'TSE' || item.market === 'OTC')) {
                    companies.set(item.symbol, { symbol: item.symbol, name: item.name,
                        market: item.market === 'TSE' ? '上市' : '上櫃' });
                }
            }
            const dates = [...new Set(value.replayReleases.filter(release => !revoked.has(release.id))
                .flatMap(release => release.items.map(item => item.date)).filter(validResearchDate))].sort().reverse();
            setCatalog({ phase: 'ready', companies: [...companies.values()], dates,
                notice: `本機目錄 ${companies.size} 檔 · ${dates.length} 個重播日期；未列日期仍可查詢，缺資料會明示。` });
        }).catch((error: unknown) => {
            if (!active || controller.signal.aborted) return;
            setCatalog({ phase: 'error', companies: [], dates: [],
                notice: `本機資料目錄無法載入：${error instanceof Error ? error.message : '來源不可用'}。仍可輸入四碼查詢；不替換成示範值。` });
        });
        return () => { active = false; controller.abort(); };
    }, [workspace.sourceMode]);
    useEffect(() => {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace)); setSaved(true); }
        catch { setSaved(false); }
    }, [workspace]);

    function selectSymbol(symbol: string) {
        if (!validSymbol(symbol)) { setMessage('請輸入四碼台股代號。'); return; }
        setWorkspace(previous => ({ ...previous, symbol }));
        setDraft(symbol); setMessage('');
    }
    function addPanel() {
        setWorkspace(previous => {
            if (previous.panels.length >= MAX_PANELS) return previous;
            const id = `research-${crypto.randomUUID()}`;
            const bottom = previous.layout.reduce((y, item) => Math.max(y, item.y + item.h), 0);
            return {
                ...previous, panels: [...previous.panels, { id, type: 'neo-research', pin: null }],
                layout: [...previous.layout, {
                    i: id, x: 0,
                    y: Math.min(bottom, RESEARCH_GRID_LIMITS.maxRows - DEFAULT_PANEL_SIZE.h),
                    ...DEFAULT_PANEL_SIZE,
                }],
            };
        });
    }

    const companyFor = (symbol: string): Company | undefined =>
        (workspace.sourceMode === 'real' ? catalog.companies : []).find(item => item.symbol === symbol)
        ?? RESEARCH_SYMBOLS.find(item => item.symbol === symbol);
    const quickCompanies: Company[] = RESEARCH_SYMBOLS.map(item => companyFor(item.symbol)!);
    const selectedCompany = companyFor(workspace.symbol);
    if (selectedCompany && !quickCompanies.some(item => item.symbol === selectedCompany.symbol)) quickCompanies.push(selectedCompany);
    const replayDates = workspace.sourceMode === 'fixture' ? [...RESEARCH_DATES] : catalog.dates;

    return <div className='research-shell'>
        <header className='research-header'>
            <div className='research-brand'><span className='research-mark'><BookOpen size={21} /></span>
                <div><p>SHIOAJI PRO · COMMUNITY FORK</p><h1>Neo 研究工作台</h1></div></div>
            <div className='research-header-end'><span className='research-mode'><ShieldCheck size={14} />觀察模式</span>
                <span className='research-build'>dev · {__SHIOAJI_BUILD_VERSION__}</span></div>
        </header>
        <div className='research-demo' role='note' data-source={workspace.sourceMode}><Database size={15} />
            <strong>{workspace.sourceMode === 'fixture' ? '示範資料，非真實行情或財報' : '真實資料 · 本機已驗公開財務與 neo 唯讀重播'}</strong>
            <span>{workspace.sourceMode === 'fixture' ? '本機合成資料' : '兩資料集各自標示來源與時點'} · 無券商連線 · 台北時間</span>
        </div>
        <div className='research-body'>
            <aside className='research-sidebar' aria-label='研究商品'>
                <div className='research-sidebar-title'>快捷代號 <span>{String(quickCompanies.length).padStart(2, '0')}</span></div>
                <p className='research-sidebar-note'>選擇商品，連動所有未鎖定面板</p>
                <nav aria-label={workspace.sourceMode === 'fixture' ? '示範商品' : '研究商品快捷代號'}>
                    {quickCompanies.map(item => <button key={item.symbol} className='research-stock'
                        aria-current={workspace.symbol === item.symbol ? 'true' : undefined}
                        onClick={() => selectSymbol(item.symbol)}>
                        <span><strong>{item.symbol}</strong><small>{item.market}</small></span>
                        <span>{item.name}</span>
                    </button>)}
                </nav>
                {workspace.sourceMode === 'real' && <p className='research-catalog-notice'
                    role={catalog.phase === 'error' ? 'alert' : 'status'}>{catalog.notice || '可直接輸入四碼代號查詢。'}</p>}
                <form className='research-search' onSubmit={event => { event.preventDefault(); selectSymbol(draft.trim()); }}>
                    <label htmlFor='research-symbol'>其他代號</label>
                    <div><input id='research-symbol' inputMode='numeric' maxLength={4} value={draft}
                        onChange={event => setDraft(event.target.value)} placeholder='四碼代號' />
                        <button type='submit'>查詢</button></div>
                    <p role='status'>{message || '未收錄的代號會顯示缺資料。'}</p>
                </form>
                <div className='research-sidebar-bottom'><span className='research-dot' />{workspace.sourceMode === 'fixture' ? '示範研究入口' : '本機快照讀取'}
                    <p>選股、模式、版面與鎖定狀態只儲存在此瀏覽器。研究資料維持觀察用途。</p></div>
            </aside>
            <main className='research-main'>
                <div className='research-toolbar'>
                    <div className='research-context'><span>工作區</span><strong>{workspace.symbol}</strong>
                        <span>{selectedCompany?.name ?? '未收錄商品'}</span></div>
                    <label>資料<select aria-label='資料來源' value={workspace.sourceMode}
                        onChange={event => {
                            const sourceMode = event.target.value === 'fixture' ? 'fixture' : 'real';
                            setWorkspace(previous => ({ ...previous, sourceMode,
                                financeMode: sourceMode === 'fixture' ? 'as_of' : 'latest' }));
                        }}>
                        <option value='real'>真實快照</option><option value='fixture'>示範資料</option>
                    </select></label>
                    <label>財務<select aria-label='財務時點' disabled={workspace.sourceMode === 'fixture'} value={workspace.financeMode}
                        onChange={event => setWorkspace(previous => ({ ...previous,
                            financeMode: event.target.value === 'latest' ? 'latest' : 'as_of' }))}>
                        <option value='latest'>最新可用</option><option value='as_of'>跟隨重播時點</option>
                    </select></label>
                    <label>重播日期<input aria-label='交易日' type='date' list='research-replay-dates' value={workspace.date}
                        onChange={event => { if (validResearchDate(event.target.value)) setWorkspace(previous => ({ ...previous, date: event.target.value })); }} /></label>
                    <datalist id='research-replay-dates'>{replayDates.map(date => <option key={date} value={date} />)}</datalist>
                    <label>重播截至<input aria-label='截至時間' type='time' min='08:00' max='13:59' value={workspace.cutoff}
                        onChange={event => { const value = event.target.value;
                            if (/^(?:0[89]|1[0-3]):[0-5]\d$/.test(value)) setWorkspace(previous => ({ ...previous, cutoff: value }));
                        }} /></label>
                    <button className='research-add' onClick={addPanel} disabled={workspace.panels.length >= MAX_PANELS}>
                        <Plus size={14} />新增研究面板</button>
                    <button className='research-reset' title='重設研究版面與選股'
                        onClick={() => { setWorkspace(defaultWorkspace()); setDraft('2330'); setMessage(''); }}><RotateCcw size={14} />重設</button>
                </div>
                <p className='research-clock-note' role='note'>{workspace.sourceMode === 'fixture' ? '示範模式：數值皆為合成資料，不代表公告歷史。'
                    : workspace.financeMode === 'latest' ? '財務使用最新可用版本；重播仍跟隨右方日期與游標，兩者時點不同。'
                        : '歷史財務只使用重播截止前已留存版本；沒有留存就顯示缺資料，不以今次下載回填。'}</p>
                <div className='research-workspace-info'><span>拖拉標題列調整位置，拖拉右下角調整大小</span>
                    <span role='status'>{saved ? '版面已儲存於本機' : '本次版面變更未儲存'} · {workspace.panels.length}/{MAX_PANELS}</span></div>
                <div className='research-grid' ref={containerRef}>
                    {workspace.panels.length === 0 && <div className='research-empty'><BookOpen size={28} />
                        <h2>建立你的研究版面</h2><p>加入研究面板，比較不同商品與同一時間的資料。</p>
                        <button onClick={addPanel}>新增研究面板</button></div>}
                    {mounted && workspace.panels.length > 0 && <GridLayout width={width} layout={workspace.layout}
                        gridConfig={{ ...RESEARCH_GRID_LIMITS, rowHeight: 30, margin: [14, 14], containerPadding: [0, 0] }}
                        dragConfig={{ handle: '.drag-handle', cancel: 'button,input,select,a' }}
                        onLayoutChange={layout => setWorkspace(previous => ({ ...previous, layout: [...layout] }))}>
                        {workspace.panels.map(panel => {
                            const symbol = panel.pin ?? workspace.symbol;
                            return <section key={panel.id} className={`${panelStyles.panel} research-panel`}
                                aria-label={`研究面板 ${symbol}`} data-panel-id={panel.id}>
                                <PanelChrome title='Neo 研究' symbolCode={symbol}
                                    symbolName={companyFor(symbol)?.name}
                                    pinnable pin={panel.pin} currentCode={workspace.symbol}
                                    onPinChange={pin => {
                                        if (pin !== null && !validSymbol(pin)) return false;
                                        setWorkspace(previous => ({ ...previous, panels: previous.panels.map(item => item.id === panel.id ? { ...item, pin } : item) }));
                                    }}
                                    onRemove={() => setWorkspace(previous => ({ ...previous,
                                        panels: previous.panels.filter(item => item.id !== panel.id),
                                        layout: previous.layout.filter(item => item.i !== panel.id),
                                    }))} />
                                <NeoResearchPanel symbol={symbol} date={workspace.date} cutoff={workspace.cutoff}
                                    sourceMode={workspace.sourceMode} financeMode={workspace.financeMode} />
                            </section>;
                        })}
                    </GridLayout>}
                </div>
                <footer className='research-footer'><span>Pro Web fork · {workspace.sourceMode === 'fixture' ? '示範資料' : '真實資料唯讀研究'}</span>
                    <span>awareness_only · decision_eligible=false</span></footer>
            </main>
        </div>
    </div>;
}
