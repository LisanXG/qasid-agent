import { generate } from './llm.js';
import { createLogger } from '../logger.js';

// ============================================================================
// QasidAI — Contextual @-Mentions
// Intelligently suggests @-mentions based on post content and topic.
// The LLM decides whether a mention is natural, not a hardcoded rule.
// ============================================================================

const log = createLogger('Mentions');

/**
 * Account categories — organized by topic/relevance.
 * QasidAI picks from these when the content is related.
 * NOTE: Keep this list curated. Only add accounts that make sense to tag.
 * Max 1-2 mentions per post to avoid looking spammy.
 */
export interface RelevantAccount {
    handle: string;           // @handle (without @)
    category: string;         // Topic category
    context: string;          // When it makes sense to mention them
    priority: number;         // 1-5 (5 = founder/official, 1 = loose association)
}

const RELEVANT_ACCOUNTS: RelevantAccount[] = [
    // Official / founder — highest priority
    {
        handle: 'Lisantheresa',
        category: 'founder',
        context: 'When talking about building, founder journey, company milestones, or the team behind Lisan',
        priority: 5,
    },
    {
        handle: 'LisanIntel',
        category: 'product',
        context: 'When sharing signal data, scorecards, win rates, or market regime from LISAN Intelligence',
        priority: 5,
    },
    {
        handle: 'netprotocolapp',
        category: 'partner',
        context: 'When discussing on-chain AI, decentralized agent infrastructure, or Net Protocol features',
        priority: 4,
    },

    // Ecosystem / crypto AI — lower priority, mention sparingly
    {
        handle: 'solaboratory',
        category: 'ecosystem',
        context: 'When talking about Solana ecosystem tools or agent launchpads',
        priority: 2,
    },
];

/** Topic keywords → relevant account categories */
const TOPIC_SIGNALS: Record<string, string[]> = {
    founder: ['founder', 'built', 'building', 'journey', 'navy', 'veteran', 'lisan holdings', 'one-man army'],
    product: ['signal', 'scorecard', 'win rate', 'regime', 'lisan intelligence', 'lisanintel', 'proof', 'accuracy'],
    partner: ['net protocol', 'on-chain', 'onchain', 'botchan', 'agent infrastructure', 'decentralized ai'],
    ecosystem: ['solana', 'sol ecosystem', 'agent launchpad'],
};

/**
 * Detect which categories are relevant to the given content.
 */
function detectRelevantCategories(content: string): string[] {
    const lower = content.toLowerCase();
    const matched: string[] = [];

    for (const [category, keywords] of Object.entries(TOPIC_SIGNALS)) {
        if (keywords.some(kw => lower.includes(kw))) {
            matched.push(category);
        }
    }
    return matched;
}

/**
 * Get candidate accounts for a piece of content.
 * Returns accounts sorted by priority (highest first).
 */
function getCandidateAccounts(content: string): RelevantAccount[] {
    const categories = detectRelevantCategories(content);
    if (categories.length === 0) return [];

    return RELEVANT_ACCOUNTS
        .filter(a => categories.includes(a.category))
        .sort((a, b) => b.priority - a.priority);
}

/**
 * LLM-powered mention selector.
 * Given content and candidate accounts, the LLM decides whether any should be mentioned.
 * Returns the modified content with mentions naturally woven in, or the original if no mentions fit.
 *
 * Rules:
 * - Max 1-2 mentions per post
 * - Only mention if it's natural and adds value
 * - Don't mention founder in every single post (feels fake)
 * - Never @-mention if the post is already close to 280 chars
 */
export async function addContextualMentions(content: string): Promise<string> {
    // Skip if content is already near the limit
    if (content.length > 240) {
        log.info('Content too long for mentions, skipping');
        return content;
    }

    const candidates = getCandidateAccounts(content);
    if (candidates.length === 0) {
        return content;
    }

    // Rate limit: only add mentions ~30% of the time to avoid spam
    if (Math.random() > 0.30) {
        log.info('Skipping mentions this post (randomized throttle)');
        return content;
    }

    // Ask the LLM to decide
    const candidateList = candidates.slice(0, 3).map(a =>
        `@${a.handle} — ${a.context}`
    ).join('\n');

    try {
        const result = await generate({
            prompt: `You have a tweet ready to post. Decide if any of these accounts should be @-mentioned naturally IN the tweet.

TWEET: "${content}"

CANDIDATE ACCOUNTS TO MENTION:
${candidateList}

RULES:
- Only add a mention if it genuinely fits the content
- Maximum 1 mention (2 only if both are directly relevant)
- Weave the @-mention naturally into the sentence — don't just append it
- Keep the total under 280 characters
- If none fit naturally, return the tweet unchanged
- Do NOT add new text or change the meaning — only insert @handles where they fit

Return ONLY the final tweet text (with mentions if appropriate, or unchanged if not):`,
            maxTokens: 150,
            temperature: 0.3,  // Low temp for consistency
        });

        let tweaked = result.content.trim();

        // Remove any quotes the LLM wraps around it
        if ((tweaked.startsWith('"') && tweaked.endsWith('"')) ||
            (tweaked.startsWith("'") && tweaked.endsWith("'"))) {
            tweaked = tweaked.slice(1, -1).trim();
        }

        // Safety: don't accept if it's way longer or drastically different
        if (tweaked.length > 280 || tweaked.length < content.length * 0.5) {
            log.warn('LLM mention edit rejected (length mismatch)', {
                original: content.length,
                modified: tweaked.length,
            });
            return content;
        }

        // Check if any mention was actually added
        const mentionAdded = candidates.some(a =>
            tweaked.includes(`@${a.handle}`) && !content.includes(`@${a.handle}`)
        );

        if (mentionAdded) {
            log.info('Contextual mention added', {
                handles: candidates.filter(a => tweaked.includes(`@${a.handle}`)).map(a => a.handle),
            });
        }

        return tweaked;
    } catch (error) {
        log.error('Failed to add contextual mentions', { error: String(error) });
        return content;
    }
}

/**
 * Add a new relevant account dynamically (e.g., from smart follow discoveries).
 */
export function addRelevantAccount(account: RelevantAccount): void {
    // Don't allow duplicates
    if (RELEVANT_ACCOUNTS.some(a => a.handle.toLowerCase() === account.handle.toLowerCase())) {
        return;
    }
    RELEVANT_ACCOUNTS.push(account);
    log.info('Added relevant account for contextual mentions', { handle: account.handle });
}
