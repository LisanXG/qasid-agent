import { supabase } from '../supabase.js';
import { createLogger } from '../logger.js';
import { getUnscoredPosts } from './tracker.js';

// ============================================================================
// QasidAI — Post Scorer
// Scores post performance after a 24-hour window
// ============================================================================

const log = createLogger('Scorer');

/**
 * Calculate a composite performance score (0-100) from engagement metrics.
 * Weighted: reactions (40%), replies (40%), link clicks (20%)
 */
function calculateScore(reactions: number, replies: number, linkClicks: number): number {
    // Normalize each metric on a log scale to handle varying volumes
    const normReactions = Math.min(Math.log2(reactions + 1) / 5, 1);   // ~32 reactions = 1.0
    const normReplies = Math.min(Math.log2(replies + 1) / 4, 1);       // ~16 replies = 1.0
    const normClicks = Math.min(Math.log2(linkClicks + 1) / 6, 1);     // ~64 clicks = 1.0

    const raw = normReactions * 0.4 + normReplies * 0.4 + normClicks * 0.2;
    return Math.round(raw * 100);
}

/**
 * Score all unscored posts that are at least 24 hours old.
 * Returns the number of posts scored.
 */
export async function scoreOldPosts(): Promise<number> {
    const posts = await getUnscoredPosts(24);

    if (posts.length === 0) {
        log.debug('No unscored posts to process');
        return 0;
    }

    log.info(`Scoring ${posts.length} posts...`);
    let scored = 0;

    for (const post of posts) {
        const reactions = post.reactions ?? 0;
        const replies = post.replies ?? 0;
        const clicks = post.link_clicks ?? 0;
        const score = calculateScore(reactions, replies, clicks);

        const { error } = await supabase
            .from('qasid_posts')
            .update({ performance_score: score })
            .eq('id', post.id);

        if (error) {
            log.error('Failed to score post', { postId: post.id, error: error.message });
        } else {
            scored++;
            log.debug('Scored post', {
                postId: post.id,
                type: post.content_type,
                platform: post.platform,
                score,
                metrics: `${reactions}r/${replies}rep/${clicks}c`,
            });
        }
    }

    log.info(`Scored ${scored}/${posts.length} posts`);
    return scored;
}
