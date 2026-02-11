import { supabase } from '../supabase.js';
import { createLogger } from '../logger.js';

// ============================================================================
// QasidAI — Performance Tracker
// Tracks engagement metrics for posted content
// ============================================================================

const log = createLogger('Tracker');

export interface EngagementUpdate {
    postId: string;
    reactions?: number;
    replies?: number;
    linkClicks?: number;
}

/**
 * Update engagement metrics for a post.
 */
export async function updatePostMetrics(update: EngagementUpdate): Promise<void> {
    const { postId, reactions, replies, linkClicks } = update;

    const updateData: Record<string, unknown> = {};
    if (reactions !== undefined) updateData.reactions = reactions;
    if (replies !== undefined) updateData.replies = replies;
    if (linkClicks !== undefined) updateData.link_clicks = linkClicks;

    const { error } = await supabase
        .from('qasid_posts')
        .update(updateData)
        .eq('id', postId);

    if (error) {
        log.error('Failed to update post metrics', { postId, error: error.message });
    } else {
        log.debug('Updated post metrics', { postId, ...updateData });
    }
}

/**
 * Get posts from the last N hours that need scoring (no performance_score yet).
 */
export async function getUnscoredPosts(olderThanHours = 24): Promise<Array<{
    id: string;
    content_type: string;
    platform: string;
    tone: string;
    topic: string;
    posted_at: string;
    reactions: number | null;
    replies: number | null;
    link_clicks: number | null;
}>> {
    const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
        .from('qasid_posts')
        .select('id, content_type, platform, tone, topic, posted_at, reactions, replies, link_clicks')
        .is('performance_score', null)
        .lte('posted_at', cutoff)
        .order('posted_at', { ascending: false });

    if (error) {
        log.error('Failed to fetch unscored posts', { error: error.message });
        return [];
    }

    return data || [];
}
