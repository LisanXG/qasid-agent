import { supabase } from '../supabase.js';
import { createLogger } from '../logger.js';
import { snapshotMetaReview } from '../net/brain.js';

// ============================================================================
// QasidAI — Meta Review
// Weekly analysis of whether learning is improving overall engagement
// ============================================================================

const log = createLogger('MetaReview');

export interface WeeklyReport {
    week: string;
    totalPosts: number;
    avgPerformanceScore: number;
    bestContentType: string;
    worstContentType: string;
    platformBreakdown: Record<string, { posts: number; avgScore: number }>;
    trend: 'improving' | 'stable' | 'declining';
}

/**
 * Run a weekly meta-review comparing this week's performance to last week's.
 */
export async function runMetaReview(): Promise<WeeklyReport | null> {
    log.info('Running weekly meta review...');

    const now = Date.now();
    const thisWeekStart = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    const lastWeekStart = new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString();

    // Fetch this week's scored posts
    const { data: thisWeek, error: err1 } = await supabase
        .from('qasid_posts')
        .select('content_type, platform, performance_score, reactions, replies')
        .not('performance_score', 'is', null)
        .gte('posted_at', thisWeekStart);

    // Fetch last week's scored posts
    const { data: lastWeek, error: err2 } = await supabase
        .from('qasid_posts')
        .select('content_type, platform, performance_score')
        .not('performance_score', 'is', null)
        .gte('posted_at', lastWeekStart)
        .lt('posted_at', thisWeekStart);

    if (err1 || err2) {
        log.error('Failed to fetch posts for meta review');
        return null;
    }

    if (!thisWeek || thisWeek.length < 3) {
        log.info('Not enough scored posts for meta review this week', {
            scoredPosts: thisWeek?.length ?? 0,
            required: 3,
        });
        return null;
    }

    // Data quality gate: check if engagement data is actually populated.
    // If all posts have zero metrics, the scores are meaningless —
    // likely because X API Free tier doesn't return public_metrics.
    const postsWithRealMetrics = thisWeek.filter(
        p => (p as any).reactions > 0 || (p as any).replies > 0
    );
    if (postsWithRealMetrics.length === 0) {
        log.warn('⚠️ META_REVIEW_SKIPPED: All scored posts have zero engagement metrics', {
            totalScored: thisWeek.length,
            diagnosis: 'Scores are based on zero-metric data (likely X API Free tier limitation). ' +
                'Meta review would report fabricated trends. Skipping until real metrics are available.',
        });
        return null;
    }

    // Calculate this week's average
    const thisWeekAvg = thisWeek.reduce((s, p) => s + p.performance_score, 0) / thisWeek.length;
    const lastWeekAvg = lastWeek && lastWeek.length > 0
        ? lastWeek.reduce((s, p) => s + p.performance_score, 0) / lastWeek.length
        : thisWeekAvg;

    // Find best/worst content types
    const typeScores: Record<string, { total: number; count: number }> = {};
    for (const post of thisWeek) {
        if (!typeScores[post.content_type]) typeScores[post.content_type] = { total: 0, count: 0 };
        typeScores[post.content_type].total += post.performance_score;
        typeScores[post.content_type].count++;
    }

    const typeSorted = Object.entries(typeScores)
        .map(([type, { total, count }]) => ({ type, avg: total / count }))
        .sort((a, b) => b.avg - a.avg);

    // Platform breakdown
    const platformBreakdown: Record<string, { posts: number; avgScore: number }> = {};
    for (const post of thisWeek) {
        if (!platformBreakdown[post.platform]) platformBreakdown[post.platform] = { posts: 0, avgScore: 0 };
        platformBreakdown[post.platform].posts++;
        platformBreakdown[post.platform].avgScore += post.performance_score;
    }
    for (const platform of Object.keys(platformBreakdown)) {
        platformBreakdown[platform].avgScore = Math.round(
            platformBreakdown[platform].avgScore / platformBreakdown[platform].posts
        );
    }

    // Determine trend
    const diff = thisWeekAvg - lastWeekAvg;
    const trend: WeeklyReport['trend'] = diff > 3 ? 'improving' : diff < -3 ? 'declining' : 'stable';

    const report: WeeklyReport = {
        week: new Date().toISOString().split('T')[0],
        totalPosts: thisWeek.length,
        avgPerformanceScore: Math.round(thisWeekAvg),
        bestContentType: typeSorted[0]?.type || 'unknown',
        worstContentType: typeSorted[typeSorted.length - 1]?.type || 'unknown',
        platformBreakdown,
        trend,
    };

    // Save report to Supabase (map to snake_case DB columns)
    const { error: insertError } = await supabase
        .from('qasid_meta_reviews')
        .insert({
            week_start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            week_end: report.week,
            total_posts: report.totalPosts,
            avg_performance_score: report.avgPerformanceScore,
            best_content_type: report.bestContentType,
            worst_content_type: report.worstContentType,
            trend: report.trend,
            report: report,
        });
    if (insertError) {
        log.error('Failed to save meta review to DB', { error: insertError.message });
    }

    // Snapshot to Net Protocol (on-chain brain)
    await snapshotMetaReview(report);

    log.info('Meta review complete', {
        trend: report.trend,
        avgScore: report.avgPerformanceScore,
        best: report.bestContentType,
        worst: report.worstContentType,
    });

    return report;
}
