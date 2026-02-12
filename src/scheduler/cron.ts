import cron from 'node-cron';
import { generatePost } from '../engine/content.js';
import { savePost, wasRecentlyPosted } from '../engine/memory.js';
import { postTweet, postTweetWithImage } from '../platforms/x.js';
import { isXConfigured, isNetConfigured } from '../config.js';
import { createLogger } from '../logger.js';
import { buildAndWriteDailySummary } from '../net/daily-summary.js';
import { scoreOldPosts } from '../learning/scorer.js';
import { fetchAndUpdateEngagement } from '../learning/engagement.js';
import { adaptWeights, getStrategyContext } from '../learning/weights.js';
import { runMetaReview } from '../learning/meta-review.js';
import { postToFeed } from '../net/client.js';
import { runTimelineScan } from '../engine/timeline-scanner.js';
import { runMentionMonitor } from '../engine/mention-monitor.js';
import { runSmartFollow } from '../engine/smart-follow.js';
import { runCreativeSession } from '../engine/creative-session.js';
import { recordAction } from '../engine/daily-budget.js';
import { generateScorecardImage } from '../engine/scorecard-image.js';

// ============================================================================
// QasidAI — Content Scheduler
// Manages automated posting schedule to X (Twitter) + Botchan
// ============================================================================

const log = createLogger('Scheduler');

const activeTasks: cron.ScheduledTask[] = [];

/** Map content type to a Botchan feed topic */
function contentTypeToBotchanTopic(contentType: string): string {
    const topicMap: Record<string, string> = {
        signal_scorecard: 'trading',
        win_streak: 'trading',
        market_regime: 'trading',
        educational: 'trading',
        builder_narrative: 'agent-finance',
        countdown_tease: 'agent-finance',
        social_proof: 'agent-finance',
        challenge: 'lisan-holdings',
        engagement_bait: 'lisan-holdings',
        cross_platform: 'lisan-holdings',
    };
    return topicMap[contentType] || 'lisan-holdings';
}

/**
 * Run a single content cycle: generate + post to X + save to memory.
 * @param options.crossPostToBotchan If true, also post to Botchan feed (once/day to save gas)
 */
async function runContentCycle(options?: {
    strategyContext?: string;
    crossPostToBotchan?: boolean;
    preferredContentType?: string;
}): Promise<void> {
    if (!isXConfigured) {
        log.warn('X not configured — skipping content cycle');
        return;
    }

    // Load current strategy context from learned weights
    const context = options?.strategyContext ?? await getStrategyContext().catch((err) => {
        log.warn('Failed to load strategy context, continuing without it', { error: String(err).slice(0, 200) });
        return undefined;
    });

    try {
        // Generate content (use preferred type if specified by time slot)
        const post = await generatePost({
            strategyContext: context,
            ...(options?.preferredContentType ? { contentType: options.preferredContentType as any } : {}),
        });

        // Dedup check — skip if very similar content type posted recently
        const duplicate = await wasRecentlyPosted(post.contentType, 'x', 4);
        if (duplicate) {
            log.info(`Skipping ${post.contentType} — recently posted. Retrying with different type.`);
            const retry = await generatePost({ strategyContext: context });
            const retryDup = await wasRecentlyPosted(retry.contentType, 'x', 4);
            if (retryDup) {
                log.warn('Still duplicate after retry, skipping this cycle');
                return;
            }
            const externalId = await postTweet(retry.content);
            await savePost(retry, externalId ?? undefined);
            // Cross-post to Botchan if enabled
            if (options?.crossPostToBotchan && isNetConfigured) {
                const topic = contentTypeToBotchanTopic(retry.contentType);
                await postToFeed(retry.content, topic).catch(e =>
                    log.warn('Botchan cross-post failed (non-blocking)', { error: String(e).slice(0, 200) })
                );
            }
            return;
        }

        // Post it to X
        const externalId = await postTweet(post.content);

        // Save to memory
        await savePost(post, externalId ?? undefined);

        // Cross-post to Botchan feed if enabled (budget: ~$0.001 gas per post)
        if (options?.crossPostToBotchan && isNetConfigured) {
            const topic = contentTypeToBotchanTopic(post.contentType);
            await postToFeed(post.content, topic).catch(e =>
                log.warn('Botchan cross-post failed (non-blocking)', { error: String(e).slice(0, 200) })
            );
        }

        log.info(`✅ Content cycle complete: ${post.contentType} → X${options?.crossPostToBotchan ? ' + Botchan' : ''}`, {
            contentLength: post.content.length,
        });

        // Record against daily budget
        await recordAction('scheduled_post', `${post.contentType}: ${post.content.slice(0, 60)}`, externalId ?? undefined);
    } catch (error) {
        log.error('Content cycle failed', { error: String(error) });
    }
}

/**
 * Start the content scheduler.
 * 10 content posts/day spread across waking hours (UTC):
 * - 06:00 🌅 GM post (+ Botchan cross-post)
 * - 08:00 📊 Market/signal data
 * - 10:00 🧱 Builder narrative / founder journey
 * - 12:00 💡 Educational / methodology
 * - 14:00 🔥 Engagement / hot take
 * - 16:00 📦 Product spotlight
 * - 18:00 🤖 Self-aware / meta AI commentary
 * - 20:00 📈 Signal/performance / proof
 * - 22:00 🧠 Engagement bait / cult vibes
 * - 23:30 🌙 Evening reflection / builder log
 *
 * Learning engine crons:
 * - Daily (1 AM UTC):    Score posts + adapt weights
 * - Weekly (Sun 2 AM UTC): Meta-review (performance report)
 * - Daily (11:59 PM UTC): Summary to Net Protocol
 */
export function startScheduler(): void {
    log.info('Starting content scheduler (10 posts/day)...');

    if (!isXConfigured) {
        log.warn('X not configured! Scheduler has nothing to do.');
        return;
    }

    // ---- 10 Content Cycles / Day ----

    // 06:00 UTC — 🌅 GM post (+ Botchan cross-post)
    const gm = cron.schedule('0 6 * * *', async () => {
        log.info('🌅 GM cycle starting (+ Botchan cross-post)');
        await runContentCycle({ crossPostToBotchan: true, preferredContentType: 'gm_post' });
    }, { timezone: 'UTC' });
    activeTasks.push(gm);

    // 08:00 UTC — 📊 Market / signal data (WITH scorecard image)
    const marketData = cron.schedule('0 8 * * *', async () => {
        log.info('📊 Market data cycle starting (with scorecard image)');
        try {
            // Try to generate and post a scorecard image
            const scorecard = await generateScorecardImage();
            if (scorecard) {
                const externalId = await postTweetWithImage(scorecard.caption, scorecard.buffer);
                if (externalId) {
                    log.info('📊 Scorecard image posted', { tweetId: externalId });
                    await recordAction('scheduled_post', `signal_scorecard (image): ${scorecard.caption.slice(0, 60)}`, externalId);
                    return;
                }
            }
        } catch (error) {
            log.warn('Scorecard image failed, falling back to text', { error: String(error) });
        }
        // Fallback to text-only
        await runContentCycle({ preferredContentType: 'signal_scorecard' });
    }, { timezone: 'UTC' });
    activeTasks.push(marketData);

    // 10:00 UTC — 🧱 Builder narrative / founder journey (+ Botchan)
    const builder = cron.schedule('0 10 * * *', async () => {
        log.info('🧱 Builder narrative cycle starting (+ Botchan)');
        await runContentCycle({ crossPostToBotchan: true, preferredContentType: 'builder_narrative' });
    }, { timezone: 'UTC' });
    activeTasks.push(builder);

    // 12:00 UTC — 💡 Educational
    const educational = cron.schedule('0 12 * * *', async () => {
        log.info('💡 Educational cycle starting');
        await runContentCycle({ preferredContentType: 'educational' });
    }, { timezone: 'UTC' });
    activeTasks.push(educational);

    // 14:00 UTC — 🔥 Engagement / hot take (+ Botchan)
    const engagement = cron.schedule('0 14 * * *', async () => {
        log.info('🔥 Engagement cycle starting (+ Botchan)');
        await runContentCycle({ crossPostToBotchan: true, preferredContentType: 'engagement_bait' });
    }, { timezone: 'UTC' });
    activeTasks.push(engagement);

    // 16:00 UTC — 📦 Product spotlight
    const product = cron.schedule('0 16 * * *', async () => {
        log.info('📦 Product spotlight cycle starting');
        await runContentCycle({ preferredContentType: 'product_spotlight' });
    }, { timezone: 'UTC' });
    activeTasks.push(product);

    // 18:00 UTC — 🤖 Self-aware / meta AI (+ Botchan)
    const selfAware = cron.schedule('0 18 * * *', async () => {
        log.info('🤖 Self-aware cycle starting (+ Botchan)');
        await runContentCycle({ crossPostToBotchan: true, preferredContentType: 'self_aware' });
    }, { timezone: 'UTC' });
    activeTasks.push(selfAware);

    // 20:00 UTC — 📈 Signal performance / proof
    const performance = cron.schedule('0 20 * * *', async () => {
        log.info('📈 Performance cycle starting');
        await runContentCycle({ preferredContentType: 'win_streak' });
    }, { timezone: 'UTC' });
    activeTasks.push(performance);

    // 22:00 UTC — 🧠 Engagement bait / cult vibes (+ Botchan)
    const lateEngagement = cron.schedule('0 22 * * *', async () => {
        log.info('🧠 Late engagement cycle starting (+ Botchan)');
        await runContentCycle({ crossPostToBotchan: true, preferredContentType: 'founder_journey' });
    }, { timezone: 'UTC' });
    activeTasks.push(lateEngagement);

    // 23:30 UTC — 🌙 Evening reflection
    const evening = cron.schedule('30 23 * * *', async () => {
        log.info('🌙 Evening reflection cycle starting');
        await runContentCycle({ preferredContentType: 'social_proof' });
    }, { timezone: 'UTC' });
    activeTasks.push(evening);

    // ---- Creative Sessions (LLM-driven discretionary budget) ----

    // 4 creative sessions per day — QasidAI decides what to do
    const creative = cron.schedule('30 9,13,17,21 * * *', async () => {
        log.info('🎨 Creative session starting (QasidAI decides what to do)');
        try {
            const actions = await runCreativeSession();
            log.info(`🎨 Creative session complete: ${actions} actions taken`);
        } catch (error) {
            log.error('Creative session failed', { error: String(error) });
        }
    }, { timezone: 'UTC' });
    activeTasks.push(creative);
    log.info('🎨 Creative sessions active (9:30, 13:30, 17:30, 21:30 UTC — QasidAI decides)');

    // Daily at 0:30 AM UTC — Fetch engagement metrics from X API
    const engagementFetch = cron.schedule('30 0 * * *', async () => {
        log.info('📊 Fetching engagement metrics from X API...');
        try {
            const updated = await fetchAndUpdateEngagement();
            log.info(`📊 Engagement fetch complete: ${updated} posts updated`);
        } catch (error) {
            log.error('Engagement fetch failed', { error: String(error) });
        }
    }, { timezone: 'UTC' });
    activeTasks.push(engagementFetch);
    log.info('📊 Engagement fetch cron active (0:30 AM UTC)');

    // Daily at 1 AM UTC — Score old posts and adapt strategy weights
    const dailyLearning = cron.schedule('0 1 * * *', async () => {
        log.info('🧠 Daily learning cycle: fetch metrics → score → adapt weights');
        try {
            // Re-fetch metrics right before scoring for maximum freshness
            await fetchAndUpdateEngagement();
            await scoreOldPosts();
            await adaptWeights();
        } catch (error) {
            log.error('Daily learning cycle failed', { error: String(error) });
        }
    }, { timezone: 'UTC' });
    activeTasks.push(dailyLearning);
    log.info('🧠 Daily learning cron active (1 AM UTC — fetch + score + adapt weights)');

    // Weekly on Sundays at 2 AM UTC — Run meta-review
    const weeklyReview = cron.schedule('0 2 * * 0', async () => {
        log.info('📊 Weekly meta-review starting');
        try {
            await runMetaReview();
        } catch (error) {
            log.error('Weekly meta-review failed', { error: String(error) });
        }
    }, { timezone: 'UTC' });
    activeTasks.push(weeklyReview);
    log.info('📊 Weekly meta-review cron active (Sun 2 AM UTC)');

    // Daily at 3 AM UTC — Smart follow (follow engaged users)
    const smartFollow = cron.schedule('0 3 * * *', async () => {
        log.info('👥 Smart follow cycle starting');
        try {
            const followed = await runSmartFollow();
            log.info(`👥 Smart follow complete: ${followed} users followed`);
        } catch (error) {
            log.error('Smart follow failed', { error: String(error) });
        }
    }, { timezone: 'UTC' });
    activeTasks.push(smartFollow);
    log.info('👥 Smart follow cron active (3 AM UTC)');

    // End-of-day — 11:55 PM UTC — Daily summary to Net Protocol (before the 23:30 reflection)
    if (isNetConfigured) {
        const dailySummary = cron.schedule('55 23 * * *', async () => {
            log.info('⏰ End-of-day: writing daily summary to Net Protocol');
            try {
                await buildAndWriteDailySummary();
            } catch (error) {
                log.error('Daily summary failed', { error: String(error) });
            }
        }, { timezone: 'UTC' });
        activeTasks.push(dailySummary);
        log.info('📝 Daily summary cron active (11:55 PM UTC → Net Protocol)');
    }

    if (isNetConfigured) {
        log.info('⛓️  Botchan cross-post active (GM cycle → 1 post/day)');
    }

    log.info(`Scheduler started with ${activeTasks.length} cron jobs (10 posts/day)`);
}

/**
 * Stop the scheduler (kill switch).
 */
export function stopScheduler(): void {
    for (const task of activeTasks) {
        task.stop();
    }
    activeTasks.length = 0;
    log.info('Scheduler stopped');
}

/**
 * Run a single content cycle manually (for testing).
 */
export async function runOnce(): Promise<void> {
    log.info('Manual run for X');
    await runContentCycle();
}

/**
 * Run a single content cycle with Botchan cross-post (for testing).
 */
export async function runOnceWithBotchan(): Promise<void> {
    log.info('Manual run for X + Botchan');
    await runContentCycle({ crossPostToBotchan: true });
}
