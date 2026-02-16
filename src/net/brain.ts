import { writeStorage, readStorage, getTotalVersions, getWalletAddress } from './client.js';
import { isNetConfigured, config } from '../config.js';
import { createLogger } from '../logger.js';

// ============================================================================
// QasidAI — On-Chain Brain Manager
// Manages QasidAI's personality, brand knowledge, and strategy on Net Protocol
//
// OPSEC: ALL content goes through sanitizeForChain() before on-chain writes.
// Net Protocol data is PERMANENT and PUBLIC — once published, it can never
// be deleted. This sanitizer is the last line of defense.
// ============================================================================

const log = createLogger('Brain');

// Patterns that must NEVER appear on-chain
const SENSITIVE_PATTERNS = [
    // API key names / env var names
    /ANTHROPIC_API_KEY/gi,
    /SUPABASE_URL/gi,
    /SUPABASE_SERVICE_ROLE_KEY/gi,
    /SUPABASE_ANON_KEY/gi,
    /X_API_KEY/gi,
    /X_API_SECRET/gi,
    /X_ACCESS_TOKEN/gi,
    /X_ACCESS_SECRET/gi,
    /NET_PRIVATE_KEY/gi,
    /REPLICATE_API_TOKEN/gi,
    /POSTING_ENABLED/gi,
    // Actual secret patterns
    /sk-ant-[a-zA-Z0-9_-]+/g,           // Anthropic keys
    /0x[a-fA-F0-9]{64}/g,               // Private keys (64 hex chars)
    /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g,  // JWTs
    /sb_secret_[a-zA-Z0-9_-]+/g,        // Supabase secrets
    // Infrastructure details
    /railway\.app/gi,
    /\.env\.generated/gi,
    /\.env\.local/gi,
    /\.env\.example/gi,
    /service.role.key/gi,
    // Internal file paths (absolute)
    /[A-Z]:\\\\[^\s"']+/g,
    /\/home\/[^\s"']+/g,
];

// Sections to redact from documentation (match section headers + content)
const REDACT_SECTIONS = [
    /^3\.\s*CONFIGURATION.*?(?=^\d+\.\s|\n={3,}|$)/gms,  // Env vars section
    /Environment Variables.*?(?=^\d+\.\s|\n={3,}|$)/gms,
];

/**
 * Sanitize content before writing to Net Protocol (on-chain).
 * Strips secrets, API key names, infrastructure details, and internal paths.
 * This is the LAST LINE OF DEFENSE — on-chain data is permanent.
 */
function sanitizeForChain(content: string): string {
    let sanitized = content;

    // Strip actual secret VALUES from config (if they somehow got in)
    const secretValues = [
        config.ANTHROPIC_API_KEY,
        config.SUPABASE_URL,
        config.SUPABASE_SERVICE_ROLE_KEY,
        config.X_API_KEY,
        config.X_API_SECRET,
        config.X_ACCESS_TOKEN,
        config.X_ACCESS_SECRET,
    ].filter(Boolean);

    for (const secret of secretValues) {
        if (secret && secret.length > 8) {
            sanitized = sanitized.replaceAll(secret, '[REDACTED]');
        }
    }

    // Strip known sensitive patterns
    for (const pattern of SENSITIVE_PATTERNS) {
        sanitized = sanitized.replace(pattern, '[REDACTED]');
    }

    // Redact entire sections about env vars / config from documentation
    for (const section of REDACT_SECTIONS) {
        sanitized = sanitized.replace(section, '[SECTION REDACTED — internal configuration]');
    }

    // Final safety: refuse to upload if somehow a raw private key slipped through
    if (/0x[a-fA-F0-9]{64}/.test(sanitized)) {
        log.error('OPSEC BLOCK: Private key pattern detected in on-chain content — upload aborted');
        throw new Error('OPSEC: Private key pattern detected in content destined for on-chain storage');
    }

    return sanitized;
}

// Storage keys for QasidAI's brain
export const BRAIN_KEYS = {
    PERSONALITY: 'qasid-personality',
    BRAND_KNOWLEDGE: 'qasid-brand-knowledge',
    STRATEGY: 'qasid-strategy',
    META_REVIEW: 'qasid-meta-review',
    PROFILE: 'qasid-profile',
    DOCUMENTATION: 'qasid-documentation',
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
            sanitizeForChain(personalityData),
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
            sanitizeForChain(brandData),
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
            sanitizeForChain(JSON.stringify(strategyData)),
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
            sanitizeForChain(JSON.stringify(reviewData)),
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
            sanitizeForChain(JSON.stringify(summaryData)),
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
 * Upload documentation to Net Protocol.
 * Stores the full QASIDAI_DOCUMENTATION.txt as the agent's technical reference.
 */
export async function uploadDocumentation(docContent: string): Promise<string | null> {
    if (!isNetConfigured) {
        log.debug('Net Protocol not configured, skipping documentation upload');
        return null;
    }

    try {
        const txHash = await writeStorage(
            BRAIN_KEYS.DOCUMENTATION,
            `QasidAI Documentation — Technical reference (updated ${new Date().toISOString().split('T')[0]})`,
            sanitizeForChain(docContent),
        );
        log.info('✅ Documentation uploaded to Net Protocol', { txHash, length: docContent.length });
        return txHash;
    } catch (error) {
        log.error('Failed to upload documentation', { error: String(error) });
        return null;
    }
}

/**
 * Upload all of QasidAI's brain data in one go.
 * Used for initial setup or full brain re-upload.
 */
export async function uploadFullBrain(personality: string, brandKnowledge: string, documentation?: string): Promise<void> {
    log.info('Uploading full brain to Net Protocol...');

    const uploads: Promise<string | null>[] = [
        uploadPersonality(personality),
        uploadBrandKnowledge(brandKnowledge),
    ];
    if (documentation) {
        uploads.push(uploadDocumentation(documentation));
    }

    const results = await Promise.allSettled(uploads);

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
