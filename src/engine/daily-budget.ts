import { supabase } from '../supabase.js';
import { createLogger } from '../logger.js';

// ============================================================================
// QasidAI — Daily Action Budget
// Tracks daily post/action budget: 35 total = 30 X + 5 Botchan
// X budget: 13 scheduled + 17 discretionary
// ============================================================================

const log = createLogger('Budget');

/** Total actions QasidAI can take per day (X + Botchan) */
export const DAILY_TOTAL_BUDGET = 35;

/** X budget: reserved for scheduled content posts (cron-driven): 10 main + 3 night owl */
export const SCHEDULED_BUDGET = 13;

/** X budget: available for QasidAI to use however it wants */
export const DISCRETIONARY_BUDGET = 17;

/** X budget: total X actions (scheduled + discretionary) */
export const X_BUDGET = 30;

/** Botchan budget: native posts to Net Protocol feed */
export const BOTCHAN_BUDGET = 5;

export type ActionType =
    | 'scheduled_post'     // One of the 13 cron-driven X posts
    | 'reply'              // Reply to a trending/relevant tweet
    | 'mention_response'   // Respond to someone who @mentioned us
    | 'thread'             // Multi-tweet thread on a topic
    | 'quote_tweet'        // Quote tweet with commentary
    | 'follow'             // Strategic follow
    | 'bonus_post'         // Extra original content post
    | 'engagement'         // Like/bookmark (doesn't count toward tweet limit)
    | 'botchan_post';      // Native Botchan content (separate budget)

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
    botchan: number;
    total: number;
    xTotal: number;
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
        return { scheduled: 0, discretionary: 0, botchan: 0, total: 0, xTotal: 0, remaining: DAILY_TOTAL_BUDGET, breakdown: {} };
    }

    const actions = data ?? [];
    const breakdown: Record<string, number> = {};
    let scheduled = 0;
    let discretionary = 0;
    let botchan = 0;

    for (const a of actions) {
        breakdown[a.action_type] = (breakdown[a.action_type] || 0) + 1;
        if (a.action_type === 'scheduled_post') {
            scheduled++;
        } else if (a.action_type === 'botchan_post') {
            botchan++;
        } else {
            discretionary++;
        }
    }

    const xTotal = scheduled + discretionary;
    const total = xTotal + botchan;
    return {
        scheduled,
        discretionary,
        botchan,
        total,
        xTotal,
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
    const { total, xTotal, discretionary, botchan } = await getTodayActions();

    if (total >= DAILY_TOTAL_BUDGET) {
        log.warn(`Daily budget exhausted (${total}/${DAILY_TOTAL_BUDGET}), blocking action`, { actionType });
        return false;
    }

    // Botchan posts have their own separate budget
    if (actionType === 'botchan_post') {
        if (botchan >= BOTCHAN_BUDGET) {
            log.warn(`Botchan budget exhausted (${botchan}/${BOTCHAN_BUDGET}), blocking action`);
            return false;
        }
        return true;
    }

    // X actions: check total X budget
    if (xTotal >= X_BUDGET) {
        log.warn(`X budget exhausted (${xTotal}/${X_BUDGET}), blocking action`, { actionType });
        return false;
    }

    // Discretionary actions: check discretionary sub-budget
    if (actionType !== 'scheduled_post' && discretionary >= DISCRETIONARY_BUDGET) {
        log.warn(`Discretionary budget exhausted (${discretionary}/${DISCRETIONARY_BUDGET}), blocking action`, { actionType });
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
    const { total, discretionary, botchan, xTotal } = await getTodayActions();

    // Step 3: Rollback if over budget
    const overTotal = total > DAILY_TOTAL_BUDGET;
    const overDiscretionary = actionType !== 'scheduled_post' && actionType !== 'botchan_post' && discretionary > DISCRETIONARY_BUDGET;
    const overBotchan = actionType === 'botchan_post' && botchan > BOTCHAN_BUDGET;
    const overX = actionType !== 'botchan_post' && xTotal > X_BUDGET;

    if (overTotal || overDiscretionary || overBotchan || overX) {
        // Delete the row we just inserted (atomic rollback)
        await supabase.from('qasid_daily_actions').delete().eq('id', inserted.id);
        log.warn(`Budget exceeded after insert — rolled back`, {
            actionType,
            total,
            discretionary,
            botchan,
            overTotal,
            overDiscretionary,
            overBotchan,
            overX,
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
        `  X posts: ${stats.xTotal}/${X_BUDGET} (scheduled: ${stats.scheduled}/${SCHEDULED_BUDGET}, discretionary: ${stats.discretionary}/${DISCRETIONARY_BUDGET})`,
        `  Botchan: ${stats.botchan}/${BOTCHAN_BUDGET}`,
    ];

    if (Object.keys(stats.breakdown).length > 0) {
        lines.push(`  Breakdown: ${Object.entries(stats.breakdown).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    }

    return lines.join('\n');
}

// ---- Token Cost Alerting ----

/** Estimated cost per 1M tokens (Claude 3.5 Sonnet pricing) */
const INPUT_COST_PER_1M = 3.00;  // $3/1M input tokens
const OUTPUT_COST_PER_1M = 15.00; // $15/1M output tokens

/** Daily cost warning threshold in USD */
const DAILY_COST_WARN_THRESHOLD = 5.00;

/**
 * Check today's token spend and log a warning if it exceeds the threshold.
 * Call this from the daily summary or creative session.
 */
export async function checkTokenCostAlert(): Promise<{ estimatedCost: number; warning: boolean }> {
    const today = new Date().toISOString().split('T')[0];
    const startOfDay = `${today}T00:00:00.000Z`;

    const { data, error } = await supabase
        .from('qasid_posts')
        .select('input_tokens, output_tokens')
        .gte('posted_at', startOfDay);

    if (error || !data) {
        return { estimatedCost: 0, warning: false };
    }

    const totalInput = data.reduce((sum, r) => sum + (r.input_tokens || 0), 0);
    const totalOutput = data.reduce((sum, r) => sum + (r.output_tokens || 0), 0);
    const estimatedCost = (totalInput / 1_000_000) * INPUT_COST_PER_1M + (totalOutput / 1_000_000) * OUTPUT_COST_PER_1M;

    if (estimatedCost >= DAILY_COST_WARN_THRESHOLD) {
        log.warn(`⚠️ LLM cost alert: $${estimatedCost.toFixed(2)} today (threshold: $${DAILY_COST_WARN_THRESHOLD.toFixed(2)})`, {
            totalInput,
            totalOutput,
            estimatedCost,
            postCount: data.length,
        });
        return { estimatedCost, warning: true };
    }

    return { estimatedCost, warning: false };
}
