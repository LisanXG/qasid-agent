import { supabase } from '../supabase.js';
import { createLogger } from '../logger.js';

// ============================================================================
// QasidAI — Reply Tracker (Shared)
// Centralized reply tracking and mention state management.
// Used by creative-session, timeline-scanner, and mention-monitor.
// ============================================================================

const log = createLogger('ReplyTracker');

/**
 * Check if we already replied to a tweet.
 */
export async function hasRepliedTo(tweetId: string): Promise<boolean> {
    const { data } = await supabase
        .from('qasid_replies')
        .select('id')
        .eq('target_tweet_id', tweetId)
        .limit(1);
    return (data?.length ?? 0) > 0;
}

/**
 * Record a reply for dedup (prevents double-replies).
 */
export async function recordReply(
    targetTweetId: string,
    targetAuthor: string,
    replyTweetId: string,
    replyText: string,
    source: string,
): Promise<void> {
    const { error } = await supabase
        .from('qasid_replies')
        .insert({
            target_tweet_id: targetTweetId,
            target_author: targetAuthor,
            reply_tweet_id: replyTweetId,
            reply_text: replyText,
            search_query: source,
            replied_at: new Date().toISOString(),
        });
    if (error) {
        log.error('Failed to record reply', { error: error.message });
    }
}

/**
 * Get the last processed mention ID from Supabase (watermark).
 * This ensures we only process new mentions on each cycle.
 */
export async function getLastMentionId(): Promise<string | undefined> {
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
export async function saveLastMentionId(mentionId: string): Promise<void> {
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
