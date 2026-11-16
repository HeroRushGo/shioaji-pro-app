import { describe, expect, it } from 'vitest';
import { parseIcEvent } from './index-components';
import { parseScannerMessages, scannerSignalKey } from './market-pulse';
import { projectMarketEvent } from './market-policy.mjs';
import { normalizeIndexQuote } from './stream';
import type { ScannerSignalEvent } from './types/market';
import { parseKbarEvent } from './chain-flow';

// Projection and the existing frontend parsers run together. Node gateway
// tests separately cover SSE framing and event-name filtering; no connection,
// subscription, SDK, or vendor request is started by these parser tests.
const wire = (name: string, raw: unknown) => JSON.stringify(projectMarketEvent(raw, name));
// Existing batch fixture: chain-flow.test.ts:82-90. The last three rows
// intentionally cannot be placed; projection must preserve parser behavior.
const kbarRows = [
    { code: '2330', time: '09:01:00', close: 1000, amount: 1 },
    { code: '2317', datetime: '2026-10-21 09:02:00', close: 200, amount: 2 },
    { code: '2454', time: '14:00:00', close: 1, amount: 1 },
    { code: '1101', time: '09:03:00', close: 0, amount: 1 },
    { time: '09:03:00', close: 1, amount: 1 },
];

describe('market gateway projection reaches the existing frontend consumers', () => {
    it.each(['rows', 'bars', 'data', 'kbars'])('preserves the %s kbar wrapper for the actual batch consumer', wrapper => {
        // Fixture uses rows; its documented sibling wrappers are selected by
        // the same existing parseKbarEvent branch (chain-flow.ts:128-152).
        const raw = { date: '2026/10/21', [wrapper]: kbarRows };
        const parsed = parseKbarEvent(wire('kbar', raw));
        expect(parsed).toEqual(parseKbarEvent(raw));
        expect(parsed.map(row => [row.code, row.slot, row.date])).toEqual([
            ['2330', 0, '2026-10-21'], ['2317', 1, '2026-10-21'],
        ]);
    });

    it('preserves root-array kbar events that the existing consumer accepts', () => {
        const parsed = parseKbarEvent(wire('kbar', kbarRows));
        expect(parsed).toEqual(parseKbarEvent(kbarRows));
        expect(parsed.map(row => [row.code, row.slot])).toEqual([['2330', 0], ['2317', 1]]);
    });

    it('preserves the parser-supported ts alias for the existing batch timestamp', () => {
        // Same 2317 timestamp/value as chain-flow.test.ts:86, using the ts
        // spelling explicitly supported by chain-flow.ts:98-99/106. This is
        // compatibility coverage, not a newly captured vendor wire sample.
        const raw = { code: '2317', ts: '2026-10-21 09:02:00', close: 200, amount: 2 };
        const parsed = parseKbarEvent(wire('kbar', raw));
        expect(parsed).toEqual(parseKbarEvent(raw));
        expect(parsed).toMatchObject([{ code: '2317', date: '2026-10-21', slot: 1, close: 200, amount: 2 }]);
    });

    it('keeps scanner rule identity, price and change detail usable by the market pulse rows', () => {
        // Upstream raw fixture: shioaji-1.7.1.test.ts:179-191.
        const raw = {
            scanner: 'trade_price_surge', region: 'TW', security_type: 'STK', exchange: 'TSE',
            quote: { code: '2330', date: '2026-07-31', time: '09:00:01.000000', close: '1040' },
            extra: { change_percent: '1.25' },
        };
        const parsed = parseScannerMessages(wire('scanner', raw), 123);
        expect(parsed).toEqual(parseScannerMessages(JSON.stringify(raw), 123));
        expect(parsed).toHaveLength(1);
        const signal = parsed[0] as ScannerSignalEvent;
        expect(scannerSignalKey(signal)).toBe('TSE:trade_price_surge:2330:2026-07-31:09:00:01.000000');
        expect(signal.quote.close).toBe('1040');
        expect(signal.extra.change_percent).toBe('1.25');
    });

    it('expands the plural scanner state fixture instead of discarding it as an empty event', () => {
        // Upstream raw fixture: shioaji-1.7.1.test.ts:215-225.
        const raw = {
            scanners: ['simtrade'], region: 'TW', security_type: 'STK', exchange: 'OTC',
            quote: { code: '6488', date: '2026-07-31', time: '08:59:00.000000', simtrade: true },
        };
        const parsed = parseScannerMessages(wire('scanner', raw), 789);
        expect(parsed).toEqual(parseScannerMessages(JSON.stringify(raw), 789));
        expect(parsed).toMatchObject([{ scanner: 'simtrade', quote: { code: '6488', simtrade: true }, extra: {}, received_at: 789 }]);
    });

    it('recognizes the existing scanner reconnect-gap report and preserves the visible dropped count', () => {
        // Upstream raw fixture: shioaji-1.7.1.test.ts:202-206.
        const raw = { dropped_count: 7, first_time: '09:00:00', last_time: '09:00:03', subscriptions: [] };
        const parsed = parseScannerMessages(wire('scanner', raw), 456);
        expect(parsed).toEqual(parseScannerMessages(JSON.stringify(raw), 456));
        expect(parsed).toEqual([{ ...raw, received_at: 456 }]);
    });

    it('retains ranking projection identity and decimal values for parseIcEvent', () => {
        // Real 1.7.4 capture retained upstream: index-components.test.ts:42-77.
        const raw = {
            contract: { security_type: 'IND', region: 'TW', exchange: 'TSE', code: 'IX0001' },
            projection: { kind: 'ranking', target: 'component', metric: 'contribution', order: 'negative_asc', limit: 25 },
            date: '2026-08-28', time: '09:28:00.000000', calculated_at: '2026-08-28T09:28:00.000000+08:00',
            reference_date: '2026-08-28', market_phase: 'continuous_trading', simtrade: false,
            entries: [{ code: '8046', category: '28', value: '-5.94', price: '1265.00', reference: '1295.00',
                price_chg: '-30.00', pct_chg: '-2.32', reference_weight_ppm: 5577,
                price_source: 'regular', trading_status: 'active', data_status: 'live' }],
        };
        const parsed = parseIcEvent(wire('index_components', raw));
        expect(parsed).toEqual(parseIcEvent(JSON.stringify(raw)));
        expect(parsed).toMatchObject({ code: 'IX0001', projKey: 'rk:contribution:negative_asc:25',
            state: { kind: 'ranking', calculatedAt: raw.calculated_at, marketPhase: 'continuous_trading',
                entries: [{ code: '8046', value: -5.94, price: 1265, weight_pct: 0.5577 }] } });
    });

    it('retains the group metric projection and its row values for parseIcEvent', () => {
        // Upstream raw fixture: index-components.test.ts:93-104.
        const raw = {
            contract: { code: 'IX0001' }, projection: { kind: 'group_metric', metric: 'contribution' },
            date: '2026-08-28', time: '09:28:01.000000', calculated_at: '2026-08-28T09:28:01.000000+08:00',
            market_phase: 'continuous_trading', simtrade: false, unit: 'points',
            groups: [{ category: '1', name: '水泥工業', item_count: 7, value: '-0.32' }],
        };
        const parsed = parseIcEvent(wire('index_components', raw));
        expect(parsed).toEqual(parseIcEvent(JSON.stringify(raw)));
        expect(parsed).toMatchObject({ code: 'IX0001', projKey: 'gm:contribution',
            state: { kind: 'group_metric', groups: [{ category: '1', name: '水泥工業', item_count: 7, value: -0.32 }] } });
    });

    it('normalizes the real PascalCase QuoteIdxV1 sample without losing index close or breadth', () => {
        // Upstream raw sample: stream-index-close.test.ts:39.
        const raw = { Code: 'IX0001', Exchange: 'TSE', Date: '2026/10/19', Time: '13:33:00.000000',
            Reference: '47111.26', Open: '46844.64', High: '46844.64', Low: '46170.0', Close: '46822.08',
            Raise: 160, Flat: 72, Fall: 862, RaiseStop: 7, FallStop: 2 };
        const parsed = normalizeIndexQuote(wire('quote_idx', raw));
        expect(parsed).toEqual(normalizeIndexQuote(JSON.stringify(raw)));
        expect(parsed).toMatchObject({ code: 'IX0001', exchange: 'TSE', date: '2026/10/19',
            time: '13:33:00.000000', close: '46822.08', raise_count: 160, flat_count: 72,
            fall_count: 862, limit_up_count: 7, limit_down_count: 2 });
    });
});
