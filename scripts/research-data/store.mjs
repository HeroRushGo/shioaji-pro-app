import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/;
const iso = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
const fields = kind => kind === 'finance' ? 'financeReleases' : kind === 'replay' ? 'replayReleases' : null;
const clock = options => typeof options?.now === 'function' ? options.now() : options?.now ?? new Date().toISOString();
const empty = () => ({ schemaVersion: 1, updatedAt: '1970-01-01T00:00:00.000Z', revoked: [], financeReleases: [], replayReleases: [] });
const emptyWithdrawals = () => ({ schemaVersion: 1, updatedAt: '1970-01-01T00:00:00.000Z', revoked: [], blockedKinds: [] });

export function validDataPath(value) {
    return typeof value === 'string' && /^releases\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}\/[a-zA-Z0-9_-]+\.json$/.test(value);
}

export function validateCatalog(catalog) {
    if (!catalog || catalog.schemaVersion !== 1 || !iso(catalog.updatedAt)
        || !Array.isArray(catalog.revoked) || catalog.revoked.some(id => typeof id !== 'string' || !idPattern.test(id))) throw new Error('Invalid research catalog');
    const ids = new Set();
    for (const kind of ['finance', 'replay']) {
        if (!Array.isArray(catalog[fields(kind)])) throw new Error('Invalid release inventory');
        for (const release of catalog[fields(kind)]) {
            if (!release || typeof release.id !== 'string' || !idPattern.test(release.id) || ids.has(release.id) || !iso(release.firstSeenAt)
                || !Array.isArray(release.items) || !release.items.length) throw new Error('Invalid release');
            ids.add(release.id);
            const revision = kind === 'finance' ? release.upstreamCommit : release.neoCommit;
            if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Missing pinned source revision');
            if (kind === 'finance' && !iso(release.upstreamBuiltAt)) throw new Error('Invalid upstream build time');
            const seen = new Set();
            for (const item of release.items) {
                const key = `${item.symbol}/${item.date ?? ''}`;
                if (!/^\d{4}$/.test(item.symbol) || !['TSE', 'OTC'].includes(item.market)
                    || typeof item.name !== 'string' || !item.name || item.name.length > 100
                    || !validDataPath(item.path) || !item.path.startsWith(`releases/${release.id}/`)
                    || !/^[a-f0-9]{64}$/.test(item.sha256) || seen.has(key)
                    || (kind === 'replay' && !/^\d{4}-\d\d-\d\d$/.test(item.date))) throw new Error('Invalid inventory item');
                seen.add(key);
            }
        }
    }
    return catalog;
}

async function rootPath(root, create = false) {
    const absolute = path.resolve(root);
    if (create) await fs.mkdir(absolute, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(absolute);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Research data root must be a real directory');
    return fs.realpath(absolute);
}

async function readFileChecked(root, relative, maxBytes = 16 * 1024 * 1024) {
    let current = root;
    for (const part of relative.split('/')) {
        current = path.join(current, part);
        if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Symlink in research data');
    }
    const handle = await fs.open(current, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > maxBytes) throw new Error('Research data size/type rejected');
        return await handle.readFile();
    } finally { await handle.close(); }
}

export async function readCatalog(root) {
    let directory;
    try {
        directory = await rootPath(root);
    } catch (error) { if (error.code === 'ENOENT') return empty(); throw error; }
    let catalog;
    let exists = true;
    try { catalog = validateCatalog(JSON.parse((await readFileChecked(directory, 'catalog.json', 4 * 1024 * 1024)).toString('utf8'))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; catalog = empty(); exists = false; }
    const withdrawals = await readWithdrawals(directory, !exists);
    const revoked = new Set([...catalog.revoked, ...withdrawals.revoked]);
    for (const kind of withdrawals.blockedKinds) for (const release of catalog[fields(kind)]) revoked.add(release.id);
    return { ...catalog, revoked: [...revoked], blockedKinds: withdrawals.blockedKinds,
        updatedAt: Date.parse(withdrawals.updatedAt) > Date.parse(catalog.updatedAt) ? withdrawals.updatedAt : catalog.updatedAt };
}

async function readWithdrawals(root, allowAbsent = false) {
    try {
        const value = JSON.parse((await readFileChecked(root, 'withdrawals.json', 1024 * 1024)).toString('utf8'));
        if (!value || value.schemaVersion !== 1 || !iso(value.updatedAt) || !Array.isArray(value.revoked)
            || value.revoked.some(id => typeof id !== 'string' || !idPattern.test(id))
            || !Array.isArray(value.blockedKinds) || value.blockedKinds.some(kind => !fields(kind))) throw new Error('Withdrawal ledger is invalid; data serving disabled');
        return value;
    } catch (error) {
        if (error.code === 'ENOENT' && allowAbsent) return emptyWithdrawals();
        throw error;
    }
}

async function locked(root, work) {
    const directory = await rootPath(root, true);
    const lock = path.join(directory, '.publish-lock');
    try { await fs.mkdir(lock, { mode: 0o700 }); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('Research publisher is locked; inspect the other writer before removing a stale lock'); throw error; }
    try { return await work(directory); }
    finally { await fs.rm(lock, { recursive: true }); }
}

async function writeJson(root, filename, value) {
    const temporary = path.join(root, `.publish-${randomUUID()}.json`);
    try {
        await fs.writeFile(temporary, canonical(value), { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, path.join(root, filename));
    } finally { await fs.rm(temporary, { force: true }); }
}
async function writeCatalog(root, catalog) {
    validateCatalog(catalog);
    await writeJson(root, 'catalog.json', catalog);
}

/** Publish only a fully validated, projected dataset. No network or SDK here. */
export async function publishRelease(input, options = {}) {
    const { root, kind, id, metadata, items } = input;
    if (!fields(kind) || typeof id !== 'string' || !idPattern.test(id) || !Array.isArray(items) || !items.length || items.length > 2000) throw new Error('Invalid publication input');
    return locked(root, async directory => {
        const catalog = await readCatalog(directory);
        if (catalog.revoked.includes(id)) throw new Error('A revoked release cannot be republished');
        if (catalog.blockedKinds?.includes(kind)) throw new Error('A revoked dataset cannot be published until withdrawal review');
        const previous = catalog[fields(kind)].find(release => release.id === id);
        if (kind === 'finance' && !previous && catalog.financeReleases.some(release =>
            !catalog.revoked.includes(release.id) && Date.parse(release.upstreamBuiltAt) > Date.parse(metadata?.upstreamBuiltAt))) {
            throw new Error('Refusing to publish an older upstream snapshot over a newer retained release');
        }
        const firstSeenAt = previous?.firstSeenAt ?? clock(options);
        if (!iso(firstSeenAt)) throw new Error('Invalid observation time');
        const blobs = [];
        const inventory = items.map(item => {
            const { symbol, name, market, date, data } = item;
            if (!data || data.schemaVersion !== 1 || data.kind !== kind || data.symbol !== symbol || data.market !== market
                || data.name !== name || (kind === 'replay' && data.date !== date)) throw new Error('Publication identity mismatch');
            const filename = `${symbol}${kind === 'replay' ? `-${date}` : ''}.json`;
            const relative = `releases/${id}/${filename}`;
            if (!validDataPath(relative)) throw new Error('Invalid publication path');
            const bytes = Buffer.from(canonical({ ...data, releaseId: id, firstSeenAt }));
            if (bytes.length > 16 * 1024 * 1024) throw new Error('Publication exceeds payload limit');
            blobs.push({ filename, bytes });
            return { symbol, name, market, ...(kind === 'replay' ? { date } : {}), path: relative, sha256: sha256(bytes) };
        });
        const release = { ...metadata, id, firstSeenAt, items: inventory };
        const next = { ...catalog, updatedAt: clock(options), [fields(kind)]: [...catalog[fields(kind)].filter(release => release.id !== id), release] };
        validateCatalog(next);
        if (previous) {
            if (canonical(previous) !== canonical(release)) throw new Error('Immutable release collision');
            for (const item of previous.items) await readDataFile(directory, item.path, catalog);
            return { release: previous, catalog, unchanged: true };
        }
        const releases = path.join(directory, 'releases');
        await fs.mkdir(releases, { recursive: true, mode: 0o700 });
        if ((await fs.lstat(releases)).isSymbolicLink()) throw new Error('Symlink release directory');
        const staging = path.join(directory, `.staging-${randomUUID()}`);
        await fs.mkdir(staging, { mode: 0o700 });
        const destination = path.join(releases, id);
        let moved = false;
        let published = false;
        try {
            for (const blob of blobs) await fs.writeFile(path.join(staging, blob.filename), blob.bytes, { flag: 'wx', mode: 0o600 });
            // rename must not replace an orphan or an existing immutable dataset.
            try { await fs.lstat(destination); throw new Error('Release directory already exists without a matching catalog; inspect the orphan'); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
            await fs.rename(staging, destination); moved = true;
            // The withdrawal ledger is independent of the replaceable pointer.
            // An existing catalog with a missing ledger has already failed closed.
            try { await fs.lstat(path.join(directory, 'withdrawals.json')); }
            catch (error) { if (error.code !== 'ENOENT') throw error; await writeJson(directory, 'withdrawals.json', emptyWithdrawals()); }
            await writeCatalog(directory, next); published = true;
            return { release, catalog: next, unchanged: false };
        } finally {
            await fs.rm(staging, { recursive: true, force: true });
            if (moved && !published) await fs.rm(destination, { recursive: true, force: true });
        }
    });
}

/** Unknown upstream withdrawals fail closed across all retained versions. */
export async function revokeReleases({ root, kind, reason }, options = {}) {
    if (!fields(kind)) throw new Error('Unknown revoked dataset');
    return locked(root, async directory => {
        const catalog = await readCatalog(directory);
        const before = await readWithdrawals(directory, !catalog.financeReleases.length && !catalog.replayReleases.length);
        const revoked = [...new Set([
            ...catalog.revoked, ...catalog[fields(kind)].map(release => release.id),
        ])];
        const notice = String(reason ?? 'upstream withdrawal requires review').slice(0, 500);
        const ledger = { ...before, updatedAt: clock(options), revoked,
            blockedKinds: [...new Set([...before.blockedKinds, kind])], reason: notice };
        // Persist withdrawals first: a later pointer-write failure cannot revive data.
        await writeJson(directory, 'withdrawals.json', ledger);
        const next = { ...catalog, updatedAt: ledger.updatedAt, revoked, blockedKinds: ledger.blockedKinds, revocationNotice: notice };
        await writeCatalog(directory, next);
        return next;
    });
}

/** The catalog, not a URL-derived filesystem path, is the read allowlist. */
export async function readDataFile(root, relative, selectedCatalog) {
    if (!validDataPath(relative)) throw new Error('Research data path rejected');
    const directory = await rootPath(root);
    // Always apply the current withdrawal list, even with a pinned old catalog.
    const current = await readCatalog(directory);
    const catalog = selectedCatalog ?? current;
    let approved;
    for (const [kind, release] of [
        ...catalog.financeReleases.map(release => ['finance', release]),
        ...catalog.replayReleases.map(release => ['replay', release]),
    ]) {
        if (current.blockedKinds?.includes(kind) || catalog.blockedKinds?.includes(kind)) continue;
        if (current.revoked.includes(release.id) || catalog.revoked.includes(release.id)) continue;
        const item = release.items.find(item => item.path === relative);
        if (item) { approved = item; break; }
    }
    if (!approved) throw new Error('Unknown or revoked research payload');
    const bytes = await readFileChecked(directory, approved.path);
    if (sha256(bytes) !== approved.sha256) throw new Error('Research payload hash mismatch');
    return bytes;
}

export async function publishedFiles(root) {
    const catalog = await readCatalog(root);
    const files = [{ path: 'catalog.json', bytes: Buffer.from(canonical(catalog)) }];
    let ledger = emptyWithdrawals();
    try { ledger = await readWithdrawals(await rootPath(root), !catalog.financeReleases.length && !catalog.replayReleases.length); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    files.push({ path: 'withdrawals.json', bytes: Buffer.from(canonical(ledger)) });
    for (const release of [...catalog.financeReleases, ...catalog.replayReleases]) {
        if (catalog.revoked.includes(release.id)) continue;
        for (const item of release.items) files.push({ path: item.path, bytes: await readDataFile(root, item.path, catalog) });
    }
    // Recheck the pointer/withdrawals to avoid building a torn snapshot.
    if (canonical(await readCatalog(root)) !== canonical(catalog)) throw new Error('Research catalog changed during export; retry the build');
    return files;
}
