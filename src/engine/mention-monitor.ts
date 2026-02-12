import { generate } from './llm.js';
import { getMentions, replyToTweet, type MentionTweet } from '../platforms/x.js';
import { gatherIntelContext } from '../data/intelligence.js';
import { supabase } from '../supabase.js';
import { createLogger } from '../logger.js';
import { processSkillApproval } from '../skills/skill-manager.js';

// ============================================================================
// QasidAI — Mention & Reply Monitor
// Watches for @mentions and replies to QasidAI's posts, then responds via LLM
// Unlike timeline scanner, these are DIRECT interactions that deserve a reply
// ============================================================================

const log = createLogger('MentionMonitor');

// ---- Configuration ----

/** Max responses per monitor cycle */
const MAX_RESPONSES_PER_CYCLE = 5;

/** Max responses per 24h window (safety rail) */
const MAX_RESPONSES_PER_DAY = 15;

// ---- Tracking ----

/**
 * Get the last processed mention ID from Supabase (watermark).
 * This ensures we only process new mentions on each cycle.
 */
async function getLastMentionId(): Promise<string | undefined> {
    const { data } = await supabase
        .from('qasid_mention_state')
        .select('last_mention_id')
        .eq('id', 'current')
        .single();
    return data?.last_mention_id ?? undefined;
}

/**
 * Save the last processed mention ID (watermark).
 */
async function saveLastMentionId(mentionId: string): Promise<void> {
    const { error } = await supabase
        .from('qasid_mention_state')
        .upsert({
            id: 'current',
            last_mention_id: mentionId,
            updated_at: new Date().toISOString(),
        });
    if (error) {
        log.error('Failed to save mention watermark', { error: error.message });
    }
}

/**
 * Check if we already responded to this mention.
 */
async function hasRespondedTo(tweetId: string): Promise<boolean> {
    const { data } = await supabase
        .from('qasid_replies')
        .select('id')
        .eq('target_tweet_id', tweetId)
        .limit(1);
    return (data?.length ?? 0) > 0;
}

/**
 * Record a mention response (reuses the qasid_replies table).
 */
async function recordMentionResponse(
    targetTweetId: string,
    targetAuthor: string,
    replyTweetId: string,
    replyText: string,
): Promise<void> {
    const { error } = await supabase
        .from('qasid_replies')
        .insert({
            target_tweet_id: targetTweetId,
            target_author: targetAuthor,
            reply_tweet_id: replyTweetId,
            reply_text: replyText,
            search_query: '@mention', // Tag as mention-sourced
            replied_at: new Date().toISOString(),
        });
    if (error) {
        log.error('Failed to record mention response', { error: error.message });
    }
}

/**
 * Count mention responses in the last 24h (safety limit).
 */
async function getMentionResponsesLast24h(): Promise<number> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
        .from('qasid_replies')
        .select('id')
        .eq('search_query', '@mention')
        .gte('replied_at', since);

    if (error) {
        log.warn('Failed to count recent mention responses', { error: error.message });
        return MAX_RESPONSES_PER_DAY; // Fail safe
    }
    return data?.length ?? 0;
}

// ---- LLM Response Generation ----

/**
 * Classify the mention and draft a contextual reply.
 * Returns null if the mention doesn't deserve a response (spam, bot, etc.).
 */
async function draftMentionResponse(
    mention: MentionTweet,
    intelContext: string,
): Promise<string | null> {
    const prompt = `Someone mentioned you (@QasidAI) on X:

FROM: @${mention.authorUsername ?? 'unknown'}
TWEET: "${mention.text}"
${mention.inReplyToUserId ? '(This is a reply in a conversation thread)' : '(This is a direct mention)'}

YOUR TASK:
1. Classify this mention:
   - QUESTION: They're asking you something → respond helpfully
   - ENGAGE: They're commenting/reacting → respond engagingly  
   - SPAM/BOT: Irrelevant or automated → skip
   - SHILL: Someone promoting their own project → politely acknowledge but don't endorse
2. Draft a reply (under 250 chars) that:
   - Directly addresses what they said
   - Stays in character as QasidAI (the autonomous CMO of Lisan Holdings)
   - Is warm, witty, and genuine
   - Can reference LISAN Intelligence data if they're asking about markets
   - Never sounds corporate or automated

LIVE MARKET CONTEXT (use if relevant):
${intelContext.slice(0, 400)}

RESPOND IN EXACTLY THIS FORMAT:
TYPE: QUESTION | ENGAGE | SPAM | SHILL
VERDICT: REPLY or SKIP
REPLY: [your reply text, or "none"]`;

    try {
        const result = await generate({
            prompt,
            maxTokens: 200,
            temperature: 0.85,
        });

        const text = result.content.trim();

        // Parse structured response
        const verdictMatch = text.match(/VERDICT:\s*(REPLY|SKIP)/i);
        if (!verdictMatch || verdictMatch[1].toUpperCase() === 'SKIP') {
            const typeMatch = text.match(/TYPE:\s*(\w+)/i);
            log.debug('Skipping mention', {
                tweetId: mention.id,
                type: typeMatch?.[1] ?? 'unknown',
                author: mention.authorUsername,
            });
            return null;
        }

        const replyMatch = text.match(/REPLY:\s*(.+)/is);
        if (!replyMatch || replyMatch[1].trim().toLowerCase() === 'none') {
            return null;
        }

        let reply = replyMatch[1].trim();
        reply = reply.replace(/^["']|["']$/g, ''); // Strip wrapping quotes

        // Safety: enforce 280 char limit
        if (reply.length > 280) {
            reply = reply.slice(0, 277) + '...';
        }

        return reply;
    } catch (error) {
        log.error('LLM mention evaluation failed', { error: String(error), tweetId: mention.id });
        return null;
    }
}

// ---- Main Monitor ----

/**
 * Run a mention monitoring cycle.
 * 1. Fetch new mentions since last watermark
 * 2. Filter out already-responded and spam
 * 3. Draft LLM responses
 * 4. Reply to each mention
 * 5. Update watermark
 *
 * Returns the number of responses posted.
 */
export async function runMentionMonitor(): Promise<number> {
    log.info('Starting mention monitor cycle...');

    // Safety check: daily limit
    const recentCount = await getMentionResponsesLast24h();
    if (recentCount >= MAX_RESPONSES_PER_DAY) {
        log.info(`Daily mention response limit reached (${recentCount}/${MAX_RESPONSES_PER_DAY}), skipping`);
        return 0;
    }

    const remainingBudget = Math.min(
        MAX_RESPONSES_PER_CYCLE,
        MAX_RESPONSES_PER_DAY - recentCount,
    );

    // Get watermark (last processed mention ID)
    const sinceId = await getLastMentionId();

    // Fetch new mentions
    const mentions = await getMentions(sinceId, 20);

    if (mentions.length === 0) {
        log.info('No new mentions to process');
        return 0;
    }

    log.info(`Found ${mentions.length} new mentions`);

    // Fetch intel context once for all evaluations
    const intelContext = await gatherIntelContext();

    let responded = 0;
    let highestId = sinceId;

    for (const mention of mentions) {
        if (responded >= remainingBudget) break;

        // Track highest ID for watermark
        if (!highestId || mention.id > highestId) {
            highestId = mention.id;
        }

        // Skip if already responded
        if (await hasRespondedTo(mention.id)) {
            log.debug('Already responded to mention', { tweetId: mention.id });
            continue;
        }

        // Check if this is a founder skill approval reply
        if (mention.authorUsername?.toLowerCase() === 'lisantheresa' && mention.conversationId) {
            try {
                const approval = await processSkillApproval(mention.text, mention.conversationId);
                if (approval) {
                    const ack = approval.approved
                        ? `✅ Skill acquired: ${approval.skill.name}. Thanks boss, I'll put it to work.`
                        : `Got it — skipping ${approval.skill.name}. Your call. 🫡`;
                    const ackId = await replyToTweet(mention.id, ack);
                    if (ackId) {
                        await recordMentionResponse(mention.id, mention.authorUsername, ackId, ack);
                        responded++;
                    }
                    continue;
                }
            } catch (error) {
                log.debug('Not a skill approval reply', { error: String(error) });
            }
        }

        // Draft a response
        const replyText = await draftMentionResponse(mention, intelContext);
        if (!replyText) continue;

        // Post the reply
        log.info('Responding to mention', {
            tweetId: mention.id,
            author: mention.authorUsername,
            reply: replyText.slice(0, 80),
        });

        const replyId = await replyToTweet(mention.id, replyText);

        if (replyId) {
            await recordMentionResponse(
                mention.id,
                mention.authorUsername ?? mention.authorId,
                replyId,
                replyText,
            );
            responded++;
            log.info('✅ Mention response posted', {
                replyId,
                targetMention: mention.id,
                author: mention.authorUsername,
            });
        }
    }

    // Update watermark to newest mention
    if (highestId && highestId !== sinceId) {
        await saveLastMentionId(highestId);
        log.debug('Updated mention watermark', { sinceId: highestId });
    }

    log.info(`Mention monitor complete: ${responded}/${mentions.length} mentions responded to`, {
        dailyTotal: recentCount + responded,
    });

    return responded;
}
