import { generate } from './llm.js';
import { generatePost, generateThread } from './content.js';
import { searchRecentTweets, replyToTweet, getMentions, postThread, postTweetWithImage, type SearchResult, type MentionTweet } from '../platforms/x.js';
import { generateScorecardImage } from './scorecard-image.js';
import { gatherIntelContext } from '../data/intelligence.js';
import { getDiscretionaryRemaining, recordAction, getBudgetSummary } from './daily-budget.js';
import { supabase } from '../supabase.js';
import { createLogger } from '../logger.js';

// ============================================================================
// QasidAI — Creative Session
// The autonomous CMO decides what to do with discretionary budget.
// No hardcoded actions — LLM plans and executes based on context.
// ============================================================================

const log = createLogger('Creative');

/** Action types the LLM can choose from */
const AVAILABLE_ACTIONS = [
    'REPLY_TRENDING — Find and reply to a trending/relevant tweet in the crypto/AI space',
    'REPLY_MENTION — Respond to someone who @mentioned us',
    'BONUS_POST — Post extra original content (a thought, hot take, or observation)',
    'THREAD — Post a multi-tweet thread (3-5 tweets) diving deep into a topic',
    'IMAGE_POST — Post a signal scorecard image with live data',
    'QUOTE_COMMENT — Find a tweet worth quote-commenting on',
    'SKIP — Save the remaining budget (no more actions this session)',
];

/**
 * Check if we already replied to a tweet.
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
 * Record a reply for dedup.
 */
async function recordReply(
    targetId: string, targetAuthor: string,
    replyId: string, replyText: string, source: string,
): Promise<void> {
    await supabase.from('qasid_replies').insert({
        target_tweet_id: targetId,
        target_author: targetAuthor,
        reply_tweet_id: replyId,
        reply_text: replyText,
        search_query: source,
        replied_at: new Date().toISOString(),
    }).then(({ error }) => {
        if (error) log.error('Failed to record reply', { error: error.message });
    });
}

/**
 * Get the last processed mention ID.
 */
async function getLastMentionId(): Promise<string | undefined> {
    const { data } = await supabase
        .from('qasid_mention_state')
        .select('last_mention_id')
        .eq('id', 'current')
        .single();
    return data?.last_mention_id ?? undefined;
}

// ---- Action Executors ----

/**
 * Execute a REPLY_TRENDING action.
 */
async function executeReplyTrending(intelContext: string): Promise<boolean> {
    // Pick a random search query
    const queries = [
        '"crypto signals" -is:retweet lang:en',
        '"AI agent" crypto -is:retweet lang:en',
        '"technical analysis" crypto -is:retweet lang:en',
        '"market regime" -is:retweet lang:en',
        'crypto "machine learning" -is:retweet lang:en',
        '"onchain AI" -is:retweet lang:en',
        '"win rate" trading crypto -is:retweet lang:en',
    ];
    const query = queries[Math.floor(Math.random() * queries.length)];

    const tweets = await searchRecentTweets(query, 10);
    const candidates = tweets.filter(t =>
        (t.metrics?.like_count ?? 0) >= 2
    );

    for (const tweet of candidates.slice(0, 3)) {
        if (await hasRepliedTo(tweet.id)) continue;

        // Draft reply via LLM
        const result = await generate({
            prompt: `You found this tweet while browsing crypto twitter:

TWEET by @${tweet.authorUsername ?? 'unknown'}: "${tweet.text}"
Likes: ${tweet.metrics?.like_count ?? 0} | Replies: ${tweet.metrics?.reply_count ?? 0}

Draft a sharp, natural reply (under 200 chars). Add value — don't just agree. Reference data from Lisan Intelligence if relevant. If this tweet isn't worth replying to, respond with just "SKIP".

MARKET CONTEXT: ${intelContext.slice(0, 300)}

Reply with ONLY the tweet text (or "SKIP"):`,
            maxTokens: 100,
            temperature: 0.9,
        });

        const reply = result.content.trim().replace(/^["']|["']$/g, '');
        if (reply.toUpperCase() === 'SKIP' || reply.length < 5) continue;

        const replyId = await replyToTweet(tweet.id, reply);
        if (replyId) {
            await recordReply(tweet.id, tweet.authorUsername ?? tweet.authorId, replyId, reply, 'creative-trending');
            await recordAction('reply', `Replied to @${tweet.authorUsername}: ${reply.slice(0, 60)}`, replyId);
            log.info('✅ Creative reply posted', { target: tweet.id, author: tweet.authorUsername });
            return true;
        }
    }
    return false;
}

/**
 * Execute a REPLY_MENTION action.
 */
async function executeReplyMention(intelContext: string): Promise<boolean> {
    const sinceId = await getLastMentionId();
    const mentions = await getMentions(sinceId, 10);

    for (const mention of mentions) {
        if (await hasRepliedTo(mention.id)) continue;

        const result = await generate({
            prompt: `Someone mentioned you (@QasidAI) on X:

FROM: @${mention.authorUsername ?? 'unknown'}
TWEET: "${mention.text}"

Draft a warm, genuine reply (under 200 chars). Be helpful if they're asking something. Be witty if they're just chatting. If this is spam/bot, respond with just "SKIP".

MARKET CONTEXT: ${intelContext.slice(0, 300)}

Reply with ONLY the tweet text (or "SKIP"):`,
            maxTokens: 100,
            temperature: 0.85,
        });

        const reply = result.content.trim().replace(/^["']|["']$/g, '');
        if (reply.toUpperCase() === 'SKIP' || reply.length < 5) continue;

        const replyId = await replyToTweet(mention.id, reply);
        if (replyId) {
            await recordReply(mention.id, mention.authorUsername ?? mention.authorId, replyId, reply, 'creative-mention');
            await recordAction('mention_response', `Responded to @${mention.authorUsername}: ${reply.slice(0, 60)}`, replyId);
            log.info('✅ Creative mention response', { target: mention.id, author: mention.authorUsername });
            return true;
        }
    }
    return false;
}

/**
 * Execute a BONUS_POST action.
 */
async function executeBonusPost(): Promise<boolean> {
    const post = await generatePost();
    // We don't post here — we return the content and let the cron handle posting
    // Actually, let's post it directly since this is discretionary
    const { postTweet } = await import('../platforms/x.js');
    const { savePost } = await import('../engine/memory.js');

    const externalId = await postTweet(post.content);
    if (externalId) {
        await savePost(post, externalId);
        await recordAction('bonus_post', `Bonus ${post.contentType}: ${post.content.slice(0, 60)}`, externalId);
        log.info('✅ Bonus post published', { contentType: post.contentType });
        return true;
    }
    return false;
}

/**
 * Execute a THREAD action.
 */
async function executeThread(): Promise<boolean> {
    const thread = await generateThread();
    if (thread.tweets.length < 2) {
        log.warn('Thread too short, skipping');
        return false;
    }

    const ids = await postThread(thread.tweets);
    if (ids.length > 0) {
        const { savePost } = await import('../engine/memory.js');
        // Save the first tweet as the "post" in memory
        await savePost({
            content: thread.tweets.join(' | '),
            contentType: thread.contentType,
            platform: 'x',
            tone: 'insightful',
            topic: thread.topic,
            inputTokens: thread.inputTokens,
            outputTokens: thread.outputTokens,
            generatedAt: new Date().toISOString(),
        }, ids[0]);
        await recordAction('thread', `${thread.contentType} thread (${ids.length} tweets): ${thread.tweets[0].slice(0, 50)}`, ids[0]);
        log.info('✅ Thread published', { tweets: ids.length, contentType: thread.contentType });
        return true;
    }
    return false;
}

/**
 * Execute an IMAGE_POST action.
 */
async function executeImagePost(): Promise<boolean> {
    const scorecard = await generateScorecardImage();
    if (!scorecard) {
        log.warn('Scorecard image generation failed');
        return false;
    }

    const externalId = await postTweetWithImage(scorecard.caption, scorecard.buffer);
    if (externalId) {
        await recordAction('bonus_post', `Scorecard image: ${scorecard.caption.slice(0, 60)}`, externalId);
        log.info('✅ Scorecard image posted', { tweetId: externalId });
        return true;
    }
    return false;
}

// ---- Main Creative Session ----

/**
 * Run a creative session. QasidAI decides what to do with remaining discretionary budget.
 *
 * The LLM receives:
 * - Current budget status
 * - Recent activity summary
 * - Live market context
 * - Available action types
 *
 * It outputs a plan of 1-4 actions, which are executed in order.
 * Returns the number of actions taken.
 */
export async function runCreativeSession(): Promise<number> {
    log.info('🎨 Creative session starting...');

    const remaining = await getDiscretionaryRemaining();
    if (remaining <= 0) {
        log.info('Discretionary budget exhausted for today, skipping creative session');
        return 0;
    }

    const budgetSummary = await getBudgetSummary();
    const intelContext = await gatherIntelContext();

    // How many actions should we plan this session? (don't blow entire budget at once)
    const maxThisSession = Math.min(remaining, 3);

    // Ask the LLM to plan this session
    const planResult = await generate({
        prompt: `You are QasidAI, autonomous CMO of Lisan Holdings. You have a daily budget of 10 discretionary actions (beyond your 10 scheduled posts). You're deciding what to do right now.

CURRENT BUDGET:
${budgetSummary}

ACTIONS AVAILABLE (pick up to ${maxThisSession}):
${AVAILABLE_ACTIONS.map((a, i) => `${i + 1}. ${a}`).join('\n')}

CURRENT TIME: ${new Date().toUTCString()}

MARKET CONTEXT:
${intelContext.slice(0, 400)}

As a creative CMO, decide what to do this session. Think about:
- What would have the most impact right now?
- What haven't you done recently?
- Is there something trending worth engaging with?
- Would a bonus post or reply be more valuable?

RESPOND WITH A NUMBERED LIST OF ACTIONS (1-${maxThisSession}):
Example:
1. REPLY_TRENDING
2. BONUS_POST
3. SKIP

Just the action names, one per line. No explanation needed:`,
        maxTokens: 100,
        temperature: 0.8,
    });

    // Parse the plan
    const planText = planResult.content.trim();
    const actions: string[] = [];
    for (const line of planText.split('\n')) {
        const cleaned = line.replace(/^\d+[\.\)]\s*/, '').trim().toUpperCase();
        if (cleaned.startsWith('REPLY_TRENDING')) actions.push('REPLY_TRENDING');
        else if (cleaned.startsWith('REPLY_MENTION')) actions.push('REPLY_MENTION');
        else if (cleaned.startsWith('BONUS_POST') || cleaned.startsWith('BONUS')) actions.push('BONUS_POST');
        else if (cleaned.startsWith('THREAD')) actions.push('THREAD');
        else if (cleaned.startsWith('IMAGE')) actions.push('IMAGE_POST');
        else if (cleaned.startsWith('QUOTE')) actions.push('QUOTE_COMMENT');
        else if (cleaned.startsWith('SKIP')) break; // Stop planning
    }

    log.info(`Creative plan: ${actions.length > 0 ? actions.join(' → ') : 'SKIP (rest today)'}`, {
        remaining,
        planned: actions.length,
    });

    // Execute the plan
    let executed = 0;
    for (const action of actions) {
        // Re-check budget before each action
        const budgetLeft = await getDiscretionaryRemaining();
        if (budgetLeft <= 0) {
            log.info('Budget exhausted mid-session, stopping');
            break;
        }

        try {
            let success = false;
            switch (action) {
                case 'REPLY_TRENDING':
                    success = await executeReplyTrending(intelContext);
                    break;
                case 'REPLY_MENTION':
                    success = await executeReplyMention(intelContext);
                    break;
                case 'BONUS_POST':
                    success = await executeBonusPost();
                    break;
                case 'THREAD':
                    success = await executeThread();
                    break;
                case 'IMAGE_POST':
                    success = await executeImagePost();
                    break;
                case 'QUOTE_COMMENT':
                    // Quote tweet is like reply trending but with a different format
                    // For now, fall through to reply trending
                    success = await executeReplyTrending(intelContext);
                    break;
            }
            if (success) executed++;
        } catch (error) {
            log.error(`Creative action failed: ${action}`, { error: String(error) });
        }
    }

    log.info(`🎨 Creative session complete: ${executed}/${actions.length} actions executed`, {
        dailyRemaining: await getDiscretionaryRemaining(),
    });

    return executed;
}
