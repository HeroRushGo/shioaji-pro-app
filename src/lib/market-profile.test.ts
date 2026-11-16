import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); });
describe('market-only frontend authority', () => {
    it('pins same-origin transport despite old local storage and environment overrides', async () => {
        vi.stubEnv('MODE', 'market');
        vi.stubEnv('VITE_API_BASE', 'http://127.0.0.1:21322');
        vi.stubEnv('VITE_STREAM_BASE', 'http://127.0.0.1:8080');
        vi.stubGlobal('localStorage', { getItem: () => 'https' });
        const runtime = await import('./runtime');
        expect(runtime.getApiBase()).toBe(''); expect(runtime.getStreamBase()).toBe('');
        expect(runtime.getApiPort()).toBe(21323); expect(runtime.getApiScheme()).toBe('http');
    });
    it('rejects broker operations before dispatch callbacks and any fetch', async () => {
        vi.stubEnv('MODE', 'market');
        const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
        const beforeDispatch = vi.fn(); const { apiPost, apiGet } = await import('./api');
        await expect(apiPost('/api/v1/order/place_order', {}, { beforeDispatch })).rejects.toMatchObject({ mutationNotStarted: true });
        await expect(apiGet('/api/v1/auth/accounts')).rejects.toMatchObject({ mutationNotStarted: true });
        expect(fetch).not.toHaveBeenCalled(); expect(beforeDispatch).not.toHaveBeenCalled();
    });
});
