import type { ContractInfo } from '../../lib/types/contract';
import { researchSymbolForContract } from './contract';
import { NeoResearchPanel } from './NeoResearchPanel';

/** Contract-aware adapter for the upstream workspace only. */
export function NeoContractResearchPanel({
    contract,
    date,
    cutoff,
}: {
    contract: ContractInfo | null | undefined;
    date?: string;
    cutoff?: string;
}) {
    const symbol = researchSymbolForContract(contract);
    // This branch is synchronous: invalid identity immediately unmounts the
    // previous fixture component and cannot briefly relabel its numeric values.
    if (!symbol) {
        return <div className='nr-panel'>
            <div className='nr-state' role='status'>
                <strong>此商品沒有示範資料</strong>
                <p>僅支援研究清單中，市場與合約身分一致的臺灣股票。</p>
            </div>
        </div>;
    }
    return <NeoResearchPanel
        key={`${contract!.region}:${contract!.security_type}:${contract!.exchange}:${symbol}`}
        symbol={symbol}
        date={date}
        cutoff={cutoff}
    />;
}
