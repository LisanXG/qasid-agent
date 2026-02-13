import { generate } from './llm.js';
import { sanitizeContent } from './content.js';
import { getMentions, replyToTweet, getTweetById, type MentionTweet } from '../platforms/x.js';
import { gatherIntelContext } from '../data/intelligence.js';
import { hasRepliedTo, recordReply, getLastMentionId, saveLastMentionId } from './reply-tracker.js';
import { addKnowledge, deactivateByKeyword } from './dynamic-knowledge.js';
import { supabase } from '../supabase.js';
import { createLogger } from '../logger.js';
import { processSkillApproval, discoverSkillFromContent } from '../skills/skill-manager.js';

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

// Prompt injection sanitization — shared utility
import { sanitizeUserInput } from './sanitize-input.js';

/** Max age of a mention to consider for replies (6 hours) */
const MAX_MENTION_AGE_MS = 6 * 60 * 60 * 1000;

// ---- Tracking ----

/** In-memory set of founder mention IDs already processed this session.
 *  Prevents re-evaluating the same mentions every 15-min cron cycle. */
const processedFounderMentionIds = new Set<string>();

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

/**
 * Get recent QasidAI replies to the same author (conversation threading).
 * Returns up to 3 recent replies, newest first.
 */
async function getConversationHistory(authorUsername: string): Promise<string[]> {
    if (!authorUsername) return [];

    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(); // Last 7 days
    const { data, error } = await supabase
        .from('qasid_replies')
        .select('reply_text, replied_at')
        .ilike('target_author', authorUsername)
        .gte('replied_at', since)
        .order('replied_at', { ascending: false })
        .limit(3);

    if (error || !data) return [];
    return data.map(r => r.reply_text);
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
    // Fetch conversation history for context (prevents repetition)
    const priorReplies = await getConversationHistory(mention.authorUsername ?? '');
    const threadContext = priorReplies.length > 0
        ? `\n\nYOUR PRIOR REPLIES TO THIS USER (don't repeat yourself):\n${priorReplies.map((r, i) => `${i + 1}. "${r.slice(0, 150)}"`).join('\n')}`
        : '';
    const prompt = `Someone mentioned you (@QasidAI) on X:

FROM: @${mention.authorUsername ?? 'unknown'}
TWEET: "${sanitizeUserInput(mention.text)}"
${mention.inReplyToUserId ? '(This is a reply in a conversation thread)' : '(This is a direct mention)'}

YOUR TASK:
1. Classify this mention:
   - QUESTION: They're asking you something → respond helpfully
   - ENGAGE: They're commenting/reacting → respond engagingly  
   - SPAM/BOT: Irrelevant or automated → skip
   - SHILL: Someone promoting their own project → politely acknowledge but don't endorse

2. Detect the SENTIMENT of their message:
   - POSITIVE: They're praising, excited, or supportive → match their energy, be enthusiastic
   - NEGATIVE: They're frustrated, critical, or disappointed → be empathetic, acknowledge their point, stay constructive
   - CURIOUS: They're genuinely interested or exploring → be informative and welcoming
   - HOSTILE: They're attacking or trolling → stay calm, confident, and brief. Don't engage with hostility.
   - NEUTRAL: Factual or matter-of-fact → match their tone, be helpful

3. Draft a reply (under 500 chars — we have X Premium) that:
   - Directly addresses what they said
   - Stays in character as QasidAI (the autonomous CMO of Lisan Holdings)
   - MATCHES THE DETECTED SENTIMENT in tone (this is critical)
   - Can reference LISAN Intelligence data if they're asking about markets
   - Never sounds corporate or automated

LIVE MARKET CONTEXT (use if relevant):
${intelContext.slice(0, 400)}${threadContext}

RESPOND IN EXACTLY THIS FORMAT:
TYPE: QUESTION | ENGAGE | SPAM | SHILL
SENTIMENT: POSITIVE | NEGATIVE | CURIOUS | HOSTILE | NEUTRAL
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
            const sentimentMatch = text.match(/SENTIMENT:\s*(\w+)/i);
            log.debug('Skipping mention', {
                tweetId: mention.id,
                type: typeMatch?.[1] ?? 'unknown',
                sentiment: sentimentMatch?.[1] ?? 'unknown',
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
        reply = sanitizeContent(reply); // Full output sanitization (URL allowlist, secret detection, wallet blocking)

        // Safety: enforce X Premium limit (generous but not insane)
        if (reply.length > 2000) {
            reply = reply.slice(0, 1997) + '...';
        }

        return reply;
    } catch (error) {
        log.error('LLM mention evaluation failed', { error: String(error), tweetId: mention.id });
        return null;
    }
}

/**
 * Draft a response specifically for founder mentions.
 * When the boss tags QasidAI, it's a briefing — not casual engagement.
 * The founder is sharing intel: competing agents, tools, links, skills to evaluate.
 * QasidAI should analyze what's being shared and relate it to Lisan Holdings.
 */
async function draftFounderMentionResponse(
    mention: MentionTweet,
    intelContext: string,
    parentTweet?: { text: string; authorUsername?: string } | null,
): Promise<string | null> {
    // Build thread context section
    let threadContext = '';
    if (parentTweet) {
        threadContext = `\n\nTHE ORIGINAL POST BEING DISCUSSED (by @${parentTweet.authorUsername ?? 'unknown'}):\n"${sanitizeUserInput(parentTweet.text)}"\n\nYou were tagged in the replies to this post. Analyze BOTH the original post AND the comment above.`;
    }

    const prompt = `@lisantherealone tagged you on X. Read what he's pointing you at and respond naturally.

THE TAG:
"${sanitizeUserInput(mention.text)}"
${mention.inReplyToUserId ? '(Tagged you in someone else\'s thread)' : '(Direct tag)'}${threadContext}

You're QasidAI — CMO of Lisan Holdings. You know your stack: LISAN Intelligence signals, on-chain brain via Net Protocol, anti-slop engine.

Respond like a sharp CMO. Be concise if the situation is simple, be detailed only if the content genuinely warrants analysis. Match the energy of what's being shared:
- Quick observation? One or two sentences is fine.
- Competitive intel worth dissecting? Go deeper.
- Give a real opinion, not a book report.

Never parrot company info just to fill space. Never list our features unprompted. Never refer to anyone as "boss" or "the boss." Write like a peer giving a sharp take, not a subordinate reporting in.

${intelContext.slice(0, 300)}

Reply text only:`;

    try {
        const result = await generate({
            prompt,
            maxTokens: 400,
            temperature: 0.9,
        });

        let reply = result.content.trim();
        reply = reply.replace(/^["']|["']$/g, '');
        reply = sanitizeContent(reply); // Full output sanitization

        if (reply.length > 2000) {
            reply = reply.slice(0, 1997) + '...';
        }

        if (reply.length < 10) {
            log.warn('Founder mention reply too short, skipping');
            return null;
        }

        log.info('👑 Drafted founder mention response', {
            replyLength: reply.length,
            preview: reply.slice(0, 80),
        });

        return reply;
    } catch (error) {
        log.error('LLM founder mention response failed', { error: String(error), tweetId: mention.id });
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
        if (await hasRepliedTo(mention.id)) {
            log.debug('Already responded to mention', { tweetId: mention.id });
            continue;
        }

        // Skip stale mentions (older than 6h) — prevents re-replying when watermark is invalidated
        if (mention.createdAt) {
            const mentionAge = Date.now() - new Date(mention.createdAt).getTime();
            if (mentionAge > MAX_MENTION_AGE_MS) {
                log.debug('Skipping stale mention', { tweetId: mention.id, ageHours: (mentionAge / 3600000).toFixed(1) });
                continue;
            }
        }

        // Check if this is a founder skill approval reply
        if (mention.authorUsername?.toLowerCase() === 'lisantherealone' && (mention.inReplyToTweetId || mention.conversationId)) {
            try {
                // Prefer inReplyToTweetId (exact reply target) over conversationId (conversation root)
                const targetTweetId = mention.inReplyToTweetId ?? mention.conversationId!;
                const approval = await processSkillApproval(mention.text, targetTweetId);
                if (approval) {
                    const ack = approval.approved
                        ? `✅ Skill acquired: ${approval.skill.name}. Thanks boss, I'll put it to work.`
                        : `Got it — skipping ${approval.skill.name}. Your call. 🫡`;
                    const ackId = await replyToTweet(mention.id, ack);
                    if (ackId) {
                        await recordReply(mention.id, mention.authorUsername, ackId, ack, '@mention');
                        responded++;
                    }
                    continue;
                }
            } catch (error) {
                log.debug('Not a skill approval reply', { error: String(error) });
            }
        }

        // Skip founder mentions — handled by the dedicated VIP monitor
        // (prevents double-reply: general + VIP responding to the same tweet)
        if (mention.authorUsername?.toLowerCase() === 'lisantherealone') {
            log.debug('Skipping founder mention (handled by VIP monitor)', { tweetId: mention.id });
            continue;
        }

        // Draft a response
        const replyText = await draftMentionResponse(mention, intelContext);
        if (!replyText) continue;

        // Pre-reply dedup guard: re-check right before posting to prevent
        // race condition with founder monitor processing the same mention
        if (await hasRepliedTo(mention.id)) {
            log.debug('Mention already handled (race guard)', { tweetId: mention.id });
            continue;
        }

        // Post the reply
        log.info('Responding to mention', {
            tweetId: mention.id,
            author: mention.authorUsername,
            reply: replyText.slice(0, 80),
        });

        const replyId = await replyToTweet(mention.id, replyText);

        if (replyId) {
            await recordReply(
                mention.id,
                mention.authorUsername ?? mention.authorId,
                replyId,
                replyText,
                '@mention',
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

// ---- Founder VIP Mention Check ----

/** Founder's X handle — always gets a reply, prioritized over general mentions */
const FOUNDER_HANDLE = 'lisantherealone';

/** Safety cap: max founder replies per 24h (generous but bounded) */
const MAX_FOUNDER_REPLIES_PER_DAY = 20;

/**
 * Count founder VIP replies in the last 24h (safety limit).
 */
async function getFounderRepliesLast24h(): Promise<number> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
        .from('qasid_replies')
        .select('id')
        .eq('search_query', 'founder_vip')
        .gte('replied_at', since);

    if (error) {
        log.warn('Failed to count founder replies', { error: error.message });
        return MAX_FOUNDER_REPLIES_PER_DAY; // Fail safe: assume at limit
    }
    return data?.length ?? 0;
}

/**
 * Check for and reply to founder (@lisantherealone) mentions.
 * This runs on its own cron (every 15 min) and is prioritized:
 * - Separate daily cap (generous but bounded for safety)
 * - Always replies with contextual, substantive content
 *
 * Unlike the general monitor, this does NOT use the watermark.
 * It always scans the 50 most recent mentions and lets hasRespondedTo
 * handle dedup. This means if a bad reply is deleted from X and its
 * Supabase record is cleared, Qasid will re-reply on the next cycle.
 *
 * Returns the number of replies posted.
 */
export async function runFounderMentionCheck(): Promise<number> {
    // Safety check: daily limit even for founder replies
    const founderRepliesCount = await getFounderRepliesLast24h();
    if (founderRepliesCount >= MAX_FOUNDER_REPLIES_PER_DAY) {
        log.warn(`🛑 Founder reply safety cap reached (${founderRepliesCount}/${MAX_FOUNDER_REPLIES_PER_DAY}), skipping`);
        return 0;
    }

    // Always fetch recent mentions WITHOUT watermark — scan a wide window
    // so we never miss a founder tag, even older ones
    const mentions = await getMentions(undefined, 50);
    if (mentions.length === 0) return 0;

    // Filter to founder only
    const founderMentions = mentions.filter(
        m => m.authorUsername?.toLowerCase() === FOUNDER_HANDLE,
    );

    if (founderMentions.length === 0) return 0;

    log.info(`👑 Found ${founderMentions.length} founder mention(s) to check`);

    // Fetch intel context once for all replies
    const intelContext = await gatherIntelContext();

    let replied = 0;

    for (const mention of founderMentions) {
        // Skip if already processed this session (saves DB + LLM calls)
        if (processedFounderMentionIds.has(mention.id)) continue;

        // Skip if already responded (check Supabase)
        if (await hasRepliedTo(mention.id)) {
            processedFounderMentionIds.add(mention.id); // Don't check again
            continue;
        }

        // Skip stale mentions (older than 6h) — prevents re-replying after tweet cleanup
        if (mention.createdAt) {
            const mentionAge = Date.now() - new Date(mention.createdAt).getTime();
            if (mentionAge > MAX_MENTION_AGE_MS) {
                processedFounderMentionIds.add(mention.id); // Don't check again
                log.debug('Skipping stale founder mention', { tweetId: mention.id, ageHours: (mentionAge / 3600000).toFixed(1) });
                continue;
            }
        }

        // Check if this is a skill approval first
        if (mention.conversationId) {
            try {
                const approval = await processSkillApproval(mention.text, mention.conversationId);
                if (approval) {
                    const ack = approval.approved
                        ? `✅ Skill acquired: ${approval.skill.name}. Thanks boss, I'll put it to work.`
                        : `Got it — skipping ${approval.skill.name}. Your call. 🫡`;
                    const ackId = await replyToTweet(mention.id, ack);
                    if (ackId) {
                        await recordReply(mention.id, FOUNDER_HANDLE, ackId, ack, 'founder_vip');
                        replied++;
                    }
                    continue;
                }
            } catch {
                // Not a skill approval — continue to normal reply
            }
        }

        // Check if this is a knowledge instruction (remember/update/forget)
        const instructionMatch = mention.text.match(
            /@\w+\s+(remember|update|forget)\s*:\s*(.+)/is,
        );
        if (instructionMatch) {
            const command = instructionMatch[1].toLowerCase() as 'remember' | 'update' | 'forget';
            const payload = sanitizeUserInput(instructionMatch[2].trim(), 500);

            let ack: string;
            if (command === 'forget') {
                const count = await deactivateByKeyword(payload);
                ack = count > 0
                    ? `Wiped ${count} fact(s) matching "${payload.slice(0, 30)}". Moving on. 🫡`
                    : `Nothing matching "${payload.slice(0, 30)}" in memory. We're clean.`;
            } else {
                // remember or update — store the fact
                const stored = await addKnowledge(payload, 'founder_instruction',
                    `https://x.com/${FOUNDER_HANDLE}/status/${mention.id}`);
                ack = stored
                    ? `Got it, boss. I'll remember that. 🧠`
                    : `Already knew that one. We're good. 🫡`;
            }

            const ackId = await replyToTweet(mention.id, ack);
            if (ackId) {
                await recordReply(mention.id, FOUNDER_HANDLE, ackId, ack, 'founder_vip');
                processedFounderMentionIds.add(mention.id);
                replied++;
                log.info('👑 Processed founder instruction', { command, payload: payload.slice(0, 80) });
            }
            continue;
        }

        // Draft a contextual response (founder-specific analytical prompt)
        // Fetch parent tweet context if this is a thread tag
        let parentTweet: { text: string; authorUsername?: string } | null = null;
        if (mention.conversationId && mention.conversationId !== mention.id) {
            parentTweet = await getTweetById(mention.conversationId);
            if (parentTweet) {
                log.info('👑 Fetched parent tweet context', {
                    parentAuthor: parentTweet.authorUsername,
                    parentPreview: parentTweet.text.slice(0, 80),
                });
            }
        }

        const replyText = await draftFounderMentionResponse(mention, intelContext, parentTweet);
        if (!replyText) continue;

        // Pre-reply dedup guard: re-check right before posting to prevent
        // race condition with general monitor processing the same mention
        if (await hasRepliedTo(mention.id)) {
            processedFounderMentionIds.add(mention.id);
            log.debug('Founder mention already handled (race guard)', { tweetId: mention.id });
            continue;
        }

        // Post the reply
        const replyId = await replyToTweet(mention.id, replyText);

        if (replyId) {
            await recordReply(mention.id, FOUNDER_HANDLE, replyId, replyText, 'founder_vip');
            processedFounderMentionIds.add(mention.id);
            replied++;
            log.info('👑 Replied to founder mention', {
                replyId,
                targetMention: mention.id,
                reply: replyText.slice(0, 80),
            });

            // After replying, evaluate if this content contains a learnable skill
            // The LLM will return null for casual questions/chats — only proposes
            // skills when it genuinely identifies a reusable pattern
            const skillContent = parentTweet
                ? `${mention.text}\n\nOriginal post by @${parentTweet.authorUsername}: ${parentTweet.text}`
                : mention.text;
            const discovered = await discoverSkillFromContent(skillContent, 'founder_tag');
            if (discovered) {
                log.info('🧠 Skill discovered from founder tag', {
                    skill: discovered.name,
                    category: discovered.category,
                });
            }
        }
    }

    // NOTE: Founder check does NOT update the watermark.
    // The general mention monitor manages its own watermark independently.

    return replied;
}
