export default async (page) => {
    const origin = 'http://127.0.0.1:5174';
    const storageKey = 'neo-pro-research-workspace-v1';
    const upstreamKeys = ['sj-pro-workspace-v3', 'sj-pro-workspace-v2'];
    const context = await page.context().browser().newContext({ viewport: { width: 1440, height: 1100 } });
    const qa = await context.newPage();
    const errors = [], checks = [], calls = [];
    let requestCount = 0;
    qa.on('pageerror', error => errors.push(String(error)));
    context.on('request', () => requestCount++);

    // The host retains all observations across every document/navigation.
    await context.exposeBinding('__recordResearchCall', (_source, call) => {
        const url = new URL(String(call.url), origin);
        url.search = '';
        url.hash = '';
        calls.push({ kind: call.kind, url: url.href, protocols: call.protocols ?? [] });
    });
    await context.addInitScript(() => {
        const pending = [], reportErrors = [];
        const record = (kind, url, protocols = []) => {
            pending.push(window.__recordResearchCall({ kind, url: String(url), protocols })
                .catch(error => reportErrors.push(String(error))));
        };
        // Flush before leaving each document as well as after the final restore.
        window.__flushResearchCalls = async () => {
            await Promise.all(pending);
            if (reportErrors.length) throw new Error(reportErrors.join('; '));
        };
        const nativeFetch = window.fetch;
        window.fetch = function (...args) {
            record('fetch', args[0]?.url ?? args[0]);
            return nativeFetch.apply(this, args);
        };
        const nativeOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (method, url, ...args) {
            record('xhr', url);
            return nativeOpen.call(this, method, url, ...args);
        };
        for (const kind of ['WebSocket', 'EventSource']) {
            window[kind] = new Proxy(window[kind], {
                construct(target, args, newTarget) {
                    const protocols = kind === 'WebSocket'
                        ? typeof args[1] === 'string' ? [args[1]]
                            : Array.isArray(args[1]) ? args[1].map(String) : []
                        : [];
                    record(kind, args[0], protocols);
                    return Reflect.construct(target, args, newTarget);
                },
            });
        }
    });

    const assert = (value, message) => { if (!value) throw new Error(message); };
    const panels = () => qa.locator('.research-panel');
    const first = () => panels().first();
    const flushCalls = () => qa.evaluate(() => window.__flushResearchCalls?.());
    const reload = async () => {
        await flushCalls();
        await qa.reload();
        await qa.locator('.nr-entity').first().waitFor();
    };
    const geometry = state => state.layout.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }))
        .sort((a, b) => a.i.localeCompare(b.i));
    const stableGeometry = () => qa.evaluate(async key => {
        let previous = '', stableFrames = 0;
        for (let frame = 0; frame < 120; frame++) {
            await new Promise(resolve => requestAnimationFrame(resolve));
            const state = JSON.parse(localStorage.getItem(key));
            const layout = state.layout.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }))
                .sort((a, b) => a.i.localeCompare(b.i));
            const current = JSON.stringify(layout);
            stableFrames = current === previous ? stableFrames + 1 : 0;
            previous = current;
            if (stableFrames >= 3) return layout;
        }
        throw new Error('Stored research geometry did not settle');
    }, storageKey);
    const assertGeometry = async (expected, label) => {
        // Wait for RGL mount callbacks and storage effects before comparing.
        await qa.waitForFunction(({ key, expected }) => {
            const state = JSON.parse(localStorage.getItem(key));
            const actual = state.layout.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }))
                .sort((a, b) => a.i.localeCompare(b.i));
            return document.querySelectorAll('.research-panel').length === expected.length
                && JSON.stringify(actual) === JSON.stringify(expected);
        }, { key: storageKey, expected });
        assert(JSON.stringify(await stableGeometry()) === JSON.stringify(expected), label);
    };
    const isViteHmr = call => {
        if (call.kind !== 'WebSocket') return false;
        const url = new URL(call.url, origin);
        return url.protocol === 'ws:' && url.hostname === '127.0.0.1' && url.port === '5174'
            && url.pathname === '/' && url.username === '' && url.password === ''
            && call.protocols.length === 1 && call.protocols[0] === 'vite-hmr';
    };

    try {
        await qa.goto(`${origin}/research.html?popout=ticket&mockPendingConfirm&condDemo`);
        await qa.locator('.nr-entity').first().waitFor();
        assert(await panels().count() === 2, 'default panels');
        checks.push('trading query flags ignored');
        await qa.getByRole('button', { name: /2377 上市 微星/ }).click();
        await first().getByText('2377 · 2026-11-13', { exact: true }).waitFor();
        assert((await panels().nth(1).innerText()).includes('2891 ·'), 'pinned second panel');
        await first().getByTitle('跟隨自選清單選擇；點擊鎖定目前商品').click();
        await qa.getByRole('button', { name: /6488 上櫃 環球晶/ }).click();
        assert((await first().innerText()).includes('2377 ·'), 'pin follows wrong symbol');
        await first().getByTitle('已鎖定；點擊恢復連動').click();
        await first().getByText('6488 · 2026-11-13', { exact: true }).waitFor();
        checks.push('selection and pin/unpin');
        await qa.getByLabel('截至時間', { exact: true }).fill('10:00');
        await first().getByRole('button', { name: '重播', exact: true }).click();
        await first().locator('table tbody tr').first().waitFor();
        const times = await first().locator('tbody th').allTextContents();
        assert(times.length && times.every(time => time <= '10:00'), 'future replay rows');
        checks.push('causal cursor prefix');
        await qa.getByLabel('交易日', { exact: true }).selectOption('2026-11-12');
        await first().getByText('6488 · 2026-11-12', { exact: true }).waitFor();
        await panels().nth(1).getByRole('button', { name: '財務', exact: true }).click();
        await panels().nth(1).getByRole('region', { name: '示範季度財報表，可水平與垂直捲動' }).waitFor();
        checks.push('date and financial table');

        const beforeDrag = await stableGeometry();
        const header = await first().locator('.drag-handle').boundingBox();
        assert(header, 'drag handle missing');
        await qa.mouse.move(header.x + 80, header.y + 20);
        await qa.mouse.down();
        await qa.mouse.move(header.x + 680, header.y + 20, { steps: 18 });
        await qa.mouse.up();
        await qa.waitForFunction(({ key, before }) => {
            const state = JSON.parse(localStorage.getItem(key));
            const actual = state.layout.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }))
                .sort((a, b) => a.i.localeCompare(b.i));
            return JSON.stringify(actual) !== JSON.stringify(before);
        }, { key: storageKey, before: beforeDrag });
        checks.push('drag persists geometry');
        await first().scrollIntoViewIfNeeded();
        const panelId = await first().getAttribute('data-panel-id');
        const handle = await first().locator('.react-resizable-handle').boundingBox();
        assert(handle, 'resize handle missing');
        const beforeResize = (await stableGeometry()).find(item => item.i === panelId);
        await qa.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
        await qa.mouse.down();
        await qa.mouse.move(handle.x - 80, handle.y + 100, { steps: 20 });
        await qa.mouse.up();
        await qa.waitForFunction(({ key, id, before }) => {
            const item = JSON.parse(localStorage.getItem(key)).layout.find(item => item.i === id);
            return item && (item.w !== before.w || item.h !== before.h);
        }, { key: storageKey, id: panelId, before: beforeResize });
        const resizedGeometry = await stableGeometry();
        await reload();
        await first().getByText('6488 · 2026-11-12', { exact: true }).waitFor();
        await assertGeometry(resizedGeometry, 'drag/resize geometry changed on reload');
        checks.push('drag/resize/reload preserves every panel x/y/w/h');
        await qa.getByRole('button', { name: '新增研究面板', exact: true }).click();
        await qa.waitForFunction(() => document.querySelectorAll('.research-panel').length === 3);
        await panels().last().getByTitle('移除此面板').click();
        await qa.waitForFunction(() => document.querySelectorAll('.research-panel').length === 2);
        const afterRemove = await stableGeometry();
        await reload();
        await first().getByText('6488 · 2026-11-12', { exact: true }).waitFor();
        assert(await qa.getByLabel('截至時間', { exact: true }).inputValue() === '10:00', 'restore cursor');
        await assertGeometry(afterRemove, 'add/remove geometry changed on reload');
        checks.push('add/remove/reload');
        await qa.getByLabel('其他代號', { exact: true }).fill('0000');
        await qa.getByRole('button', { name: '查詢', exact: true }).click();
        await first().getByText('此查詢沒有示範資料').waitFor();
        checks.push('missing data');
        for (const key of ['b', 's', 'Escape', 'Escape']) await qa.keyboard.press(key);

        const blocked = {};
        for (const route of ['/api/accounts', '/api/orders', '/admin', '/stream', '/index.html', '/approval.html']) {
            const response = await context.request.get(origin + route);
            blocked[route] = response.status();
            assert(response.status() === 403, `route ${route}`);
        }
        checks.push('forbidden routes rejected');
        const unknownBookmark = await context.request.get(`${origin}/missing-research-bookmark`);
        const unknownBody = await unknownBookmark.text();
        assert(unknownBookmark.status() === 404, 'unknown bookmark must return 404');
        assert(!unknownBody.includes('src/main.tsx'), 'unknown bookmark returned the trading entry');
        blocked['/missing-research-bookmark'] = unknownBookmark.status();
        checks.push('unknown bookmark returns 404 without trading HTML');

        // Valid upstream v3 uses the 288-column grid; v2 uses the legacy 24-column grid.
        const upstreamWorkspaces = {
            'sj-pro-workspace-v3': {
                blocks: [{ id: 'ticket-v3', type: 'ticket', pin: '2377' }],
                layout: [{ i: 'ticket-v3', x: 0, y: 0, w: 144, h: 16, minW: 48, minH: 10 }],
            },
            'sj-pro-workspace-v2': {
                blocks: [{ id: 'flash-v2', type: 'flash', pin: '6488' }],
                layout: [{ i: 'flash-v2', x: 0, y: 0, w: 12, h: 16, minW: 4, minH: 10 }],
            },
        };
        // Test each real upstream key independently, then both together without an own key.
        for (const keys of [[upstreamKeys[0]], [upstreamKeys[1]], upstreamKeys]) {
            await qa.evaluate(({ ownKey, allKeys, keys, workspaces }) => {
                localStorage.removeItem(ownKey);
                for (const key of allKeys) localStorage.removeItem(key);
                for (const key of keys) localStorage.setItem(key, JSON.stringify(workspaces[key]));
            }, { ownKey: storageKey, allKeys: upstreamKeys, keys, workspaces: upstreamWorkspaces });
            await reload();
            await first().getByText('2330 · 2026-11-13', { exact: true }).waitFor();
            assert(await panels().count() === 2, `upstream-only ${keys.join(',')} changed defaults`);
            const restored = await qa.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
            assert(restored.symbol === '2330' && restored.date === '2026-11-13'
                && restored.cutoff === '13:30', 'upstream-only selection changed research defaults');
            assert(restored.panels[0].id === 'research-1' && restored.panels[0].pin === null
                && restored.panels[1].id === 'research-2' && restored.panels[1].pin === '2891',
            'upstream-only panel types or pins changed research defaults');
            for (const key of keys) {
                const raw = await qa.evaluate(key => localStorage.getItem(key), key);
                assert(raw === JSON.stringify(upstreamWorkspaces[key]), 'research modified upstream storage');
            }
        }
        checks.push('real upstream v3/v2 keys alone restore research defaults');
        const ownWorkspace = {
            version: 1, symbol: '6488', date: '2026-11-12', cutoff: '10:00',
            panels: [
                { id: 'research-bad', type: 'ticket', pin: '2377' },
                { id: 'research-safe', type: 'neo-research', pin: '2891' },
            ],
            layout: [{ i: 'research-safe', x: 0, y: 0, w: 6, h: 16 }],
        };
        await qa.evaluate(({ ownKey, own, upstream }) => {
            for (const [key, value] of Object.entries(upstream)) localStorage.setItem(key, JSON.stringify(value));
            localStorage.setItem(ownKey, JSON.stringify(own));
        }, { ownKey: storageKey, own: ownWorkspace, upstream: upstreamWorkspaces });
        await reload();
        await first().getByText('2891 · 2026-11-12', { exact: true }).waitFor();
        assert(await panels().count() === 1, 'restore allowlist');
        const finalState = await qa.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
        assert(finalState.symbol === '6488' && finalState.date === '2026-11-12'
            && finalState.cutoff === '10:00', 'research namespace selection was not restored');
        assert(finalState.panels[0].id === 'research-safe' && finalState.panels[0].pin === '2891',
            'research namespace panel was not restored');
        assert(JSON.stringify(geometry(finalState)) === JSON.stringify(geometry(ownWorkspace)),
            'research namespace geometry changed');
        checks.push('coexisting upstream keys ignored; own namespace filters trading panels');

        // No navigation/interaction follows this last cumulative assertion.
        await qa.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await flushCalls();
        const unexpected = calls.filter(call => !isViteHmr(call));
        assert(unexpected.length === 0, `unexpected network attempts: ${JSON.stringify(unexpected)}`);
        checks.push('all navigations: zero fetch/XHR/SSE/broker sockets; only identified Vite HMR allowed');
        assert(errors.length === 0, errors.join('; '));
        return { checks, blocked, calls, pageErrors: errors, requests: requestCount,
            viewport: { width: 1440, height: 1100 } };
    } finally {
        await context.close();
    }
};
