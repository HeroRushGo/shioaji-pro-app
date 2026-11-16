const SHARED_SOURCE = new Set([
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

export function deniedResearchPath(url: string): boolean {
    try {
        const pathname = decodeURIComponent(new URL(url, 'http://127.0.0.1').pathname);
        return /^\/(?:api|admin|stream|apps)(?:\/|$)/i.test(pathname)
            || /^\/(?:index|approval)\.html$/i.test(pathname);
    } catch { return true; }
}
