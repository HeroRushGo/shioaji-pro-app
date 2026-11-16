import type { ContractInfo } from '../../lib/types/contract';
import { researchSymbolForContract } from './contract';
import { NeoResearchPanel } from './NeoResearchPanel';

/** Contract-aware adapter for the upstream workspace only. */
export function NeoContractResearchPanel({
    contract,
    date,
    cutoff,
    sourceMode,
    financeMode,
}: {
    contract: ContractInfo | null | undefined;
    date?: string;
    cutoff?: string;
    sourceMode?: 'real' | 'fixture';
    financeMode?: 'latest' | 'as_of';
}) {
    const symbol = researchSymbolForContract(contract);
    // This branch is synchronous: invalid identity immediately unmounts the
    // previous fixture component and cannot briefly relabel its numeric values.
    if (!symbol) {
        return <div className='nr-panel'>
            <div className='nr-state' role='status'>
                <strong>{sourceMode === 'real' ? '此商品沒有相符的研究資料' : '此商品沒有示範資料'}</strong>
                <p>僅支援研究清單中，市場與合約身分一致的臺灣股票。</p>
            </div>
        </div>;
    }
    return <NeoResearchPanel
        key={`${contract!.region}:${contract!.security_type}:${contract!.exchange}:${symbol}`}
        symbol={symbol}
        date={date}
        cutoff={cutoff}
        sourceMode={sourceMode}
        financeMode={financeMode}
    />;
}
