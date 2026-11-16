import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(path.join(root, '.research-import-probe-'));
const probe = path.join(directory, 'format.ts');
await writeFile(probe, 'export const harmlessProbe = 1;\n');
try {
    let rejected = false;
    try {
        await build({
            root, configFile: path.join(root, 'vite.research.config.ts'), logLevel: 'silent',
            build: { write: false },
            plugins: [{
                name: 'inject-unreviewed-first-party-probe', enforce: 'pre',
                transform(code, id) {
                    if (id.replaceAll('\\', '/').endsWith('/src/research/main.tsx')) {
                        return `import ${JSON.stringify(probe.replaceAll('\\', '/'))};\n${code}`;
                    }
                },
            }],
        });
    } catch (error) {
        if (!/Research entry cannot import .*format\.ts/.test(String(error))) throw error;
        rejected = true;
    }
    if (!rejected) throw new Error('Research build accepted an unreviewed first-party import outside src');
    console.log('PASS: actual Vite build rejects a harmless unreviewed first-party import outside src');
} finally {
    await rm(directory, { recursive: true, force: true });
}
