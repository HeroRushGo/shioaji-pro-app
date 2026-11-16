import type { LayoutItem } from 'react-grid-layout';

export const STORAGE_KEY = 'neo-pro-research-workspace-v1';
export const MAX_PANELS = 6;
export const RESEARCH_GRID_LIMITS = { cols: 12, maxRows: 330 } as const;
export const PANEL_SIZE_LIMITS = {
    minW: 4,
    maxW: RESEARCH_GRID_LIMITS.cols,
    minH: 10,
    maxH: 30,
} as const;
export const DEFAULT_PANEL_SIZE = { w: 6, h: 16, ...PANEL_SIZE_LIMITS } as const;
export type ResearchPanel = { id: string; type: 'neo-research'; pin: string | null };
export type ResearchWorkspace = {
    version: 2;
    symbol: string;
    date: string;
    cutoff: string;
    sourceMode: 'real' | 'fixture';
    financeMode: 'latest' | 'as_of';
    panels: ResearchPanel[];
    layout: LayoutItem[];
};

export function validSymbol(value: unknown): value is string {
    return typeof value === 'string' && /^\d{4}$/.test(value);
}

export function validResearchDate(value: unknown): value is string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function defaultWorkspace(): ResearchWorkspace {
    return {
        version: 2, symbol: '2330', date: '2026-11-13', cutoff: '13:30',
        sourceMode: 'real', financeMode: 'latest',
        panels: [
            { id: 'research-1', type: 'neo-research', pin: null },
            { id: 'research-2', type: 'neo-research', pin: '2891' },
        ],
        layout: [
            { i: 'research-1', x: 0, y: 0, ...DEFAULT_PANEL_SIZE },
            { i: 'research-2', x: 6, y: 0, ...DEFAULT_PANEL_SIZE },
        ],
    };
}

const record = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, low: number, high: number, fallback: number) => {
    const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    return Math.min(high, Math.max(low, Math.round(number)));
};

/** Only the research namespace is accepted. Never deserialize Pro trading panels. */
export function restoreWorkspace(raw: string | null): ResearchWorkspace {
    const defaults = defaultWorkspace();
    try {
        const value: unknown = JSON.parse(raw ?? 'null');
        if (!record(value) || (value.version !== 1 && value.version !== 2) || !Array.isArray(value.panels)) return defaults;
        // A v1 workspace only ever displayed synthetic data. Migration must
        // not turn its old date/cursor into an implicit real-data request.
        const sourceMode = value.version === 2 && value.sourceMode === 'real' ? 'real' : 'fixture';
        const financeMode = sourceMode === 'real' && value.financeMode === 'latest' ? 'latest' : 'as_of';
        const seen = new Set<string>();
        const panels: ResearchPanel[] = [];
        for (const candidate of value.panels) {
            if (!record(candidate) || candidate.type !== 'neo-research'
                || typeof candidate.id !== 'string' || !/^research-[a-zA-Z0-9-]{1,60}$/.test(candidate.id)
                || seen.has(candidate.id)) continue;
            seen.add(candidate.id);
            panels.push({ id: candidate.id, type: 'neo-research', pin: validSymbol(candidate.pin) ? candidate.pin : null });
            if (panels.length === MAX_PANELS) break;
        }
        const savedLayout = Array.isArray(value.layout) ? value.layout : [];
        const layout = panels.map((panel, index): LayoutItem => {
            const item: unknown = savedLayout.find(item => record(item) && item.i === panel.id);
            const geometry = record(item) ? item : {};
            const w = integer(geometry.w, PANEL_SIZE_LIMITS.minW, PANEL_SIZE_LIMITS.maxW, DEFAULT_PANEL_SIZE.w);
            const h = integer(geometry.h, PANEL_SIZE_LIMITS.minH, PANEL_SIZE_LIMITS.maxH, DEFAULT_PANEL_SIZE.h);
            return {
                i: panel.id, w, h,
                x: integer(geometry.x, 0, RESEARCH_GRID_LIMITS.cols - w, (index % 2) * DEFAULT_PANEL_SIZE.w),
                y: integer(geometry.y, 0, RESEARCH_GRID_LIMITS.maxRows - h, Math.floor(index / 2) * DEFAULT_PANEL_SIZE.h),
                ...PANEL_SIZE_LIMITS,
            };
        });
        return {
            version: 2,
            symbol: validSymbol(value.symbol) ? value.symbol : defaults.symbol,
            date: validResearchDate(value.date) ? value.date : defaults.date,
            cutoff: typeof value.cutoff === 'string' && /^(?:0[89]|1[0-3]):[0-5]\d$/.test(value.cutoff)
                ? value.cutoff : defaults.cutoff,
            sourceMode, financeMode, panels, layout,
        };
    } catch { return defaults; }
}
