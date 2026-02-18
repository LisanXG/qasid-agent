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
    log.info('═══ ENGAGEMENT PIPELINE START ═══');

    // Stage 1: Find posts needing metrics
    const posts = await getPostsNeedingMetrics();

    if (posts.length === 0) {
        log.info('No posts need metric updates — all posts either have metrics or no external_id');
        return 0;
    }

    // Diagnostic: how many have metrics vs not
    const withMetrics = posts.filter(p => p.reactions !== null).length;
    const withoutMetrics = posts.length - withMetrics;
    log.info(`Stage 1: Found ${posts.length} posts needing updates`, {
        needFirstFetch: withoutMetrics,
        needRefresh: withMetrics,
        sampleTweetIds: posts.slice(0, 3).map(p => p.external_id),
    });

    // Stage 2: Fetch metrics from X API
    const tweetIds = posts.map(p => p.external_id);
    const postByTweetId = new Map(posts.map(p => [p.external_id, p]));

    const metricsMap = await getTweetMetrics(tweetIds);

    // Stage 3: Diagnose API response
    if (metricsMap.size === 0) {
        log.warn('⚠️ API_TIER_LIMITATION: X API returned 0 metrics', {
            tweetIdsSent: tweetIds.length,
            diagnosis: 'X Free tier does not support GET /2/tweets with public_metrics. ' +
                'Upgrade to Basic tier ($100/mo) to enable the learning loop, or ' +
                'engagement data will remain at zero and weights will never adapt.',
            sampleIds: tweetIds.slice(0, 5),
        });
        return 0;
    }

    log.info(`Stage 2: X API returned metrics for ${metricsMap.size}/${tweetIds.length} tweets`);

    // Stage 4: Update Supabase
    let updated = 0;
    let totalLikes = 0;
    let totalReplies = 0;
    let totalImpressions = 0;

    for (const [tweetId, metrics] of metricsMap) {
        const post = postByTweetId.get(tweetId);
        if (!post) continue;

        try {
            // Fix 12: Column name mapping (legacy misnomers — renaming would break data):
            //   reactions (DB) ← like_count (X API)
            //   link_clicks (DB) ← impression_count (X API)
            await updatePostMetrics({
                postId: post.id,
                reactions: metrics.like_count,
                replies: metrics.reply_count,
                linkClicks: metrics.impression_count,
            });
            updated++;
            totalLikes += metrics.like_count;
            totalReplies += metrics.reply_count;
            totalImpressions += metrics.impression_count;
        } catch (error) {
            log.error('Failed to update metrics for post', {
                postId: post.id,
                tweetId,
                error: String(error),
            });
        }
    }

    log.info(`═══ ENGAGEMENT PIPELINE COMPLETE ═══`, {
        postsUpdated: `${updated}/${posts.length}`,
        metricsFromApi: metricsMap.size,
        aggregates: {
            totalLikes,
            totalReplies,
            totalImpressions,
            avgLikes: updated > 0 ? (totalLikes / updated).toFixed(1) : '0',
            avgImpressions: updated > 0 ? (totalImpressions / updated).toFixed(0) : '0',
        },
    });

    return updated;
}
