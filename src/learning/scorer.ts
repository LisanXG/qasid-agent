import { supabase } from '../supabase.js';
import { createLogger } from '../logger.js';
import { getUnscoredPosts } from './tracker.js';

// ============================================================================
// QasidAI — Post Scorer (v2)
// Scores post performance after a 24-hour window.
//
// Improvements over v1:
// - Content-type benchmarking: scores relative to type average, not absolute
// - Time-decay: older posts need more engagement to score the same
// - Richer formula: engagement rate (likes+replies / impressions) factored in
// - Bonus multiplier for high engagement rate (viral signal)
// ============================================================================

const log = createLogger('Scorer');

/** Cache of average scores per content type (refreshed each scoring run) */
let typeAverages: Map<string, { avgReactions: number; avgReplies: number; count: number }> = new Map();

/**
 * Calculate a composite performance score (0-100) from engagement metrics.
 *
 * Formula v2:
 * - Base score from log-normalized metrics (reactions 35%, replies 35%, impressions 20%)
 * - Engagement rate bonus: if likes+replies / impressions > 2%, +10 points
 * - Content-type benchmark: if above type average, +5 bonus; if below, -5 penalty
 * - Time decay: posts older than 48h get a 10% score reduction per additional day
 */
function calculateScore(
    reactions: number,
    replies: number,
    impressions: number,
    contentType: string,
    hoursOld: number,
): number {
    // ---- Base score from log-normalized metrics ----
    const normReactions = Math.min(Math.log2(reactions + 1) / 5, 1);   // ~32 reactions = 1.0
    const normReplies = Math.min(Math.log2(replies + 1) / 4, 1);       // ~16 replies = 1.0
    const normImpressions = Math.min(Math.log2(impressions + 1) / 10, 1); // ~1024 impressions = 1.0

    let rawScore = normReactions * 0.35 + normReplies * 0.35 + normImpressions * 0.20;

    // ---- Engagement rate bonus ----
    // Viral signal: high engagement relative to reach
    if (impressions > 50) {
        const engagementRate = (reactions + replies) / impressions;
        if (engagementRate > 0.02) {
            rawScore += 0.10; // Bonus for > 2% engagement rate
        }
    }

    // ---- Content-type benchmarking ----
    const avg = typeAverages.get(contentType);
    if (avg && avg.count >= 3) {
        const isAboveAvgReactions = reactions > avg.avgReactions * 1.2;
        const isAboveAvgReplies = replies > avg.avgReplies * 1.2;
        if (isAboveAvgReactions && isAboveAvgReplies) {
            rawScore += 0.05; // Outperforming type average
        } else if (reactions < avg.avgReactions * 0.5 && replies < avg.avgReplies * 0.5) {
            rawScore -= 0.05; // Significantly underperforming
        }
    }

    // ---- Time decay ----
    // Posts older than 48h: 10% reduction per additional day (maxes out at 30% reduction)
    if (hoursOld > 48) {
        const extraDays = (hoursOld - 48) / 24;
        const decayFactor = Math.max(0.70, 1.0 - extraDays * 0.10);
        rawScore *= decayFactor;
    }

    return Math.round(Math.min(1, Math.max(0, rawScore)) * 100);
}

/**
 * Refresh content-type average engagement metrics from DB.
 * Used for relative benchmarking in the scorer.
 */
async function refreshTypeAverages(): Promise<void> {
    const { data, error } = await supabase
        .from('qasid_posts')
        .select('content_type, reactions, replies')
        .not('performance_score', 'is', null)
        .order('posted_at', { ascending: false })
        .limit(200);

    if (error || !data) {
        log.warn('Failed to fetch type averages', { error: error?.message });
        return;
    }

    const groups = new Map<string, { totalReactions: number; totalReplies: number; count: number }>();
    for (const row of data) {
        const type = row.content_type ?? 'unknown';
        const group = groups.get(type) ?? { totalReactions: 0, totalReplies: 0, count: 0 };
        group.totalReactions += row.reactions ?? 0;
        group.totalReplies += row.replies ?? 0;
        group.count += 1;
        groups.set(type, group);
    }

    typeAverages = new Map(
        [...groups.entries()].map(([type, g]) => [
            type,
            {
                avgReactions: g.count > 0 ? g.totalReactions / g.count : 0,
                avgReplies: g.count > 0 ? g.totalReplies / g.count : 0,
                count: g.count,
            },
        ]),
    );

    log.debug('Refreshed type averages', {
        types: [...typeAverages.entries()].map(([t, a]) => `${t}: ${a.avgReactions.toFixed(1)}r/${a.avgReplies.toFixed(1)}rep (n=${a.count})`),
    });
}

/**
 * Score all unscored posts that are at least 24 hours old.
 * Returns the number of posts scored.
 */
export async function scoreOldPosts(): Promise<number> {
    // Refresh content-type benchmarks before scoring
    await refreshTypeAverages();

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
        // Fix 12: Column `link_clicks` is a legacy misnomer — it actually stores impression count.
        // Renaming the DB column would break existing data, so we document the mapping here.
        const impressions = post.link_clicks ?? 0;
        const contentType = post.content_type ?? 'unknown';
        const hoursOld = post.posted_at
            ? (Date.now() - new Date(post.posted_at).getTime()) / 3600000
            : 24;

        const score = calculateScore(reactions, replies, impressions, contentType, hoursOld);

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
                type: contentType,
                platform: post.platform,
                score,
                metrics: `${reactions}r/${replies}rep/${impressions}imp`,
                hoursOld: Math.round(hoursOld),
            });
        }
    }

    log.info(`Scored ${scored}/${posts.length} posts`);
    return scored;
}
