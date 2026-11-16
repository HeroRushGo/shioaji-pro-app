const SHARED_SOURCE = new Set([
    'research.html',
    'src/theme.css.ts', 'src/components/panel-chrome.tsx',
    'src/components/panel-chrome.css.ts', 'src/components/panel.css.ts',
]);

/** A new shared dependency requires an explicit review. */
export function isResearchSource(relativePath: string): boolean {
    const source = relativePath.replaceAll('\\', '/').split('?')[0] ?? '';
    return !source.split('/').includes('..') && (
        source.startsWith('src/research/') || source.startsWith('src/features/neo-research/')
        || SHARED_SOURCE.has(source) || [...SHARED_SOURCE].some(path => source === `${path}.vanilla.css`)
    );
}

/** Vite IDs use forward slashes even when the project root is a Windows path. */
export function researchProjectPath(id: string, projectRoot: string): string | null {
    // Vite-generated virtual modules are not first-party files. Package modules
    // are installed from the frozen lockfile and have their own dependency boundary.
    if (id.startsWith('\0') || id.startsWith('virtual:')) return null;
    const normalizedId = id.replaceAll('\\', '/').split('?')[0] ?? '';
    if (['/@react-refresh', '/@vite/client', '/@vite/env'].includes(normalizedId)) return null;
    if (normalizedId.split('/').includes('node_modules')) return null;
    const normalizedRoot = projectRoot.replaceAll('\\', '/').replace(/\/$/, '');
    const windows = /^[a-z]:\//i.test(normalizedRoot);
    const candidate = windows ? normalizedId.toLowerCase() : normalizedId;
    const root = windows ? normalizedRoot.toLowerCase() : normalizedRoot;
    if (candidate.startsWith(`${root}/`)) return normalizedId.slice(normalizedRoot.length + 1);
    // An unknown external file is not silently reclassified as a package/virtual module.
    return `outside-project:${normalizedId}`;
}

export function assertResearchSources(sources: string[]): void {
    const forbidden = sources.filter(id => !isResearchSource(id));
    if (forbidden.length) throw new Error(`Research bundle imported services: ${forbidden.join(', ')}`);
    const clean = sources.map(id => id.split('?')[0]);
    for (const required of ['src/research/main.tsx', 'src/features/neo-research/NeoResearchPanel.tsx']) {
        if (!clean.includes(required)) throw new Error(`Research bundle is missing required source: ${required}`);
    }
}

export function deniedResearchPath(url: string): boolean {
    try {
        const pathname = decodeURIComponent(new URL(url, 'http://127.0.0.1').pathname);
        return /^\/(?:api|admin|stream|apps|dist|dist-research|@fs|@vite\/\.\.)(?:\/|$)/i.test(pathname)
            || /(?:^|\/)\.(?:research-data|git)(?:\/|$)/i.test(pathname)
            || (/\.html?$/i.test(pathname) && pathname !== '/research.html');
    } catch { return true; }
}

/** Document navigations have exactly two entry URLs, regardless of file aliases. */
export function allowedResearchDocument(url: string): boolean {
    try {
        const pathname = decodeURIComponent(new URL(url, 'http://127.0.0.1').pathname);
        return pathname === '/' || pathname === '/research.html';
    } catch { return false; }
}
