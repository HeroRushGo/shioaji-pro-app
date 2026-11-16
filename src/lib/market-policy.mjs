// Shared, dependency-free policy. This module contains no credentials.
const reads = new Set([
    '/api/v1/health', '/api/v1/info',
    '/api/v1/data/contracts', '/api/v1/data/regulatory_punish', '/api/v1/data/regulatory_notice',
    '/api/v1/stream/data',
]);
const posts = new Set([
    '/api/v1/data/snapshots', '/api/v1/data/ticks', '/api/v1/data/kbars',
    '/api/v1/data/daily_quotes', '/api/v1/data/scanner', '/api/v1/data/index_components',
    '/api/v1/data/contracts/combo',
    ...['subscribe', 'unsubscribe'].flatMap(action => [
        `/api/v1/stream/${action}`,
        ...['kbars', 'calculated_index', 'index_contribution', 'industry_contribution', 'index_components', 'scanner']
            .map(kind => `/api/v1/stream/${action}/${kind}`),
    ]),
]);
export function allowedMarketRequest(method, target) {
    if (typeof target !== 'string' || !target.startsWith('/') || target.length > 8192
        || /[\\#\x00-\x20\x7f]/.test(target)) return false;
    const pathname = target.split('?')[0];
    if (pathname.includes('%') || pathname.includes('//') || pathname.split('/').some(p => p === '.' || p === '..')) return false;
    // Watchlists are gateway-local display preferences, NEVER forwarded to
    // the SDK. Full Pro requires them to select a contract.
    if (!target.includes('?')) {
        if (pathname === '/api/v1/watchlist') return method === 'GET' || method === 'POST';
        if (/^\/api\/v1\/watchlist\/[A-Za-z0-9_-]+$/.test(pathname)) return ['GET', 'PUT', 'DELETE'].includes(method);
        if (/^\/api\/v1\/watchlist\/[A-Za-z0-9_-]+\/contracts$/.test(pathname)) return method === 'POST' || method === 'DELETE';
    }
    if (method === 'POST') return posts.has(pathname) && !target.includes('?');
    if (method !== 'GET') return false;
    const params = new URLSearchParams(target.split('?')[1] ?? '');
    const keys = new Set(['security_type', 'region', 'exchange', 'page', 'page_size', 'root', 'underlying_code', 'code', 'keyword', 'limit', 'offset',
        'delivery_month', 'option_right', 'strike_min', 'strike_max', 'expiry_weekday', 'call_put', 'expiry_from', 'expiry_to', 'include_name']);
    for (const [key, value] of params) {
        if (!keys.has(key) || params.getAll(key).length !== 1 || value.length > 100 || !/^[A-Za-z0-9_. -]*$/.test(value)) return false;
    }
    return reads.has(pathname)
        || /^\/api\/v1\/data\/contracts\/[A-Za-z0-9_-]+(?:\/info)?$/.test(pathname)
        || /^\/api\/v1\/data\/contracts\/(?:futures\/roots|options\/roots|warrants\/underlyings|combo\/futures|tick-bands\/[A-Za-z0-9_-]+)$/.test(pathname);
}

const events = new Set([
    'tick_stk', 'bidask_stk', 'quote_stk', 'tick_fop', 'bidask_fop', 'quote_fop', 'quote_idx',
    'calculated_index', 'index_contribution', 'industry_contribution', 'index_components',
    'kbar', 'scanner', 'contract_event', 'heartbeat',
]);
export function allowedMarketEvent(name) {
    return events.has(name) || (name.endsWith('_gap') && events.has(name.slice(0, -4)));
}

const bodyKeys = new Set(['name', 'contract', 'contracts', 'index', 'stocks', 'scanner', 'id', 'security_type', 'exchange', 'region', 'code', 'target_code',
    'quote_type', 'intraday_odd', 'version', 'start', 'end', 'date', 'query_type', 'time_start', 'time_end', 'last_cnt',
    'scanner_type', 'ascending', 'count', 'timeout', 'codes', 'period', 'interval', 'index_code', 'ranking', 'projection',
    'legs', 'combo_type', 'target', 'metric', 'order', 'limit', 'kind', 'group']);
const contractKeys = new Set(['security_type', 'exchange', 'region', 'code', 'target_code', 'legs', 'combo_type', 'action', 'ratio']);
const projectionKeys = new Set(['kind', 'target', 'metric', 'order', 'limit', 'group']);
const scannerKeys = new Set(['kind', 'id']);
export function allowedMarketBody(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
    const visit = (value, keys, depth) => {
        if (depth > 6) return false;
        if (Array.isArray(value)) return value.length <= 1000 && value.every(v => visit(v, keys, depth + 1));
        if (value && typeof value === 'object') return Object.entries(value).every(([k, v]) => {
            if (!keys.has(k)) return false;
            if (['contracts', 'legs', 'stocks'].includes(k) && (!Array.isArray(v) || v.some(item => !item || typeof item !== 'object' || Array.isArray(item)))) return false;
            if (['contract', 'index', 'projection'].includes(k) && (!v || typeof v !== 'object' || Array.isArray(v))) return false;
            if (k === 'scanner' && !(typeof v === 'string' || (v && typeof v === 'object' && !Array.isArray(v)))) return false;
            if (k === 'codes' && (!Array.isArray(v) || v.some(item => typeof item !== 'string'))) return false;
            if (['name', 'code', 'start', 'end', 'date', 'quote_type', 'scanner_type'].includes(k) && typeof v !== 'string') return false;
            const nestedKeys = ['contract', 'contracts', 'legs', 'index', 'stocks'].includes(k) ? contractKeys
                : k === 'projection' ? projectionKeys : k === 'scanner' ? scannerKeys : keys;
            return visit(v, nestedKeys, depth + 1);
        });
        return value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.length <= 200 && !/[\x00-\x1f]/.test(value));
    };
    return visit(body, bodyKeys, 0);
}

// Explicit public market projection; unexpected upstream metadata is dropped.
const eventKeys = new Set(('code exchange security_type region date time datetime timestamp close open high low volume amount average_price total_volume total_amount tick_type chg_type price_chg pct_chg change_price change_rate change_type buy_price buy_volume sell_price sell_volume bid_price bid_volume ask_price ask_volume bid_total_vol ask_total_vol diff_bid_vol diff_ask_vol avg_price underlying_price simtrade intraday_odd amount_ratio volume_ratio reference yesterday_volume price ranking entries category points index_close index_price_chg event_id action published_at base_changed info_changed info_scope info_shards type dropped interval period start end Open High Low Close Volume Amount index_code projection calculated_at market_phase groups name item_count value weight_pct price_source trading_status data_status reference_weight_ppm contract revision sequence').split(' '));
for (const name of ('code exchange date time datetime reference open high low close amount_sum amount volume vol_sum count count_sum no_trade estimate_amount_sum bid_side_total_vol ask_side_total_vol limit_up_count raise_count flat_count fall_count limit_down_count').split(' ')) {
    eventKeys.add(name);
    eventKeys.add(name.split('_').map(part => part[0].toUpperCase() + part.slice(1)).join(''));
}
for (const name of ['RaiseStop', 'Raise', 'Flat', 'Fall', 'FallStop']) eventKeys.add(name);
const scannerEventKeys = new Set(['scanner', 'scanners', 'region', 'security_type', 'exchange', 'quote', 'extra']);
const gapKeys = new Set(['type', 'dropped', 'dropped_count', 'first_time', 'last_time', 'subscriptions', 'code', 'contract', 'projection']);
const componentKeys = new Set(['contract', 'projection', 'date', 'time', 'calculated_at', 'reference_date', 'market_phase', 'simtrade', 'unit', 'entries', 'groups']);
const scannerQuoteKeys = new Set(['code', 'date', 'time', 'open', 'high', 'low', 'close', 'amount_sum', 'vol_sum', 'diff_price', 'simtrade']);
const subscriptionKeys = new Set(['scanner', 'region', 'security_type', 'exchange', 'code', 'index', 'stocks', 'contract', 'projection']);
const kbarKeys = new Set([...eventKeys, 'rows', 'bars', 'data', 'kbars', 'ts', 'tick_count', 'net']);

export function projectMarketEvent(value, eventName) {
    if (!allowedMarketEvent(eventName)) throw new Error('unknown market event');
    if (!value || typeof value !== 'object' || (Array.isArray(value) && (eventName !== 'kbar' || value.some(row => !row || typeof row !== 'object' || Array.isArray(row))))) throw new Error('market event object required');
    const rootKeys = eventName.endsWith('_gap') || (eventName === 'scanner' && typeof value?.dropped_count === 'number') ? gapKeys : eventName === 'scanner' ? scannerEventKeys
        : eventName === 'index_components' ? componentKeys : eventName === 'kbar' ? kbarKeys : eventKeys;
    const visit = (item, keys, depth) => {
        if (depth > 8) throw new Error('market event depth');
        if (Array.isArray(item)) return item.map(v => visit(v, keys, depth + 1));
        if (!item || typeof item !== 'object') return item;
        return Object.fromEntries(Object.entries(item).filter(([k]) => keys.has(k)).map(([k, v]) => {
            if (k === 'extra') {
                // ScannerExtra is an upstream public diagnostic scalar map
                // (types/market.ts), not an untyped nested metadata payload.
                const extra = v && typeof v === 'object' && !Array.isArray(v) ? Object.entries(v).filter(([name, scalar]) =>
                    /^[a-z][a-z0-9_]{0,63}$/i.test(name) && !/(?:account|person|broker|secret|token|auth|password|pwd|api_key|__proto__|constructor|prototype)/i.test(name)
                    && (scalar === null || (typeof scalar === 'number' && Number.isFinite(scalar)) || (typeof scalar === 'string' && scalar.length <= 200))) : [];
                return [k, Object.fromEntries(extra)];
            }
            const nested = k === 'projection' ? projectionKeys : ['contract', 'index', 'stocks'].includes(k) ? contractKeys
                : k === 'quote' ? scannerQuoteKeys : k === 'subscriptions' ? subscriptionKeys
                : k === 'scanner' && typeof v === 'object' ? scannerKeys : eventName === 'kbar' ? kbarKeys : eventKeys;
            return [k, visit(v, nested, depth + 1)];
        }));
    };
    return visit(value, rootKeys, 0);
}
