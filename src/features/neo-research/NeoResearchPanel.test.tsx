import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResearchQuery, ResearchSnapshot } from './model';

const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('./model', () => ({ loadResearchSnapshot: mocks.load }));
import { NeoResearchPanel } from './NeoResearchPanel';

type Props = Parameters<typeof NeoResearchPanel>[0];
const realQuery: ResearchQuery = {
    symbol: '2330', date: '2026-11-13', cutoff: '10:00', sourceMode: 'real', financeMode: 'latest',
};
function snapshot(query: ResearchQuery, patch: Partial<ResearchSnapshot> = {}): ResearchSnapshot {
    const source = query.sourceMode ?? 'fixture';
    return {
        query, name: '台積電', market: '上市', status: 'ready', source,
        releaseId: 'combined-test', asOf: `${query.date}T${query.cutoff}:00+08:00`, notice: '',
        revenue: [{ period: '2026-09', revenueThousands: 1234567, yoyPercent: null }],
        quarters: [
            { period: '2026Q1', eps: 2.75, grossMarginPercent: null, epsBasis: 'quarter_reported_q1' },
            { period: '2026Q2', eps: 3.25, grossMarginPercent: 51, epsBasis: 'quarter_derived_from_ytd' },
        ],
        replay: [{ time: '10:00', price: 777, vwap: 776.25, poc: 775 }],
        finance: { status: 'ready', source: source === 'fixture' ? 'fixture' : 'shioaji-public',
            releaseId: 'finance-new', firstSeenAt: '2026-11-16T11:00:00+08:00', notice: '財務來源已核對',
            provenance: { sourceSha256: 'finance-sha', sourceUrl: 'https://example.test/finance' } },
        replayInfo: { status: 'ready', source: source === 'fixture' ? 'fixture' : 'neo-export',
            releaseId: 'replay-old', firstSeenAt: '2026-11-16T11:05:00+08:00', notice: 'neo 匯出',
            actualAsOf: `${query.date}T10:00:00+08:00`, samplingMinutes: 30 },
        decisionUse: 'awareness_only', decisionEligible: false,
        ...patch,
    };
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    return { promise: new Promise<T>(yes => { resolve = yes; }), resolve };
}
function text(node: ReactTestInstance | string): string {
    return typeof node === 'string' ? node : node.children.map(text).join('');
}
let view: ReactTestRenderer | undefined;
async function render(props: Props = realQuery) {
    await act(async () => { view = create(createElement(NeoResearchPanel, props)); });
}
function update(props: Props) {
    act(() => { view!.update(createElement(NeoResearchPanel, props)); });
}
function tab(label: string) {
    const button = view!.root.findAllByType('button').find(node => text(node) === label)!;
    act(() => button.props.onClick());
}
function output() { return text(view!.root); }

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.load.mockReset();
});
afterEach(() => {
    act(() => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

describe('real and synthetic research panel', () => {
    it('shows latest finance independently of missing replay, with separate time and source labels', async () => {
        const value = snapshot(realQuery);
        value.status = 'missing'; // A single global status must not hide a ready dataset.
        value.replay = [];
        value.replayInfo = { ...value.replayInfo, status: 'missing', actualAsOf: undefined, notice: '此日未匯出' };
        mocks.load.mockResolvedValue(value);
        await render();
        expect(output()).toContain('真實資料 · 唯讀本機已驗快照');
        expect(output()).toContain('最新可用財務，與重播時點不同；不是當時已知資料');
        expect(output()).toContain('首次留存：2026-11-16T11:00:00+08:00');
        expect(output()).toContain('要求截止：2026-11-13T10:00:00+08:00');
        expect(output()).toContain('1,234,567');
        expect(output()).toContain('neo 重播：缺資料');
        expect(output()).not.toContain('776.25');
        tab('來源');
        expect(output()).toContain('finance-new');
        expect(output()).toContain('finance-sha');
        expect(output()).toContain('replay-old');
        expect(output()).toContain('decision_eligible=false');
    });

    it('keeps historical finance unretained while still displaying the real neo prefix', async () => {
        const query = { ...realQuery, financeMode: 'as_of' as const };
        const value = snapshot(query);
        value.finance = { ...value.finance, status: 'not-retained', firstSeenAt: null, notice: '當時版本未留存' };
        // Even contradictory numeric arrays cannot escape a missing dataset's UI gate.
        value.revenue = [{ period: '2026-09', revenueThousands: 987654321, yoyPercent: 99 }];
        mocks.load.mockResolvedValue(value);
        await render(query);
        expect(output()).toContain('財務：當時版本未留存');
        expect(output()).not.toContain('987,654,321');
        expect(output()).not.toContain('最新可用財務');
        expect(output()).toContain('776.25');
        expect(output()).toContain('此頁不重算 VWAP／POC');
        expect(output()).toContain('採樣 30 分鐘');
    });

    it('labels the actual Q1 and derived-quarter EPS basis in each financial row', async () => {
        mocks.load.mockResolvedValue(snapshot(realQuery));
        await render();
        tab('財務');
        expect(output()).toContain('第一季公告值');
        expect(output()).toContain('單季，累計相減推算');
        const tables = view!.root.findAllByType('table');
        expect(tables).toHaveLength(2);
        expect(tables[1]!.findAllByType('tbody')[0]!.findAllByType('tr').map(text))
            .toEqual(['2026Q12.75第一季公告值—', '2026Q23.25單季，累計相減推算51%']);
    });

    it('does not imply a true EPS derivation for an unlabeled synthetic example', async () => {
        const query = { ...realQuery, sourceMode: 'fixture' as const, financeMode: 'as_of' as const };
        const value = snapshot(query);
        value.quarters = [{ period: '2026Q2', eps: 1, grossMarginPercent: null }];
        mocks.load.mockResolvedValue(value);
        await render(query);
        tab('財務');
        expect(output()).toContain('示範資料，非真實行情或財報');
        expect(output()).toContain('合成示範資料');
        expect(output()).not.toContain('單季，累計相減推算');
        expect(output()).not.toContain('第一季公告值');
    });

    it('preserves null replay values and breaks chart lines at missing samples', async () => {
        const value = snapshot(realQuery);
        value.replay = [
            { time: '09:00', price: 10, vwap: 10.25, poc: null },
            { time: '09:30', price: null, vwap: null, poc: null },
            { time: '10:00', price: 12, vwap: 12.25, poc: null },
        ];
        mocks.load.mockResolvedValue(value);
        await render();
        tab('重播');
        const rows = view!.root.findByType('tbody').findAllByType('tr');
        expect(rows.map(text)).toEqual(['09:001010.25—', '09:30———', '10:001212.25—']);
        expect(view!.root.findAllByType('polyline').every(node => node.props.points.split(' ').length === 1)).toBe(true);
        expect(view!.root.findAllByType('circle').every(node => Number.isFinite(node.props.cy))).toBe(true);
    });

    it('hides prior values immediately when source or finance mode changes', async () => {
        const pending = deferred<ResearchSnapshot>();
        mocks.load.mockResolvedValueOnce(snapshot(realQuery)).mockReturnValue(pending.promise);
        await render();
        expect(output()).toContain('1,234,567');
        const asOf = { ...realQuery, financeMode: 'as_of' as const };
        update(asOf);
        expect(output()).toContain('載入研究資料');
        expect(output()).not.toContain('1,234,567');
        expect((mocks.load.mock.calls[0]![1] as AbortSignal).aborted).toBe(true);
        const fixture = { ...asOf, sourceMode: 'fixture' as const };
        update(fixture);
        expect(output()).not.toContain('1,234,567');
        expect((mocks.load.mock.calls[1]![1] as AbortSignal).aborted).toBe(true);
        expect(mocks.load.mock.calls.at(-1)![0]).toEqual(fixture);
    });

    it('ignores a late synthetic response even if the adapter ignores cancellation', async () => {
        const old = deferred<ResearchSnapshot>(), current = deferred<ResearchSnapshot>();
        const fixture = { ...realQuery, sourceMode: 'fixture' as const, financeMode: 'as_of' as const };
        mocks.load.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
        await render(fixture);
        update(realQuery);
        const realValue = snapshot(realQuery);
        realValue.revenue[0]!.revenueThousands = 5555555;
        await act(async () => { current.resolve(realValue); });
        expect(output()).toContain('5,555,555');
        await act(async () => { old.resolve(snapshot(fixture)); });
        expect(output()).toContain('5,555,555');
        expect(output()).not.toContain('1,234,567');
        expect(output()).not.toContain('示範資料，非真實行情或財報');
    });

    it.each(['query', 'source'] as const)('rejects a mismatched %s identity without showing values', async mismatch => {
        const value = snapshot(realQuery);
        if (mismatch === 'query') value.query = { ...realQuery, financeMode: 'as_of' };
        else value.source = 'fixture';
        mocks.load.mockResolvedValue(value);
        await render();
        expect(output()).toContain('資料身分或來源不一致');
        expect(output()).not.toContain('1,234,567');
        expect(output()).not.toContain('776.25');
    });
});
