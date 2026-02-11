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
 */
export async function loadWeights(): Promise<StrategyWeights> {
    const { data, error } = await supabase
        .from('qasid_strategy')
        .select('*')
        .eq('id', 'current')
        .single();

    if (error || !data) {
        log.info('No existing weights found, using defaults');
        return { ...defaultWeights };
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
 * Analyzes recent post performance and adjusts content type weights.
 */
export async function adaptWeights(): Promise<void> {
    log.info('Running daily weight adaptation...');

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

    // Calculate average performance score per content type
    const typeScores: Record<string, { total: number; count: number }> = {};
    for (const post of posts) {
        const type = post.content_type;
        if (!typeScores[type]) typeScores[type] = { total: 0, count: 0 };
        typeScores[type].total += post.performance_score;
        typeScores[type].count++;
    }

    // Calculate overall average for comparison
    const overallAvg = posts.reduce((s, p) => s + p.performance_score, 0) / posts.length;

    // Adjust weights: above-average types get boosted, below-average get reduced
    for (const type of contentTypes) {
        const stats = typeScores[type];
        if (!stats || stats.count < 2) continue; // Need at least 2 data points

        const typeAvg = stats.total / stats.count;
        const diff = typeAvg - overallAvg;

        // Nudge the weight proportionally to the performance difference
        const currentWeight = currentWeights.content_type_weights[type] || 10;
        const newWeight = currentWeight + diff * LEARNING_RATE;

        // Clamp to MIN/MAX range
        currentWeights.content_type_weights[type] = Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, Math.round(newWeight)));
    }

    // Normalize weights to sum to 100
    const totalWeight = Object.values(currentWeights.content_type_weights).reduce((a, b) => a + b, 0);
    if (totalWeight > 0) {
        for (const type of contentTypes) {
            currentWeights.content_type_weights[type] = Math.round(
                (currentWeights.content_type_weights[type] / totalWeight) * 100
            );
            // Re-clamp after normalization
            currentWeights.content_type_weights[type] = Math.max(MIN_WEIGHT, currentWeights.content_type_weights[type]);
        }
    }

    await saveWeights(currentWeights);

    // Snapshot strategy to Net Protocol (on-chain brain)
    await snapshotStrategy(currentWeights);

    log.info('Weight adaptation complete', {
        overallAvg: Math.round(overallAvg),
        topTypes: Object.entries(currentWeights.content_type_weights)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 3)
            .map(([type, weight]) => `${type}:${weight}`)
            .join(', '),
    });
}

/**
 * Generate a strategy context string for injection into the system prompt.
 */
export async function getStrategyContext(): Promise<string> {
    const weights = await loadWeights();
    const sorted = Object.entries(weights.content_type_weights)
        .sort(([, a], [, b]) => b - a);

    const topTypes = sorted.slice(0, 3);
    const bottomTypes = sorted.slice(-3);

    return `Based on recent performance data, prioritize these content types:
${topTypes.map(([type, weight]) => `- ${type.replace(/_/g, ' ')} (weight: ${weight})`).join('\n')}

These content types have lower engagement — use less frequently:
${bottomTypes.map(([type, weight]) => `- ${type.replace(/_/g, ' ')} (weight: ${weight})`).join('\n')}

Last strategy update: ${weights.updated_at}`;
}
