import { afterEach, expect, it, vi } from 'vitest';
import { resolveConfig } from 'vite';
import path from 'node:path';

afterEach(() => vi.unstubAllEnvs());
it.each([
    ['VITE_API_TARGET', 'http://127.0.0.1:21322'],
    ['VITE_DEV_SERVER_PORT', '8080'],
    ['VITE_API_BASE', 'http://127.0.0.1:21322'],
    ['VITE_STREAM_BASE', 'http://127.0.0.1:8080'],
    ['PORT', '5177'],
])('market startup rejects incompatible %s without falling back', async (key, value) => {
    vi.stubEnv(key, value);
    await expect(resolveConfig({ configFile: path.resolve(__dirname, '../vite.config.ts'), logLevel: 'silent' }, 'serve', 'market')).rejects.toThrow(/market profile/);
});
