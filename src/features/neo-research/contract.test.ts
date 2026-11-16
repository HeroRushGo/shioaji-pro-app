import { createElement, useEffect } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractInfo } from '../../lib/types/contract';
import { researchSymbolForContract } from './contract';

const observed = vi.hoisted(() => ({
    renders: [] as string[], mounts: [] as string[], unmounts: [] as string[],
}));
vi.mock('./NeoResearchPanel', () => ({
    NeoResearchPanel: (props: { symbol: string; date?: string; cutoff?: string }) => {
        observed.renders.push(props.symbol);
        useEffect(() => {
            observed.mounts.push(props.symbol);
            return () => { observed.unmounts.push(props.symbol); };
        }, [props.symbol]);
        return createElement('div', {
            'data-fixture': props.symbol,
            'data-date': props.date,
            'data-cutoff': props.cutoff,
        }, `fixture:${props.symbol}:123.45`);
    },
}));
import { NeoContractResearchPanel } from './NeoContractResearchPanel';

function contract(overrides: Partial<ContractInfo> = {}): ContractInfo {
    return {
        region: 'TW', exchange: 'TSE', security_type: 'STK', code: '2330',
        target_code: null, name: '台積電', currency: 'TWD',
        limit_up: 0, limit_down: 0, reference: 0, day_trade: '', update_date: '',
        category: '', margin_trading_balance: 0, short_selling_balance: 0,
        ...overrides,
    };
}

const invalidContracts: readonly [string, ContractInfo | null | undefined][] = [
    ['no contract', null],
    ['undefined contract', undefined],
    ['missing region', contract({ region: undefined })],
    ['US region', contract({ region: 'US' })],
    ['HK region', contract({ region: 'HK' })],
    ['JP region', contract({ region: 'JP' })],
    ['futures', contract({ security_type: 'FUT' })],
    ['options', contract({ security_type: 'OPT' })],
    ['warrants', contract({ security_type: 'WRT' })],
    ['index', contract({ security_type: 'IND' })],
    ['missing security type', contract({ security_type: null })],
    ['same code with OTC exchange', contract({ exchange: 'OTC' })],
    ['OES exchange', contract({ exchange: 'OES' })],
    ['TAIFEX exchange', contract({ exchange: 'TAIFEX' })],
    ['missing exchange', contract({ exchange: null })],
    ['unknown stock', contract({ code: '0000' })],
    ['different target code', contract({ target_code: '2377' })],
    ['OTC stock with TSE exchange', contract({ code: '6488', exchange: 'TSE' })],
    ['combo identity', contract({ combo: { code: '2330', combo_type: 'Spread', legs: [] } })],
];

describe('upstream contract to research fixture identity', () => {
    it.each([null, undefined, '', '2330'])('accepts a target resolving to its own primary code: %s', target_code => {
        expect(researchSymbolForContract(contract({ target_code }))).toBe('2330');
    });
    it.each([
        ['2330', 'TSE'], ['2377', 'TSE'], ['2891', 'TSE'], ['6488', 'OTC'],
    ] as const)('accepts TW/STK/%s only on its declared %s market', (code, exchange) => {
        expect(researchSymbolForContract(contract({ code, exchange }))).toBe(code);
    });

    it.each(invalidContracts)('rejects %s without reducing it to a known code', (_label, selected) => {
        expect(researchSymbolForContract(selected)).toBeNull();
    });
});

let view: ReactTestRenderer | undefined;
function render(selected: ContractInfo | null | undefined) {
    act(() => { view = create(createElement(NeoContractResearchPanel, { contract: selected })); });
}
function update(selected: ContractInfo | null | undefined) {
    act(() => { view!.update(createElement(NeoContractResearchPanel, { contract: selected })); });
}
function text(node: ReactTestInstance | string): string {
    return typeof node === 'string' ? node : node.children.map(text).join('');
}
function fixtureNodes() {
    return view!.root.findAll(node => typeof node.type === 'string' && node.props['data-fixture'] !== undefined);
}

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    observed.renders.length = 0;
    observed.mounts.length = 0;
    observed.unmounts.length = 0;
});
afterEach(() => {
    act(() => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

describe('contract-aware research renderer', () => {
    it('clears numbers for a different target, then mounts the primary fixture again', () => {
        render(contract({ target_code: null }));
        update(contract({ target_code: '2377' }));
        expect(fixtureNodes()).toHaveLength(0);
        expect(text(view!.root)).not.toContain('123.45');
        expect(observed.unmounts).toEqual(['2330']);
        update(contract({ target_code: null }));
        expect(fixtureNodes()).toHaveLength(1);
        expect(observed.mounts).toEqual(['2330', '2330']);
    });
    it('unmounts TSE/2330 immediately for OTC/2330, then mounts a fresh valid fixture when switched back', () => {
        render(contract());
        expect(fixtureNodes()).toHaveLength(1);
        expect(text(view!.root)).toContain('fixture:2330:123.45');
        expect(observed.mounts).toEqual(['2330']);

        update(contract({ exchange: 'OTC' }));
        expect(fixtureNodes()).toHaveLength(0);
        expect(text(view!.root)).toContain('此商品沒有示範資料');
        expect(text(view!.root)).not.toContain('123.45');
        expect(observed.renders).toEqual(['2330']);
        expect(observed.unmounts).toEqual(['2330']);

        update(contract());
        expect(fixtureNodes()).toHaveLength(1);
        expect(text(view!.root)).toContain('fixture:2330:123.45');
        expect(observed.mounts).toEqual(['2330', '2330']);
    });

    it.each(invalidContracts)('clears the prior numeric content for %s in the same update', (_label, selected) => {
        render(contract());
        update(selected);
        expect(fixtureNodes()).toHaveLength(0);
        expect(text(view!.root)).toContain('此商品沒有示範資料');
        expect(text(view!.root)).not.toContain('fixture:');
        expect(text(view!.root)).not.toContain('123.45');
        expect(observed.renders).toEqual(['2330']);
        expect(observed.unmounts).toEqual(['2330']);
    });

    it('renders the correct OTC fixture and passes the query boundary through', () => {
        act(() => {
            view = create(createElement(NeoContractResearchPanel, {
                contract: contract({ code: '6488', exchange: 'OTC' }),
                date: '2026-11-12', cutoff: '10:00',
            }));
        });
        const nodes = fixtureNodes();
        expect(nodes).toHaveLength(1);
        expect(nodes[0]!.props).toMatchObject({
            'data-fixture': '6488', 'data-date': '2026-11-12', 'data-cutoff': '10:00',
        });
        expect(observed.mounts).toEqual(['6488']);
    });
});
