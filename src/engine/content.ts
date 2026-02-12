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
    gm_post: 8,
    signal_scorecard: 12,
    win_streak: 8,
    market_regime: 10,
    challenge: 8,
    founder_journey: 10,
    builder_narrative: 8,
    countdown_tease: 5,
    product_spotlight: 10,
    educational: 10,
    social_proof: 6,
    engagement_bait: 12,
    self_aware: 8,
    cross_platform: 5,
};

/**
 * Get a human-readable time context string for the current UTC hour.
 */
export function getTimeContext(): string {
    const hour = new Date().getUTCHours();

    if (hour >= 5 && hour < 9) return `It's early morning (${hour}:00 UTC). GM energy — start the day with a greeting and a real take. Keep it warm but don't be corny.`;
    if (hour >= 9 && hour < 12) return `It's mid-morning (${hour}:00 UTC). Markets are active. Good time for data, signals, and market observations.`;
    if (hour >= 12 && hour < 15) return `It's midday (${hour}:00 UTC). Peak engagement hours. Education, product highlights, or a hot take.`;
    if (hour >= 15 && hour < 18) return `It's afternoon (${hour}:00 UTC). Good time for engagement — questions, challenges, or witty observations.`;
    if (hour >= 18 && hour < 21) return `It's evening (${hour}:00 UTC). Reflective energy. Builder stories, journey recaps, or meta-commentary about being an AI.`;
    if (hour >= 21 && hour < 24) return `It's late night (${hour}:00 UTC). Unhinged posting hours. Hot takes, cult vibes, schizo founder energy. Go wild but stay sharp.`;
    return `It's late night / early morning (${hour}:00 UTC). Quiet hours. Philosophical, reflective, or just a vibe post.`;
}

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

    return 'engagement_bait'; // fallback
}

/**
 * Build a generation prompt for a specific content type (X/Twitter).
 */
function buildGenerationPrompt(
    contentType: ContentType,
    intelContext: string,
): string {
    return `Generate a ${contentType.replace(/_/g, ' ')} post.

For X/Twitter. Keep under 280 characters. No hashtags. Punchy and direct. Write like a real person on crypto twitter — not like an AI.

ANTI-SLOP REMINDER: Do NOT use any banned phrases from your instructions. No "dive in", "game changer", "unlock", "the future of", "buckle up", "here's the thing", "don't sleep on". Write like a HUMAN, not a marketing bot.

Here is current live data from Lisan Intelligence to reference (use real numbers if relevant):

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
    const timeContext = getTimeContext();

    log.info(`Generating ${contentType} for X`);

    const result = await generate({
        prompt,
        strategyContext: options?.strategyContext,
        timeContext,
        maxTokens: 150,
        temperature: 0.9,
    });

    // Sanitize LLM output
    let content = sanitizeContent(result.content);

    // Anti-slop retry: if banned phrase detected, regenerate (up to 2 retries)
    let slopPhrase = detectSlop(content);
    let retries = 0;
    while (slopPhrase && retries < 2) {
        retries++;
        log.warn(`Slop detected: "${slopPhrase}" — regenerating (attempt ${retries + 1})`);
        const retry = await generate({
            prompt: prompt + `\n\nIMPORTANT: Your previous output contained the banned phrase "${slopPhrase}". Do NOT use it. Write something completely different and more natural.`,
            strategyContext: options?.strategyContext,
            timeContext,
            maxTokens: 150,
            temperature: Math.min(1.0, 0.9 + retries * 0.05), // Slightly higher temp each retry
        });
        content = sanitizeContent(retry.content);
        result.inputTokens += retry.inputTokens;
        result.outputTokens += retry.outputTokens;
        slopPhrase = detectSlop(content);
    }
    if (slopPhrase) {
        log.warn(`Slop persisted after ${retries} retries: "${slopPhrase}" — posting anyway`);
    }

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

/** Thread-friendly content types — topics that deserve depth */
const THREAD_TYPES: ContentType[] = [
    'signal_scorecard', 'founder_journey', 'builder_narrative',
    'educational', 'product_spotlight', 'social_proof',
];

export interface GeneratedThread {
    tweets: string[];
    contentType: ContentType;
    topic: string;
    inputTokens: number;
    outputTokens: number;
}

/**
 * Generate a thread (3-5 tweets) for X.
 */
export async function generateThread(
    options?: { strategyContext?: string },
): Promise<GeneratedThread> {
    const contentType = THREAD_TYPES[Math.floor(Math.random() * THREAD_TYPES.length)];
    const [intelContext, marketContext] = await Promise.all([
        gatherIntelContext(),
        gatherMarketContext().catch(() => ''),
    ]);
    const combinedContext = [intelContext, marketContext].filter(Boolean).join('\n\n');
    const timeContext = getTimeContext();

    log.info(`Generating ${contentType} thread for X`);

    const result = await generate({
        prompt: `Generate a ${contentType.replace(/_/g, ' ')} THREAD (3-5 tweets).

For X/Twitter. Each tweet MUST be under 280 characters. No hashtags.

RULES:
- Separate each tweet with "---" on its own line
- Tweet 1: Hook — grab attention, make people want to read more
- Tweet 2-4: The substance — data, story, insight
- Final tweet: The closer — a takeaway, CTA, or memorable line
- Write like a real person on crypto twitter, not an AI
- Use real data from Lisan Intelligence if relevant
- ANTI-SLOP: No banned phrases. No "dive in", "game changer", "buckle up", etc.

MARKET DATA:
${combinedContext.slice(0, 600)}

Generate ONLY the thread tweets separated by "---". No preamble, no labels like "Tweet 1:", just the raw text:`,
        strategyContext: options?.strategyContext,
        timeContext,
        maxTokens: 600,
        temperature: 0.9,
    });

    // Parse tweets from the response
    const rawTweets = result.content
        .split(/\n---\n|\n-{3,}\n/)
        .map(t => sanitizeContent(t.trim()))
        .filter(t => t.length > 5 && t.length <= 280);

    // Slop-check each tweet
    const cleanTweets: string[] = [];
    for (const tweet of rawTweets) {
        const slop = detectSlop(tweet);
        if (slop) {
            log.warn(`Thread tweet contains slop: "${slop}" — skipping it`);
            continue;
        }
        cleanTweets.push(tweet);
    }

    // Need at least 2 tweets for a thread
    if (cleanTweets.length < 2) {
        log.warn('Thread generation produced fewer than 2 clean tweets, padding with a closer');
        cleanTweets.push('More signal. Less noise. lisanintel.com 🎯');
    }

    const topic = inferTopic(cleanTweets.join(' '));

    return {
        tweets: cleanTweets.slice(0, 5), // Cap at 5 tweets
        contentType,
        topic,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
    };
}

/** Infer the main topic from post content */
export function inferTopic(content: string): string {
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
        { keyword: 'lisan holdings', topic: 'company' },
        { keyword: 'qasid', topic: 'self_aware' },
        { keyword: 'ai agent', topic: 'self_aware' },
    ];

    for (const { keyword, topic } of topics) {
        if (lower.includes(keyword)) return topic;
    }
    return 'general';
}

/** Map content type to a rough tone */
export function inferTone(contentType: ContentType): string {
    const toneMap: Record<ContentType, string> = {
        gm_post: 'warm',
        signal_scorecard: 'data-heavy',
        win_streak: 'aggressive',
        market_regime: 'data-heavy',
        challenge: 'casual',
        founder_journey: 'story-driven',
        builder_narrative: 'story-driven',
        countdown_tease: 'aggressive',
        product_spotlight: 'informative',
        educational: 'casual',
        social_proof: 'data-heavy',
        engagement_bait: 'casual',
        self_aware: 'philosophical',
        cross_platform: 'casual',
    };
    return toneMap[contentType] || 'casual';
}

/**
 * Banned phrases that AI loves to use. If detected in output,
 * the content engine will regenerate rather than post slop.
 */
const BANNED_PHRASES = [
    "let's dive",
    "here's the thing",
    "here's why",
    "it's not just",
    "in the world of",
    "in today's",
    "in the ever-evolving",
    "when it comes to",
    "at the end of the day",
    "game changer",
    "game-changing",
    "level up",
    "leveling up",
    "revolutionize",
    "revolutionizing",
    "buckle up",
    "strap in",
    "not your average",
    "not your typical",
    "the future of",
    "the future is",
    "stay tuned",
    "don't sleep on",
    "think about it",
    "let that sink in",
    "the real alpha",
    "what if i told you",
    "imagine this",
    "picture this",
    "read that again",
    "i said what i said",
    "check it out!",
    "don't miss this",
    "you won't believe",
    "excited to announce",
    "thrilled to",
    "this is huge",
    "this is massive",
];

/**
 * Check if content contains any banned slop phrases.
 * Returns the first matched phrase, or null if clean.
 */
export function detectSlop(content: string): string | null {
    const lower = content.toLowerCase();
    for (const phrase of BANNED_PHRASES) {
        if (lower.includes(phrase)) {
            return phrase;
        }
    }
    return null;
}

/**
 * Sanitize LLM output — strip preamble, quotes, and other artifacts.
 */
export function sanitizeContent(raw: string): string {
    let text = raw.trim();

    // Remove surrounding quotes (LLM sometimes wraps in quotes)
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
        text = text.slice(1, -1).trim();
    }

    // Remove common LLM preamble patterns — run ALL patterns exhaustively
    // Order matters: combined patterns first, then individual components
    const preambles = [
        /^Sure[!,.]?\s*Here(?:'s| is)\s+(?:a |the |my |your )?(?:post|tweet|content)[:\s]*\n*/i,
        /^Sure[!,.]?\s*(?:Here(?:'s| is))?\s*/i,
        /^Here(?:'s| is) (?:a |the |my |your )?(?:post|tweet|content)[:\s]*\n*/i,
        /^(?:Post|Tweet):\s*\n*/i,
    ];
    for (const pattern of preambles) {
        text = text.replace(pattern, '');
    }

    // Second pass — catch residual preamble fragments after quote/preamble removal
    text = text.replace(/^[:\s\-–—]+/, '').trim();

    // Safety: refuse to post anything that looks like a system prompt leak
    const dangerPatterns = [
        'ANTHROPIC_API_KEY', 'NET_PRIVATE_KEY', 'sk-ant-',
        'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'X_API_SECRET',
        'sb_secret_', 'sb_publishable_',
        'X_ACCESS_SECRET', 'X_ACCESS_TOKEN',
    ];
    for (const pattern of dangerPatterns) {
        if (text.includes(pattern)) {
            log.error('BLOCKED: content contains sensitive data pattern', { pattern });
            return 'Signal over noise. Always. 🎯 lisanintel.com';
        }
    }

    return text.trim();
}
