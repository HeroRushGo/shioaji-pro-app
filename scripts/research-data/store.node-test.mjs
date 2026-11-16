import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { canonical, publishRelease, publishedFiles, readCatalog, readDataFile, revokeReleases } from './store.mjs';
import { researchDataMiddleware } from './serve.mjs';

const first = '2026-11-16T04:00:00.000Z';
function input(root, id = 'finance-a', built = '2026-11-13T23:27:57+08:00') {
    return { root, kind: 'finance', id,
        metadata: { upstreamCommit: 'a'.repeat(40), upstreamBuiltAt: built },
        items: [{ symbol: '2330', name: '台積電', market: 'TSE', data: {
            schemaVersion: 1, kind: 'finance', symbol: '2330', name: '台積電', market: 'TSE', revenue: [], quarters: [],
        } }],
    };
}
async function temporary(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pro-store-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return root;
}
async function request(middleware, url, method = 'GET', headers = {}) {
    let result;
    const response = { statusCode: 200, headers: {}, setHeader(key, value) { this.headers[key] = value; },
        end(body) { result = { status: this.statusCode, headers: this.headers, body: body?.toString() }; } };
    await middleware({ url, method, headers }, response, () => { result = { next: true }; });
    return result;
}

test('successful publish and rerun retain the original firstSeenAt and bytes', async t => {
    const root = await temporary(t);
    const a = await publishRelease(input(root), { now: first });
    const b = await publishRelease(input(root), { now: '2026-11-17T04:00:00Z' });
    assert.equal(a.release.firstSeenAt, b.release.firstSeenAt);
    assert.equal(b.unchanged, true);
    assert.equal(b.catalog.financeReleases.length, 1);
    assert.equal(JSON.parse((await readDataFile(root, a.release.items[0].path)).toString()).firstSeenAt, first);
});
test('mismatched identity, duplicate items and immutable collisions leave the active pointer unchanged', async t => {
    const root = await temporary(t);
    const a = await publishRelease(input(root), { now: first });
    const initial = canonical(await readCatalog(root));
    const invalid = input(root, 'finance-b'); invalid.items[0].data.symbol = '2377';
    await assert.rejects(publishRelease(invalid), /identity/);
    const duplicate = input(root, 'finance-b'); duplicate.items.push(duplicate.items[0]);
    await assert.rejects(publishRelease(duplicate), /inventory/);
    const collision = input(root); collision.items[0].data.revenue = [{ period: '2026-10', revenueThousands: 1 }];
    await assert.rejects(publishRelease(collision), /collision/);
    assert.equal(canonical(await readCatalog(root)), initial);
    assert.equal((await publishedFiles(root)).length, a.release.items.length + 2);
});
test('older downloader cannot overwrite a more recent published source', async t => {
    const root = await temporary(t);
    await publishRelease(input(root), { now: first });
    await assert.rejects(publishRelease(input(root, 'finance-old', '2026-11-01T00:00:00Z')), /older upstream/);
    assert.equal((await readCatalog(root)).financeReleases.length, 1);
});
test('concurrent publisher lock fails closed without releasing another writer lock', async t => {
    const root = await temporary(t);
    await fs.mkdir(path.join(root, '.publish-lock'));
    await assert.rejects(publishRelease(input(root)), /locked/);
    assert.equal((await fs.stat(path.join(root, '.publish-lock'))).isDirectory(), true);
    assert.equal((await readCatalog(root)).financeReleases.length, 0);
});
test('tampered bytes and symlinks cannot be read or included in a build', async t => {
    const root = await temporary(t);
    const result = await publishRelease(input(root), { now: first });
    const file = path.join(root, result.release.items[0].path);
    await fs.writeFile(file, '{}');
    await assert.rejects(readDataFile(root, result.release.items[0].path), /hash/);
    await assert.rejects(publishedFiles(root), /hash/);
    await fs.rm(file); await fs.symlink(path.join(root, 'catalog.json'), file);
    await assert.rejects(readDataFile(root, result.release.items[0].path), /Symlink/);
    for (const relative of ['../catalog.json', 'releases/x/../../catalog.json', 'https://example.com/data.json', '/etc/passwd']) {
        await assert.rejects(readDataFile(root, relative), /path/);
    }
});
test('withdrawals block old URL, old catalog and re-publication; build excludes bytes', async t => {
    const root = await temporary(t);
    const result = await publishRelease(input(root), { now: first });
    await revokeReleases({ root, kind: 'finance', reason: 'test withdrawal' });
    await assert.rejects(readDataFile(root, result.release.items[0].path, result.catalog), /revoked/);
    await assert.rejects(publishRelease(input(root)), /revoked/);
    assert.equal((await publishedFiles(root)).length, 2);
    const middleware = researchDataMiddleware(root);
    assert.equal((await request(middleware, `/research-data/${result.release.items[0].path}`)).status, 404);
});
test('preview overlays new withdrawals onto an earlier build and remembers them across pointer rollback', async t => {
    const source = await temporary(t); const built = await temporary(t);
    const result = await publishRelease(input(source), { now: first });
    for (const file of await publishedFiles(source)) {
        await fs.mkdir(path.dirname(path.join(built, file.path)), { recursive: true });
        await fs.writeFile(path.join(built, file.path), file.bytes);
    }
    const middleware = researchDataMiddleware(built, { withdrawalRoot: source });
    const url = `/research-data/${result.release.items[0].path}`;
    assert.equal((await request(middleware, url)).status, 200);
    await revokeReleases({ root: source, kind: 'finance', reason: 'upstream' });
    assert.equal((await request(middleware, url)).status, 404);
    await fs.writeFile(path.join(source, 'catalog.json'), canonical(result.catalog));
    assert.equal((await request(middleware, url)).status, 404);
    assert.deepEqual(JSON.parse((await request(middleware, '/research-data/catalog.json')).body).revoked, [result.release.id]);
    const restarted = researchDataMiddleware(built, { withdrawalRoot: source });
    assert.equal((await request(restarted, url)).status, 404);
    await assert.rejects(publishRelease(input(source, 'finance-future')), /revoked dataset/);
});
test('missing or corrupted persistent withdrawal ledger stops serving rather than reviving data', async t => {
    const root = await temporary(t); const result = await publishRelease(input(root), { now: first });
    await fs.writeFile(path.join(root, 'withdrawals.json'), '{broken');
    await assert.rejects(readCatalog(root));
    assert.equal((await request(researchDataMiddleware(root), `/research-data/${result.release.items[0].path}`)).status, 404);
    await fs.rm(path.join(root, 'withdrawals.json'));
    await assert.rejects(readCatalog(root));
    await assert.rejects(publishRelease(input(root, 'finance-b')));
});
test('read middleware denies mutations, cross-site and unlisted paths with no static fallback', async t => {
    const root = await temporary(t); const middleware = researchDataMiddleware(root);
    assert.equal((await request(middleware, '/other')).next, true);
    for (const url of ['/research-data/../secret', '/research-data/.staging/x.json', '/research-data/releases/x/2330.json', '/research-data/catalog.json?raw', '/research-data/%2e%2e/secret']) {
        assert.equal((await request(middleware, url)).status, 404);
    }
    assert.equal((await request(middleware, '/research-data/catalog.json', 'POST')).status, 403);
    assert.equal((await request(middleware, '/research-data/catalog.json', 'GET', { 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await request(middleware, '/research-data/catalog.json', 'HEAD')).body, undefined);
});
