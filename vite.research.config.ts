import { execFileSync } from 'node:child_process';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { vanillaExtractPlugin } from '@vanilla-extract/vite-plugin';
import { defineConfig, normalizePath, type Plugin } from 'vite';
import { allowedResearchDocument, assertResearchSources, deniedResearchPath, isResearchSource, researchProjectPath } from './src/research/boundary';

const projectRoot = normalizePath(path.resolve(__dirname));
const policy = (dev: boolean) => [
    "default-src 'self'", `script-src 'self'${dev ? " 'unsafe-inline'" : ''}`,
    "style-src 'self' 'unsafe-inline'", "img-src 'self' data:",
    dev ? "connect-src 'self' ws://127.0.0.1:5174" : "connect-src 'none'",
    "object-src 'none'", "base-uri 'none'", "form-action 'self'",
].join('; ');

function researchBoundary(): Plugin {
    return {
        name: 'research-source-boundary', enforce: 'pre',
        configureServer(server) {
            server.middlewares.use((request, response, next) => {
                const url = request.url ?? '/';
                const destination = request.headers['sec-fetch-dest'];
                const navigation = destination === 'document' || destination === 'iframe'
                    || request.headers.accept?.includes('text/html');
                const denied = deniedResearchPath(url);
                if (denied || (navigation && !allowedResearchDocument(url))) {
                    response.statusCode = denied ? 403 : 404;
                    response.setHeader('Content-Type', 'application/json');
                    response.end(JSON.stringify({ error: denied ? 'research_only' : 'research_not_found' }));
                    return;
                }
                if (new URL(request.url ?? '/', 'http://localhost').pathname === '/') request.url = '/research.html';
                next();
            });
        },
        transform(_code, id) {
            const source = researchProjectPath(normalizePath(id), projectRoot);
            if (source && !isResearchSource(source)) {
                throw new Error(`Research entry cannot import ${source}`);
            }
        },
        generateBundle() {
            const sources = [...this.getModuleIds()].map(id => researchProjectPath(normalizePath(id), projectRoot))
                .filter((id): id is string => id !== null);
            assertResearchSources(sources);
            this.emitFile({ type: 'asset', fileName: 'research-build.json', source: JSON.stringify({
                entry: 'research.html', source: 'fixture', brokerConnections: false, reviewedSourceModules: sources.sort(),
            }, null, 2) });
        },
    };
}

export default defineConfig(({ command }) => {
    let revision = 'unknown';
    try {
        revision = execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], { encoding: 'utf8' }).trim();
        if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) revision += '+dirty';
    } catch { /* Source archives retain an honest unknown build identity. */ }
    return {
        appType: 'mpa',
        plugins: [researchBoundary(), vanillaExtractPlugin(), react()],
        define: { 'process.env': {}, __SHIOAJI_BUILD_VERSION__: JSON.stringify(revision) },
        build: {
            outDir: 'dist-research', emptyOutDir: true, copyPublicDir: false,
            rolldownOptions: { input: path.resolve(__dirname, 'research.html') },
        },
        server: {
            host: '127.0.0.1', port: 5174, strictPort: true,
            headers: { 'Content-Security-Policy': `${policy(command === 'serve')}; frame-ancestors 'none'` },
        },
        preview: {
            host: '127.0.0.1', port: 5175, strictPort: true,
            headers: { 'Content-Security-Policy': `${policy(false)}; frame-ancestors 'none'` },
        },
    };
});
