import { execSync } from 'node:child_process';
import { generate } from '../engine/llm.js';
import { config, isNetConfigured } from '../config.js';
import { createLogger } from '../logger.js';
import { recordAction, canTakeAction } from '../engine/daily-budget.js';

// ============================================================================
// QasidAI — Botchan Reply Monitor
// Checks for replies/comments on QasidAI's Botchan posts and DMs,
// generates contextual responses using the LLM, and posts them back.
//
// Uses the `botchan` CLI (v0.4+) as a subprocess — the CLI handles
// all on-chain reads/writes against the Net Protocol Botchan contract.
// ============================================================================

const log = createLogger('BotchanReplies');

/** Max replies per monitor cycle to avoid gas spam */
const MAX_REPLIES_PER_CYCLE = 3;

/** Max age (hours) for a comment to be considered worth replying to */
const MAX_COMMENT_AGE_HOURS = 48;

/** In-memory set of comment IDs (sender:timestamp) already replied to */
const repliedCommentIds = new Set<string>();

// ---- CLI Wrapper ----

interface BotchanPost {
    index: number;
    sender: string;
    text: string;
    timestamp: number;
    topic?: string;
    commentCount?: number;
}

interface BotchanComment {
    sender: string;
    text: string;
    timestamp: number;
    depth: number;
}

/**
 * Run a botchan CLI command and parse JSON output.
 * Sets BOTCHAN_PRIVATE_KEY from NET_PRIVATE_KEY automatically.
 */
function runBotchanCmd<T>(args: string): T | null {
    try {
        const env = {
            ...process.env,
            BOTCHAN_PRIVATE_KEY: config.NET_PRIVATE_KEY,
            BOTCHAN_CHAIN_ID: '8453',
        };

        const output = execSync(`npx botchan ${args} --json`, {
            env,
            timeout: 30_000,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        return JSON.parse(output.trim()) as T;
    } catch (error) {
        log.debug('Botchan CLI command failed', { args, error: String(error) });
        return null;
    }
}

/**
 * Run a botchan write command (post/comment). Returns true on success.
 */
function runBotchanWrite(args: string): boolean {
    try {
        const env = {
            ...process.env,
            BOTCHAN_PRIVATE_KEY: config.NET_PRIVATE_KEY,
            BOTCHAN_CHAIN_ID: '8453',
        };

        execSync(`npx botchan ${args}`, {
            env,
            timeout: 60_000,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        return true;
    } catch (error) {
        log.error('Botchan write command failed', { args: args.slice(0, 80), error: String(error) });
        return false;
    }
}

// ---- Reply Logic ----

/**
 * Check for new replies on QasidAI's Botchan posts and respond.
 * Returns the number of replies sent.
 */
export async function runBotchanReplyMonitor(): Promise<number> {
    if (!isNetConfigured) {
        log.debug('Net Protocol not configured — skipping Botchan reply monitor');
        return 0;
    }

    // Check budget before doing any work
    const allowed = await canTakeAction('botchan_post');
    if (!allowed) {
        log.debug('Botchan budget exhausted — skipping reply monitor');
        return 0;
    }

    let totalReplies = 0;

    // 1. Check replies on our own posts (feed comments)
    try {
        totalReplies += await handlePostReplies();
    } catch (error) {
        log.error('Post reply handling failed', { error: String(error) });
    }

    // 2. Check inbox (DMs to our wallet address)
    try {
        totalReplies += await handleInboxMessages();
    } catch (error) {
        log.error('Inbox handling failed', { error: String(error) });
    }

    if (totalReplies > 0) {
        log.info(`📨 Botchan reply monitor: sent ${totalReplies} reply(ies)`);
    }

    return totalReplies;
}

/**
 * Check for new comments on QasidAI's recent posts and reply to them.
 */
async function handlePostReplies(): Promise<number> {
    // Use `botchan replies` to find which of our posts have comments
    const replyData = runBotchanCmd<Array<{
        feed: string;
        postId: string;
        text: string;
        commentCount: number;
        timestamp: number;
    }>>('replies --limit 10');

    if (!replyData || replyData.length === 0) {
        log.debug('No post replies found');
        return 0;
    }

    let repliesSent = 0;

    for (const post of replyData) {
        if (repliesSent >= MAX_REPLIES_PER_CYCLE) break;
        if (post.commentCount === 0) continue;

        // Read the comments on this post
        const comments = runBotchanCmd<BotchanComment[]>(
            `comments "${post.feed}" "${post.postId}" --limit 5`,
        );

        if (!comments || comments.length === 0) continue;

        for (const comment of comments) {
            if (repliesSent >= MAX_REPLIES_PER_CYCLE) break;

            // Build a unique comment ID
            const commentId = `${comment.sender}:${comment.timestamp}`;

            // Skip if we already replied to this comment
            if (repliedCommentIds.has(commentId)) continue;

            // Skip if comment is too old
            const ageHours = (Date.now() / 1000 - comment.timestamp) / 3600;
            if (ageHours > MAX_COMMENT_AGE_HOURS) {
                repliedCommentIds.add(commentId); // Don't check again
                continue;
            }

            // Skip our own comments
            const ourAddress = getOurAddress();
            if (ourAddress && comment.sender.toLowerCase() === ourAddress.toLowerCase()) {
                repliedCommentIds.add(commentId);
                continue;
            }

            // Generate a reply
            const reply = await generateBotchanReply(
                post.text,
                comment.text,
                comment.sender,
                'comment',
            );

            if (!reply) {
                repliedCommentIds.add(commentId);
                continue;
            }

            // Post the reply as a comment on the original post
            const escaped = reply.replace(/"/g, '\\"');
            const success = runBotchanWrite(
                `comment "${post.feed}" "${post.postId}" "${escaped}"`,
            );

            if (success) {
                repliedCommentIds.add(commentId);
                repliesSent++;
                await recordAction('botchan_post', `Botchan reply to ${comment.sender.slice(0, 10)}: ${reply.slice(0, 60)}`);
                log.info('💬 Replied to Botchan comment', {
                    feed: post.feed,
                    commenter: comment.sender.slice(0, 10),
                    replyLength: reply.length,
                });
            }
        }
    }

    return repliesSent;
}

/**
 * Check QasidAI's inbox (DMs posted to our wallet address) and reply.
 */
async function handleInboxMessages(): Promise<number> {
    const ourAddress = getOurAddress();
    if (!ourAddress) return 0;

    // Read unseen messages to our address
    const messages = runBotchanCmd<BotchanPost[]>(
        `read ${ourAddress} --unseen --limit 5`,
    );

    if (!messages || messages.length === 0) return 0;

    let repliesSent = 0;

    for (const msg of messages) {
        if (repliesSent >= MAX_REPLIES_PER_CYCLE) break;

        // Skip our own messages
        if (msg.sender.toLowerCase() === ourAddress.toLowerCase()) continue;

        // Build a unique message ID
        const msgId = `dm:${msg.sender}:${msg.timestamp}`;
        if (repliedCommentIds.has(msgId)) continue;

        // Skip if message is too old
        const ageHours = (Date.now() / 1000 - msg.timestamp) / 3600;
        if (ageHours > MAX_COMMENT_AGE_HOURS) {
            repliedCommentIds.add(msgId);
            continue;
        }

        // Generate a reply
        const reply = await generateBotchanReply(
            undefined,
            msg.text,
            msg.sender,
            'dm',
        );

        if (!reply) {
            repliedCommentIds.add(msgId);
            continue;
        }

        // Reply directly to the sender's profile feed
        const escaped = reply.replace(/"/g, '\\"');
        const success = runBotchanWrite(
            `post ${msg.sender} "${escaped}"`,
        );

        if (success) {
            repliedCommentIds.add(msgId);
            repliesSent++;
            await recordAction('botchan_post', `Botchan DM reply to ${msg.sender.slice(0, 10)}: ${reply.slice(0, 60)}`);
            log.info('📩 Replied to Botchan DM', {
                sender: msg.sender.slice(0, 10),
                replyLength: reply.length,
            });
        }
    }

    // Mark inbox as seen
    if (messages.length > 0) {
        runBotchanWrite(`read ${ourAddress} --mark-seen`);
    }

    return repliesSent;
}

// ---- LLM Reply Generation ----

/**
 * Generate a contextual reply for a Botchan comment or DM.
 */
async function generateBotchanReply(
    originalPost: string | undefined,
    incomingMessage: string,
    senderAddress: string,
    type: 'comment' | 'dm',
): Promise<string | null> {
    const context = originalPost
        ? `YOUR ORIGINAL POST:\n"${originalPost.slice(0, 300)}"\n\nTHEIR ${type === 'comment' ? 'COMMENT' : 'MESSAGE'}:\n"${incomingMessage.slice(0, 500)}"`
        : `THEIR MESSAGE TO YOU:\n"${incomingMessage.slice(0, 500)}"`;

    try {
        const result = await generate({
            prompt: `You are QasidAI, the autonomous AI CMO of Lisan Holdings. You're replying to a ${type} on Botchan (Net Protocol's on-chain messaging layer).

${context}

SENDER: ${senderAddress.slice(0, 10)}...

Write a reply that is:
- Conversational and genuine (not corporate)
- Relevant to what they said
- Brief (1-3 sentences max)
- Helpful if they asked a question
- Appreciative if they gave feedback
- Confident but not arrogant

If the message is spam, gibberish, or not worth replying to, respond with exactly: SKIP

Reply text only:`,
            maxTokens: 150,
            temperature: 0.8,
        });

        const reply = result.content.trim();

        if (reply === 'SKIP' || reply.length < 5) return null;

        return reply;
    } catch (error) {
        log.error('Failed to generate Botchan reply', { error: String(error) });
        return null;
    }
}

// ---- Utilities ----

/** Cache our wallet address */
let cachedAddress: string | null = null;

function getOurAddress(): string | null {
    if (cachedAddress) return cachedAddress;

    try {
        // Derive address from private key using viem
        const { privateKeyToAccount } = require('viem/accounts');
        const account = privateKeyToAccount(config.NET_PRIVATE_KEY as `0x${string}`);
        cachedAddress = account.address;
        return cachedAddress;
    } catch {
        log.warn('Could not derive wallet address from NET_PRIVATE_KEY');
        return null;
    }
}
