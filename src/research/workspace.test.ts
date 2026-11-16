import { describe, expect, it } from 'vitest';
import { defaultWorkspace, MAX_PANELS, PANEL_SIZE_LIMITS, RESEARCH_GRID_LIMITS, restoreWorkspace } from './workspace';

describe('research workspace boundary', () => {
    it('defaults safely for damaged or legacy trading workspaces', () => {
        expect(restoreWorkspace('{')).toEqual(defaultWorkspace());
        expect(restoreWorkspace(JSON.stringify({ blocks: [{ type: 'ticket' }] }))).toEqual(defaultWorkspace());
    });
    it('drops trading panels, duplicate IDs and unrecognized fields', () => {
        const workspace = restoreWorkspace(JSON.stringify({
            version: 1, symbol: '2377',
            panels: [{ id: 'research-one', type: 'ticket' },
                { id: 'research-two', type: 'neo-research', pin: '2891', account: 'private' },
                { id: 'research-two', type: 'neo-research' }],
        }));
        expect(workspace.panels).toEqual([{ id: 'research-two', type: 'neo-research', pin: '2891' }]);
        expect(workspace.symbol).toBe('2377');
    });
    it('bounds count and hostile geometry and rejects malformed pins', () => {
        const workspace = restoreWorkspace(JSON.stringify({
            version: 1, panels: Array.from({ length: 100 }, (_, n) => ({
                id: `research-${n}`, type: 'neo-research', pin: 'http://localhost:8788/api',
            })),
            layout: [{ i: 'research-0', x: 999, y: -1, w: 999, h: -3, static: true }],
        }));
        expect(workspace.panels).toHaveLength(MAX_PANELS);
        expect(workspace.panels[0]?.pin).toBeNull();
        expect(workspace.layout[0]).toEqual({ i: 'research-0', x: 0, y: 0, w: 12, h: 10, ...PANEL_SIZE_LIMITS });
    });
    it('clamps the fallback x position to the saved width for a second full-width panel', () => {
        const defaults = defaultWorkspace();
        const workspace = restoreWorkspace(JSON.stringify({
            ...defaults,
            layout: [defaults.layout[0], { i: 'research-2', w: RESEARCH_GRID_LIMITS.cols }],
        }));
        expect(workspace.layout[1]?.w).toBe(RESEARCH_GRID_LIMITS.cols);
        expect(workspace.layout[1]?.x).toBe(0);
    });
    it('preserves each legal extreme geometry through save and restore', () => {
        const saved = {
            ...defaultWorkspace(),
            layout: [
                { i: 'research-1', x: 0, y: 0, w: RESEARCH_GRID_LIMITS.cols, h: PANEL_SIZE_LIMITS.maxH },
                {
                    i: 'research-2', x: RESEARCH_GRID_LIMITS.cols - PANEL_SIZE_LIMITS.minW,
                    y: RESEARCH_GRID_LIMITS.maxRows - PANEL_SIZE_LIMITS.minH,
                    w: PANEL_SIZE_LIMITS.minW, h: PANEL_SIZE_LIMITS.minH,
                },
            ],
        };
        const geometry = (item: { i: string; x: number; y: number; w: number; h: number }) =>
            ({ i: item.i, x: item.x, y: item.y, w: item.w, h: item.h });
        const restored = restoreWorkspace(JSON.stringify(saved));
        expect(restored.layout.map(geometry)).toEqual(saved.layout.map(geometry));
        expect(restoreWorkspace(JSON.stringify(restored)).layout.map(geometry)).toEqual(saved.layout.map(geometry));
        expect(restored.layout.every(item => item.maxH === PANEL_SIZE_LIMITS.maxH)).toBe(true);
    });
    it('constrains hostile dimensions and positions to the same interactive grid bounds', () => {
        const workspace = restoreWorkspace(JSON.stringify({
            ...defaultWorkspace(),
            layout: [
                { i: 'research-1', x: 999, y: 999, w: -100, h: 999 },
                { i: 'research-2', x: -9, y: -9, w: 999, h: -999 },
            ],
        }));
        expect(workspace.layout[0]).toEqual({
            i: 'research-1', x: 8, y: 300, w: 4, h: 30, ...PANEL_SIZE_LIMITS,
        });
        expect(workspace.layout[1]).toEqual({
            i: 'research-2', x: 0, y: 0, w: 12, h: 10, ...PANEL_SIZE_LIMITS,
        });
        expect(workspace.layout.every(item => item.y + item.h <= RESEARCH_GRID_LIMITS.maxRows)).toBe(true);
    });
    it('applies shared height limits to every default panel before interaction', () => {
        expect(defaultWorkspace().layout.every(item => item.minW === PANEL_SIZE_LIMITS.minW
            && item.minH === PANEL_SIZE_LIMITS.minH && item.maxH === PANEL_SIZE_LIMITS.maxH)).toBe(true);
    });
    it('round trips saved selection, pinned panels and geometry', () => {
        expect(restoreWorkspace(JSON.stringify(defaultWorkspace()))).toEqual(defaultWorkspace());
    });
    it('preserves an intentionally empty layout', () => {
        expect(restoreWorkspace(JSON.stringify({ ...defaultWorkspace(), panels: [], layout: [] })).panels).toEqual([]);
    });
});
