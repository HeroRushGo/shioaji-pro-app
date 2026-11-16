import path from 'node:path';
import type { Plugin } from 'vite';
import { researchDataMiddleware } from './serve.mjs';
import { publishedFiles } from './store.mjs';

/** Vite has additional root, /@fs and module handlers after this plugin.
 * Reject every alternate spelling before any of those handlers can decode it.
 * Only the literal public namespace is delegated to the ledger middleware.
 */
function privateDataAlias(raw: string): boolean {
    if (!raw.startsWith('/') || raw.length > 16 * 1024 || /[\x00-\x20\x7f]/.test(raw)) return true;
    const pathname = raw.split(/[?#]/, 1)[0]!;
    let decoded = pathname;
    try {
        for (let pass = 0; pass < 2 && decoded.includes('%'); pass++) decoded = decodeURIComponent(decoded);
    } catch { return true; }
    if (decoded.startsWith('//') || /[%?#\\\x00-\x1f\x7f]/.test(decoded)) return true;
    const normalized = path.posix.normalize(decoded);
    const hasDataSegment = [decoded, normalized].some(candidate => candidate.toLowerCase()
        .split('/').some(segment => segment === '.research-data' || segment === 'research-data'));
    if (!hasDataSegment) return false;
    return !(pathname.startsWith('/research-data/') && pathname === decoded && pathname === normalized);
}

function guardedResearchData(root: string, options?: { withdrawalRoot?: string }) {
    const serve = researchDataMiddleware(root, options);
    return async (...args: Parameters<typeof serve>) => {
        const [request, response] = args;
        if (privateDataAlias(request.url ?? '/')) {
            response.statusCode = 404;
            response.setHeader('Content-Type', 'application/json; charset=utf-8');
            response.setHeader('Cache-Control', 'no-store');
            response.setHeader('X-Content-Type-Options', 'nosniff');
            response.end(request.method === 'HEAD' ? undefined : '{"error":"research_not_found"}');
            return;
        }
        await serve(...args);
    };
}

/** Attach the verified JSON projection to the full Pro workspace. */
export function researchDataPlugin(projectRoot: string): Plugin {
    const dataRoot = path.resolve(projectRoot, '.research-data');
    let outputRoot = path.resolve(projectRoot, 'dist');
    return {
        name: 'pro-verified-research-data',
        enforce: 'pre',
        configResolved(config) {
            outputRoot = path.resolve(config.root, config.build.outDir);
        },
        configureServer(server) {
            server.middlewares.use(guardedResearchData(dataRoot));
        },
        configurePreviewServer(server) {
            // Preview reads its packaged data, while current withdrawals can
            // still invalidate a retained build. Never serve the source payloads.
            server.middlewares.use(guardedResearchData(
                path.join(outputRoot, 'research-data'), { withdrawalRoot: dataRoot },
            ));
        },
        async generateBundle() {
            for (const file of await publishedFiles(dataRoot)) {
                this.emitFile({
                    type: 'asset', fileName: `research-data/${file.path}`, source: file.bytes,
                });
            }
        },
    };
}
