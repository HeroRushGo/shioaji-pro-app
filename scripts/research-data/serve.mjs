import { readCatalog, readDataFile } from './store.mjs';
import { posix } from 'node:path';

/**
 * Classify before yielding to Vite's static handler, which may decode and
 * normalize a different spelling of the same filesystem path. Decode at most
 * twice; a remaining escape (or a malformed/ambiguous target) is rejected,
 * never handed to another decoder. Only literal canonical data URLs may read
 * through the catalog/withdrawal gate. Ordinary non-data Vite assets keep their
 * original target, including their normal query parameters.
 */
function requestTargetKind(raw) {
    // Absolute-form/protocol-relative targets are not canonical data URLs.
    // Reject absolute-form globally rather than assume a later static handler
    // will not extract its pathname. Repeated leading slashes are classified
    // below as paths so a namespace alias cannot bypass this middleware.
    if (typeof raw !== 'string' || !raw.startsWith('/') || raw.length > 16 * 1024
        || /[\x00-\x20\x7f]/.test(raw)) return 'reject';
    const pathname = raw.split(/[?#]/, 1)[0];
    let decoded = pathname;
    try {
        for (let pass = 0; pass < 2 && decoded.includes('%'); pass += 1) decoded = decodeURIComponent(decoded);
    } catch { return 'reject'; }
    // No unbounded decoder loop, encoded delimiters, control characters or
    // Windows separators may reach the static fallback under another meaning.
    if (decoded.startsWith('//') || /[%?#\\\x00-\x1f\x7f]/.test(decoded)) return 'reject';
    const normalized = posix.normalize(decoded);
    const dataTarget = pathname.toLowerCase().startsWith('/research-data')
        || decoded.toLowerCase().startsWith('/research-data')
        || normalized.toLowerCase().startsWith('/research-data');
    if (!dataTarget) return 'other';
    return raw === pathname && pathname === decoded && pathname === normalized
        && pathname.startsWith('/research-data/') ? 'canonical' : 'reject';
}

/** Narrow static read surface shared by dev and built preview. */
export function researchDataMiddleware(root, { withdrawalRoot } = {}) {
    const rememberedWithdrawals = new Set();
    const blockedKinds = new Set();
    return async (request, response, next) => {
        const raw = request.url ?? '/';
        const end = (status, data) => {
            response.statusCode = status;
            response.setHeader('Content-Type', 'application/json; charset=utf-8');
            response.setHeader('Cache-Control', 'no-store');
            response.setHeader('X-Content-Type-Options', 'nosniff');
            response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
            response.setHeader('Vary', 'Sec-Fetch-Site');
            response.end(request.method === 'HEAD' ? undefined : data);
        };
        const targetKind = requestTargetKind(raw);
        if (targetKind === 'other') { next(); return; }
        if (targetKind !== 'canonical') { end(404, '{"error":"research_not_found"}'); return; }
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
            for (const kind of [...(catalog.blockedKinds ?? []), ...(withdrawals.blockedKinds ?? [])]) blockedKinds.add(kind);
            // A retained build may contain IDs absent from a rolled-back pointer.
            // A family withdrawal still covers those older packaged payloads.
            for (const kind of blockedKinds) for (const release of catalog[`${kind}Releases`]) rememberedWithdrawals.add(release.id);
            const selected = { ...catalog, revoked: [...rememberedWithdrawals], blockedKinds: [...blockedKinds] };
            if (raw === '/research-data/catalog.json') end(200, JSON.stringify(selected));
            else end(200, await readDataFile(root, relative, selected));
        } catch { end(404, '{"error":"research_data_unavailable"}'); }
    };
}
