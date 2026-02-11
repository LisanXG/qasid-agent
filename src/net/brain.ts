import { writeStorage, readStorage, getTotalVersions, getWalletAddress } from './client.js';
import { isNetConfigured } from '../config.js';
import { createLogger } from '../logger.js';

// ============================================================================
// QasidAI — On-Chain Brain Manager
// Manages QasidAI's personality, brand knowledge, and strategy on Net Protocol
// ============================================================================

const log = createLogger('Brain');

// Storage keys for QasidAI's brain
export const BRAIN_KEYS = {
    PERSONALITY: 'qasid-personality',
    BRAND_KNOWLEDGE: 'qasid-brand-knowledge',
    STRATEGY: 'qasid-strategy',
    META_REVIEW: 'qasid-meta-review',
    PROFILE: 'qasid-profile',
    DAILY_SUMMARY: 'qasid-daily', // appended with date: qasid-daily-2026-02-11
} as const;

/**
 * Upload QasidAI's personality (system prompt template) to Net Protocol.
 */
export async function uploadPersonality(personalityData: string): Promise<string | null> {
    if (!isNetConfigured) {
        log.debug('Net Protocol not configured, skipping personality upload');
        return null;
    }

    try {
        const txHash = await writeStorage(
            BRAIN_KEYS.PERSONALITY,
            'QasidAI Personality — System prompt and voice rules',
            personalityData,
        );
        log.info('✅ Personality uploaded to Net Protocol', { txHash });
        return txHash;
    } catch (error) {
        log.error('Failed to upload personality', { error: String(error) });
        return null;
    }
}

/**
 * Upload brand knowledge to Net Protocol.
 */
export async function uploadBrandKnowledge(brandData: string): Promise<string | null> {
    if (!isNetConfigured) {
        log.debug('Net Protocol not configured, skipping brand knowledge upload');
        return null;
    }

    try {
        const txHash = await writeStorage(
            BRAIN_KEYS.BRAND_KNOWLEDGE,
            'QasidAI Brand Knowledge — Lisan Holdings products and founder info',
            brandData,
        );
        log.info('✅ Brand knowledge uploaded to Net Protocol', { txHash });
        return txHash;
    } catch (error) {
        log.error('Failed to upload brand knowledge', { error: String(error) });
        return null;
    }
}

/**
 * Download personality from Net Protocol.
 * Returns null if nothing stored on-chain yet.
 */
export async function downloadPersonality(): Promise<string | null> {
    if (!isNetConfigured) return null;

    try {
        const result = await readStorage(BRAIN_KEYS.PERSONALITY);
        if (result) {
            log.info('Loaded personality from Net Protocol (on-chain brain)');
            return result.data;
        }
        return null;
    } catch (error) {
        log.debug('Could not load personality from chain', { error: String(error) });
        return null;
    }
}

/**
 * Download brand knowledge from Net Protocol.
 * Returns null if nothing stored on-chain yet.
 */
export async function downloadBrandKnowledge(): Promise<string | null> {
    if (!isNetConfigured) return null;

    try {
        const result = await readStorage(BRAIN_KEYS.BRAND_KNOWLEDGE);
        if (result) {
            log.info('Loaded brand knowledge from Net Protocol (on-chain brain)');
            return result.data;
        }
        return null;
    } catch (error) {
        log.debug('Could not load brand knowledge from chain', { error: String(error) });
        return null;
    }
}

/**
 * Snapshot strategy weights to Net Protocol.
 * Called after daily weight adaptation.
 */
export async function snapshotStrategy(strategyData: object): Promise<string | null> {
    if (!isNetConfigured) return null;

    try {
        const txHash = await writeStorage(
            BRAIN_KEYS.STRATEGY,
            `QasidAI Strategy Snapshot — ${new Date().toISOString().split('T')[0]}`,
            JSON.stringify(strategyData),
        );
        log.info('✅ Strategy snapshot saved to Net Protocol', { txHash });
        return txHash;
    } catch (error) {
        log.error('Failed to snapshot strategy on-chain', { error: String(error) });
        return null;
    }
}

/**
 * Snapshot a meta review to Net Protocol.
 * Called after weekly meta review.
 */
export async function snapshotMetaReview(reviewData: object): Promise<string | null> {
    if (!isNetConfigured) return null;

    try {
        const txHash = await writeStorage(
            BRAIN_KEYS.META_REVIEW,
            `QasidAI Meta Review — ${new Date().toISOString().split('T')[0]}`,
            JSON.stringify(reviewData),
        );
        log.info('✅ Meta review saved to Net Protocol', { txHash });
        return txHash;
    } catch (error) {
        log.error('Failed to snapshot meta review on-chain', { error: String(error) });
        return null;
    }
}

/**
 * Write a daily post summary to Net Protocol.
 */
export async function writeDailySummary(date: string, summaryData: object): Promise<string | null> {
    if (!isNetConfigured) return null;

    const key = `${BRAIN_KEYS.DAILY_SUMMARY}-${date}`;

    try {
        const txHash = await writeStorage(
            key,
            `QasidAI Daily Summary — ${date}`,
            JSON.stringify(summaryData),
        );
        log.info('✅ Daily summary saved to Net Protocol', { txHash, date });
        return txHash;
    } catch (error) {
        log.error('Failed to write daily summary on-chain', { error: String(error) });
        return null;
    }
}

/**
 * Get the number of strategy versions stored on-chain.
 */
export async function getStrategyVersionCount(): Promise<number> {
    if (!isNetConfigured) return 0;
    return getTotalVersions(BRAIN_KEYS.STRATEGY);
}

/**
 * Upload all of QasidAI's brain data in one go.
 * Used for initial setup or full brain re-upload.
 */
export async function uploadFullBrain(personality: string, brandKnowledge: string): Promise<void> {
    log.info('Uploading full brain to Net Protocol...');

    const results = await Promise.allSettled([
        uploadPersonality(personality),
        uploadBrandKnowledge(brandKnowledge),
    ]);

    const succeeded = results.filter(r => r.status === 'fulfilled' && r.value).length;
    const failed = results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value)).length;

    if (failed > 0 && succeeded === 0) {
        log.error(`Brain upload FAILED: 0/${results.length} succeeded`);
        console.error('\n❌ Brain upload failed — check wallet balance (needs ETH on Base for gas)');
        console.error('   Bridge ETH at: https://bridge.base.org');
    } else if (failed > 0) {
        log.warn(`Brain upload partial: ${succeeded}/${results.length} succeeded, ${failed} failed`);
        console.log(`\n⚠️  Partial brain upload: ${succeeded} succeeded, ${failed} failed`);
    } else {
        log.info(`✅ Brain upload complete: ${succeeded}/${results.length} succeeded`);
        console.log(`\n✅ Brain uploaded to Net Protocol on Base L2`);
        console.log(`   Wallet: ${getWalletAddress()}`);
    }
}
