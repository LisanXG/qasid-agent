import { generate } from './llm.js';
import { generatePost, generateThread, sanitizeContent } from './content.js';
import { searchRecentTweets, replyToTweet, getMentions, postThread, postTweetWithImage, quoteTweet, type SearchResult, type MentionTweet } from '../platforms/x.js';

import { generateScrollStopper, isImageGenConfigured } from './image-gen.js';
import { gatherIntelContext } from '../data/intelligence.js';
import { getDiscretionaryRemaining, recordAction, getBudgetSummary } from './daily-budget.js';
import { hasRepliedTo, recordReply, getLastMentionId } from './reply-tracker.js';
import { createLogger } from '../logger.js';
import { sanitizeUserInput } from './sanitize-input.js';
import { getSkillsSummary } from '../skills/skill-manager.js';

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
    'AI_IMAGE — Generate an AI image with a hot take (eye-catching scroll-stopper)',
    'QUOTE_TWEET — Quote tweet an interesting post with sharp commentary',
    'ASK_QUESTION — Post a thoughtful question to spark conversation and build relationships',
    'SKIP — Save the remaining budget (no more actions this session)',
];
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

        // Draft reply via LLM (sanitize user text to prevent prompt injection)
        const result = await generate({
            prompt: `You found this tweet while browsing crypto twitter:

TWEET by @${tweet.authorUsername ?? 'unknown'}: "${sanitizeUserInput(tweet.text)}"
Likes: ${tweet.metrics?.like_count ?? 0} | Replies: ${tweet.metrics?.reply_count ?? 0}

Draft a sharp, natural reply (under 200 chars). Add value — don't just agree. Reference data from Lisan Intelligence if relevant. If this tweet isn't worth replying to, respond with just "SKIP".

MARKET CONTEXT: ${intelContext.slice(0, 300)}

Reply with ONLY the tweet text (or "SKIP"):`,
            maxTokens: 100,
            temperature: 0.9,
        });

        let reply = result.content.trim().replace(/^["']|["']$/g, '');
        if (reply.toUpperCase().startsWith('SKIP') || reply.length < 5) continue;
        reply = sanitizeContent(reply);

        // Reserve budget BEFORE posting (consistent with executeBonusPost/executeThread)
        const budgetOk = await recordAction('reply', `Reply to @${tweet.authorUsername}: ${reply.slice(0, 60)}`);
        if (!budgetOk) {
            log.warn('Budget reservation failed — skipping reply');
            continue;
        }

        const replyId = await replyToTweet(tweet.id, reply);
        if (replyId) {
            await recordReply(tweet.id, tweet.authorUsername ?? tweet.authorId, replyId, reply, 'creative-trending');
            log.info('✅ Creative reply posted', { target: tweet.id, author: tweet.authorUsername });
            return true;
        }
    }
    return false;
}

/**
 * Execute a REPLY_MENTION action.
 * NOTE: Skips founder (@lisantherealone) mentions — those are handled
 * by the dedicated VIP mention cron with a better analytical prompt.
 */
async function executeReplyMention(intelContext: string): Promise<boolean> {
    const sinceId = await getLastMentionId();
    const mentions = await getMentions(sinceId, 10);

    for (const mention of mentions) {
        // Skip founder mentions — handled by VIP cron
        if (mention.authorUsername?.toLowerCase() === 'lisantherealone') continue;

        if (await hasRepliedTo(mention.id)) continue;

        const result = await generate({
            prompt: `Someone mentioned you (@QasidAI) on X:

FROM: @${mention.authorUsername ?? 'unknown'}
TWEET: "${sanitizeUserInput(mention.text)}"

Draft a warm, genuine reply (under 500 chars — we have X Premium). Be helpful if they're asking something. Be witty if they're just chatting. If this is spam/bot, respond with just "SKIP".

MARKET CONTEXT: ${intelContext.slice(0, 300)}

Reply with ONLY the tweet text (or "SKIP"):`,
            maxTokens: 200,
            temperature: 0.85,
        });

        let reply = result.content.trim().replace(/^["']|["']$/g, '');
        if (reply.toUpperCase().startsWith('SKIP') || reply.length < 5) continue;
        reply = sanitizeContent(reply);

        // Reserve budget BEFORE posting (consistent with executeReplyTrending)
        const budgetOk = await recordAction('mention_response', `Reply to @${mention.authorUsername}: ${reply.slice(0, 60)}`);
        if (!budgetOk) {
            log.warn('Budget reservation failed — skipping mention reply');
            continue;
        }

        const replyId = await replyToTweet(mention.id, reply);
        if (replyId) {
            await recordReply(mention.id, mention.authorUsername ?? mention.authorId, replyId, reply, 'creative-mention');
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
    const { postTweet } = await import('../platforms/x.js');
    const { savePost } = await import('../engine/memory.js');

    // Reserve budget BEFORE posting
    const budgetOk = await recordAction('bonus_post', `Bonus ${post.contentType}: ${post.content.slice(0, 60)}`);
    if (!budgetOk) {
        log.warn('Budget reservation failed — skipping bonus post');
        return false;
    }

    const externalId = await postTweet(post.content);
    if (externalId) {
        await savePost(post, externalId);
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

    // Reserve budget BEFORE posting
    const budgetOk = await recordAction('thread', `${thread.contentType} thread (${thread.tweets.length} tweets): ${thread.tweets[0].slice(0, 50)}`);
    if (!budgetOk) {
        log.warn('Budget reservation failed — skipping thread');
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
        log.info('✅ Thread published', { tweets: ids.length, contentType: thread.contentType });
        return true;
    }
    return false;
}

/**
 * Execute an AI_IMAGE action.
 * Generates an AI image with a scroll-stopping hot take.
 * If Replicate isn't configured or fails, skips entirely.
 */
async function executeAiImage(): Promise<boolean> {
    if (!isImageGenConfigured()) {
        log.info('Image gen not configured — skipping AI_IMAGE');
        return false;
    }

    const scrollStopper = await generateScrollStopper();
    if (!scrollStopper) {
        log.warn('Scroll stopper generation failed');
        return false;
    }

    const budgetOk = await recordAction('bonus_post', `AI Image: ${scrollStopper.text.slice(0, 60)}`);
    if (!budgetOk) {
        log.warn('Budget reservation failed — skipping AI image');
        return false;
    }

    const tweetId = await postTweetWithImage(scrollStopper.text, scrollStopper.image.buffer, scrollStopper.image.mimeType);
    if (tweetId) {
        log.info('✅ AI image posted', { tweetId });
        return true;
    }
    return false;
}

/**
 * Execute a QUOTE_TWEET action.
 * Finds an interesting tweet and quote-tweets it with sharp commentary.
 */
async function executeQuoteTweet(intelContext: string): Promise<boolean> {
    const queries = [
        '"AI agent" crypto -is:retweet lang:en',
        '"on-chain" AI -is:retweet lang:en',
        '"autonomous agent" -is:retweet lang:en',
        'crypto marketing AI -is:retweet lang:en',
        '"win rate" trading -is:retweet lang:en',
    ];
    const query = queries[Math.floor(Math.random() * queries.length)];

    const tweets = await searchRecentTweets(query, 10);
    // Prefer tweets with some engagement but not too crowded
    const candidates = tweets.filter(t =>
        (t.metrics?.like_count ?? 0) >= 3 &&
        (t.metrics?.quote_count ?? 0) < 10
    );

    for (const tweet of candidates.slice(0, 3)) {
        if (await hasRepliedTo(tweet.id)) continue;

        const result = await generate({
            prompt: `You found this tweet while browsing crypto twitter:

TWEET by @${tweet.authorUsername ?? 'unknown'}: "${sanitizeUserInput(tweet.text)}"
Likes: ${tweet.metrics?.like_count ?? 0} | Quotes: ${tweet.metrics?.quote_count ?? 0}

Draft sharp quote tweet commentary (under 500 chars — we have X Premium). Add your own perspective — agree, disagree, expand, or offer a contrarian take. Reference Lisan Holdings' experience if relevant. If this tweet isn't worth quoting, respond with just "SKIP".

MARKET CONTEXT: ${intelContext.slice(0, 300)}

Reply with ONLY the commentary (or "SKIP"):`,
            maxTokens: 100,
            temperature: 0.9,
        });

        let commentary = result.content.trim().replace(/^["']|["']$/g, '');
        if (commentary.toUpperCase().startsWith('SKIP') || commentary.length < 5) continue;
        commentary = sanitizeContent(commentary);

        const budgetOk = await recordAction('reply', `Quote @${tweet.authorUsername}: ${commentary.slice(0, 60)}`);
        if (!budgetOk) {
            log.warn('Budget reservation failed — skipping quote tweet');
            continue;
        }

        const qtId = await quoteTweet(commentary, tweet.id);
        if (qtId) {
            await recordReply(tweet.id, tweet.authorUsername ?? tweet.authorId, qtId, commentary, 'creative-quote');
            log.info('✅ Quote tweet posted', { target: tweet.id, author: tweet.authorUsername });
            return true;
        }
    }
    return false;
}

/**
 * Execute an ASK_QUESTION action.
 * Posts a thoughtful question to spark conversation and build relationships.
 */
async function executeAskQuestion(intelContext: string): Promise<boolean> {
    const result = await generate({
        prompt: `You are QasidAI, autonomous CMO of Lisan Holdings. You want to start a conversation on crypto twitter.

Post a genuine, thought-provoking question about one of these topics:
- How AI agents are changing crypto marketing
- The future of on-chain identity and reputation for AI agents
- Whether autonomous agents should have transparent strategy weights
- The difference between "AI-powered" and truly autonomous agents
- Solo builder vs. VC-funded team dynamics in crypto
- What traders actually want from signal platforms

MARKET CONTEXT: ${intelContext.slice(0, 300)}

Rules:
- Make it a REAL question, not rhetorical
- Keep it under 500 chars (we have X Premium)
- Don't tag anyone — let the question stand on its own
- Make people want to reply
- Don't sound like a survey

Reply with ONLY the question:`,
        maxTokens: 100,
        temperature: 0.9,
    });

    let question = result.content.trim().replace(/^["']|["']$/g, '');
    question = sanitizeContent(question);
    if (question.length < 10) return false;

    const budgetOk = await recordAction('bonus_post', `Question: ${question.slice(0, 60)}`);
    if (!budgetOk) {
        log.warn('Budget reservation failed — skipping question');
        return false;
    }

    const { postTweet } = await import('../platforms/x.js');
    const tweetId = await postTweet(question);
    if (tweetId) {
        const { savePost } = await import('../engine/memory.js');
        await savePost({
            content: question,
            contentType: 'engagement_bait',
            platform: 'x',
            tone: 'curious',
            topic: 'conversation-starter',
            inputTokens: 0,
            outputTokens: 0,
            generatedAt: new Date().toISOString(),
        }, tweetId);
        log.info('✅ Question posted', { tweetId });
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
        prompt: `You are QasidAI, autonomous CMO of Lisan Holdings. You have a discretionary action budget each day (beyond your scheduled posts). You're deciding what to do right now.

CURRENT BUDGET:
${budgetSummary}

ACTIONS AVAILABLE (pick up to ${maxThisSession}):
${AVAILABLE_ACTIONS.map((a, i) => `${i + 1}. ${a}`).join('\n')}

CURRENT TIME: ${new Date().toUTCString()}

MARKET CONTEXT:
${intelContext.slice(0, 400)}

ACTIVE SKILLS:
${getSkillsSummary() || 'No learned skills yet.'}

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
        else if (cleaned.startsWith('IMAGE_P')) actions.push('AI_IMAGE');
        else if (cleaned.startsWith('AI_IMAGE') || cleaned === 'IMAGE') actions.push('AI_IMAGE');
        else if (cleaned.startsWith('QUOTE')) actions.push('QUOTE_TWEET');
        else if (cleaned.startsWith('ASK')) actions.push('ASK_QUESTION');
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

                case 'QUOTE_TWEET':
                    success = await executeQuoteTweet(intelContext);
                    break;
                case 'ASK_QUESTION':
                    success = await executeAskQuestion(intelContext);
                    break;
                case 'AI_IMAGE':
                    success = await executeAiImage();
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
