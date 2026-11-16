import type { LayoutItem } from 'react-grid-layout';

export const STORAGE_KEY = 'neo-pro-research-workspace-v1';
export const MAX_PANELS = 6;
export type ResearchPanel = { id: string; type: 'neo-research'; pin: string | null };
export type ResearchWorkspace = {
    version: 1;
    symbol: string;
    date: string;
    cutoff: string;
    panels: ResearchPanel[];
    layout: LayoutItem[];
};

export function validSymbol(value: unknown): value is string {
    return typeof value === 'string' && /^\d{4}$/.test(value);
}

export function defaultWorkspace(): ResearchWorkspace {
    return {
        version: 1, symbol: '2330', date: '2026-11-13', cutoff: '13:30',
        panels: [
            { id: 'research-1', type: 'neo-research', pin: null },
            { id: 'research-2', type: 'neo-research', pin: '2891' },
        ],
        layout: [
            { i: 'research-1', x: 0, y: 0, w: 6, h: 16, minW: 4, minH: 10 },
            { i: 'research-2', x: 6, y: 0, w: 6, h: 16, minW: 4, minH: 10 },
        ],
    };
}

const record = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, low: number, high: number, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value)
        ? Math.min(high, Math.max(low, Math.round(value))) : fallback;

/** Only the research namespace is accepted. Never deserialize Pro trading panels. */
export function restoreWorkspace(raw: string | null): ResearchWorkspace {
    const defaults = defaultWorkspace();
    try {
        const value: unknown = JSON.parse(raw ?? 'null');
        if (!record(value) || value.version !== 1 || !Array.isArray(value.panels)) return defaults;
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
            const w = integer(geometry.w, 4, 12, 6);
            return {
                i: panel.id, w,
                x: integer(geometry.x, 0, 12 - w, (index % 2) * 6),
                y: integer(geometry.y, 0, 300, Math.floor(index / 2) * 16),
                h: integer(geometry.h, 10, 30, 16), minW: 4, minH: 10,
            };
        });
        return {
            version: 1,
            symbol: validSymbol(value.symbol) ? value.symbol : defaults.symbol,
            date: value.date === '2026-11-12' ? value.date : defaults.date,
            cutoff: typeof value.cutoff === 'string' && /^(?:0[89]|1[0-3]):[0-5]\d$/.test(value.cutoff)
                ? value.cutoff : defaults.cutoff,
            panels, layout,
        };
    } catch { return defaults; }
}
