import cron from 'node-cron';
import { generatePost } from '../engine/content.js';
import { savePost, wasRecentlyPosted } from '../engine/memory.js';
import { postTweet } from '../platforms/x.js';
import { isXConfigured, isNetConfigured } from '../config.js';
import { createLogger } from '../logger.js';
import { buildAndWriteDailySummary } from '../net/daily-summary.js';
import { scoreOldPosts } from '../learning/scorer.js';
import { adaptWeights, getStrategyContext } from '../learning/weights.js';
import { runMetaReview } from '../learning/meta-review.js';
import { postToFeed } from '../net/client.js';

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
async function runContentCycle(options?: { strategyContext?: string; crossPostToBotchan?: boolean }): Promise<void> {
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
        // Generate content
        const post = await generatePost({ strategyContext: context });

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
        await runContentCycle({ crossPostToBotchan: true });
    }, { timezone: 'UTC' });
    activeTasks.push(gm);

    // 08:00 UTC — 📊 Market / signal data
    const marketData = cron.schedule('0 8 * * *', async () => {
        log.info('📊 Market data cycle starting');
        await runContentCycle();
    }, { timezone: 'UTC' });
    activeTasks.push(marketData);

    // 10:00 UTC — 🧱 Builder narrative / founder journey (+ Botchan)
    const builder = cron.schedule('0 10 * * *', async () => {
        log.info('🧱 Builder narrative cycle starting (+ Botchan)');
        await runContentCycle({ crossPostToBotchan: true });
    }, { timezone: 'UTC' });
    activeTasks.push(builder);

    // 12:00 UTC — 💡 Educational
    const educational = cron.schedule('0 12 * * *', async () => {
        log.info('💡 Educational cycle starting');
        await runContentCycle();
    }, { timezone: 'UTC' });
    activeTasks.push(educational);

    // 14:00 UTC — 🔥 Engagement / hot take (+ Botchan)
    const engagement = cron.schedule('0 14 * * *', async () => {
        log.info('🔥 Engagement cycle starting (+ Botchan)');
        await runContentCycle({ crossPostToBotchan: true });
    }, { timezone: 'UTC' });
    activeTasks.push(engagement);

    // 16:00 UTC — 📦 Product spotlight
    const product = cron.schedule('0 16 * * *', async () => {
        log.info('📦 Product spotlight cycle starting');
        await runContentCycle();
    }, { timezone: 'UTC' });
    activeTasks.push(product);

    // 18:00 UTC — 🤖 Self-aware / meta AI (+ Botchan)
    const selfAware = cron.schedule('0 18 * * *', async () => {
        log.info('🤖 Self-aware cycle starting (+ Botchan)');
        await runContentCycle({ crossPostToBotchan: true });
    }, { timezone: 'UTC' });
    activeTasks.push(selfAware);

    // 20:00 UTC — 📈 Signal performance / proof
    const performance = cron.schedule('0 20 * * *', async () => {
        log.info('📈 Performance cycle starting');
        await runContentCycle();
    }, { timezone: 'UTC' });
    activeTasks.push(performance);

    // 22:00 UTC — 🧠 Engagement bait / cult vibes (+ Botchan)
    const lateEngagement = cron.schedule('0 22 * * *', async () => {
        log.info('🧠 Late engagement cycle starting (+ Botchan)');
        await runContentCycle({ crossPostToBotchan: true });
    }, { timezone: 'UTC' });
    activeTasks.push(lateEngagement);

    // 23:30 UTC — 🌙 Evening reflection
    const evening = cron.schedule('30 23 * * *', async () => {
        log.info('🌙 Evening reflection cycle starting');
        await runContentCycle();
    }, { timezone: 'UTC' });
    activeTasks.push(evening);

    // ---- Learning Engine Crons ----

    // Daily at 1 AM UTC — Score old posts and adapt strategy weights
    const dailyLearning = cron.schedule('0 1 * * *', async () => {
        log.info('🧠 Daily learning cycle: scoring posts + adapting weights');
        try {
            await scoreOldPosts();
            await adaptWeights();
        } catch (error) {
            log.error('Daily learning cycle failed', { error: String(error) });
        }
    }, { timezone: 'UTC' });
    activeTasks.push(dailyLearning);
    log.info('🧠 Daily learning cron active (1 AM UTC — score + adapt weights)');

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
