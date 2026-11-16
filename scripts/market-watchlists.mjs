// Pro's saved symbol lists are display preferences, kept outside the SDK.
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export function marketWatchlists(filename) {
    let tail = Promise.resolve();
    return (method, pathname, body) => {
        const run = tail.then(async () => {
            let lists = [];
            try {
                const stat = await fs.lstat(filename);
                if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error('private watchlist file required');
                lists = JSON.parse(await fs.readFile(filename, 'utf8'));
                if (!Array.isArray(lists)) throw new Error('invalid display preferences');
            } catch (error) { if (error.code !== 'ENOENT') throw error; }
            const parts = pathname.split('/'); const id = parts[4];
            const index = lists.findIndex(list => list.id === id);
            let result;
            if (method === 'GET') {
                if (id && index === -1) throw new Error('watchlist not found');
                return id ? lists[index] : lists;
            }
            if (method === 'POST' && !id) {
                if (typeof body.name !== 'string' || !body.name.trim() || !Array.isArray(body.contracts)) throw new Error('invalid display preferences');
                result = { id: randomUUID(), name: body.name, contracts: body.contracts, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
                lists.push(result);
            } else {
                if (index === -1) throw new Error('watchlist not found');
                if (method === 'DELETE' && parts.length === 5) { lists.splice(index, 1); result = { deleted: id }; }
                else {
                    if (!Array.isArray(body.contracts)) throw new Error('contracts required');
                    const list = lists[index];
                    const key = contract => `${contract.security_type}:${contract.exchange}:${contract.code}`;
                    const targets = new Set(body.contracts.map(key));
                    const contracts = method === 'PUT' ? body.contracts : method === 'DELETE'
                        ? list.contracts.filter(c => !targets.has(key(c)))
                        : [...list.contracts.filter(c => !targets.has(key(c))), ...body.contracts];
                    result = lists[index] = { ...list, contracts, updated_at: new Date().toISOString() };
                }
            }
            const temporary = `${filename}.${randomUUID()}.tmp`;
            try {
                await fs.writeFile(temporary, JSON.stringify(lists), { mode: 0o600, flag: 'wx' });
                await fs.rename(temporary, filename);
            } finally { await fs.rm(temporary, { force: true }); }
            return result;
        });
        tail = run.catch(() => {});
        return run;
    };
}
