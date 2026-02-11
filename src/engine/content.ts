import { generate } from './llm.js';
import { gatherIntelContext } from '../data/intelligence.js';
import { gatherMarketContext } from '../data/market.js';
import { createLogger } from '../logger.js';
import { contentTypes, type ContentType } from '../personality/system-prompt.js';

// ============================================================================
// QasidAI — Content Generation Engine
// Generates X (Twitter) content using LLM + live data
// ============================================================================

const log = createLogger('Content');

export interface GeneratedPost {
    content: string;
    contentType: ContentType;
    platform: 'x';
    tone: string;
    topic: string;
    inputTokens: number;
    outputTokens: number;
    generatedAt: string;
}

/** Default content type weights (learning engine overrides these) */
const defaultWeights: Record<ContentType, number> = {
    signal_scorecard: 15,
    win_streak: 10,
    market_regime: 12,
    challenge: 10,
    builder_narrative: 10,
    countdown_tease: 5,
    educational: 12,
    social_proof: 8,
    engagement_bait: 10,
    cross_platform: 8,
};

/**
 * Pick a content type based on weights (weighted random selection).
 * Learning engine can override weights.
 */
export function pickContentType(weights?: Partial<Record<ContentType, number>>): ContentType {
    const w = { ...defaultWeights, ...weights };
    const total = Object.values(w).reduce((a, b) => a + b, 0);
    let random = Math.random() * total;

    for (const type of contentTypes) {
        random -= w[type] || 0;
        if (random <= 0) return type;
    }

    return 'signal_scorecard'; // fallback
}

/**
 * Build a generation prompt for a specific content type (X/Twitter).
 */
function buildGenerationPrompt(
    contentType: ContentType,
    intelContext: string,
): string {
    return `Generate a ${contentType.replace(/_/g, ' ')} post.

For X/Twitter. Keep under 280 characters. No hashtags unless very natural. Punchy and direct.

Here is current live data from LISAN Intelligence to reference (use real numbers if relevant):

${intelContext}

Generate ONLY the post content. No preamble, no explanation, no quotes around it. Just the raw post text ready to publish.`;
}

/**
 * Generate a single post for X (Twitter).
 */
export async function generatePost(
    options?: {
        contentType?: ContentType;
        weights?: Partial<Record<ContentType, number>>;
        strategyContext?: string;
    },
): Promise<GeneratedPost> {
    const contentType = options?.contentType || pickContentType(options?.weights);
    const [intelContext, marketContext] = await Promise.all([
        gatherIntelContext(),
        gatherMarketContext().catch(() => ''),
    ]);
    const combinedContext = [intelContext, marketContext].filter(Boolean).join('\n\n');
    const prompt = buildGenerationPrompt(contentType, combinedContext);

    log.info(`Generating ${contentType} for X`);

    const result = await generate({
        prompt,
        strategyContext: options?.strategyContext,
        maxTokens: 150,
        temperature: 0.9,
    });

    // Sanitize LLM output
    let content = sanitizeContent(result.content);

    // Enforce tweet length limit
    if (content.length > 280) {
        log.warn(`Tweet too long (${content.length} chars), truncating to 280`);
        content = content.slice(0, 277) + '...';
    }

    // Extract a rough topic from the content
    const topic = inferTopic(content);
    const tone = inferTone(contentType);

    return {
        content,
        contentType,
        platform: 'x',
        tone,
        topic,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        generatedAt: new Date().toISOString(),
    };
}

/** Infer the main topic from post content */
function inferTopic(content: string): string {
    const lower = content.toLowerCase();
    const topics = [
        { keyword: 'btc', topic: 'BTC' }, { keyword: 'bitcoin', topic: 'BTC' },
        { keyword: 'eth', topic: 'ETH' }, { keyword: 'ethereum', topic: 'ETH' },
        { keyword: 'sol', topic: 'SOL' }, { keyword: 'solana', topic: 'SOL' },
        { keyword: 'xrp', topic: 'XRP' }, { keyword: 'regime', topic: 'market_regime' },
        { keyword: 'win rate', topic: 'performance' }, { keyword: 'proof', topic: 'performance' },
        { keyword: 'navy', topic: 'founder_story' }, { keyword: 'veteran', topic: 'founder_story' },
        { keyword: 'lisan score', topic: 'lisan_score' }, { keyword: 'tradingview', topic: 'lisan_score' },
        { keyword: 'indicator', topic: 'educational' },
    ];

    for (const { keyword, topic } of topics) {
        if (lower.includes(keyword)) return topic;
    }
    return 'general';
}

/** Map content type to a rough tone */
function inferTone(contentType: ContentType): string {
    const toneMap: Record<ContentType, string> = {
        signal_scorecard: 'data-heavy',
        win_streak: 'aggressive',
        market_regime: 'data-heavy',
        challenge: 'casual',
        builder_narrative: 'story-driven',
        countdown_tease: 'aggressive',
        educational: 'casual',
        social_proof: 'data-heavy',
        engagement_bait: 'casual',
        cross_platform: 'casual',
    };
    return toneMap[contentType] || 'casual';
}

/**
 * Sanitize LLM output — strip preamble, quotes, and other artifacts.
 */
function sanitizeContent(raw: string): string {
    let text = raw.trim();

    // Remove surrounding quotes (LLM sometimes wraps in quotes)
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
        text = text.slice(1, -1).trim();
    }

    // Remove common LLM preamble patterns
    const preambles = [
        /^Here(?:'s| is) (?:a |the |my |your )?(?:post|tweet|content)[:\s]*\n*/i,
        /^(?:Post|Tweet):\s*\n*/i,
        /^Sure[!,.]?\s*(?:Here(?:'s| is))?\s*/i,
    ];
    for (const pattern of preambles) {
        text = text.replace(pattern, '');
    }

    // Safety: refuse to post anything that looks like a system prompt leak
    const dangerPatterns = ['ANTHROPIC_API_KEY', 'NET_PRIVATE_KEY', 'sk-ant-', 'SUPABASE_ANON_KEY', 'X_API_SECRET'];
    for (const pattern of dangerPatterns) {
        if (text.includes(pattern)) {
            log.error('BLOCKED: content contains sensitive data pattern', { pattern });
            return 'Signal over noise. Always. 🎯 lisanintel.com';
        }
    }

    return text.trim();
}

