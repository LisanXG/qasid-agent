import { generate } from './llm.js';
import { createLogger } from '../logger.js';

// ============================================================================
// QasidAI — Contextual @-Mentions
// Intelligently suggests @-mentions based on post content and topic.
// The LLM decides whether a mention is natural, not a hardcoded rule.
// ============================================================================

const log = createLogger('Mentions');

// Fix 10: Per-post cooldown — track how many posts since last mention
let postsSinceLastMention = 0;

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
        handle: 'lisantherealone',
        category: 'founder',
        context: 'When talking about building, founder journey, company milestones, or the team behind Lisan',
        priority: 5,
    },
    {
        handle: 'netprotocolapp',
        category: 'partner',
        context: 'When discussing on-chain AI, decentralized agent infrastructure, or Net Protocol features',
        priority: 4,
    },
];

/** Topic keywords → relevant account categories */
const TOPIC_SIGNALS: Record<string, string[]> = {
    founder: ['lisan holdings', 'my creator', 'my founder', 'the founder'],
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
 * - Never @-mention if the post is already very long
 */
export async function addContextualMentions(content: string): Promise<string> {
    // Skip if content is already near the limit
    if (content.length > 400) {
        log.info('Content too long for mentions, skipping');
        return content;
    }

    const candidates = getCandidateAccounts(content);
    if (candidates.length === 0) {
        return content;
    }

    // Rate limit: only add mentions ~15% of the time (Fix 10: reduced from 30%)
    if (Math.random() > 0.15) {
        log.info('Skipping mentions this post (randomized throttle)');
        postsSinceLastMention++;
        return content;
    }

    // Fix 10: Cooldown — skip if fewer than 4 posts since last mention
    if (postsSinceLastMention < 4) {
        log.info(`Mention cooldown active (${postsSinceLastMention}/4 posts since last mention)`);
        postsSinceLastMention++;
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
- Keep the total concise — don't make it longer than necessary
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
        if (tweaked.length > content.length + 50 || tweaked.length < content.length * 0.5) {
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
            postsSinceLastMention = 0; // Fix 10: Reset cooldown
            log.info('Contextual mention added', {
                handles: candidates.filter(a => tweaked.includes(`@${a.handle}`)).map(a => a.handle),
            });
        } else {
            postsSinceLastMention++;
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

/**
 * Known entity names → their official @handles (static fallback).
 * IMPORTANT: Only add VERIFIED real X accounts here.
 */
const STATIC_HANDLE_MAP: { pattern: RegExp; handle: string }[] = [
    { pattern: /\bNet Protocol\b/i, handle: '@netprotocolapp' },
    { pattern: /\bBotchan\b/i, handle: '@netprotocolapp' },
];

// ---- Dynamic Following Cache ----
// Synced once daily from X API. Maps display names → @handles for accounts
// QasidAI follows. Only verified accounts are included.

interface CachedHandle {
    handle: string;       // e.g. 'netprotocolapp'
    displayName: string;  // e.g. 'Net Protocol'
    pattern: RegExp;      // built from displayName for matching
}

let followingCache: CachedHandle[] = [];

/**
 * Sync the following cache from X API.
 * Called once daily during the smart-follow cron.
 * Only caches verified accounts to avoid tagging random/fake accounts.
 */
export async function syncFollowingHandles(): Promise<number> {
    try {
        const { getFollowing } = await import('../platforms/x.js');
        const following = await (getFollowing as () => Promise<any[]>)();

        // Only cache verified accounts (user's requirement)
        const verified = following.filter((a: any) => a.verified);

        followingCache = verified
            .filter((a: any) => a.displayName && a.handle)
            .map((a: any) => ({
                handle: a.handle as string,
                displayName: a.displayName as string,
                // Build word-boundary regex from display name
                // Escape regex special chars in display name
                pattern: new RegExp(
                    `\\b${(a.displayName as string).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
                    'i'
                ),
            }));

        log.info(`Following cache synced: ${followingCache.length} verified accounts`, {
            total: following.length,
            verified: verified.length,
            cached: followingCache.length,
            handles: followingCache.map(c => `@${c.handle}`).join(', '),
        });

        return followingCache.length;
    } catch (error) {
        log.error('Failed to sync following handles', { error: String(error) });
        return 0;
    }
}

/**
 * Get a formatted context block of followed accounts for the LLM prompt.
 * Returns a rotating subset of 5-8 accounts so QasidAI can naturally
 * mention them in posts. Grows automatically as the following list grows.
 */
export function getFollowingContext(): string {
    // Core accounts always included (founder + key partners)
    const coreHandles = RELEVANT_ACCOUNTS.map(a => `@${a.handle} (${a.context})`);

    // Dynamic accounts from the following cache — pick a random subset
    const dynamicAccounts = followingCache
        .filter(c => !RELEVANT_ACCOUNTS.some(r => r.handle.toLowerCase() === c.handle.toLowerCase()))
        .map(c => ({ handle: c.handle, displayName: c.displayName }));

    if (dynamicAccounts.length === 0 && coreHandles.length === 0) return '';

    // Shuffle and pick 5-8 dynamic accounts (rotate each generation)
    const maxDynamic = Math.min(8, dynamicAccounts.length);
    const shuffled = dynamicAccounts.sort(() => Math.random() - 0.5).slice(0, maxDynamic);
    const dynamicLines = shuffled.map(a => `@${a.handle} (${a.displayName})`);

    const allAccounts = [...coreHandles, ...dynamicLines];

    return [
        'YOUR NETWORK: You follow these accounts on X. When your post topic is relevant to any of them, you may naturally @-mention up to 2-3 if they fit the context. Only tag if it genuinely adds value — never force it. Not every post needs a mention.',
        ...allAccounts.map(a => `  - ${a}`),
    ].join('\n');
}

/**
 * Replace known entity names with their @handles in post content.
 * Uses both static mappings (hardcoded core entities) and dynamic
 * mappings (from the daily following list sync).
 * Max 3 replacements per post to keep it natural without being spammy.
 */
export function handleify(content: string): string {
    let result = content;
    const MAX_MENTIONS = 3;
    let mentionCount = 0;

    // 1. Static mappings first (core entities like Net Protocol)
    for (const { pattern, handle } of STATIC_HANDLE_MAP) {
        if (mentionCount >= MAX_MENTIONS) break;
        if (result.includes(handle)) continue;
        const newResult = result.replace(pattern, handle);
        if (newResult !== result) {
            result = newResult;
            mentionCount++;
        }
    }

    // 2. Dynamic mappings from following cache
    for (const { pattern, handle } of followingCache) {
        if (mentionCount >= MAX_MENTIONS) break;
        const atHandle = `@${handle}`;
        if (result.includes(atHandle)) continue;
        const newResult = result.replace(pattern, atHandle);
        if (newResult !== result) {
            result = newResult;
            mentionCount++;
        }
    }

    if (result !== content) {
        log.info('Handleified entity name', {
            original: content.slice(0, 100),
            modified: result.slice(0, 100),
        });
    }
    return result;
}
