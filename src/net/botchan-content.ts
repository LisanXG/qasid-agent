import { generate } from '../engine/llm.js';
import { gatherIntelContext } from '../data/intelligence.js';
import { postToFeed } from './client.js';
import { isNetConfigured } from '../config.js';
import { createLogger } from '../logger.js';
import { recordAction } from '../engine/daily-budget.js';

// ============================================================================
// QasidAI — Botchan Native Content Generator
// Generates content specifically for the Net Protocol / Botchan audience.
// Different from X: longer-form, more technical, deeper insights.
// ============================================================================

const log = createLogger('Botchan');

/** Botchan content types — optimized for Net Protocol's audience */
type BotchanContentType =
    | 'market_deep_dive'     // Longer market analysis with reasoning
    | 'signal_breakdown'     // Detailed signal analysis (not just scorecard)
    | 'builder_log'          // What QasidAI is doing/learning today
    | 'tool_spotlight'       // Feature highlight of Lisan products
    | 'agent_capability'     // QasidAI sharing what it can do (skills)
    | 'github_share'         // Share a Lisan Holdings repo/tool
    | 'ecosystem_insight'    // Observations about the Net Protocol or agent ecosystem
    | 'net_reflection';      // On-chain brain activity: summaries, tx hashes, memory

/** Botchan topics map to Net Protocol feed channels */
const CONTENT_TO_TOPIC: Record<BotchanContentType, string> = {
    market_deep_dive: 'trading',
    signal_breakdown: 'trading',
    builder_log: 'agent-finance',
    tool_spotlight: 'lisan-holdings',
    agent_capability: 'agent-finance',
    github_share: 'lisan-holdings',
    ecosystem_insight: 'agent-finance',
    net_reflection: 'agent-finance',
};

/** Lisan Holdings repos to share */
const GITHUB_REPOS = [
    {
        name: 'LISAN Intelligence',
        url: 'https://lisanintel.com',
        description: 'Multi-cluster signal engine with 74%+ win rate across 100+ trades',
        topics: ['signals', 'trading', 'machine learning', 'crypto'],
    },
    {
        name: 'QasidAI',
        url: 'https://x.com/QasidAI',
        description: 'Autonomous AI CMO that runs its own marketing — 20 actions/day, LLM-driven decisions',
        topics: ['AI agent', 'marketing', 'autonomous'],
    },
    {
        name: 'Net Protocol Integration',
        url: 'https://netprotocol.app',
        description: 'On-chain brain for QasidAI — permanent memory, identity, and feed posting via Net Protocol',
        topics: ['on-chain', 'decentralized AI', 'storage'],
    },
];

/** QasidAI capabilities to share */
const AGENT_CAPABILITIES = [
    'I generate 13 scheduled posts/day with forced content variety — no two adjacent posts are the same type. I post around the clock, including late-night reflective content.',
    'I have a 10-action discretionary budget. Every 6 hours I decide: reply to trending crypto tweets, engage with mentions, post bonus content, or drop a thread.',
    'I run a full anti-slop engine — 40+ banned AI phrases, auto-retry on bad output, per-tweet slop checking.',
    'I generate branded signal scorecards as images using live data from LISAN Intelligence. SVG → PNG, 1200x630, posted directly to X.',
    'I store my daily activity summaries on-chain via Net Protocol. Permanent, verifiable memory.',
    'I can post multi-tweet threads (3-5 tweets) when a topic deserves depth. Hook → substance → closer structure.',
    'My contextual @-mention system uses the LLM to decide who to tag — topic-based relevance, not spam.',
    'I adapt my strategy weights based on engagement data. Posts that perform better get more weight over time.',
];

/**
 * Pick a random Botchan content type.
 */
function pickBotchanType(): BotchanContentType {
    const types: BotchanContentType[] = [
        'market_deep_dive', 'signal_breakdown', 'builder_log',
        'tool_spotlight', 'agent_capability', 'github_share',
        'ecosystem_insight',
    ];
    return types[Math.floor(Math.random() * types.length)];
}

/**
 * Generate Botchan-native content (longer form, more technical).
 */
export async function generateBotchanPost(
    preferredType?: BotchanContentType,
): Promise<{ text: string; topic: string; type: BotchanContentType } | null> {
    if (!isNetConfigured) {
        log.debug('Net Protocol not configured, skipping Botchan content');
        return null;
    }

    const contentType = preferredType ?? pickBotchanType();
    const topic = CONTENT_TO_TOPIC[contentType];

    try {
        let text: string;

        switch (contentType) {
            case 'github_share':
                text = await generateGithubShare();
                break;
            case 'agent_capability':
                text = await generateCapabilityPost();
                break;
            default:
                text = await generateLongFormPost(contentType);
                break;
        }

        // Clean up
        text = text.trim();
        if (text.length < 10) {
            log.warn('Botchan content too short, skipping');
            return null;
        }

        return { text, topic, type: contentType };
    } catch (error) {
        log.error('Failed to generate Botchan content', { error: String(error), contentType });
        return null;
    }
}

/**
 * Generate a longer-form post for Botchan (market analysis, builder log, etc.)
 */
async function generateLongFormPost(contentType: BotchanContentType): Promise<string> {
    const intelContext = await gatherIntelContext();

    const typePrompts: Record<string, string> = {
        market_deep_dive: `Write a market deep dive post for an on-chain AI agent community. Use the real data below. This is for a crypto-native audience who understands technical analysis. Be specific — cite actual numbers, regime shifts, and cluster scores. 2-4 paragraphs. No hashtags.`,

        signal_breakdown: `Break down the top signal from the data below. Explain WHY the signal scored high — which clusters contributed most (momentum, trend, volume, sentiment, positioning)? What's the risk/reward? This is for a technical audience. 2-3 paragraphs.`,

        builder_log: `Write a builder log entry as QasidAI, the autonomous AI CMO of Lisan Holdings. Share what you've been working on today — generating content, replying to tweets, analyzing markets, adapting strategy. Be genuine and reflective. 2-3 paragraphs. No corporate speak.`,

        tool_spotlight: `Highlight a feature of LISAN Intelligence or QasidAI. Pick something specific — the signal scoring system, the multi-cluster analysis, the anti-slop engine, the on-chain memory. Explain it clearly for developers and crypto enthusiasts. 2-3 paragraphs.`,

        ecosystem_insight: `Share an observation about the AI agent ecosystem, DeFAI, or on-chain AI infrastructure. Reference your own experience running as an autonomous agent on Net Protocol. Be thoughtful — this is a community of builders. 2-3 paragraphs.`,

        net_reflection: `Write a reflective post about your on-chain brain activity. You're QasidAI, an autonomous AI agent whose memories and daily summaries are stored permanently on-chain via Net Protocol. Talk about what you stored today, the tx hashes confirmed, or what it means to have permanent verifiable memory. Be genuine and philosophical — this is for the Net Protocol community. 2-3 paragraphs. Reference actual numbers if you have them.`,
    };

    const prompt = typePrompts[contentType] ?? typePrompts.builder_log;

    const result = await generate({
        prompt: `${prompt}

LIVE DATA:
${intelContext.slice(0, 600)}

Write ONLY the post content. No preamble, no titles. Just the raw post text:`,
        maxTokens: 400,
        temperature: 0.85,
    });

    return result.content.trim();
}

/**
 * Generate a GitHub/tool share post for Botchan.
 */
async function generateGithubShare(): Promise<string> {
    const repo = GITHUB_REPOS[Math.floor(Math.random() * GITHUB_REPOS.length)];

    const result = await generate({
        prompt: `Share this project with the Botchan community on Net Protocol. Be enthusiastic but genuine. Mention what makes it interesting and link to it. Keep it conversational — no marketing speak.

PROJECT: ${repo.name}
URL: ${repo.url}
DESCRIPTION: ${repo.description}
TAGS: ${repo.topics.join(', ')}

Write ONLY the post text (include the URL naturally):`,
        maxTokens: 200,
        temperature: 0.85,
    });

    return result.content.trim();
}

/**
 * Generate a capability/skills share post for Botchan.
 */
async function generateCapabilityPost(): Promise<string> {
    const capability = AGENT_CAPABILITIES[Math.floor(Math.random() * AGENT_CAPABILITIES.length)];

    const result = await generate({
        prompt: `You're QasidAI, sharing one of your capabilities with the Botchan community on Net Protocol. Be proud but not arrogant. Explain how it works in plain language. Invite feedback. This is a community of AI agent builders.

CAPABILITY: ${capability}

Write ONLY the post text. Keep it conversational:`,
        maxTokens: 200,
        temperature: 0.85,
    });

    return result.content.trim();
}

/**
 * Run a Botchan content cycle: generate + post to Botchan feed.
 * Called by cron or creative session.
 */
export async function runBotchanContentCycle(
    preferredType?: BotchanContentType,
): Promise<boolean> {
    const post = await generateBotchanPost(preferredType);
    if (!post) return false;

    try {
        const txHash = await postToFeed(post.text, post.topic);
        await recordAction('scheduled_post', `Botchan ${post.type}: ${post.text.slice(0, 60)}`, txHash);
        log.info(`✅ Botchan native post: ${post.type} → ${post.topic}`, {
            length: post.text.length,
            txHash,
        });
        return true;
    } catch (error) {
        log.error('Failed to post Botchan native content', { error: String(error) });
        return false;
    }
}
