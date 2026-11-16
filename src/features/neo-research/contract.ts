import type { ContractInfo } from '../../lib/types/contract';
import { RESEARCH_SYMBOLS } from './fixtures';

export type ResearchContractIdentity = Pick<
    ContractInfo,
    'region' | 'security_type' | 'exchange' | 'code' | 'combo'
>;

/**
 * The upstream workspace resolves complete market identities. Never reduce an
 * unverified contract to its code: the same code can belong to another market.
 * The independent research entry has its own four-digit fixture selector.
 */
export function researchSymbolForContract(
    contract: ResearchContractIdentity | null | undefined,
): string | null {
    if (!contract || contract.region !== 'TW' || contract.security_type !== 'STK'
        || contract.combo !== undefined) return null;

    const company = RESEARCH_SYMBOLS.find(entry => entry.symbol === contract.code);
    if (!company) return null;
    const exchange = company.market === '上市' ? 'TSE' : 'OTC';
    return contract.exchange === exchange ? company.symbol : null;
}
