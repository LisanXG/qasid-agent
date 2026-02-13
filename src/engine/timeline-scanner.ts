import { generate } from './llm.js';
import { sanitizeContent } from './content.js';
import { searchRecentTweets, replyToTweet, type SearchResult } from '../platforms/x.js';
import { gatherIntelContext } from '../data/intelligence.js';
import { supabase } from '../supabase.js';
import { createLogger } from '../logger.js';
import { config } from '../config.js';
import { sanitizeUserInput } from './sanitize-input.js';

// ============================================================================
// QasidAI — Timeline Scanner
// Searches X for relevant crypto/AI conversations and replies contextually
// AxiomBot-style: find high-value tweets → evaluate → reply as Qasid
// ============================================================================

const log = createLogger('Scanner');

// ---- Configuration ----

/** Max replies per scan cycle */
const MAX_REPLIES_PER_CYCLE = 3;

/** Max replies per 24h window (safety rail) */
const MAX_REPLIES_PER_DAY = 10;

/** Minimum engagement a tweet needs before we consider replying */
const MIN_LIKES = 2;

/** Search queries — rotated each cycle for variety */
const SEARCH_QUERIES = [
    // Crypto trading & signals
    '"crypto signals" -is:retweet lang:en',
    '"technical analysis" crypto -is:retweet lang:en',
    '"AI trading" -is:retweet lang:en',
    // AI agents & autonomous finance
    '"AI agent" crypto -is:retweet lang:en',
    '"autonomous agent" -is:retweet lang:en',
    '"onchain AI" -is:retweet lang:en',
    // Market commentary
    '"fear and greed" crypto -is:retweet lang:en',
    '"market regime" -is:retweet lang:en',
    'crypto "machine learning" -is:retweet lang:en',
    // Lisan-adjacent topics
    '"signal accuracy" trading -is:retweet lang:en',
    '"win rate" trading crypto -is:retweet lang:en',
];

// ---- Tracking (prevent double-replies) ----

/**
 * Check if we already replied to a tweet (stored in Supabase).
 */
async function hasRepliedTo(tweetId: string): Promise<boolean> {
    const { data } = await supabase
        .from('qasid_replies')
        .select('id')
        .eq('target_tweet_id', tweetId)
        .limit(1);
    return (data?.length ?? 0) > 0;
}

/**
 * Record a reply so we never double-reply.
 */
async function recordReply(
    targetTweetId: string,
    targetAuthor: string,
    replyTweetId: string,
    replyText: string,
    searchQuery: string,
): Promise<void> {
    const { error } = await supabase
        .from('qasid_replies')
        .insert({
            target_tweet_id: targetTweetId,
            target_author: targetAuthor,
            reply_tweet_id: replyTweetId,
            reply_text: replyText,
            search_query: searchQuery,
            replied_at: new Date().toISOString(),
        });
    if (error) {
        log.error('Failed to record reply', { error: error.message });
    }
}

/**
 * Count replies in the last 24 hours (safety limit).
 */
async function getRepliesLast24h(): Promise<number> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
        .from('qasid_replies')
        .select('id')
        .gte('replied_at', since);

    if (error) {
        log.warn('Failed to count recent replies', { error: error.message });
        return MAX_REPLIES_PER_DAY; // Fail safe: assume we're at limit
    }
    return data?.length ?? 0;
}

// ---- LLM Evaluation ----

/**
 * Use LLM to evaluate a tweet and draft a reply.
 * Returns null if the tweet isn't worth replying to.
 */
async function evaluateAndDraftReply(
    tweet: SearchResult,
    intelContext: string,
): Promise<string | null> {
    const prompt = `You found this tweet on X while scanning for engagement opportunities:

TWEET by @${tweet.authorUsername ?? 'unknown'}:
"${sanitizeUserInput(tweet.text)}"

Engagement: ${tweet.metrics?.like_count ?? 0} likes, ${tweet.metrics?.reply_count ?? 0} replies

YOUR TASK:
1. Decide if this tweet is worth replying to. Reply ONLY if the topic is genuinely related to crypto trading, AI agents, market analysis, or DeFi. Do NOT reply to spam, scams, or irrelevant content.
2. If worth replying, draft a short, punchy reply (under 200 chars) that:
   - Adds genuine value or insight
   - Subtly positions Qasid/Lisan Intelligence as knowledgeable
   - Does NOT hard-sell or spam links
   - Feels natural and conversational, not corporate
   - May reference LISAN Intelligence data if relevant

LIVE MARKET CONTEXT:
${intelContext.slice(0, 500)}

RESPOND IN EXACTLY THIS FORMAT:
VERDICT: REPLY or SKIP
REASON: [one sentence why]
REPLY: [your reply text, or "none"]`;

    try {
        const result = await generate({
            prompt,
            maxTokens: 200,
            temperature: 0.8,
        });

        const text = result.content.trim();

        // Parse the structured response
        const verdictMatch = text.match(/VERDICT:\s*(REPLY|SKIP)/i);
        if (!verdictMatch || verdictMatch[1].toUpperCase() === 'SKIP') {
            const reasonMatch = text.match(/REASON:\s*(.+)/i);
            log.debug('Skipping tweet', {
                tweetId: tweet.id,
                reason: reasonMatch?.[1]?.slice(0, 100) ?? 'no reason given',
            });
            return null;
        }

        const replyMatch = text.match(/REPLY:\s*(.+)/is);
        if (!replyMatch || replyMatch[1].trim().toLowerCase() === 'none') {
            return null;
        }

        let reply = replyMatch[1].trim();

        // Strip quotes if LLM wrapped the reply
        reply = reply.replace(/^["']|["']$/g, '');

        // Run through full output sanitization (URL allowlist, secret detection, wallet blocking)
        reply = sanitizeContent(reply);

        // No hard char limit (X Premium account) — prompt already constrains reply length

        return reply;
    } catch (error) {
        log.error('LLM evaluation failed', { error: String(error), tweetId: tweet.id });
        return null;
    }
}

// ---- Main Scanner ----

/**
 * Run a single timeline scan cycle.
 * 1. Pick a search query
 * 2. Fetch matching tweets from X
 * 3. Filter: skip our own, already-replied, low engagement
 * 4. Evaluate top candidates via LLM
 * 5. Reply to the best ones
 *
 * Returns the number of replies posted.
 */
export async function runTimelineScan(): Promise<number> {
    log.info('Starting timeline scan cycle...');

    // Safety check: daily reply limit
    const recentCount = await getRepliesLast24h();
    if (recentCount >= MAX_REPLIES_PER_DAY) {
        log.info(`Daily reply limit reached (${recentCount}/${MAX_REPLIES_PER_DAY}), skipping scan`);
        return 0;
    }

    const remainingBudget = Math.min(
        MAX_REPLIES_PER_CYCLE,
        MAX_REPLIES_PER_DAY - recentCount,
    );

    // Pick 2-3 random queries for variety
    const shuffled = [...SEARCH_QUERIES].sort(() => Math.random() - 0.5);
    const queries = shuffled.slice(0, 3);

    // Fetch intel context once for all evaluations
    const intelContext = await gatherIntelContext();

    let totalReplies = 0;
    const seenTweetIds = new Set<string>();

    for (const query of queries) {
        if (totalReplies >= remainingBudget) break;

        log.info(`Searching: "${query}"`);

        try {
            const tweets = await searchRecentTweets(query, 15);

            // Filter candidates
            const candidates: SearchResult[] = [];
            for (const tweet of tweets) {
                // Skip if we've seen this tweet ID already
                if (seenTweetIds.has(tweet.id)) continue;
                seenTweetIds.add(tweet.id);

                // Skip low engagement
                if ((tweet.metrics?.like_count ?? 0) < MIN_LIKES) continue;

                // Skip if already replied
                if (await hasRepliedTo(tweet.id)) continue;

                candidates.push(tweet);
            }

            log.info(`Found ${candidates.length} candidates from query`, { query, total: tweets.length });

            // Evaluate top candidates (limit to avoid burning tokens)
            const toEvaluate = candidates.slice(0, 3);

            for (const candidate of toEvaluate) {
                if (totalReplies >= remainingBudget) break;

                const replyText = await evaluateAndDraftReply(candidate, intelContext);
                if (!replyText) continue;

                // Post the reply
                log.info('Replying to tweet', {
                    tweetId: candidate.id,
                    author: candidate.authorUsername,
                    reply: replyText.slice(0, 80),
                });

                const replyId = await replyToTweet(candidate.id, replyText);

                if (replyId) {
                    await recordReply(
                        candidate.id,
                        candidate.authorUsername ?? candidate.authorId,
                        replyId,
                        replyText,
                        query,
                    );
                    totalReplies++;
                    log.info('✅ Reply posted', {
                        replyId,
                        targetTweet: candidate.id,
                        author: candidate.authorUsername,
                    });
                }
            }
        } catch (error) {
            log.error('Search query failed', { query, error: String(error) });
        }
    }

    log.info(`Timeline scan complete: ${totalReplies} replies posted`, {
        queriesRun: queries.length,
        dailyTotal: recentCount + totalReplies,
    });

    return totalReplies;
}
