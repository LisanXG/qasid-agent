import { supabase } from '../supabase.js';
import { createLogger } from '../logger.js';
import { getTweetMetrics } from '../platforms/x.js';
import { updatePostMetrics } from './tracker.js';

// ============================================================================
// QasidAI — Engagement Pipeline
// Fetches real tweet metrics from X API and backfills Supabase
// Run this BEFORE scoring so the scorer has real data to work with
// ============================================================================

const log = createLogger('Engagement');

interface PostWithExternalId {
    id: string;
    external_id: string;
    reactions: number | null;
    posted_at: string;
}

/**
 * Fetch all posts that have a real external_id (tweet ID) but haven't
 * had their metrics updated yet, or were posted recently and might
 * have new engagement.
 *
 * Two passes:
 * 1. Posts with NO metrics yet (reactions is null) — always update
 * 2. Posts from the last 48h — re-fetch for freshness
 */
async function getPostsNeedingMetrics(): Promise<PostWithExternalId[]> {
    // Pass 1: Posts with no metrics at all
    const { data: unmetric, error: err1 } = await supabase
        .from('qasid_posts')
        .select('id, external_id, reactions, posted_at')
        .not('external_id', 'is', null)
        .not('external_id', 'like', 'dry-run-%')
        .is('reactions', null)
        .order('posted_at', { ascending: false })
        .limit(100);

    if (err1) {
        log.error('Failed to fetch unmetric posts', { error: err1.message });
    }

    // Pass 2: Recent posts (last 48h) for metric refresh
    const cutoff48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const { data: recent, error: err2 } = await supabase
        .from('qasid_posts')
        .select('id, external_id, reactions, posted_at')
        .not('external_id', 'is', null)
        .not('external_id', 'like', 'dry-run-%')
        .gte('posted_at', cutoff48h)
        .order('posted_at', { ascending: false })
        .limit(50);

    if (err2) {
        log.error('Failed to fetch recent posts for metrics', { error: err2.message });
    }

    // Merge and deduplicate by post ID
    const all = [...(unmetric ?? []), ...(recent ?? [])];
    const seen = new Set<string>();
    return all.filter(p => {
        if (!p.external_id || seen.has(p.id)) return false;
        seen.add(p.id);
        return true;
    });
}

/**
 * Main engagement pipeline: fetch metrics from X API and update Supabase.
 * Returns the number of posts updated.
 */
export async function fetchAndUpdateEngagement(): Promise<number> {
    log.info('Starting engagement pipeline...');

    const posts = await getPostsNeedingMetrics();

    if (posts.length === 0) {
        log.info('No posts need metric updates');
        return 0;
    }

    log.info(`Found ${posts.length} posts needing metric updates`);

    // Collect tweet IDs and build lookup map
    const tweetIds = posts.map(p => p.external_id);
    const postByTweetId = new Map(posts.map(p => [p.external_id, p]));

    // Fetch metrics from X API (batched, 100 per call)
    const metricsMap = await getTweetMetrics(tweetIds);

    if (metricsMap.size === 0) {
        log.warn('No metrics returned from X API — API may be rate limited');
        return 0;
    }

    // Update each post in Supabase
    let updated = 0;
    for (const [tweetId, metrics] of metricsMap) {
        const post = postByTweetId.get(tweetId);
        if (!post) continue;

        try {
            await updatePostMetrics({
                postId: post.id,
                reactions: metrics.like_count,
                replies: metrics.reply_count,
                // Use impressions as link_clicks proxy (best available metric)
                linkClicks: metrics.impression_count,
            });
            updated++;

            log.debug('Updated metrics for post', {
                postId: post.id,
                tweetId,
                likes: metrics.like_count,
                replies: metrics.reply_count,
                retweets: metrics.retweet_count,
                impressions: metrics.impression_count,
            });
        } catch (error) {
            log.error('Failed to update metrics for post', {
                postId: post.id,
                tweetId,
                error: String(error),
            });
        }
    }

    log.info(`Engagement pipeline complete: ${updated}/${posts.length} posts updated`, {
        fetched: metricsMap.size,
        updated,
        total: posts.length,
    });

    return updated;
}
