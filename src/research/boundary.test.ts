import { describe, expect, it } from 'vitest';
import { deniedResearchPath, isResearchSource } from './boundary';

describe('research import and HTTP boundary', () => {
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
