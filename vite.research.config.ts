import { execFileSync } from 'node:child_process';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { vanillaExtractPlugin } from '@vanilla-extract/vite-plugin';
import { defineConfig, type Plugin } from 'vite';
import { deniedResearchPath, isResearchSource } from './src/research/boundary';

const sourceRoot = path.resolve(__dirname, 'src') + path.sep;
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
                if (deniedResearchPath(request.url ?? '/')) {
                    response.statusCode = 403;
                    response.setHeader('Content-Type', 'application/json');
                    response.end(JSON.stringify({ error: 'research_only' }));
                    return;
                }
                if (new URL(request.url ?? '/', 'http://localhost').pathname === '/') request.url = '/research.html';
                next();
            });
        },
        transform(_code, id) {
            const source = id.split('?')[0] ?? id;
            if (source.startsWith(sourceRoot) && !isResearchSource(path.relative(__dirname, source))) {
                throw new Error(`Research entry cannot import ${path.relative(__dirname, source)}`);
            }
        },
        generateBundle() {
            const sources = [...this.getModuleIds()].filter(id => id.startsWith(sourceRoot))
                .map(id => path.relative(__dirname, id).replaceAll('\\', '/'));
            const forbidden = sources.filter(id => !isResearchSource(id));
            if (forbidden.length) this.error(`Research bundle imported services: ${forbidden.join(', ')}`);
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
