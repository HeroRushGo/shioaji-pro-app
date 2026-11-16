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
        ...['kbars', 'calculated_index', 'index_contribution', 'industry_contribution', 'scanner']
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
    const keys = new Set(['security_type', 'region', 'exchange', 'page', 'page_size', 'root', 'underlying_code', 'code', 'keyword', 'limit', 'offset']);
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

const bodyKeys = new Set(['name', 'contract', 'contracts', 'security_type', 'exchange', 'region', 'code', 'target_code',
    'quote_type', 'intraday_odd', 'version', 'start', 'end', 'date', 'query_type', 'time_start', 'time_end', 'last_cnt',
    'scanner_type', 'ascending', 'count', 'timeout', 'codes', 'period', 'interval', 'index_code', 'ranking', 'projection',
    'legs', 'combo_type', 'target', 'metric', 'order', 'limit', 'kind', 'group']);
const contractKeys = new Set(['security_type', 'exchange', 'region', 'code', 'target_code', 'legs', 'combo_type', 'action', 'ratio']);
export function allowedMarketBody(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
    const visit = (value, keys, depth) => {
        if (depth > 6) return false;
        if (Array.isArray(value)) return value.length <= 1000 && value.every(v => visit(v, keys, depth + 1));
        if (value && typeof value === 'object') return Object.entries(value).every(([k, v]) => {
            if (!keys.has(k)) return false;
            if (['contracts', 'legs'].includes(k) && (!Array.isArray(v) || v.some(item => !item || typeof item !== 'object' || Array.isArray(item)))) return false;
            if (k === 'contract' && (!v || typeof v !== 'object' || Array.isArray(v))) return false;
            if (k === 'codes' && (!Array.isArray(v) || v.some(item => typeof item !== 'string'))) return false;
            if (['name', 'code', 'start', 'end', 'date', 'quote_type', 'scanner_type'].includes(k) && typeof v !== 'string') return false;
            return visit(v, ['contract', 'contracts', 'legs'].includes(k) ? contractKeys : keys, depth + 1);
        });
        return value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.length <= 200 && !/[\x00-\x1f]/.test(value));
    };
    return visit(body, bodyKeys, 0);
}

// Explicit public market projection; unexpected upstream metadata is dropped.
const eventKeys = new Set(('code exchange security_type region date time datetime timestamp close open high low volume amount average_price total_volume total_amount tick_type chg_type price_chg pct_chg change_price change_rate change_type buy_price buy_volume sell_price sell_volume bid_price bid_volume ask_price ask_volume bid_total_vol ask_total_vol diff_bid_vol diff_ask_vol avg_price underlying_price simtrade intraday_odd amount_ratio volume_ratio reference yesterday_volume price ranking entries category points index_close index_price_chg event_id action published_at base_changed info_changed info_scope info_shards type dropped interval period start end Open High Low Close Volume Amount index_code projection calculated_at market_phase groups name item_count value weight_pct price_source trading_status data_status reference_weight_ppm contract revision sequence').split(' '));
for (const name of ('code exchange date time datetime reference open high low close amount_sum amount volume vol_sum count count_sum no_trade estimate_amount_sum bid_side_total_vol ask_side_total_vol').split(' ')) {
    eventKeys.add(name);
    eventKeys.add(name.split('_').map(part => part[0].toUpperCase() + part.slice(1)).join(''));
}
for (const name of ['RaiseStop', 'Raise', 'Flat', 'Fall', 'FallStop']) eventKeys.add(name);
export function projectMarketEvent(value, depth = 0) {
    if (depth > 8) throw new Error('market event depth');
    if (Array.isArray(value)) return value.map(v => projectMarketEvent(v, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => eventKeys.has(k)).map(([k, v]) => [k, projectMarketEvent(v, depth + 1)]));
    return value;
}
