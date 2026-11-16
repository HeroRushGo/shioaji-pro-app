import { useEffect, useState } from 'react';
import GridLayout, { useContainerWidth } from 'react-grid-layout';
import { BookOpen, Database, Plus, RotateCcw, ShieldCheck } from 'lucide-react';
import { PanelChrome } from '../components/panel-chrome';
import * as panelStyles from '../components/panel.css';
import { NeoResearchPanel } from '../features/neo-research/NeoResearchPanel';
import { RESEARCH_DATES, RESEARCH_SYMBOLS } from '../features/neo-research/model';
import { defaultWorkspace, MAX_PANELS, restoreWorkspace, STORAGE_KEY, validSymbol } from './workspace';
import type { ResearchWorkspace } from './workspace';
import 'react-grid-layout/css/styles.css';
import './research.css';

function initialWorkspace(): ResearchWorkspace {
    try { return restoreWorkspace(localStorage.getItem(STORAGE_KEY)); }
    catch { return defaultWorkspace(); }
}

export function ResearchApp() {
    const [workspace, setWorkspace] = useState(initialWorkspace);
    const [draft, setDraft] = useState(workspace.symbol);
    const [message, setMessage] = useState('');
    const [saved, setSaved] = useState(true);
    const { width, containerRef, mounted } = useContainerWidth();
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
                layout: [...previous.layout, { i: id, x: 0, y: bottom, w: 6, h: 16, minW: 4, minH: 10 }],
            };
        });
    }

    return <div className='research-shell'>
        <header className='research-header'>
            <div className='research-brand'><span className='research-mark'><BookOpen size={21} /></span>
                <div><p>SHIOAJI PRO · COMMUNITY FORK</p><h1>Neo 研究工作台</h1></div></div>
            <div className='research-header-end'><span className='research-mode'><ShieldCheck size={14} />觀察模式</span>
                <span className='research-build'>dev · {__SHIOAJI_BUILD_VERSION__}</span></div>
        </header>
        <div className='research-demo' role='note'><Database size={15} />
            <strong>示範資料，非真實行情或財報</strong><span>本機合成資料 · 無券商連線 · 截止時間為台北時間</span>
        </div>
        <div className='research-body'>
            <aside className='research-sidebar' aria-label='研究商品'>
                <div className='research-sidebar-title'>研究清單 <span>04</span></div>
                <p className='research-sidebar-note'>選擇商品，連動所有未鎖定面板</p>
                <nav aria-label='示範商品'>
                    {RESEARCH_SYMBOLS.map(item => <button key={item.symbol} className='research-stock'
                        aria-current={workspace.symbol === item.symbol ? 'true' : undefined}
                        onClick={() => selectSymbol(item.symbol)}>
                        <span><strong>{item.symbol}</strong><small>{item.market}</small></span>
                        <span>{item.name}</span>
                    </button>)}
                </nav>
                <form className='research-search' onSubmit={event => { event.preventDefault(); selectSymbol(draft.trim()); }}>
                    <label htmlFor='research-symbol'>其他代號</label>
                    <div><input id='research-symbol' inputMode='numeric' maxLength={4} value={draft}
                        onChange={event => setDraft(event.target.value)} placeholder='四碼代號' />
                        <button type='submit'>查詢</button></div>
                    <p role='status'>{message || '未收錄的代號會顯示缺資料。'}</p>
                </form>
                <div className='research-sidebar-bottom'><span className='research-dot' />離線研究入口
                    <p>選股、版面與鎖定狀態只儲存在此瀏覽器。示範值不可用於交易。</p></div>
            </aside>
            <main className='research-main'>
                <div className='research-toolbar'>
                    <div className='research-context'><span>工作區</span><strong>{workspace.symbol}</strong>
                        <span>{RESEARCH_SYMBOLS.find(item => item.symbol === workspace.symbol)?.name ?? '未收錄商品'}</span></div>
                    <label>交易日<select aria-label='交易日' value={workspace.date}
                        onChange={event => setWorkspace(previous => ({ ...previous, date: event.target.value }))}>
                        {RESEARCH_DATES.map(date => <option key={date}>{date}</option>)}
                    </select></label>
                    <label>截至<input aria-label='截至時間' type='time' min='08:00' max='13:59' value={workspace.cutoff}
                        onChange={event => { const value = event.target.value;
                            if (/^(?:0[89]|1[0-3]):[0-5]\d$/.test(value)) setWorkspace(previous => ({ ...previous, cutoff: value }));
                        }} /></label>
                    <button className='research-add' onClick={addPanel} disabled={workspace.panels.length >= MAX_PANELS}>
                        <Plus size={14} />新增研究面板</button>
                    <button className='research-reset' title='重設研究版面與選股'
                        onClick={() => { setWorkspace(defaultWorkspace()); setDraft('2330'); setMessage(''); }}><RotateCcw size={14} />重設</button>
                </div>
                <div className='research-workspace-info'><span>拖拉標題列調整位置，拖拉右下角調整大小</span>
                    <span role='status'>{saved ? '版面已儲存於本機' : '儲存不可用，重載將回到預設版面'} · {workspace.panels.length}/{MAX_PANELS}</span></div>
                <div className='research-grid' ref={containerRef}>
                    {workspace.panels.length === 0 && <div className='research-empty'><BookOpen size={28} />
                        <h2>建立你的研究版面</h2><p>加入研究面板，比較不同商品與同一時間的資料。</p>
                        <button onClick={addPanel}>新增研究面板</button></div>}
                    {mounted && workspace.panels.length > 0 && <GridLayout width={width} layout={workspace.layout}
                        gridConfig={{ cols: 12, rowHeight: 30, margin: [14, 14], containerPadding: [0, 0] }}
                        dragConfig={{ handle: '.drag-handle', cancel: 'button,input,select,a' }}
                        onLayoutChange={layout => setWorkspace(previous => ({ ...previous, layout: [...layout] }))}>
                        {workspace.panels.map(panel => {
                            const symbol = panel.pin ?? workspace.symbol;
                            return <section key={panel.id} className={`${panelStyles.panel} research-panel`}
                                aria-label={`研究面板 ${symbol}`} data-panel-id={panel.id}>
                                <PanelChrome title='Neo 研究' symbolCode={symbol}
                                    symbolName={RESEARCH_SYMBOLS.find(item => item.symbol === symbol)?.name}
                                    pinnable pin={panel.pin} currentCode={workspace.symbol}
                                    onPinChange={pin => {
                                        if (pin !== null && !validSymbol(pin)) return;
                                        setWorkspace(previous => ({ ...previous, panels: previous.panels.map(item => item.id === panel.id ? { ...item, pin } : item) }));
                                    }}
                                    onRemove={() => setWorkspace(previous => ({ ...previous,
                                        panels: previous.panels.filter(item => item.id !== panel.id),
                                        layout: previous.layout.filter(item => item.i !== panel.id),
                                    }))} />
                                <NeoResearchPanel symbol={symbol} date={workspace.date} cutoff={workspace.cutoff} />
                            </section>;
                        })}
                    </GridLayout>}
                </div>
                <footer className='research-footer'><span>Pro Web fork · 研究面板原型</span>
                    <span>awareness_only · decision_eligible=false</span></footer>
            </main>
        </div>
    </div>;
}
