import { followUser, getMentions, getMyUserId } from '../platforms/x.js';
import { supabase } from '../supabase.js';
import { createLogger } from '../logger.js';
import { config } from '../config.js';

// ============================================================================
// QasidAI — Smart Follow Engine
// Strategically follows users who engage with QasidAI + interesting accounts
// discovered during timeline scanning. Builds community organically.
// ============================================================================

const log = createLogger('SmartFollow');

// ---- Configuration ----

/** Max follows per cycle */
const MAX_FOLLOWS_PER_CYCLE = 5;

/** Max follows per 24h window (X enforces ~400/day, we stay well under) */
const MAX_FOLLOWS_PER_DAY = 15;

/** Cooldown: don't re-follow someone we unfollowed or already follow */
const FOLLOW_COOLDOWN_DAYS = 30;

// ---- Follow Tracking ----

/**
 * Check if we've already followed (or recently attempted to follow) this user.
 */
async function hasFollowed(userId: string): Promise<boolean> {
    const cutoff = new Date(Date.now() - FOLLOW_COOLDOWN_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { data } = await supabase
        .from('qasid_follows')
        .select('id')
        .eq('target_user_id', userId)
        .gte('followed_at', cutoff)
        .limit(1);
    return (data?.length ?? 0) > 0;
}

/**
 * Record a follow action.
 */
async function recordFollow(
    userId: string,
    username: string,
    source: 'mention' | 'reply' | 'scanner' | 'manual',
    reason: string,
): Promise<void> {
    const { error } = await supabase
        .from('qasid_follows')
        .insert({
            target_user_id: userId,
            target_username: username,
            source,
            reason,
            followed_at: new Date().toISOString(),
        });
    if (error) {
        log.error('Failed to record follow', { error: error.message, userId });
    }
}

/**
 * Count follows in the last 24 hours.
 */
async function getFollowsLast24h(): Promise<number> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
        .from('qasid_follows')
        .select('id')
        .gte('followed_at', since);

    if (error) {
        log.warn('Failed to count recent follows', { error: error.message });
        return MAX_FOLLOWS_PER_DAY; // Fail safe
    }
    return data?.length ?? 0;
}

// ---- Follow Sources ----

/**
 * Source 1: Follow users who mentioned @QasidAI.
 * People who tag you are warm leads — follow them back.
 */
async function followMentioners(budget: number): Promise<number> {
    if (budget <= 0) return 0;

    // Get recent mentions
    const mentions = await getMentions(undefined, 20);
    if (mentions.length === 0) return 0;

    // Deduplicate by author
    const uniqueAuthors = new Map<string, string>();
    for (const m of mentions) {
        if (m.authorId && !uniqueAuthors.has(m.authorId)) {
            uniqueAuthors.set(m.authorId, m.authorUsername ?? m.authorId);
        }
    }

    let followed = 0;

    // Get our own user ID once (not per-iteration)
    let myId: string;
    try {
        myId = await getMyUserId();
    } catch (error) {
        log.error('Failed to get own user ID, aborting follow cycle', { error: String(error) });
        return 0;
    }

    for (const [userId, username] of uniqueAuthors) {
        if (followed >= budget) break;

        // Skip self
        if (userId === myId) continue;

        // Skip if already followed
        if (await hasFollowed(userId)) continue;

        const success = await followUser(userId);
        if (success) {
            await recordFollow(userId, username, 'mention', 'Mentioned @QasidAI');
            followed++;
            log.info('Followed mentioner', { userId, username });
        }
    }

    return followed;
}

// ---- Main Engine ----

/**
 * Run a smart follow cycle.
 * Follows users who mentioned @QasidAI (warmest leads).
 * Returns the number of users followed.
 */
export async function runSmartFollow(): Promise<number> {
    log.info('Starting smart follow cycle...');

    // Safety check: daily limit
    const recentCount = await getFollowsLast24h();
    if (recentCount >= MAX_FOLLOWS_PER_DAY) {
        log.info(`Daily follow limit reached (${recentCount}/${MAX_FOLLOWS_PER_DAY}), skipping`);
        return 0;
    }

    const totalBudget = Math.min(
        MAX_FOLLOWS_PER_CYCLE,
        MAX_FOLLOWS_PER_DAY - recentCount,
    );

    // Follow mentioners (people who tagged us are warm leads)
    const totalFollowed = await followMentioners(totalBudget);

    log.info(`Smart follow complete: ${totalFollowed} users followed`, {
        dailyTotal: recentCount + totalFollowed,
    });

    return totalFollowed;
}
