import { supabase } from '../supabase.js';
import { createLogger } from '../logger.js';
import { contentTypes, type ContentType } from '../personality/system-prompt.js';
import { snapshotStrategy } from '../net/brain.js';

// ============================================================================
// QasidAI — Strategy Weight Manager
// Adapts content strategy weights based on performance data
// ============================================================================

const log = createLogger('Weights');

/** Minimum weight for any content type (5% — maintains variety) */
const MIN_WEIGHT = 5;

/** Maximum weight for any content type (prevents over-concentration) */
const MAX_WEIGHT = 30;

/** How aggressively weights shift (0.1 = slow, 0.5 = fast) */
const LEARNING_RATE = 0.2;

export interface StrategyWeights {
    content_type_weights: Record<ContentType, number>;
    time_weights: Record<string, number>;  // hour -> weight
    tone_weights: Record<string, number>;
    topic_weights: Record<string, number>;
    updated_at: string;
}

const defaultWeights: StrategyWeights = {
    content_type_weights: Object.fromEntries(contentTypes.map(t => [t, 10])) as Record<ContentType, number>,
    time_weights: {},
    tone_weights: {},
    topic_weights: {},
    updated_at: new Date().toISOString(),
};

/**
 * Load current strategy weights from Supabase.
 * If no weights exist, seed defaults into the DB so adaptations can persist.
 */
export async function loadWeights(): Promise<StrategyWeights> {
    const { data, error } = await supabase
        .from('qasid_strategy')
        .select('*')
        .eq('id', 'current')
        .single();

    if (error || !data) {
        log.info('No existing weights found — seeding defaults to DB');
        const seeded = { ...defaultWeights };
        await saveWeights(seeded);
        return seeded;
    }

    return {
        content_type_weights: data.content_type_weights || defaultWeights.content_type_weights,
        time_weights: data.time_weights || {},
        tone_weights: data.tone_weights || {},
        topic_weights: data.topic_weights || {},
        updated_at: data.updated_at,
    };
}

/**
 * Save updated strategy weights to Supabase.
 */
export async function saveWeights(weights: StrategyWeights): Promise<void> {
    weights.updated_at = new Date().toISOString();

    const { error } = await supabase
        .from('qasid_strategy')
        .upsert({
            id: 'current',
            ...weights,
        });

    if (error) {
        log.error('Failed to save weights', { error: error.message });
    } else {
        log.info('Strategy weights saved');
    }
}

/**
 * Run the daily weight adaptation cycle.
 * Analyzes recent post performance and adjusts ALL weight dimensions:
 * - content_type_weights: Which content types perform best
 * - time_weights: Which hours of day get highest engagement
 * - tone_weights: Which tones resonate most
 * - topic_weights: Which topics drive engagement
 */
export async function adaptWeights(): Promise<void> {
    log.info('Running daily weight adaptation (all dimensions)...');

    // Get scored posts from the last 7 days
    const { data: posts, error } = await supabase
        .from('qasid_posts')
        .select('content_type, platform, tone, topic, performance_score, posted_at')
        .not('performance_score', 'is', null)
        .gte('posted_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
        .order('posted_at', { ascending: false });

    if (error || !posts || posts.length < 5) {
        log.info('Not enough scored posts for adaptation (need at least 5)');
        return;
    }

    const currentWeights = await loadWeights();
    const overallAvg = posts.reduce((s, p) => s + p.performance_score, 0) / posts.length;

    // ---- 1. Content Type Weights ----
    const typeScores: Record<string, { total: number; count: number }> = {};
    for (const post of posts) {
        const type = post.content_type;
        if (!typeScores[type]) typeScores[type] = { total: 0, count: 0 };
        typeScores[type].total += post.performance_score;
        typeScores[type].count++;
    }

    for (const type of contentTypes) {
        const stats = typeScores[type];
        if (!stats || stats.count < 2) continue;

        const typeAvg = stats.total / stats.count;
        const diff = typeAvg - overallAvg;
        const currentWeight = currentWeights.content_type_weights[type] || 10;
        const newWeight = currentWeight + diff * LEARNING_RATE;
        currentWeights.content_type_weights[type] = Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, Math.round(newWeight)));
    }

    // Normalize content type weights to sum to 100
    const totalWeight = Object.values(currentWeights.content_type_weights).reduce((a, b) => a + b, 0);
    if (totalWeight > 0) {
        for (const type of contentTypes) {
            currentWeights.content_type_weights[type] = Math.max(
                MIN_WEIGHT,
                Math.round((currentWeights.content_type_weights[type] / totalWeight) * 100),
            );
        }
    }

    // ---- 2. Time Weights (by UTC hour) ----
    const hourScores: Record<string, { total: number; count: number }> = {};
    for (const post of posts) {
        const hour = new Date(post.posted_at).getUTCHours().toString().padStart(2, '0');
        if (!hourScores[hour]) hourScores[hour] = { total: 0, count: 0 };
        hourScores[hour].total += post.performance_score;
        hourScores[hour].count++;
    }

    for (const [hour, stats] of Object.entries(hourScores)) {
        if (stats.count < 2) continue;
        const hourAvg = stats.total / stats.count;
        const current = currentWeights.time_weights[hour] ?? 10;
        const diff = hourAvg - overallAvg;
        currentWeights.time_weights[hour] = Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, Math.round(current + diff * LEARNING_RATE)));
    }

    // ---- 3. Tone Weights ----
    const toneScores: Record<string, { total: number; count: number }> = {};
    for (const post of posts) {
        if (!post.tone) continue;
        if (!toneScores[post.tone]) toneScores[post.tone] = { total: 0, count: 0 };
        toneScores[post.tone].total += post.performance_score;
        toneScores[post.tone].count++;
    }

    for (const [tone, stats] of Object.entries(toneScores)) {
        if (stats.count < 2) continue;
        const toneAvg = stats.total / stats.count;
        const current = currentWeights.tone_weights[tone] ?? 10;
        const diff = toneAvg - overallAvg;
        currentWeights.tone_weights[tone] = Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, Math.round(current + diff * LEARNING_RATE)));
    }

    // ---- 4. Topic Weights ----
    const topicScores: Record<string, { total: number; count: number }> = {};
    for (const post of posts) {
        if (!post.topic) continue;
        if (!topicScores[post.topic]) topicScores[post.topic] = { total: 0, count: 0 };
        topicScores[post.topic].total += post.performance_score;
        topicScores[post.topic].count++;
    }

    for (const [topic, stats] of Object.entries(topicScores)) {
        if (stats.count < 2) continue;
        const topicAvg = stats.total / stats.count;
        const current = currentWeights.topic_weights[topic] ?? 10;
        const diff = topicAvg - overallAvg;
        currentWeights.topic_weights[topic] = Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, Math.round(current + diff * LEARNING_RATE)));
    }

    await saveWeights(currentWeights);

    // Snapshot strategy to Net Protocol (on-chain brain)
    await snapshotStrategy(currentWeights);

    log.info('Weight adaptation complete (all dimensions)', {
        overallAvg: Math.round(overallAvg),
        postsAnalyzed: posts.length,
        topTypes: Object.entries(currentWeights.content_type_weights)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 3)
            .map(([type, weight]) => `${type}:${weight}`)
            .join(', '),
        topHours: Object.entries(currentWeights.time_weights)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 3)
            .map(([h, w]) => `${h}:00=${w}`)
            .join(', ') || 'not enough data',
        topTones: Object.entries(currentWeights.tone_weights)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 2)
            .map(([t, w]) => `${t}:${w}`)
            .join(', ') || 'not enough data',
    });
}

/**
 * Generate a strategy context string for injection into the system prompt.
 * Now includes all 4 weight dimensions.
 */
export async function getStrategyContext(): Promise<string> {
    const weights = await loadWeights();

    // Content type rankings
    const sortedTypes = Object.entries(weights.content_type_weights)
        .sort(([, a], [, b]) => b - a);
    const topTypes = sortedTypes.slice(0, 3);
    const bottomTypes = sortedTypes.slice(-3);

    const sections: string[] = [
        `CONTENT TYPES (prioritize top, reduce bottom):`,
        `  Best: ${topTypes.map(([t, w]) => `${t.replace(/_/g, ' ')} (${w})`).join(', ')}`,
        `  Worst: ${bottomTypes.map(([t, w]) => `${t.replace(/_/g, ' ')} (${w})`).join(', ')}`,
    ];

    // Time of day insights
    const timeEntries = Object.entries(weights.time_weights).sort(([, a], [, b]) => b - a);
    if (timeEntries.length > 0) {
        const bestHours = timeEntries.slice(0, 3).map(([h, w]) => `${h}:00 UTC (${w})`).join(', ');
        sections.push(`\nBEST TIMES: ${bestHours}`);
    }

    // Tone insights
    const toneEntries = Object.entries(weights.tone_weights).sort(([, a], [, b]) => b - a);
    if (toneEntries.length > 0) {
        const bestTones = toneEntries.slice(0, 3).map(([t, w]) => `${t} (${w})`).join(', ');
        sections.push(`BEST TONES: ${bestTones}`);
    }

    // Topic insights
    const topicEntries = Object.entries(weights.topic_weights).sort(([, a], [, b]) => b - a);
    if (topicEntries.length > 0) {
        const bestTopics = topicEntries.slice(0, 3).map(([t, w]) => `${t} (${w})`).join(', ');
        sections.push(`HOT TOPICS: ${bestTopics}`);
    }

    sections.push(`\nLast strategy update: ${weights.updated_at}`);

    return sections.join('\n');
}
