import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from './workspace';

const normalKey = 'sj-pro-workspace-v3';
const marketKey = 'sj-pro-market-workspace-v1';
const normalProfiles = 'sj-pro-profiles-v2';
const marketProfiles = 'sj-pro-market-profiles-v1';
function saved(id: string): Workspace {
    return { blocks: [{ id, type: 'chart', pin: '2377' }],
        layout: [{ i: id, x: 0, y: 0, w: 288, h: 10 }] };
}
function storage(entries: [string, string][] = []) {
    const values = new Map(entries);
    const getItem = vi.fn((key: string) => values.get(key) ?? null);
    vi.stubGlobal('localStorage', {
        getItem,
        setItem: (key: string, value: string) => { values.set(key, value); },
    });
    return { values, getItem };
}
async function profile(marketOnly: boolean) {
    vi.resetModules();
    vi.doMock('./market-profile', () => ({ marketOnly }));
    return import('./workspace');
}
afterEach(() => {
    vi.doUnmock('./market-profile');
    vi.resetModules();
    vi.unstubAllGlobals();
});

describe('market-only workspace and profile isolation', () => {
    it('starts with five connected market/research panels and visible non-overlapping Neo space', async () => {
        storage();
        const ws = await profile(true);
        const initial = ws.loadWorkspace();
        expect(initial.blocks.map(block => block.type)).toEqual(['watchlist', 'chart', 'depth', 'tape', 'neo-research']);
        expect(initial.blocks.every(block => block.pin === null)).toBe(true);
        const neo = initial.layout.find(item => item.i === 'neo-research-market')!;
        expect(neo.y).toBe(0);
        expect(neo.w).toBeGreaterThanOrEqual(8 * ws.GRID_LEGACY_SCALE);
        expect(neo.h).toBeGreaterThanOrEqual(16);
        for (const a of initial.layout) {
            expect(a.x + a.w).toBeLessThanOrEqual(ws.GRID_COLS);
            for (const b of initial.layout.filter(item => item.i !== a.i)) {
                expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true);
            }
        }
        initial.blocks[0]!.pin = '2330';
        expect(ws.loadWorkspace()).toEqual(ws.DEFAULT_WORKSPACE); // Fresh clone on every load.
    });

    it('ignores normal and legacy workspaces/profiles even when market storage is corrupt', async () => {
        const prior = saved('normal');
        const { getItem } = storage([
            [normalKey, JSON.stringify(prior)], ['sj-pro-workspace-v2', JSON.stringify(prior)],
            [normalProfiles, JSON.stringify([{ name: 'normal', workspace: prior }])],
            ['sj-pro-profiles-v1', JSON.stringify([{ name: 'legacy', workspace: prior }])],
            [marketKey, '{corrupt'], [marketProfiles, '{corrupt'],
        ]);
        const ws = await profile(true);
        expect(ws.loadWorkspace()).toEqual(ws.DEFAULT_WORKSPACE);
        expect(ws.loadProfiles()).toEqual([]);
        expect(getItem.mock.calls.map(([key]) => key)).toEqual([marketKey, marketProfiles]);
    });

    it('persists edits and named profiles only under market keys, then resets to the market default', async () => {
        const normalBytes = JSON.stringify(saved('normal'));
        const normalProfileBytes = JSON.stringify([{ name: 'normal', workspace: saved('normal-profile') }]);
        const { values } = storage([[normalKey, normalBytes], [normalProfiles, normalProfileBytes]]);
        const ws = await profile(true);
        const edited = saved('market-custom');
        ws.saveWorkspace(edited);
        ws.saveProfiles([{ name: '研究', workspace: edited }]);
        expect(ws.loadWorkspace()).toEqual(edited);
        expect(ws.loadProfiles()).toEqual([{ name: '研究', workspace: edited }]);
        expect(values.has(marketKey)).toBe(true);
        expect(values.has(marketProfiles)).toBe(true);
        ws.resetSavedWorkspace();
        expect(ws.loadWorkspace()).toEqual(ws.DEFAULT_WORKSPACE);
        expect(ws.loadProfiles()).toEqual([{ name: '研究', workspace: edited }]);
        expect(values.get(normalKey)).toBe(normalBytes);
        expect(values.get(normalProfiles)).toBe(normalProfileBytes);
    });

    it('uses the market default when a newer stored workspace contains only unsupported panels', async () => {
        const unknown = { blocks: [{ id: 'future', type: 'future-panel', pin: null }],
            layout: [{ i: 'future', x: 0, y: 0, w: 288, h: 10 }] };
        storage([[marketKey, JSON.stringify(unknown)]]);
        const ws = await profile(true);
        const loaded = ws.loadWorkspace();
        expect(loaded.blocks).toEqual(ws.DEFAULT_WORKSPACE.blocks);
        expect(loaded.unsupported?.blocks).toEqual(unknown.blocks);
    });

    it('keeps the normal Pro default and existing workspace/profile keys unchanged', async () => {
        const normal = saved('normal-custom');
        const marketBytes = JSON.stringify(saved('market-custom'));
        const { values } = storage([[normalKey, JSON.stringify(normal)], [marketKey, marketBytes]]);
        const ws = await profile(false);
        expect(ws.DEFAULT_WORKSPACE.blocks.map(block => block.type)).toEqual([
            'watchlist', 'movers', 'chart', 'dock', 'depth', 'ticket', 'tape',
        ]);
        expect(ws.loadWorkspace()).toEqual(normal);
        ws.saveProfiles([{ name: '交易', workspace: normal }]);
        expect(ws.loadProfiles()).toEqual([{ name: '交易', workspace: normal }]);
        expect(values.has(normalProfiles)).toBe(true);
        expect(values.has(marketProfiles)).toBe(false);
        ws.resetSavedWorkspace();
        expect(ws.loadWorkspace()).toEqual(ws.DEFAULT_WORKSPACE);
        expect(values.get(marketKey)).toBe(marketBytes);
    });
});
