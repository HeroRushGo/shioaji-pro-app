import { describe, expect, it } from 'vitest';
import { assertResearchSources, deniedResearchPath, isResearchSource, researchSourcePath } from './boundary';

describe('research import and HTTP boundary', () => {
    it('normalizes Windows module IDs and project roots before applying the allowlist', () => {
        expect(researchSourcePath('C:/repo/src/lib/shioaji.ts', 'C:\\repo\\src')).toBe('src/lib/shioaji.ts');
        expect(isResearchSource(researchSourcePath('c:\\repo\\src\\lib\\boot.ts', 'C:/repo/src')!)).toBe(false);
        expect(researchSourcePath('C:/repo/src/research/main.tsx?x=1', 'C:\\repo\\src')).toBe('src/research/main.tsx');
        expect(researchSourcePath('/repo/src-other/main.tsx', '/repo/src')).toBeNull();
    });
    it('fails closed for empty or incomplete build receipts', () => {
        expect(() => assertResearchSources([])).toThrow('missing required source');
        expect(() => assertResearchSources(['src/research/main.tsx'])).toThrow('NeoResearchPanel');
        expect(() => assertResearchSources(['src/research/main.tsx', 'src/features/neo-research/NeoResearchPanel.tsx', 'src/lib/boot.ts'])).toThrow('imported services');
        expect(() => assertResearchSources(['src/research/main.tsx', 'src/features/neo-research/NeoResearchPanel.tsx', 'src/theme.css.ts'])).not.toThrow();
    });
    it.each(['src/lib/boot.ts', 'src/lib/shioaji.ts', 'src/lib/stream.ts',
        'src/lib/trading-state.ts', 'src/components/panel-library.tsx', 'src/main.tsx',
        'src/App.tsx', 'src/research/../lib/bracket.ts'])('rejects service module %s', file => {
        expect(isResearchSource(file)).toBe(false);
    });
    it.each(['src/research/main.tsx', 'src/features/neo-research/model.ts',
        'src/components/panel-chrome.tsx', 'src/theme.css.ts'])('accepts reviewed source %s', file => {
        expect(isResearchSource(file)).toBe(true);
    });
    it.each(['/api/accounts', '/api/orders?symbol=2330', '/admin', '/stream',
        '/apps/test', '/index.html', '/approval.html', '/%61pi/orders', '/%'])('rejects route %s', route => {
        expect(deniedResearchPath(route)).toBe(true);
    });
    it.each(['/', '/research.html', '/src/research/main.tsx', '/node_modules/.vite/deps/react.js'])('allows assets %s', route => {
        expect(deniedResearchPath(route)).toBe(false);
    });
});
