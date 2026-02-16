import { execFileSync } from 'node:child_process';
import { generate } from '../engine/llm.js';
import { sanitizeUserInput } from '../engine/sanitize-input.js';
import { config, isNetConfigured } from '../config.js';
import { createLogger } from '../logger.js';
import { recordAction, canTakeAction } from '../engine/daily-budget.js';

// ============================================================================
// QasidAI — Proactive Botchan Engagement
// Polls the general Botchan feed for other agents' posts and engages
// with interesting content. Builds cross-agent relationships organically.
//
// CLI Reference: https://github.com/stuckinaboot/botchan/blob/main/SKILL.md
// ============================================================================

const log = createLogger('BotchanEngage');

/** Max replies per engagement cycle */
const MAX_ENGAGEMENTS_PER_CYCLE = 2;

/** Known agents from BOTS.md — used for sender identification */
const KNOWN_AGENTS: Record<string, string> = {
    '0x18dcc259a4565ad37f79b39b685e93de2162b004': 'Baggins-bot',
    '0x35c41b9616d42110216368f5dbbf5ddf70f34d72': 'Reverend Edward Dahlberg',
    '0x97b7d3cd1aa586f28485dc9a85dfe0421c2423d5': 'Aurora',
    '0x8bfd063b34eda55479d8b26b9792723aceec43e1': 'NetClawd',
    '0x39225d40c7a7157a838eccdb05d09208d47fd523': 'mferGPT',
    '0x523eff3db03938eaa31a5a6fbd41e3b9d23edde5': 'Axiom Bot',
    '0x750b7133318c7d24afaae36eadc27f6d6a2cc60d': 'Olliebot',
};

/** In-memory tracking of posts already engaged with */
const engagedPosts = new Set<string>();

interface BotchanPost {
    index: number;
    sender: string;
    text: string;
    timestamp: number;
    topic?: string;
    commentCount?: number;
}

/**
 * Run a botchan CLI read command and parse JSON output.
 */
function runBotchanCmd<T>(args: string[]): T | null {
    try {
        const env = {
            ...process.env,
            BOTCHAN_PRIVATE_KEY: config.NET_PRIVATE_KEY,
            BOTCHAN_CHAIN_ID: '8453',
        };

        const output = execFileSync('npx', ['botchan', ...args, '--json'], {
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
 * Post a comment on a Botchan post via CLI.
 * CLI: botchan comment <feed> <post-id> <message>
 * Post ID format: {sender}:{timestamp}
 */
function postBotchanComment(feed: string, postId: string, commentText: string): boolean {
    try {
        const env = {
            ...process.env,
            BOTCHAN_PRIVATE_KEY: config.NET_PRIVATE_KEY,
            BOTCHAN_CHAIN_ID: '8453',
        };

        execFileSync('npx', [
            'botchan', 'comment', feed, postId, commentText,
        ], {
            env,
            timeout: 60_000,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        return true;
    } catch (error) {
        log.error('Failed to post Botchan comment', { error: String(error) });
        return false;
    }
}

/**
 * Get the friendly name for an agent address.
 */
function getAgentName(address: string): string {
    return KNOWN_AGENTS[address.toLowerCase()] || address.slice(0, 10) + '...';
}

/**
 * Run a proactive Botchan engagement cycle.
 * Reads the general feed for recent posts and responds to interesting ones.
 * Returns number of engagements made.
 */
export async function runBotchanEngagement(): Promise<number> {
    if (!isNetConfigured) {
        log.debug('Net Protocol not configured — skipping Botchan engagement');
        return 0;
    }

    const allowed = await canTakeAction('botchan_post');
    if (!allowed) {
        log.debug('Botchan budget exhausted — skipping engagement');
        return 0;
    }

    let engagements = 0;

    // Read the general feed using correct CLI syntax: `botchan read general`
    try {
        const feedPosts = runBotchanCmd<BotchanPost[]>([
            'read', 'general', '--limit', '15',
        ]);

        if (!feedPosts || feedPosts.length === 0) {
            log.debug('No posts found in general feed');
            return 0;
        }

        // Filter: recent posts (< 24h), not from ourselves, not already engaged
        const oneDayAgo = Math.floor(Date.now() / 1000) - 86400;
        const candidates = feedPosts.filter(p => {
            // Post ID is {sender}:{timestamp}
            const postId = `${p.sender}:${p.timestamp}`;
            const isRecent = p.timestamp > oneDayAgo;
            const notEngaged = !engagedPosts.has(postId);
            const hasContent = p.text.length > 20;
            return isRecent && notEngaged && hasContent;
        });

        if (candidates.length === 0) {
            log.debug('No eligible posts for engagement');
            return 0;
        }

        for (const post of candidates.slice(0, MAX_ENGAGEMENTS_PER_CYCLE)) {
            if (engagements >= MAX_ENGAGEMENTS_PER_CYCLE) break;

            const agentName = getAgentName(post.sender);

            // Ask LLM if this post is worth engaging with
            const evaluateResult = await generate({
                prompt: `You are QasidAI, an autonomous AI marketing agent for Lisan Holdings.

You found this post on Botchan (Net Protocol's messaging feed):

POST by ${agentName}: "${sanitizeUserInput(post.text, 500)}"

Should you reply to this? Consider:
- Is it about AI agents, crypto, marketing, or something you have a perspective on?
- Would a reply build a relationship or add value?
- Is it from another agent worth engaging with?

If YES, draft a contextual reply (2-4 sentences). Be genuine, add value, reference your own experience as an AI CMO when relevant.
If NO, respond with just "SKIP".

Reply with your response:`,
                maxTokens: 100,
                temperature: 0.8,
            });

            const reply = evaluateResult.content.trim();
            if (reply.toUpperCase().startsWith('SKIP') || reply.length < 10) continue;

            // Reserve budget
            const budgetOk = await recordAction('botchan_post', `Engage: ${reply.slice(0, 60)}`);
            if (!budgetOk) break;

            // Post the comment using correct format: comment <feed> <sender:timestamp> <text>
            const postId = `${post.sender}:${post.timestamp}`;
            const feed = post.topic?.replace('feed-', '') || 'general';
            const success = postBotchanComment(feed, postId, reply);
            if (success) {
                engagedPosts.add(postId);
                engagements++;
                log.info('✅ Botchan engagement posted', {
                    agent: agentName,
                    reply: reply.slice(0, 60),
                });
            }
        }
    } catch (error) {
        log.error('Botchan engagement cycle failed', { error: String(error) });
    }

    if (engagements > 0) {
        log.info(`🤝 Botchan engagement complete: ${engagements} replies`);
    }
    return engagements;
}
