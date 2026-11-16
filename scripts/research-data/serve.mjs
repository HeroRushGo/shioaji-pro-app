import { readCatalog, readDataFile } from './store.mjs';

/** Narrow static read surface shared by dev and built preview. */
export function researchDataMiddleware(root, { withdrawalRoot } = {}) {
    const rememberedWithdrawals = new Set();
    return async (request, response, next) => {
        const raw = request.url ?? '/';
        if (!raw.startsWith('/research-data')) { next(); return; }
        const end = (status, data) => {
            response.statusCode = status;
            response.setHeader('Content-Type', 'application/json; charset=utf-8');
            response.setHeader('Cache-Control', 'no-store');
            response.setHeader('X-Content-Type-Options', 'nosniff');
            response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
            response.setHeader('Vary', 'Sec-Fetch-Site');
            response.end(request.method === 'HEAD' ? undefined : data);
        };
        if (!['GET', 'HEAD'].includes(request.method ?? '') || request.headers['sec-fetch-site'] === 'cross-site') {
            end(403, '{"error":"research_read_only"}'); return;
        }
        if (raw.includes('?') || raw.includes('#') || raw.includes('%') || raw.includes('\\')) {
            end(404, '{"error":"research_not_found"}'); return;
        }
        const relative = raw.slice('/research-data/'.length);
        try {
            const catalog = await readCatalog(root);
            const withdrawals = withdrawalRoot ? await readCatalog(withdrawalRoot) : catalog;
            for (const id of [...catalog.revoked, ...withdrawals.revoked]) rememberedWithdrawals.add(id);
            const selected = { ...catalog, revoked: [...rememberedWithdrawals] };
            if (raw === '/research-data/catalog.json') end(200, JSON.stringify(selected));
            else end(200, await readDataFile(root, relative, selected));
        } catch { end(404, '{"error":"research_data_unavailable"}'); }
    };
}
