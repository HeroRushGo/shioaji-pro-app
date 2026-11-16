import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createViteServer, type Plugin, type ResolvedConfig, type ViteDevServer } from 'vite';
import { researchDataPlugin } from './plugin';

type Middleware = (request: IncomingMessage, response: ServerResponse, next: () => void) => Promise<void>;
const roots: string[] = [];
const viteServers: ViteDevServer[] = [];
const httpServers: Server[] = [];
const firstSeenAt = '2026-11-16T04:00:00Z';
const releaseId = 'finance-approved';
const payloadPath = `releases/${releaseId}/2330.json`;
const payload = JSON.stringify({ schemaVersion: 1, kind: 'finance', symbol: '2330',
    name: '台積電', market: 'TSE', releaseId, firstSeenAt, revenue: [], quarters: [] });
const catalog = {
    schemaVersion: 1, updatedAt: firstSeenAt, revoked: [], replayReleases: [],
    financeReleases: [{ id: releaseId, firstSeenAt, upstreamCommit: 'a'.repeat(40),
        upstreamBuiltAt: '2026-11-13T23:27:57+08:00', items: [{
            symbol: '2330', name: '台積電', market: 'TSE', path: payloadPath,
            sha256: createHash('sha256').update(payload).digest('hex'),
        }] }],
};
const withdrawals = { schemaVersion: 1, updatedAt: firstSeenAt, revoked: [], blockedKinds: [] };
async function project() {
    const root = await mkdtemp(path.join(tmpdir(), 'pro-research-plugin-'));
    roots.push(root);
    const data = path.join(root, '.research-data');
    await mkdir(path.join(data, 'releases', releaseId), { recursive: true });
    await writeFile(path.join(data, payloadPath), payload);
    await writeFile(path.join(data, 'catalog.json'), JSON.stringify(catalog));
    await writeFile(path.join(data, 'withdrawals.json'), JSON.stringify(withdrawals));
    return { root, data, plugin: researchDataPlugin(root) };
}
function hook(plugin: Plugin, name: keyof Plugin) {
    const value = plugin[name];
    return typeof value === 'function' ? value : (value as { handler: (...args: never[]) => unknown }).handler;
}
function middleware(plugin: Plugin, preview = false) {
    let registered: Middleware | undefined;
    const server = { middlewares: { use(value: Middleware) { registered = value; } } };
    hook(plugin, preview ? 'configurePreviewServer' : 'configureServer').call(plugin, server as ViteDevServer);
    return registered!;
}
async function invoke(serve: Middleware, url: string, method = 'GET') {
    let next = false;
    let body: string | undefined;
    const headers: Record<string, string> = {};
    const response = { statusCode: 200, setHeader(key: string, value: string) { headers[key] = value; },
        end(value?: string | Buffer) { body = value?.toString(); } };
    await serve({ url, method, headers: {} } as IncomingMessage, response as ServerResponse, () => { next = true; });
    return { status: response.statusCode, body, headers, next };
}
async function bundle(plugin: Plugin) {
    const files: { fileName: string; source: Buffer }[] = [];
    await hook(plugin, 'generateBundle').call({ emitFile(file: { fileName: string; source: Buffer }) { files.push(file); } });
    return files;
}
afterEach(async () => {
    await Promise.all(httpServers.splice(0).map(server => new Promise<void>((resolve, reject) => {
        if (!server.listening) { resolve(); return; }
        server.closeAllConnections();
        server.close(error => error ? reject(error) : resolve());
    })));
    await Promise.all(viteServers.splice(0).map(server => server.close()));
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function realVite(root: string) {
    const vite = await createViteServer({
        root, configFile: false, envDir: false, plugins: [researchDataPlugin(root)],
        appType: 'mpa', logLevel: 'silent', optimizeDeps: { noDiscovery: true },
        // Real Vite handlers, hosted by an ephemeral test listener. Never use
        // Vite's default dev port or the task's running app/backend services.
        server: { middlewareMode: true, hmr: false, ws: false, fs: { allow: [root] } },
    });
    viteServers.push(vite);
    const server = createHttpServer((request, response) => vite.middlewares(request, response));
    httpServers.push(server);
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing ephemeral test address');
    return address.port;
}
function rawGet(port: number, pathname: string) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
        const request = httpRequest({ hostname: '127.0.0.1', port, path: pathname }, response => {
            const chunks: Buffer[] = [];
            response.on('data', chunk => { chunks.push(chunk); });
            response.on('end', () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString() }));
            response.on('error', reject);
        });
        request.on('error', reject);
        request.setTimeout(2000, () => { request.destroy(new Error('test request timed out')); });
        request.end();
    });
}

describe('verified research data in the full Pro workspace', () => {
    it('mounts the approved data gate without intercepting Pro assets or broker routes', async () => {
        const { plugin } = await project();
        const serve = middleware(plugin);
        const approved = await invoke(serve, `/research-data/${payloadPath}`);
        expect(approved).toMatchObject({ status: 200, body: payload, next: false });
        expect(approved.headers).toMatchObject({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        expect((await invoke(serve, '/src/main.tsx?t=12')).next).toBe(true);
        expect((await invoke(serve, '/api/v1/info')).next).toBe(true);
        expect(await invoke(serve, `/research-data/${payloadPath}`, 'POST')).toMatchObject({ status: 403, next: false });
        expect(await invoke(serve, '/%72esearch-data/catalog.json')).toMatchObject({ status: 404, next: false });
        expect(await invoke(serve, '/research-data/releases/unapproved/2330.json')).toMatchObject({ status: 404, next: false });
    });

    it('packages only catalog-approved JSON and preserves its original observation time', async () => {
        const { plugin, data } = await project();
        await writeFile(path.join(data, 'unlisted-secret.json'), '{"canary":"must not be packaged"}');
        const files = await bundle(plugin);
        expect(files.map(file => file.fileName)).toEqual([
            'research-data/catalog.json', 'research-data/withdrawals.json', `research-data/${payloadPath}`,
        ]);
        expect(files.find(file => file.fileName.endsWith('/2330.json'))!.source.toString()).toBe(payload);
        expect(JSON.parse(files[0]!.source.toString()).financeReleases[0].firstSeenAt).toBe(firstSeenAt);
        await writeFile(path.join(data, payloadPath), '{"changed":true}');
        await expect(bundle(plugin)).rejects.toThrow(/hash|digest|integrity/i);
    });

    it('previews the configured build only and applies withdrawals published after that build', async () => {
        const { root, data, plugin } = await project();
        const output = path.join(root, 'custom-build');
        const config = { root, build: { outDir: 'custom-build' }, server: { fs: { deny: ['.env', '**/.git/**'] } } };
        hook(plugin, 'configResolved').call(plugin, config as ResolvedConfig);
        for (const file of await bundle(plugin)) {
            await mkdir(path.dirname(path.join(output, file.fileName)), { recursive: true });
            await writeFile(path.join(output, file.fileName), file.source);
        }
        // A source-only new release is absent from the packaged projection.
        const sourceOnly = structuredClone(catalog);
        sourceOnly.financeReleases[0]!.id = 'finance-source-only';
        sourceOnly.financeReleases[0]!.items[0]!.path = 'releases/finance-source-only/2330.json';
        await writeFile(path.join(data, 'catalog.json'), JSON.stringify(sourceOnly));
        let serve = middleware(plugin, true);
        expect((await invoke(serve, `/research-data/${payloadPath}`)).body).toBe(payload);
        const previewCatalog = JSON.parse((await invoke(serve, '/research-data/catalog.json')).body!);
        expect(previewCatalog.financeReleases[0].id).toBe(releaseId);
        expect(await invoke(serve, '/research-data/releases/finance-source-only/2330.json')).toMatchObject({ status: 404, next: false });
        await writeFile(path.join(data, 'withdrawals.json'), JSON.stringify({ ...withdrawals, blockedKinds: ['finance'] }));
        serve = middleware(plugin, true); // Also survives a preview restart.
        expect(await invoke(serve, `/research-data/${payloadPath}`)).toMatchObject({ status: 404, next: false });
        expect(JSON.parse((await invoke(serve, '/research-data/catalog.json')).body!).revoked).toContain(releaseId);
        expect(await readFile(path.join(output, `research-data/${payloadPath}`), 'utf8')).toBe(payload);
    });

    it('blocks source, build and filesystem aliases in actual Vite handlers before and after withdrawal', async () => {
        const { root, data } = await project();
        for (const directory of ['dist', 'dist-market', 'dist-research', 'custom-build']) {
            await mkdir(path.join(root, directory, 'research-data', 'releases', releaseId), { recursive: true });
            await writeFile(path.join(root, directory, 'research-data', 'catalog.json'), JSON.stringify(catalog));
            await writeFile(path.join(root, directory, 'research-data', payloadPath), payload);
        }
        await writeFile(path.join(root, 'main.js'), 'export const appCanary = true;');
        const port = await realVite(root);
        expect((await rawGet(port, '/research-data/catalog.json')).status).toBe(200);
        expect((await rawGet(port, `/research-data/${payloadPath}`)).body).toBe(payload);
        expect((await rawGet(port, '/main.js')).body).toContain('appCanary');
        // /@fs remains functional for ordinary app dependencies; only data
        // aliases are denied. Node-side publisher imports remain untouched.
        expect((await rawGet(port, `/@fs${root}/main.js`)).status).toBe(200);
        const aliases = [
            '/.research-data/catalog.json', `/.research-data/${payloadPath}`,
            '/.research-data/catalog.json?raw', '/%2eresearch-data/catalog.json',
            '/.%72esearch-data/catalog.json', '/%252eresearch-data/catalog.json',
            '/nested/../.research-data/catalog.json', '/nested/%2e%2e/.research-data/catalog.json',
            '/%25252eresearch-data/catalog.json', '/.research-data%2fcatalog.json',
            '/.research-data%5ccatalog.json', '/.RESEARCH-DATA/catalog.json',
            '/dist/research-data/catalog.json', '/dist-market/research-data/catalog.json',
            '/dist-research/research-data/catalog.json', '/custom-build/research-data/catalog.json',
            '/dist/%72esearch-data/catalog.json', '/dist/x/../research-data/catalog.json',
            `/@fs${data}/catalog.json`, `/@fs${data}/${payloadPath}`,
            `/@fs${root}/%2eresearch-data/catalog.json?import`,
            `/@fs${root}/dist/research-data/catalog.json`,
            `/@fs${root}/dist-research/research-data/${payloadPath}?raw`,
            '/%72esearch-data/catalog.json', '/research-data/./catalog.json',
        ];
        const checkAliases = async () => {
            for (const alias of aliases) {
                const response = await rawGet(port, alias);
                expect(response.status, alias).toBe(404);
                expect(response.body, alias).not.toContain('financeReleases');
                expect(response.body, alias).not.toContain('firstSeenAt');
            }
        };
        await checkAliases();
        await writeFile(path.join(data, 'withdrawals.json'), JSON.stringify({ ...withdrawals, blockedKinds: ['finance'] }));
        expect((await rawGet(port, `/research-data/${payloadPath}`)).status).toBe(404);
        expect(JSON.parse((await rawGet(port, '/research-data/catalog.json')).body).revoked).toContain(releaseId);
        await checkAliases();
    });
});
