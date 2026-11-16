import { describe, expect, it } from 'vitest';
import { defaultWorkspace, MAX_PANELS, restoreWorkspace } from './workspace';

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
        expect(workspace.layout[0]).toEqual({ i: 'research-0', x: 0, y: 0, w: 12, h: 10, minW: 4, minH: 10 });
    });
    it('round trips saved selection, pinned panels and geometry', () => {
        expect(restoreWorkspace(JSON.stringify(defaultWorkspace()))).toEqual(defaultWorkspace());
    });
    it('preserves an intentionally empty layout', () => {
        expect(restoreWorkspace(JSON.stringify({ ...defaultWorkspace(), panels: [], layout: [] })).panels).toEqual([]);
    });
});
