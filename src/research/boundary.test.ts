import { describe, expect, it } from 'vitest';
import { allowedResearchDocument, assertResearchSources, deniedResearchPath, isResearchSource, researchProjectPath } from './boundary';

describe('research import and HTTP boundary', () => {
    it('normalizes Windows module IDs and project roots before applying the allowlist', () => {
        expect(researchProjectPath('C:/repo/src/lib/shioaji.ts', 'C:\\repo')).toBe('src/lib/shioaji.ts');
        expect(isResearchSource(researchProjectPath('c:\\repo\\src\\lib\\boot.ts', 'C:/repo')!)).toBe(false);
        expect(researchProjectPath('C:/repo/src/research/main.tsx?x=1', 'C:\\repo')).toBe('src/research/main.tsx');
        expect(researchProjectPath('/repo-other/main.tsx', '/repo')).toContain('outside-project:');
    });
    it('rejects unreviewed first-party sources anywhere in or outside the project', () => {
        for (const file of ['/repo/shared/format.ts', '/repo/scripts/local.ts', '/another-project/shared.ts']) {
            expect(isResearchSource(researchProjectPath(file, '/repo')!)).toBe(false);
        }
        expect(researchProjectPath('/repo/node_modules/react/index.js', '/repo')).toBeNull();
        expect(researchProjectPath('\0vite/modulepreload-polyfill.js', '/repo')).toBeNull();
        expect(researchProjectPath('/@react-refresh', '/repo')).toBeNull();
        expect(isResearchSource(researchProjectPath('/@react-refresh/local.ts', '/repo')!)).toBe(false);
        expect(isResearchSource(researchProjectPath('/repo/research.html', '/repo')!)).toBe(true);
    });
    it('does not serve original build documents or document aliases', () => {
        for (const route of ['/dist', '/dist/', '/dist/index.html', '/dist/approval.html',
            '/dist-research/research.html', '/docs/index.html', '/%64ist/index.html']) {
            expect(deniedResearchPath(route)).toBe(true);
            expect(allowedResearchDocument(route)).toBe(false);
        }
        expect(allowedResearchDocument('/old-bookmark')).toBe(false);
        expect(allowedResearchDocument('/')).toBe(true);
        expect(allowedResearchDocument('/research.html?popout=ticket')).toBe(true);
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
