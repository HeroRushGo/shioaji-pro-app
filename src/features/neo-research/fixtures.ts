// Synthetic data only. Company labels identify UI examples; none of the
// financial or market values below come from those companies or a broker.

export const RESEARCH_SYMBOLS = [
    { symbol: '2330', name: '台積電', market: '上市' },
    { symbol: '2377', name: '微星', market: '上市' },
    { symbol: '6488', name: '環球晶', market: '上櫃' },
    { symbol: '2891', name: '中信金', market: '上市' },
] as const;

export const RESEARCH_DATES = ['2026-11-13', '2026-11-12'] as const;
export const FIXTURE_RELEASE_ID = 'neo-research-synthetic-v1';
export const FIXTURE_NOTICE = '示範資料，非真實行情或財報；僅供研究工作台操作驗證。';

export interface ResearchFixture {
    revenue: { period: string; revenueThousands: number; yoyPercent: number | null }[];
    quarters: { period: string; eps: number | null; grossMarginPercent: number | null }[];
    replay: { time: string; price: number; vwap: number; poc: number }[];
}

const PRICE_BASES: Record<string, number> = {
    '2330': 100,
    '2377': 80,
    '6488': 60,
    '2891': 20,
};

/** Every invocation returns fresh rows so a consumer cannot mutate future reads. */
export function fixtureFor(symbol: string, date: string): ResearchFixture | undefined {
    const symbolIndex = RESEARCH_SYMBOLS.findIndex(entry => entry.symbol === symbol);
    const dateIndex = RESEARCH_DATES.findIndex(entry => entry === date);
    const base = PRICE_BASES[symbol];
    if (symbolIndex < 0 || dateIndex < 0 || base === undefined) return undefined;

    // Distinct day fixtures deliberately expose accidental date-key reuse.
    const dayOffset = dateIndex === 0 ? 2 : -2;
    const round = (value: number) => Math.round(value * 100) / 100;
    const times = ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30'];
    const prices = times.map((_, index) => round(base + dayOffset + [0, 1, -0.5, 1.5, 2, 1, 2.5, 3, 2, 3.5][index]!));

    return {
        revenue: ['2026-07', '2026-08', '2026-09'].map((period, index) => ({
            period,
            revenueThousands: (symbolIndex + 1) * 100_000 + index * 10_000,
            yoyPercent: index === 0 ? null : (symbolIndex + 1) * 2 + index,
        })),
        quarters: ['2025Q3', '2025Q4', '2026Q1', '2026Q2'].map((period, index) => ({
            period,
            eps: round(0.5 + symbolIndex * 0.25 + index * 0.1),
            // Banks do not share an industrial gross-margin format.
            grossMarginPercent: symbol === '2891' ? null : 20 + symbolIndex * 5 + index,
        })),
        replay: times.map((time, index) => ({
            time,
            price: prices[index]!,
            vwap: round(prices.slice(0, index + 1).reduce((sum, price) => sum + price, 0) / (index + 1)),
            poc: round(base + dayOffset + (index < 4 ? 0 : 1)),
        })),
    };
}
