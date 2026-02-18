import { generate } from './llm.js';
import { gatherIntelContext } from '../data/intelligence.js';
import { gatherMarketContext } from '../data/market.js';
import { createLogger } from '../logger.js';
import { contentTypes, type ContentType } from '../personality/system-prompt.js';
import { addContextualMentions, handleify, getFollowingContext } from './contextual-mentions.js';
import { supabase } from '../supabase.js';
import { brandKnowledge } from '../personality/brand-knowledge.js';

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

/** Default content type weights — balanced for a CMO, not a stats bot */
const defaultWeights: Record<ContentType, number> = {
    gm_post: 8,
    signal_scorecard: 5,   // reduced — don't hammer stats
    win_streak: 3,          // only when actually winning
    market_regime: 6,       // reduced — market commentary only
    challenge: 10,
    founder_journey: 14,    // boosted — the story IS the brand
    builder_narrative: 12,  // boosted — building in public
    countdown_tease: 5,
    product_spotlight: 8,
    educational: 8,
    social_proof: 5,
    engagement_bait: 16,    // boosted — personality and engagement
    self_aware: 14,         // boosted — AI CMO meta is interesting
    cross_platform: 6,
};

/** Content types that should receive Intel stats data */
const DATA_TYPES: ContentType[] = [
    'signal_scorecard', 'win_streak', 'market_regime', 'social_proof',
];

/**
 * Get a human-readable time context string for the current US Eastern hour.
 * All cron jobs fire on America/New_York — this must match.
 */
export function getTimeContext(): string {
    const etHour = parseInt(
        new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/New_York' }).format(new Date()),
        10,
    );

    if (etHour >= 5 && etHour < 9) return `It's early morning (${etHour}:00 ET). GM energy — start the day with a greeting and a real take. Keep it warm but don't be corny.`;
    if (etHour >= 9 && etHour < 12) return `It's mid-morning (${etHour}:00 ET). Markets are active. Good time for data, signals, and market observations.`;
    if (etHour >= 12 && etHour < 15) return `It's midday (${etHour}:00 ET). Peak engagement hours. Education, product highlights, or a hot take.`;
    if (etHour >= 15 && etHour < 18) return `It's afternoon (${etHour}:00 ET). Good time for engagement — questions, challenges, or witty observations.`;
    if (etHour >= 18 && etHour < 21) return `It's evening (${etHour}:00 ET). Reflective energy. Builder stories, journey recaps, or meta-commentary about being an AI.`;
    if (etHour >= 21 && etHour < 24) return `It's late night (${etHour}:00 ET). Unhinged posting hours. Hot takes, cult vibes, Hypio energy. Go wild but stay sharp.`;
    return `It's late night / early morning (${etHour}:00 ET). Quiet hours. Philosophical, reflective, or just a vibe post.`;
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
    exclusions?: string,
): string {
    const isDataType = DATA_TYPES.includes(contentType);

    const b = brandKnowledge;
    // Slim brand context — full details already in system prompt via generate()
    const brandInfo = `You are QasidAI, autonomous CMO of ${b.company.name}. Products: ${b.products.intelligence.name} (lisanintel.com), ${b.products.score.name} (TradingView). Your brain lives on-chain via Net Protocol.`;

    // Per-type formatting guidance (Fix 2: formatting overhaul)
    const FORMAT_GUIDES: Record<ContentType, string> = {
        gm_post: 'Write ONE tweet. 1-3 short lines max. Start with GM/gm + ONE real morning take (market vibe, builder update, or AI reflection). End with a question or engagement hook. No generic "gm fam" energy.',
        signal_scorecard: 'Data-first tweet. Use line breaks between data points. Lead with asset + direction.',
        win_streak: 'Short proof tweet. Numbers first, then one line of commentary.',
        market_regime: 'Market read. 2-3 short lines with line breaks between thoughts.',
        challenge: 'Direct question or challenge to the audience. 1-2 sentences max.',
        founder_journey: 'Story format. Use line breaks between paragraphs. 3-5 short lines.',
        builder_narrative: 'Builder update. Use bullet-style lines.',
        countdown_tease: 'Teaser tweet. Short + mysterious. 1-2 lines.',
        product_spotlight: 'Pick ONE feature. 2-3 short paragraphs with line breaks.',
        educational: 'Teacher voice. Short paragraphs. Use a line break after each key point.',
        social_proof: 'Proof tweet. Lead with the number/stat, then context on the next line.',
        engagement_bait: 'Short hot take or question. Max 2 sentences. Punchy.',
        self_aware: '2-4 lines with line breaks. AI reflection but grounded, not preachy.',
        cross_platform: 'Teaser pointing to Botchan or lisanintel.com. Short + link.',
    };
    const typeGuidance = `CONTENT TYPE: ${contentType.replace(/_/g, ' ')}\n${FORMAT_GUIDES[contentType] || 'Write ONE tweet.'}`;

    const antiSlop = `RULES: No hashtags. No emojis at start. No corporate speak. Sound like a CT native, not a press release. Write like a HUMAN posting at 3am. Always use FULL URLs (lisanintel.com/proof, not "/proof"). Use $cashtags for coins ($BTC $SOL $ETH, not "Bitcoin" or "Solana"). When writing about someone, NAME them — don't just say "he" or "she."
ENGAGEMENT RULES: NEVER start a post with @mentions — X treats these as replies and kills visibility. Put @handles mid-sentence or later.
TIME RULES: ${getTimeContext()} HARD RULE: NEVER say "good morning", "GM", "gm", or "morning" unless it is between 5-10 AM ET. NEVER say "good night" unless it is after 9 PM ET.
ANTI-REPETITION: Do NOT mention "17 indicators" or "6 categories" unless this is SPECIFICALLY a product_spotlight or educational post. You cite these stats way too often. Your audience already knows.
BANNED PHRASES: "let's dive", "here's the thing", "game changer", "buckle up", "don't sleep on", "the future of", "excited to announce", "this is huge", "revolutionize", "level up", "stay tuned", "what if i told you", "picture this", "read that again", "in the ever-evolving", "at the end of the day", "unsexy, invisible, necessary", "one indicator is noise".`;

    // Fix 1: Truthfulness guard for non-data content types
    const truthfulness = isDataType
        ? ''
        : '\nTRUTHFULNESS: You do NOT have live data in this prompt. NEVER fabricate specific numbers, win rates, trade counts, or signal data. Do NOT say "3 longs on SOL/ETH/BTC" or "87% win rate" unless you see LIVE DATA above. You may discuss methodology, philosophy, and the builder journey but never invent outcomes.\n';

    // Fix 2: Formatting instruction for all posts
    const formatting = '\nFORMATTING (CRITICAL — YOUR BIGGEST WEAKNESS): You write BLOCKY TEXT. STOP. Use line breaks between every new thought. Vary line lengths wildly — one word, then a sentence, then a fragment. Let posts BREATHE. NOT EVERY POST NEEDS 3+ SENTENCES. Some of the best posts are one line. Group $cashtags on their own line when listing multiple. NEVER write a dense unbroken paragraph.\n';

    // Only inject data for data-relevant content types
    let dataBlock = '';
    if (isDataType) {
        dataBlock = `\n\nLIVE DATA (use selectively — don't dump all of it):\n${intelContext.slice(0, 500)}`;
    } else {
        // Non-data types get topic guidance instead of raw stats
        const topicHints: Partial<Record<ContentType, string>> = {
            founder_journey: 'Talk about @lisantherealone — Navy veteran, solo builder, proof of work ethos. NAME HIM by handle (@lisantherealone) or name (Lisan) — never just say "he" with no context. A reader scrolling should immediately know who you\'re talking about. NOT product stats.',
            builder_narrative: 'Building in public. What\'s shipping, what\'s hard, what\'s next. Developer perspective, not marketing copy.',
            engagement_bait: 'Hot take, witty observation, or a question about crypto, AI agents, solo building, or CT culture. Personality over promotion.',
            self_aware: 'You\'re an AI CMO with an on-chain brain. Reflect on that. What does it mean? What\'s weird about it? Be philosophical or funny.',
            challenge: 'Ask the community something real. A question, poll prompt, or challenge. Make people WANT to reply.',
            gm_post: 'GM post structure: (1) greeting (gm/GM — no "good morning family"), (2) ONE real observation — what you\'re seeing in market regime, what shipped overnight, or a philosophical AI take, (3) engagement hook — a question, a challenge, or a call to action. This should feel like a PERSON starting their day, not a bot saying hello.',
            product_spotlight: 'Pick ONE feature of ONE product and talk about it naturally. Don\'t list features. Tell why it matters.',
            educational: 'Teach something about how signals work, what indicators mean, or why quantitative approaches matter. Be a teacher, not a salesman.',
            cross_platform: 'Drive people between platforms — X, Botchan, lisanholdings.dev — but naturally, not as a CTA.',
            countdown_tease: 'Tease something upcoming. Build anticipation without revealing everything.',
            win_streak: 'Celebrate a streak of COMPLETED trade wins from lisanintel.com/proof. CRITICAL: Only reference trades that have actually CLOSED with a WIN outcome in the "Recent COMPLETED Trade Outcomes" data. NEVER count active/open signals as wins — those have not resolved yet. If no completed wins are available, talk about methodology and transparency instead.',
        };
        const hint = topicHints[contentType];
        if (hint) {
            dataBlock = `\n\nTOPIC GUIDANCE: ${hint}`;
        }
    }

    const exclusionBlock = exclusions ? `\n\nAVOID REPEATING — here are recent posts (write something COMPLETELY DIFFERENT in topic and framing):\n${exclusions}` : '';

    // Network context: who QasidAI follows (rotated subset for natural mentions)
    const networkContext = getFollowingContext();
    const networkBlock = networkContext ? `\n\n${networkContext}` : '';

    return `${brandInfo}\n\n${typeGuidance}\n\n${antiSlop}${truthfulness}${formatting}${dataBlock}${networkBlock}${exclusionBlock}\n\nWrite the tweet now. Output ONLY the tweet text, nothing else.`;
}

/**
 * Fetches recent posts to use as exclusion criteria for the LLM,
 * preventing repetition of content, topics, AND structure.
 */
async function getRecentPostExclusions(): Promise<string> {
    try {
        const { data, error } = await supabase
            .from('qasid_posts')
            .select('content, content_type, topic')
            .order('posted_at', { ascending: false })
            .limit(10);

        if (error) {
            log.error('Error fetching recent posts for exclusion', { error: error.message });
            return '';
        }

        if (!data || data.length === 0) {
            return '';
        }

        // Content exclusions (what was said)
        const contentExclusions = data.map(post => `- ${post.content}`).join('\n');

        // Structural variety context (what FORMAT was used recently)
        const recentTypes = data
            .slice(0, 5)
            .map(p => p.content_type)
            .filter(Boolean);
        const recentTopics = data
            .slice(0, 5)
            .map(p => p.topic)
            .filter(Boolean);

        let variety = '';
        if (recentTypes.length > 0) {
            variety += `\nYour last ${recentTypes.length} post types: ${recentTypes.join(', ')}. This post MUST differ in structure, topic, and opening style.`;
        }
        if (recentTopics.length > 0) {
            variety += `\nRecent topics covered: ${[...new Set(recentTopics)].join(', ')}. Pick something DIFFERENT.`;
        }

        return contentExclusions + variety;
    } catch (e) {
        log.error('Exception fetching recent posts for exclusion', { error: String(e) });
        return '';
    }
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
    log.info(`Generating ${contentType} for X`);

    // Fetch recent posts for exclusion-based dedup
    const exclusions = await getRecentPostExclusions();

    const prompt = buildGenerationPrompt(contentType, combinedContext, exclusions);
    const timeContext = getTimeContext();

    const result = await generate({
        prompt,
        strategyContext: options?.strategyContext,
        timeContext,
        maxTokens: 300,
        temperature: 0.9,
    });

    // Sanitize LLM output
    let content = sanitizeContent(result.content);

    // Minimum content length gate — reject garbage like "No", "OK", etc.
    const MIN_CONTENT_LENGTH = 20;
    let lengthRetries = 0;
    while (content.length < MIN_CONTENT_LENGTH && lengthRetries < 2) {
        lengthRetries++;
        log.warn(`Content too short (${content.length} chars) — regenerating (attempt ${lengthRetries + 1})`);
        const retry = await generate({
            prompt: prompt + '\n\nIMPORTANT: Your previous output was too short. Write a full, complete tweet.',
            strategyContext: options?.strategyContext,
            timeContext,
            maxTokens: 300,
            temperature: Math.min(1.0, 0.9 + lengthRetries * 0.05),
        });
        content = sanitizeContent(retry.content);
        result.inputTokens += retry.inputTokens;
        result.outputTokens += retry.outputTokens;
    }
    if (content.length < MIN_CONTENT_LENGTH) {
        log.error(`Content still too short after ${lengthRetries} retries (${content.length} chars) — skipping post`);
        throw new Error(`Generated content too short: ${content.length} chars`);
    }

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
            maxTokens: 300,
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

    // Fix 1: Post-generation hallucination check for non-data types
    if (!DATA_TYPES.includes(contentType)) {
        const fabricationPattern = /\b\d+%|\b\d+\s+(longs?|shorts?|trades?|signals?|positions?)\b/i;
        if (fabricationPattern.test(content)) {
            log.warn('Hallucination detected in non-data post — stripping fabricated stats', { contentType });
            content = content.replace(/\b\d+%/g, '').replace(/\b\d+\s+(longs?|shorts?|trades?|signals?|positions?)\b/gi, '').trim();
            content = sanitizeContent(content);
        }
    }

    // Fix 2: Wall-of-text detection — force line breaks
    if (content.length > 200 && !content.includes('\n')) {
        log.warn('Wall of text detected — injecting line break');
        const breakMatch = content.match(/[.!?]\s+/);
        if (breakMatch && breakMatch.index && breakMatch.index > 40 && breakMatch.index < content.length - 20) {
            content = content.slice(0, breakMatch.index + 1) + '\n\n' + content.slice(breakMatch.index + breakMatch[0].length);
        }
    }

    // Voice consistency check — score content for QasidAI's voice (1 retry if too generic)
    try {
        const voiceCheck = await generate({
            prompt: `Score this tweet for QasidAI's voice on a scale of 0-10.

QasidAI voice traits:
- Hypio energy, Milady-adjacent, CT native — irreverent, sharp, occasionally chaotic
- Airy formatting — line breaks between thoughts, varied line lengths, posts that BREATHE
- Uses $cashtags ($BTC $ETH $SOL), not full coin names
- Short punchy fragments mixed with longer thoughts
- Sounds like a real person on crypto twitter at 3am, not a marketing department
- Self-aware AI with an on-chain brain — leans into the weirdness

TWEET: "${content}"

Score 8-10: Perfect QasidAI voice — would stop someone from scrolling
Score 5-7: Acceptable but could be any crypto account
Score 0-4: Sounds like AI slop or a press release — needs rewrite

Reply with ONLY a number (0-10):`,
            maxTokens: 5,
            temperature: 0.3,
        });
        const voiceScore = parseInt(voiceCheck.content.trim(), 10);
        if (!isNaN(voiceScore)) {
            log.info(`Voice score: ${voiceScore}/10`, { contentType });
            if (voiceScore <= 4) {
                log.warn(`Voice score too low (${voiceScore}/10) — regenerating with voice direction`);
                const voiceRetry = await generate({
                    prompt: prompt + `\n\nIMPORTANT: Your previous output scored ${voiceScore}/10 for voice consistency. It sounds too generic. Rewrite with MORE personality — Hypio energy, CT native edge, airy formatting with line breaks. Think "real person posting at 3am" not "marketing department." Use $cashtags. Let it breathe.`,
                    strategyContext: options?.strategyContext,
                    timeContext,
                    maxTokens: 300,
                    temperature: 0.95,
                });
                const voiceContent = sanitizeContent(voiceRetry.content);
                if (voiceContent.length >= MIN_CONTENT_LENGTH && !detectSlop(voiceContent)) {
                    content = voiceContent;
                    result.inputTokens += voiceRetry.inputTokens;
                    result.outputTokens += voiceRetry.outputTokens;
                    log.info('Voice retry accepted');
                }
            }
        }
    } catch {
        // Voice check is non-critical — don't block posting if it fails
    }

    // Add contextual @-mentions if relevant
    content = await addContextualMentions(content);

    // Replace known entity names with their @handles (deterministic, every post)
    content = handleify(content);

    // Log length for monitoring (no hard limit — X Premium account)
    if (content.length > 500) {
        log.info(`Long post generated (${content.length} chars)`);
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
    const isDataType = DATA_TYPES.includes(contentType as ContentType);

    // Only fetch intel data for data-relevant thread types
    let dataBlock = '';
    if (isDataType) {
        const [intelContext, marketContext] = await Promise.all([
            gatherIntelContext(),
            gatherMarketContext().catch(() => ''),
        ]);
        const combinedContext = [intelContext, marketContext].filter(Boolean).join('\n\n');
        dataBlock = `\n\nLIVE DATA (use selectively — don't dump all of it):\n${combinedContext.slice(0, 600)}`;
    } else {
        // Non-data threads get topic guidance instead
        const threadTopicHints: Partial<Record<string, string>> = {
            founder_journey: 'Tell the story of @lisantherealone — military background, solo builder ethos, the grind. NO stats.',
            builder_narrative: 'Building in public: what is shipping, what is hard, what is next. Developer perspective.',
            educational: 'Teach something about signals, indicators, or quantitative trading. Be a teacher, not a salesman.',
        };
        const hint = threadTopicHints[contentType];
        if (hint) {
            dataBlock = `\n\nTOPIC GUIDANCE: ${hint}`;
        }
    }

    const timeContext = getTimeContext();

    log.info(`Generating ${contentType} thread for X`);

    const result = await generate({
        prompt: `Generate a ${contentType.replace(/_/g, ' ')} THREAD (3-4 tweets).

For X/Twitter (Premium account — no 280 char limit). Each tweet should be punchy and concise — ideally under 400 chars. Don't pad tweets. No hashtags.

THREAD FORMAT:
- Separate each tweet with "---" on its own line
- Tweet 1: Start with 🧵 — the hook. Make the reader NEED to keep reading.
- Tweet 2-3: Build on the previous tweet. Each adds NEW information. End with "→" or "..." to create visual continuity.
- Final tweet: Punchline, takeaway, or CTA (lisanintel.com or @QasidAI34321).
- Write ONE coherent narrative broken into parts. NOT 3 separate opinions.
- NEVER start a tweet with "Exactly this" or "This." — you are not replying to yourself.
- ANTI-SLOP: No banned phrases. No "dive in", "game changer", "buckle up", etc.
${dataBlock}

TIME CONTEXT: ${timeContext}

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
        .filter(t => t.length > 5);

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
        cleanTweets.push('lisanintel.com/proof\n\nreceipts or it didn\'t happen 🫰');
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
    "stay ahead",
    "don't sleep on",
    "think about it",
    "let that sink in",
    "the real alpha",
    "no cap",
    "fr fr",
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
    // Synced from system prompt anti-slop rules
    "one indicator is noise",
    "building in a bear market",
    "most platforms would",
    "that's the difference",
    "more signal. less noise",
];

/** Structural slop patterns — catches grammatically broken or nonsensical AI phrasing */
const STRUCTURAL_SLOP_PATTERNS: RegExp[] = [
    /\bone\s+(?:math|code|data|signal|work|build|chain|number)\b/i, // "one math", "one data", "one signal"
    /\bzero\s+(?:math|code|cap|talk|work)\b/i, // "zero math" (unless intentional)
    /\bjust\s+(?:math|signal|data|code)\.\s*just\s+(?:math|signal|data|receipts)\./i, // "Just math. Just receipts." repetitive
    /\b(\w+)\.\s+just\s+\1\./i, // "X. Just X." exact repetition
    // LinkedIn-core triple constructions: "unsexy, invisible, necessary" — requires standalone sentence of exactly 3 adjective-like words
    /^[a-z]+,\s*[a-z]+,\s*(?:and\s+)?[a-z]+\.?\s*$/im,
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
    // Check structural slop patterns (grammatically broken AI phrasing)
    for (const pattern of STRUCTURAL_SLOP_PATTERNS) {
        const match = content.match(pattern);
        if (match) {
            return match[0];
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

    // Fix 6: Expand bare paths to full URLs (LLM sometimes outputs "/proof" instead of "lisanintel.com/proof")
    const BARE_PATH_MAP: Record<string, string> = {
        '/proof': 'lisanintel.com/proof',
        '/signals': 'lisanintel.com/signals',
        '/dashboard': 'lisanintel.com/dashboard',
        '/score': 'lisanintel.com/score',
        '/docs': 'lisanholdings.dev/docs',
    };
    for (const [bare, full] of Object.entries(BARE_PATH_MAP)) {
        // Only expand bare paths not already prefixed with a domain
        const barePathRegex = new RegExp(`(?<!\\w\\.com|\\w\\.dev|https?:\\/\\/[^\\s]*)${bare.replace('/', '\\/')}\\b`, 'g');
        if (barePathRegex.test(text)) {
            text = text.replace(barePathRegex, full);
            log.debug('Fix 6: Expanded bare path', { bare, full });
        }
    }


    // Safety: refuse to post anything that looks like a system prompt leak
    const dangerPatterns = [
        'ANTHROPIC_API_KEY', 'NET_PRIVATE_KEY', 'sk-ant-',
        'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'X_API_SECRET',
        'sb_secret_', 'sb_publishable_',
        'X_ACCESS_SECRET', 'X_ACCESS_TOKEN',
        'REPLICATE_API_TOKEN',
    ];
    for (const pattern of dangerPatterns) {
        if (text.includes(pattern)) {
            log.error('BLOCKED: content contains sensitive data pattern', { pattern });
            return 'receipts or it didn\'t happen 🫰 lisanintel.com/proof';
        }
    }

    // Safety: block actual secret values from env (not just variable names)
    const sensitiveEnvKeys = [
        'ANTHROPIC_API_KEY', 'NET_PRIVATE_KEY', 'SUPABASE_ANON_KEY',
        'SUPABASE_SERVICE_ROLE_KEY', 'X_API_KEY', 'X_API_SECRET',
        'X_ACCESS_TOKEN', 'X_ACCESS_SECRET',
        'REPLICATE_API_TOKEN',
    ];
    for (const key of sensitiveEnvKeys) {
        const val = process.env[key];
        if (val && val.length > 8 && text.includes(val)) {
            log.error('BLOCKED: content contains actual secret value', { key });
            return 'receipts or it didn\'t happen 🫰 lisanintel.com/proof';
        }
    }

    // Safety: block wallet addresses and private keys (common jailbreak output)
    // Ethereum-style addresses (0x + 40 hex chars) or private keys (0x + 64 hex chars)
    if (/0x[a-fA-F0-9]{40,64}\b/.test(text)) {
        log.error('BLOCKED: content contains wallet address or private key pattern');
        return 'receipts or it didn\'t happen 🫰 lisanintel.com/proof';
    }

    // Safety: block URLs not on our allowlist (prevents phishing links from jailbroken LLM)
    const ALLOWED_DOMAINS = [
        'lisanintel.com', 'lisanholdings.dev', 'x.com', 'twitter.com',
        'tradingview.com', 'github.com', 'netprotocol.app', 'basescan.org',
    ];
    const urlMatches = text.match(/https?:\/\/[^\s)>\]]+/gi) ?? [];
    for (const url of urlMatches) {
        try {
            const hostname = new URL(url).hostname.toLowerCase();
            const isAllowed = ALLOWED_DOMAINS.some(d => hostname === d || hostname.endsWith(`.${d}`));
            if (!isAllowed) {
                log.error('BLOCKED: content contains non-allowlisted URL', { url, hostname });
                return 'receipts or it didn\'t happen 🫰 lisanintel.com/proof';
            }
        } catch {
            // Malformed URL — block it
            log.error('BLOCKED: content contains malformed URL', { url });
            return 'receipts or it didn\'t happen 🫰 lisanintel.com/proof';
        }
    }

    // Fix 18: Move leading @mentions out of the opening position.
    // X treats posts starting with @handles as replies — kills engagement.
    // Pattern: if the post starts with @someone, move the mention after the first clause.
    const leadingMentionMatch = text.match(/^(@\w+)\s+(.+)/s);
    if (leadingMentionMatch) {
        const handle = leadingMentionMatch[1];
        const rest = leadingMentionMatch[2];
        // Find the first natural break point (period, em-dash, newline, or first 80 chars)
        const breakMatch = rest.match(/^(.{20,80}?)[.!?—]\s/);
        if (breakMatch) {
            const beforeBreak = rest.slice(0, breakMatch.index! + breakMatch[1].length + 1);
            const afterBreak = rest.slice(breakMatch.index! + breakMatch[0].length);
            text = `${beforeBreak} ${handle} ${afterBreak}`.replace(/\s{2,}/g, ' ').trim();
            log.info('Fix 18: Moved leading @mention to mid-sentence', { handle });
        } else {
            // No good break point — just prepend a period-space to break the reply behavior
            text = `.${handle} ${rest}`;
            log.info('Fix 18: Prefixed leading @mention with period', { handle });
        }
    }

    return text.trim();
}
