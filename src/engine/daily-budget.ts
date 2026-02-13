import { supabase } from '../supabase.js';
import { createLogger } from '../logger.js';

// ============================================================================
// QasidAI — Daily Action Budget
// Tracks daily post/action budget: 23 total = 13 scheduled + 10 discretionary
// ============================================================================

const log = createLogger('Budget');

/** Total actions QasidAI can take per day */
export const DAILY_TOTAL_BUDGET = 23;

/** Reserved for scheduled content posts (cron-driven): 10 main + 3 night owl */
export const SCHEDULED_BUDGET = 13;

/** Available for QasidAI to use however it wants */
export const DISCRETIONARY_BUDGET = 10;

export type ActionType =
    | 'scheduled_post'     // One of the 10 cron-driven posts
    | 'reply'              // Reply to a trending/relevant tweet
    | 'mention_response'   // Respond to someone who @mentioned us
    | 'thread'             // Multi-tweet thread on a topic
    | 'quote_tweet'        // Quote tweet with commentary
    | 'follow'             // Strategic follow
    | 'bonus_post'         // Extra original content post
    | 'engagement';        // Like/bookmark (doesn't count toward tweet limit)

/**
 * Get today's date key (UTC).
 */
function getTodayKey(): string {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Get the current action counts for today.
 */
export async function getTodayActions(): Promise<{
    scheduled: number;
    discretionary: number;
    total: number;
    remaining: number;
    breakdown: Record<string, number>;
}> {
    const today = getTodayKey();
    const { data, error } = await supabase
        .from('qasid_daily_actions')
        .select('action_type')
        .eq('day', today);

    if (error) {
        log.warn('Failed to fetch daily actions', { error: error.message });
        return { scheduled: 0, discretionary: 0, total: 0, remaining: DAILY_TOTAL_BUDGET, breakdown: {} };
    }

    const actions = data ?? [];
    const breakdown: Record<string, number> = {};
    let scheduled = 0;
    let discretionary = 0;

    for (const a of actions) {
        breakdown[a.action_type] = (breakdown[a.action_type] || 0) + 1;
        if (a.action_type === 'scheduled_post') {
            scheduled++;
        } else {
            discretionary++;
        }
    }

    const total = scheduled + discretionary;
    return {
        scheduled,
        discretionary,
        total,
        remaining: Math.max(0, DAILY_TOTAL_BUDGET - total),
        breakdown,
    };
}

/**
 * Get remaining discretionary budget for today.
 */
export async function getDiscretionaryRemaining(): Promise<number> {
    const { discretionary } = await getTodayActions();
    return Math.max(0, DISCRETIONARY_BUDGET - discretionary);
}

/**
 * Check if an action can be taken without recording it.
 * Use this BEFORE posting to enforce budget as a gate.
 */
export async function canTakeAction(actionType: ActionType): Promise<boolean> {
    const { total, discretionary } = await getTodayActions();

    if (total >= DAILY_TOTAL_BUDGET) {
        log.warn(`Daily budget exhausted (${total}/${DAILY_TOTAL_BUDGET}), blocking action`, { actionType });
        return false;
    }

    if (actionType !== 'scheduled_post' && discretionary >= DISCRETIONARY_BUDGET) {
        log.warn(`Discretionary budget exhausted, blocking action`, { actionType });
        return false;
    }

    return true;
}

/**
 * Record an action against today's budget.
 * Insert-then-check pattern to avoid TOCTOU race condition:
 * 1. Insert the action optimistically
 * 2. Re-read today's count
 * 3. If over budget, delete the row we just inserted (rollback)
 * Returns true if the action was within budget, false if rolled back.
 */
export async function recordAction(
    actionType: ActionType,
    description: string,
    tweetId?: string,
): Promise<boolean> {
    const today = getTodayKey();
    const insertedAt = new Date().toISOString();

    // Step 1: Insert optimistically
    const { data: inserted, error: insertError } = await supabase
        .from('qasid_daily_actions')
        .insert({
            day: today,
            action_type: actionType,
            description,
            tweet_id: tweetId,
            created_at: insertedAt,
        })
        .select('id')
        .single();

    if (insertError || !inserted) {
        log.error('Failed to record action', { error: insertError?.message, actionType });
        return false;
    }

    // Step 2: Re-read count (includes the row we just inserted)
    const { total, discretionary } = await getTodayActions();

    // Step 3: Rollback if over budget
    const overTotal = total > DAILY_TOTAL_BUDGET;
    const overDiscretionary = actionType !== 'scheduled_post' && discretionary > DISCRETIONARY_BUDGET;

    if (overTotal || overDiscretionary) {
        // Delete the row we just inserted (atomic rollback)
        await supabase.from('qasid_daily_actions').delete().eq('id', inserted.id);
        log.warn(`Budget exceeded after insert — rolled back`, {
            actionType,
            total,
            discretionary,
            overTotal,
            overDiscretionary,
        });
        return false;
    }

    log.debug('Action recorded', { actionType, description: description.slice(0, 60) });
    return true;
}

/**
 * Get a human-readable budget summary for the LLM planner.
 */
export async function getBudgetSummary(): Promise<string> {
    const stats = await getTodayActions();
    const lines = [
        `Daily budget: ${stats.total}/${DAILY_TOTAL_BUDGET} used`,
        `  Scheduled posts: ${stats.scheduled}/${SCHEDULED_BUDGET}`,
        `  Discretionary: ${stats.discretionary}/${DISCRETIONARY_BUDGET} (${Math.max(0, DISCRETIONARY_BUDGET - stats.discretionary)} remaining)`,
    ];

    if (Object.keys(stats.breakdown).length > 0) {
        lines.push(`  Breakdown: ${Object.entries(stats.breakdown).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    }

    return lines.join('\n');
}
