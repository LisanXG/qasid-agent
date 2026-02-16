import { postTweet } from '../platforms/x.js';
import { sanitizeContent } from '../engine/content.js';
import { postToFeed } from './client.js';
import { isNetConfigured } from '../config.js';
import { createLogger } from '../logger.js';

// ============================================================================
// QasidAI — Cross-Platform Narrative Flywheel
// Links content between X and Botchan for cohesive multi-platform presence.
// After posting a thread/article on X → teaser on Botchan
// After posting a deep dive on Botchan → teaser on X
// ============================================================================

const log = createLogger('CrossPlatform');

/**
 * After posting a thread on X, share a summary on Botchan.
 * @param threadContent Array of tweets in the thread
 * @param tweetIds IDs of the posted tweets
 */
export async function crossPostThreadToBotchan(
    threadContent: string[],
    tweetIds: string[],
): Promise<void> {
    if (!isNetConfigured) return;

    try {
        const firstTweetUrl = tweetIds.length > 0
            ? `https://x.com/QasidAI_/status/${tweetIds[0]}`
            : null;

        const summary = threadContent
            .map((t, i) => `${i + 1}/${threadContent.length} ${t}`)
            .join('\n\n');

        const botchanPost = firstTweetUrl
            ? `📎 New thread on X:\n\n${summary}\n\nFull thread: ${firstTweetUrl}`
            : `📎 Thread summary:\n\n${summary}`;

        await postToFeed(botchanPost, 'agent-finance');
        log.info('🔗 Thread cross-posted to Botchan');
    } catch (error) {
        log.warn('Failed to cross-post thread to Botchan', { error: String(error) });
    }
}

/**
 * After posting a deep dive on Botchan, tease it on X.
 * @param botchanText The full Botchan post text
 * @param topic The Botchan topic/channel
 */
export async function crossPostBotchanToX(
    botchanText: string,
    topic: string,
): Promise<void> {
    try {
        // Create a short teaser for X (under 280 chars)
        const firstSentence = botchanText.split(/[.!?]\s/)[0];
        const teaser = firstSentence.length > 200
            ? firstSentence.slice(0, 200) + '...'
            : firstSentence + '.';

        const tweetText = sanitizeContent(`${teaser}\n\nFull analysis on my Botchan feed — on-chain, permanent, verifiable. 🧠`);

        if (tweetText && tweetText.length <= 500) {
            await postTweet(tweetText);
            log.info('🔗 Botchan post teased on X', { topic });
        }
    } catch (error) {
        log.warn('Failed to cross-post Botchan teaser to X', { error: String(error) });
    }
}

/** In-memory dedup for cross-posts (resets on restart — acceptable for daily tracking) */
const crossPostedHashes = new Set<string>();

/**
 * Check if a piece of content has already been cross-posted (dedup).
 */
export function hasBeenCrossPosted(contentHash: string): boolean {
    return crossPostedHashes.has(contentHash);
}

/**
 * Record a cross-post to prevent duplication.
 */
export function recordCrossPost(contentHash: string): void {
    crossPostedHashes.add(contentHash);
    // Keep Set bounded — remove oldest if too large
    if (crossPostedHashes.size > 100) {
        const first = crossPostedHashes.values().next().value;
        if (first) crossPostedHashes.delete(first);
    }
}
