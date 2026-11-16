// Run by a host with an existing Playwright Page. All state, interception and
// navigation belong to a new isolated context; the user's Page is untouched.
export async function run(page, { origin = 'http://127.0.0.1:5174' } = {}) {
    const context = await page.context().browser().newContext({ viewport: { width: 1440, height: 1100 } });
    const qa = await context.newPage();
    const checks = [], calls = [], pageErrors = [], ticketActions = [], dialogs = [], browserRequests = [];
    const assert = (condition, message) => { if (!condition) throw new Error(message); };
    const same = (actual, expected, message) => assert(JSON.stringify(actual) === JSON.stringify(expected),
        `${message}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
    const storageKey = 'neo-pro-research-workspace-v1';
    const pinnedCommit = '526c518249a3c5bdaa74d63684c0358db7c248e6';
    const observePage = observed => {
        observed.on('pageerror', error => pageErrors.push(String(error)));
        observed.on('dialog', dialog => { dialogs.push(dialog.type()); void dialog.dismiss(); });
    };
    observePage(qa); context.on('page', observePage);
    context.on('request', request => browserRequests.push({ url: request.url(), method: request.method(), resourceType: request.resourceType() }));
    await context.exposeBinding('__recordRealResearchCall', (_source, value) => {
        const url = new URL(String(value.url), origin);
        const queryPresent = url.search !== '';
        url.search = ''; url.hash = '';
        calls.push({ kind: value.kind, url: url.href, method: value.method ?? 'GET', queryPresent, protocols: value.protocols ?? [] });
    });
    await context.exposeBinding('__recordRealResearchTicket', (_source, event) => ticketActions.push(event.type));
    await context.addInitScript(() => {
        const pending = [], failures = [];
        const record = value => pending.push(window.__recordRealResearchCall(value).catch(error => failures.push(String(error))));
        window.__flushRealResearchCalls = async () => { await Promise.all(pending); if (failures.length) throw new Error(failures.join('; ')); };
        const nativeFetch = window.fetch;
        window.fetch = function (...args) {
            record({ kind: 'fetch', url: String(args[0]?.url ?? args[0]), method: args[1]?.method ?? args[0]?.method ?? 'GET' });
            return nativeFetch.apply(this, args);
        };
        const nativeOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (method, url, ...args) {
            record({ kind: 'xhr', url: String(url), method });
            return nativeOpen.call(this, method, url, ...args);
        };
        for (const kind of ['WebSocket', 'EventSource']) {
            window[kind] = new Proxy(window[kind], { construct(target, args, newTarget) {
                const protocols = kind === 'WebSocket' ? typeof args[1] === 'string' ? [args[1]]
                    : Array.isArray(args[1]) ? args[1].map(String) : [] : [];
                record({ kind, url: String(args[0]), protocols });
                return Reflect.construct(target, args, newTarget);
            } });
        }
        window.addEventListener('sj-ticket-action', event => {
            pending.push(window.__recordRealResearchTicket({ type: event.type }).catch(error => failures.push(String(error))));
        });
    });
    const first = () => qa.locator('.research-panel').first();
    const second = () => qa.locator('.research-panel').nth(1);
    const settled = async (panel = first()) => {
        await panel.locator('.nr-panel[aria-busy="false"]').waitFor();
        await panel.locator('.nr-entity').waitFor();
    };
    const tab = async (name, panel = first()) => { await panel.getByRole('button', { name, exact: true }).click(); await settled(panel); };
    const flush = () => qa.evaluate(() => window.__flushRealResearchCalls?.());
    const reload = async () => { await flush(); await qa.reload(); await settled(); };
    const facts = (panel = first()) => panel.locator('.nr-facts > div').evaluateAll(elements =>
        Object.fromEntries(elements.map(element => [element.querySelector('dt')?.textContent, element.querySelector('dd')?.textContent])));
    const status = async (label, expected, panel = first()) => {
        await panel.locator(`[data-dataset="${label}"][data-status="${expected}"]`).waitFor();
    };
    const number = value => value == null ? '—' : value.toLocaleString('zh-TW', { maximumFractionDigits: 2 });
    const rows = (panel = first()) => panel.locator('table tbody tr').evaluateAll(elements => elements.map(element =>
        [...element.querySelectorAll('th,td')].map(cell => cell.textContent)));
    const setCutoff = async value => { await qa.getByLabel('截至時間', { exact: true }).fill(value); await settled(); };
    const selectCompany = async (code, name, market) => {
        await qa.getByRole('button', { name: new RegExp(`${code} ${market} ${name}`) }).click();
        await settled();
        assert((await first().locator('.nr-entity').innerText()).includes(code), `wrong company after selecting ${code}`);
    };
    const isHmr = call => {
        if (call.kind !== 'WebSocket') return false;
        const url = new URL(call.url); const site = new URL(origin);
        return url.protocol === (site.protocol === 'https:' ? 'wss:' : 'ws:') && url.hostname === site.hostname
            && url.port === site.port && url.pathname === '/' && !url.username && !url.password
            && call.protocols.length === 1 && call.protocols[0] === 'vite-hmr';
    };
    let catalog, financeRelease, replayRelease;
    const verifiedPayloads = [], payloadCache = new Map();
    async function readVerified(item) {
        assert(/^releases\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}\/[a-zA-Z0-9_-]+\.json$/.test(item.path), 'unexpected expected-data path');
        if (payloadCache.has(item.path)) return payloadCache.get(item.path);
        const response = await context.request.get(`${origin}/research-data/${item.path}`);
        assert(response.status() === 200, `expected published payload unavailable: ${item.path}`);
        assert((response.headers()['content-type'] ?? '').includes('application/json'), 'expected payload is not JSON');
        const bytes = await response.body();
        const hash = await qa.evaluate(async values => {
            const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(values));
            return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
        }, [...bytes]);
        assert(hash === item.sha256, `expected payload hash mismatch: ${item.path}`);
        const payload = JSON.parse(bytes.toString('utf8'));
        assert(payload.symbol === item.symbol && payload.market === item.market, 'expected payload identity mismatch');
        verifiedPayloads.push({ path: item.path, sha256: hash, symbol: item.symbol });
        payloadCache.set(item.path, { payload, bytes });
        return { payload, bytes };
    }
    function findItem(release, symbol, date) {
        const item = release.items.find(item => item.symbol === symbol && (date === undefined || item.date === date));
        assert(item, `required published item missing: ${symbol}/${date ?? 'finance'}`);
        return item;
    }
    async function assertReplay(expected, cutoff, panel = first()) {
        await tab('重播', panel); await status('neo 重播', 'ready', panel);
        const actual = await rows(panel);
        const prefix = expected.points.filter(point => point.time <= cutoff);
        same(actual.map(row => row[0]), prefix.map(point => point.time), 'replay timestamps differ from immutable neo export');
        same(actual, prefix.map(point => [point.time, number(point.price), number(point.vwap), number(point.poc)]), 'replay display differs from exported values');
        assert(actual.every(row => row[0] <= cutoff), 'future replay point visible');
        return actual;
    }

    try {
        const response = await context.request.get(`${origin}/research-data/catalog.json`);
        assert(response.status() === 200, 'import finance and neo replay before running real-data QA');
        catalog = await response.json();
        assert(catalog.schemaVersion === 1 && Array.isArray(catalog.revoked), 'invalid real-data catalog');
        const newestFirst = (a, b) => Date.parse(b.firstSeenAt) - Date.parse(a.firstSeenAt) || b.id.localeCompare(a.id);
        const activeFinance = catalog.financeReleases.filter(release => !catalog.revoked.includes(release.id)).sort(newestFirst);
        financeRelease = activeFinance.find(release => release.upstreamCommit === pinnedCommit
            && ['2330', '2377', '6488', '2891'].every(symbol => release.items.some(item => item.symbol === symbol)));
        assert(financeRelease, 'four-stock finance release from independently checked commit is required');
        replayRelease = [...catalog.replayReleases].sort(newestFirst).find(release => !catalog.revoked.includes(release.id)
            && ['2330', '2377', '6488', '2891'].every(symbol => release.items.some(item => item.symbol === symbol && item.date === '2026-11-13')));
        assert(replayRelease, 'four-stock 2026-11-13 neo replay release is required');
        await qa.goto(`${origin}/research.html?popout=ticket&mockPendingConfirm&condDemo`);
        await qa.getByRole('heading', { name: 'Neo 研究工作台', exact: true }).waitFor();
        await settled();
        assert(await qa.getByLabel('資料來源', { exact: true }).inputValue() === 'real', 'fresh workspace must use real data');
        assert(await qa.getByLabel('財務時點', { exact: true }).inputValue() === 'latest', 'fresh workspace must use latest finance');
        assert(await qa.locator('.research-demo[data-source="real"]').count() === 1, 'real-data banner missing');
        await status('財務', 'ready'); await status('neo 重播', 'ready');
        checks.push('fresh isolated workspace uses real/latest; trading query flags ignored');

        const finance2330 = (await readVerified(findItem(financeRelease, '2330'))).payload;
        const finance6488 = (await readVerified(findItem(financeRelease, '6488'))).payload;
        const finance2891 = (await readVerified(findItem(financeRelease, '2891'))).payload;
        const replay2330 = (await readVerified(findItem(replayRelease, '2330', '2026-11-13'))).payload;
        assert(replay2330.samplingMinutes === 30, 'QA expects the requested 30-minute neo export');
        assert(finance2330.revenue.find(row => row.period === '2026-10')?.revenueThousands === 586890319, 'independent TWSE revenue golden mismatch');
        assert(finance2330.quarters.find(row => row.period === '2026Q3')?.eps === 29.42, 'independent Q3 EPS projection golden mismatch');
        assert(finance6488.revenue.find(row => row.period === '2026-10')?.revenueThousands === 4764123, 'independent TPEx revenue golden mismatch');
        assert(finance2891.quarters.every(row => row.grossMarginPercent === null), 'financial-industry margin must remain null');
        await tab('概覽');
        const overview = await facts();
        assert(overview['營收月份'] === '2026-10' && overview['月營收（千元）'] === '586,890,319', 'real TWSE month/value not displayed');
        assert(overview['財報季別'] === '2026Q3' && overview['每股盈餘（元）'] === '29.42', 'real single-quarter EPS not displayed');
        assert(overview['EPS 口徑'] === '單季，累計相減推算', 'derived EPS must not be labelled reported YTD');
        assert((await first().innerText()).includes('不是當時已知資料'), 'latest finance lacks historical-time distinction');
        checks.push('SHA-verified finance is anchored to independent official numeric goldens and explicit derived EPS');

        await tab('來源');
        const sourceText = await first().innerText();
        for (const text of ['財務來源', 'neo 重播來源', 'shioaji-public', 'neo-replay', financeRelease.id, replayRelease.id,
            pinnedCommit, 'decision_eligible=false']) assert(sourceText.includes(text), `source metadata missing: ${text}`);
        checks.push('finance and neo replay expose separate source/version/first-retained metadata');

        await tab('財務', second());
        const bankRows = await second().getByRole('region', { name: '真實季度財報表，可水平與垂直捲動' }).locator('tbody tr').allTextContents();
        const bankMargins = await second().getByRole('region', { name: '真實季度財報表，可水平與垂直捲動' }).locator('tbody tr td:last-child').allTextContents();
        assert(bankRows.length > 0 && bankMargins.every(value => value === '—'), 'banking gross margin was fabricated');
        checks.push('banking financial format preserves non-applicable gross margins');

        await qa.getByLabel('財務時點', { exact: true }).selectOption('as_of');
        await tab('概覽'); await status('財務', 'not-retained'); await status('neo 重播', 'ready');
        assert(!(await first().innerText()).includes('586,890,319'), 'current finance leaked into unretained historical query');
        await assertReplay(replay2330, '13:30');
        checks.push('as_of 2026-11-13 has no retained finance; neo historical replay remains available');
        await setCutoff('08:59');
        await assertReplay(replay2330, '08:59');
        await first().getByText('游標前沒有重播資料。', { exact: true }).waitFor();
        assert(await first().locator('svg[role="img"]').count() === 0, 'pre-open chart borrowed a future value');
        checks.push('pre-first-sample cursor stays empty without borrowing future points');
        await setCutoff('10:15');
        const prefix = await assertReplay(replay2330, '10:15');
        assert(prefix.length > 0 && prefix.at(-1)[0] === '10:00', 'minute cursor did not stop at the last 30-minute sample');
        assert((await first().innerText()).includes('2026-11-13T10:00:00+08:00'), 'actual sampled time is not distinguished from request 10:15');
        checks.push('minute cursor exposes exact neo prefix values only through actual sample 10:00');

        await qa.getByLabel('財務時點', { exact: true }).selectOption('latest');
        await setCutoff('13:30');
        await selectCompany('6488', '環球晶', '上櫃'); await tab('概覽'); await status('財務', 'ready');
        assert((await first().locator('.nr-entity').innerText()).includes('OTC · 6488'), 'OTC market identity lost');
        assert((await facts())['月營收（千元）'] === '4,764,123', 'real TPEx revenue not displayed');
        checks.push('switching to OTC stock preserves its market and independently checked revenue');
        await qa.getByLabel('交易日', { exact: true }).fill('2026-11-12'); await settled();
        await status('財務', 'ready'); await status('neo 重播', 'missing');
        assert((await facts())['月營收（千元）'] === '4,764,123', 'latest finance was incorrectly bound to missing replay date');
        assert(await first().locator('.nr-metrics').count() === 0, 'missing replay date reused another date\'s values');
        await qa.getByLabel('交易日', { exact: true }).fill('2026-11-13'); await settled();
        await status('neo 重播', 'ready');
        checks.push('changing real replay date keeps latest finance but never borrows another replay date');
        await qa.getByLabel('其他代號', { exact: true }).fill('0000');
        await qa.getByRole('button', { name: '查詢', exact: true }).click(); await settled();
        await status('財務', 'missing'); await status('neo 重播', 'missing');
        assert(await first().locator('.nr-metrics,.nr-facts').count() === 0, 'unknown stock received borrowed real or synthetic values');
        checks.push('unknown real stock stays missing in both datasets without fixture fallback');

        await selectCompany('2330', '台積電', '上市');
        await qa.getByLabel('資料來源', { exact: true }).selectOption('fixture'); await settled();
        await first().getByText('示範資料，非真實行情或財報', { exact: true }).waitFor();
        assert((await first().innerText()).includes('120,000') && !(await first().innerText()).includes('586,890,319'), 'explicit fixture mode not distinct from real data');
        await qa.getByLabel('資料來源', { exact: true }).selectOption('real');
        assert(!(await first().innerText()).includes('120,000'), 'synthetic result remained visible after real mode selected');
        for (const selector of [/6488 上櫃 環球晶/, /2377 上市 微星/, /2330 上市 台積電/]) {
            await qa.getByRole('button', { name: selector }).click();
        }
        await settled(); await status('財務', 'ready');
        assert((await first().locator('.nr-entity').innerText()).includes('TSE · 2330'), 'rapid selection published stale company identity');
        assert((await facts())['月營收（千元）'] === '586,890,319', 'rapid selection or mode switch retained stale values');
        checks.push('explicit fixture banner and rapid real-mode/stock changes never retain synthetic or cross-stock values');

        // Faults are served only inside this isolated context. The actual local
        // catalog, immutable data and user's trial tab are never modified.
        const financeItem = findItem(financeRelease, '2330');
        const financeResponse = await readVerified(financeItem);
        const corruptPattern = `${origin}/research-data/${financeItem.path}`;
        await context.route(corruptPattern, route => route.fulfill({ status: 200,
            contentType: 'application/json', body: financeResponse.bytes.toString('utf8') + ' ' }));
        await reload(); await tab('概覽'); await status('財務', 'invalid'); await status('neo 重播', 'ready');
        assert((await first().innerText()).includes('SHA-256 不符'), 'corrupted finance did not expose integrity rejection');
        assert(!(await first().innerText()).includes('586,890,319'), 'corrupted finance remained visible');
        await context.unroute(corruptPattern); await reload(); await status('財務', 'ready');
        checks.push('bad finance byte hash is rejected while valid neo replay remains available');

        const catalogPattern = `${origin}/research-data/catalog.json`;
        await context.route(catalogPattern, route => route.fulfill({ status: 200, contentType: 'application/json',
            body: JSON.stringify({ ...catalog, schemaVersion: 2 }) }));
        await reload(); await status('財務', 'unavailable'); await status('neo 重播', 'unavailable');
        assert((await first().innerText()).includes('未知研究目錄格式'), 'unknown catalog schema was not rejected');
        assert(await first().locator('.nr-metrics,.nr-facts').count() === 0, 'unknown schema rendered stale values');
        await context.unroute(catalogPattern);
        const revoked = [...new Set([...catalog.revoked, ...catalog.financeReleases.map(release => release.id)])];
        await context.route(catalogPattern, route => route.fulfill({ status: 200, contentType: 'application/json',
            body: JSON.stringify({ ...catalog, revoked }) }));
        await reload(); await status('財務', 'revoked'); await status('neo 重播', 'ready');
        assert(!(await first().innerText()).includes('586,890,319'), 'withdrawn finance revived from an older local version');
        await context.unroute(catalogPattern); await reload(); await status('財務', 'ready'); await status('neo 重播', 'ready');
        checks.push('unknown schema and all-version finance withdrawal reject data; isolated interception restores cleanly');

        await qa.evaluate(() => { document.activeElement?.blur?.(); document.body.tabIndex = -1; document.body.focus(); });
        for (const key of ['b', 's', 'Escape', 'Escape']) await qa.keyboard.press(key);
        assert(await qa.locator('[role="dialog"]:visible,[role="alertdialog"]:visible,dialog[open]:visible').count() === 0, 'trading confirmation appeared');
        const finalWorkspace = await qa.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
        assert(finalWorkspace.sourceMode === 'real' && finalWorkspace.financeMode === 'latest'
            && finalWorkspace.symbol === '2330' && finalWorkspace.date === '2026-11-13', 'final isolated workspace identity drifted');
        await flush();
        const allowedData = new Set(['/research-data/catalog.json', ...[...catalog.financeReleases, ...catalog.replayReleases]
            .flatMap(release => release.items.map(item => `/research-data/${item.path}`))]);
        const unexpected = calls.filter(call => {
            if (isHmr(call)) return false;
            const url = new URL(call.url);
            return !(call.kind === 'fetch' && call.method.toUpperCase() === 'GET' && !call.queryPresent
                && url.origin === origin && allowedData.has(url.pathname));
        });
        assert(unexpected.length === 0, `unexpected monitored network attempts: ${JSON.stringify(unexpected)}`);
        const outside = browserRequests.filter(request => {
            const url = new URL(request.url);
            if (url.protocol === 'ws:' || url.protocol === 'wss:') {
                url.search = ''; url.hash = '';
                return !calls.some(call => isHmr(call) && call.url === url.href);
            }
            return url.origin !== origin || /^(?:\/api(?:\/|$)|\/admin(?:\/|$)|\/stream(?:\/|$))/.test(url.pathname);
        });
        assert(outside.length === 0, `external or broker/admin browser request: ${JSON.stringify(outside)}`);
        assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
        assert(ticketActions.length === 0 && dialogs.length === 0, 'trading shortcut events or native dialogs detected');
        checks.push('all navigations and injected failures: only catalog-allowlisted same-origin JSON GETs and identified HMR; zero broker/admin/XHR/SSE/external calls');
        return { checks, verifiedPayloads, financeRelease: financeRelease.id, replayRelease: replayRelease.id,
            upstreamCommit: pinnedCommit, calls, browserRequests, pageErrors, ticketActions, dialogs,
            finalWorkspace: { symbol: finalWorkspace.symbol, date: finalWorkspace.date, cutoff: finalWorkspace.cutoff,
                sourceMode: finalWorkspace.sourceMode, financeMode: finalWorkspace.financeMode },
            viewport: { width: 1440, height: 1100 } };
    } finally { await context.close(); }
}

export default run;
