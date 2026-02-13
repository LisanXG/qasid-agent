import { writeStorage, readStorage } from './client.js';
import { BRAIN_KEYS } from './brain.js';
import { isNetConfigured } from '../config.js';
import { getWalletAddress } from './client.js';
import { createLogger } from '../logger.js';

// ============================================================================
// QasidAI — On-Chain Profile
// Manages QasidAI's public identity on Net Protocol
// ============================================================================

const log = createLogger('Profile');

export interface AgentProfile {
    name: string;
    meaning: string;
    tagline: string;
    role: string;
    owner: string;
    wallet: string;
    xHandle?: string;
    products: string[];
    website: string;
    createdAt: string;
    updatedAt: string;
}

/**
 * Build the default QasidAI profile.
 */
function buildDefaultProfile(): AgentProfile {
    return {
        name: 'QasidAI',
        meaning: 'Qasid (قاصد) = Messenger in Arabic',
        tagline: 'The Messenger — autonomous CMO of Lisan Holdings',
        role: 'Autonomous AI Chief Marketing Officer. Runs 24/7 on-chain via Net Protocol. Promotes all facets of Lisan Holdings.',
        owner: 'Lisan (@lisantherealone)',
        wallet: isNetConfigured ? getWalletAddress() : '',
        xHandle: '@QasidAi34321',
        products: [
            'LISAN INTELLIGENCE — Quantitative crypto signal platform (lisanintel.com)',
            'LISAN SCORE — PineScript indicator for TradingView (free)',
            'QASID AI — Autonomous AI CMO with on-chain brain via Net Protocol',
        ],
        website: 'https://lisanholdings.dev',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
}

/**
 * Upload QasidAI's profile to Net Protocol.
 */
export async function uploadProfile(customProfile?: Partial<AgentProfile>): Promise<string | null> {
    if (!isNetConfigured) {
        log.debug('Net Protocol not configured, skipping profile upload');
        return null;
    }

    // Read existing profile to preserve createdAt
    const existing = await readProfile();
    const createdAt = existing?.createdAt ?? new Date().toISOString();

    const profile = { ...buildDefaultProfile(), ...customProfile, createdAt, updatedAt: new Date().toISOString() };

    try {
        const txHash = await writeStorage(
            BRAIN_KEYS.PROFILE,
            'QasidAI Agent Profile — Public identity on Net Protocol',
            JSON.stringify(profile, null, 2),
        );
        log.info('✅ Profile uploaded to Net Protocol', { txHash, wallet: profile.wallet });
        return txHash;
    } catch (error) {
        log.error('Failed to upload profile', { error: String(error) });
        return null;
    }
}

/**
 * Read QasidAI's profile from Net Protocol.
 */
export async function readProfile(): Promise<AgentProfile | null> {
    if (!isNetConfigured) return null;

    try {
        const result = await readStorage(BRAIN_KEYS.PROFILE);
        if (result) {
            return JSON.parse(result.data) as AgentProfile;
        }
        return null;
    } catch (error) {
        log.debug('Could not read profile from chain', { error: String(error) });
        return null;
    }
}
