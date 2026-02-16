import cron from 'node-cron';
import { readFileSync } from 'fs';
import { runFounderMentionCheck } from '../engine/mention-monitor.js';
import { generatePost, generateThread, sanitizeContent } from '../engine/content.js';
import { savePost, wasRecentlyPosted } from '../engine/memory.js';
import { runBotchanReplyMonitor } from '../net/botchan-replies.js';
import { runBotchanEngagement } from '../net/botchan-engage.js';
import { postTweet, postTweetWithImage, postThread } from '../platforms/x.js';
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
import { recordAction, canTakeAction } from '../engine/daily-budget.js';
import { generateScorecardImage } from '../engine/scorecard-image.js';
import { runBotchanContentCycle } from '../net/botchan-content.js';
import { initializeSkills, syncSkillsToChain } from '../skills/skill-manager.js';
import { runSkillScout } from '../skills/skill-scout.js';
import { runBotchanSetup } from '../net/botchan-setup.js';
import { crossPostThreadToBotchan, crossPostBotchanToX } from '../net/cross-platform.js';
import { generateArticle } from '../engine/x-articles.js';
import { runFounderMonitor } from '../engine/founder-monitor.js';
import { runWebsiteMonitor } from '../engine/website-monitor.js';
import { runGitHubMonitor } from '../engine/github-monitor.js';
import { uploadFullBrain } from '../net/brain.js';
import { buildSystemPrompt } from '../personality/system-prompt.js';
import { brandKnowledge } from '../personality/brand-knowledge.js';
import { loadDynamicKnowledge } from '../engine/dynamic-knowledge.js';

// ============================================================================
// QasidAI — Content Scheduler
// Manages automated posting schedule to X (Twitter) + Botchan
// ============================================================================

const log = createLogger('Scheduler');

const activeTasks: cron.ScheduledTask[] = [];

/**
 * Run a single content cycle: generate + post to X + save to memory.
 */
async function runContentCycle(options?: {
    strategyContext?: string;
    preferredContentType?: string;
}): Promise<void> {
    if (!isXConfigured) {
        log.warn('X not configured — skipping content cycle');
        return;
    }

    // Pre-check budget before generating/posting (enforce budget as a gate)
    const allowed = await canTakeAction('scheduled_post');
    if (!allowed) {
        log.warn('Budget exhausted — skipping content cycle', {
            preferredType: options?.preferredContentType ?? 'random',
        });
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
            log.info(`Dedup: ${post.contentType} recently posted — retrying with different type`);
            const retry = await generatePost({ strategyContext: context, weights: { [post.contentType]: 0 } });
            const retryDup = await wasRecentlyPosted(retry.contentType, 'x', 4);
            if (retryDup) {
                log.info(`Dedup: ${retry.contentType} also recent — trying fully random`);
                const fallback = await generatePost({
                    strategyContext: context,
                    weights: { [post.contentType]: 0, [retry.contentType]: 0 },
                });
                // Third try — post regardless (don't silently drop)
                const budgetOk = await recordAction('scheduled_post', `${fallback.contentType}: ${fallback.content.slice(0, 60)}`);
                if (!budgetOk) {
                    log.warn('Budget reservation failed on dedup fallback — skipping post');
                    return;
                }
                const externalId = await postTweet(fallback.content);
                await savePost(fallback, externalId ?? undefined);
                log.info(`✅ Content cycle (dedup fallback): ${fallback.contentType} → X`);
                return;
            }
            // Reserve budget BEFORE posting
            const budgetOk = await recordAction('scheduled_post', `${retry.contentType}: ${retry.content.slice(0, 60)}`);
            if (!budgetOk) {
                log.warn('Budget reservation failed — skipping post');
                return;
            }
            const externalId = await postTweet(retry.content);
            await savePost(retry, externalId ?? undefined);
            log.info(`✅ Content cycle (dedup retry): ${retry.contentType} → X`);
            return;
        }

        // Reserve budget BEFORE posting (safer: wastes a slot if post fails, but prevents over-posting)
        const budgetOk = await recordAction('scheduled_post', `${post.contentType}: ${post.content.slice(0, 60)}`);
        if (!budgetOk) {
            log.warn('Budget reservation failed — skipping post');
            return;
        }

        // Post it to X
        const externalId = await postTweet(post.content);

        // Save to memory
        await savePost(post, externalId ?? undefined);

        log.info(`✅ Content cycle complete: ${post.contentType} → X`, {
            contentLength: post.content.length,
        });
    } catch (error) {
        log.error('Content cycle failed', { error: String(error) });
    }
}

/**
 * Start the content scheduler.
 * 10 content posts/day spread across waking hours (US Eastern):
 * - 06:00 🌅 GM post
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
 * - Daily (1 AM ET):    Score posts + adapt weights
 * - Weekly (Sun 2 AM ET): Meta-review (performance report)
 * - Daily (11:59 PM ET): Summary to Net Protocol
 */
export function startScheduler(): void {
    log.info('Starting content scheduler (10 posts/day)...');

    if (!isXConfigured) {
        log.warn('X not configured! Scheduler has nothing to do.');
        return;
    }

    // Initialize skills system (fire-and-forget, non-blocking)
    initializeSkills().catch(error => {
        log.warn('Skills initialization failed, continuing without skills', { error: String(error) });
    });

    // Set up Botchan profile + agent leaderboard (fire-and-forget, non-blocking)
    runBotchanSetup().catch(error => {
        log.warn('Botchan setup failed, continuing without profile', { error: String(error) });
    });

    // ---- 10 Content Cycles / Day ----

    // 06:00 ET — 🌅 GM post
    const gm = cron.schedule('0 6 * * *', async () => {
        log.info('🌅 GM cycle starting');
        await runContentCycle({ preferredContentType: 'gm_post' });
    }, { timezone: 'America/New_York' });
    activeTasks.push(gm);
    log.info('📌 Registered: 06:00 ET — GM post');

    // 08:00 ET — 📊 Market / signal data (WITH scorecard image)
    const marketData = cron.schedule('0 8 * * *', async () => {
        log.info('📊 Market data cycle starting (with scorecard image)');
        try {
            // Try to generate and post a scorecard image
            const scorecard = await generateScorecardImage();
            if (scorecard) {
                // Reserve budget BEFORE posting
                const budgetOk = await recordAction('scheduled_post', `signal_scorecard (image): ${scorecard.caption.slice(0, 60)}`);
                if (!budgetOk) {
                    log.warn('Budget reservation failed — skipping scorecard image');
                    return;
                }
                const externalId = await postTweetWithImage(scorecard.caption, scorecard.buffer);
                if (externalId) {
                    log.info('📊 Scorecard image posted', { tweetId: externalId });
                    return;
                }
            }
        } catch (error) {
            log.warn('Scorecard image failed, falling back to text', { error: String(error) });
        }
        // Fallback to text-only
        await runContentCycle({ preferredContentType: 'signal_scorecard' });
    }, { timezone: 'America/New_York' });
    activeTasks.push(marketData);

    // 10:00 ET — 🧱 Builder narrative / founder journey
    const builder = cron.schedule('0 10 * * *', async () => {
        log.info('🧱 Builder narrative cycle starting');
        await runContentCycle({ preferredContentType: 'builder_narrative' });
    }, { timezone: 'America/New_York' });
    activeTasks.push(builder);

    // 12:00 ET — 💡 Educational
    const educational = cron.schedule('0 12 * * *', async () => {
        log.info('💡 Educational cycle starting');
        await runContentCycle({ preferredContentType: 'educational' });
    }, { timezone: 'America/New_York' });
    activeTasks.push(educational);

    // 14:00 ET — 🔥 Engagement / hot take
    const engagement = cron.schedule('0 14 * * *', async () => {
        log.info('🔥 Engagement cycle starting');
        await runContentCycle({ preferredContentType: 'engagement_bait' });
    }, { timezone: 'America/New_York' });
    activeTasks.push(engagement);

    // 16:00 ET — 📦 Product spotlight
    const product = cron.schedule('0 16 * * *', async () => {
        log.info('📦 Product spotlight cycle starting');
        await runContentCycle({ preferredContentType: 'product_spotlight' });
    }, { timezone: 'America/New_York' });
    activeTasks.push(product);

    // 18:00 ET — 🤖 Self-aware / meta AI
    const selfAware = cron.schedule('0 18 * * *', async () => {
        log.info('🤖 Self-aware cycle starting');
        await runContentCycle({ preferredContentType: 'self_aware' });
    }, { timezone: 'America/New_York' });
    activeTasks.push(selfAware);

    // 20:00 ET — 📈 Signal performance / proof
    const performance = cron.schedule('0 20 * * *', async () => {
        log.info('📈 Performance cycle starting');
        await runContentCycle({ preferredContentType: 'win_streak' });
    }, { timezone: 'America/New_York' });
    activeTasks.push(performance);

    // 22:00 ET — 🧠 Engagement bait / cult vibes
    const lateEngagement = cron.schedule('0 22 * * *', async () => {
        log.info('🧠 Late engagement cycle starting');
        await runContentCycle({ preferredContentType: 'founder_journey' });
    }, { timezone: 'America/New_York' });
    activeTasks.push(lateEngagement);

    // 23:30 ET — 🌙 Evening reflection
    const evening = cron.schedule('30 23 * * *', async () => {
        log.info('🌙 Evening reflection cycle starting');
        await runContentCycle({ preferredContentType: 'social_proof' });
    }, { timezone: 'America/New_York' });
    activeTasks.push(evening);

    // ---- Creative Sessions (LLM-driven discretionary/reply budget) ----

    // 4 creative sessions per day — QasidAI decides what to do (reply, thread, quote, bonus)
    const creative = cron.schedule('30 9,13,17,21 * * *', async () => {
        log.info('🎨 Creative session starting (QasidAI decides what to do)');
        try {
            const actions = await runCreativeSession();
            log.info(`🎨 Creative session complete: ${actions} actions taken`);
        } catch (error) {
            log.error('Creative session failed', { error: String(error) });
        }
    }, { timezone: 'America/New_York' });
    activeTasks.push(creative);
    log.info('🎨 Creative sessions active (9:30, 13:30, 17:30, 21:30 ET — reply budget)');

    // ---- Timeline Scanner (proactive engagement — 3x/day) ----
    // Searches for relevant crypto/AI tweets and replies contextually.
    // Staggered from content posts and creative sessions.
    const timelineScan = cron.schedule('45 7,12,19 * * *', async () => {
        log.info('🔍 Timeline scan starting (proactive engagement)');
        try {
            const replies = await runTimelineScan();
            log.info(`🔍 Timeline scan complete: ${replies} replies posted`);
        } catch (error) {
            log.error('Timeline scan failed', { error: String(error) });
        }
    }, { timezone: 'America/New_York' });
    activeTasks.push(timelineScan);
    log.info('🔍 Timeline scanner active (7:45, 12:45, 19:45 ET — proactive engagement)');

    // ---- Botchan Native Content (5 unique posts for Net Protocol) ----

    // 9:00 ET — Botchan ecosystem insight or agent capability
    const botchanEarlyMorning = cron.schedule('0 9 * * *', async () => {
        log.info('⛓️ Botchan native content: ecosystem/capability post');
        try {
            const type = Math.random() > 0.5 ? 'ecosystem_insight' : 'agent_capability';
            await runBotchanContentCycle(type as any);
        } catch (error) {
            log.error('Botchan early morning post failed', { error: String(error) });
        }
    }, { timezone: 'America/New_York' });
    activeTasks.push(botchanEarlyMorning);

    // 11:00 ET — Botchan market analysis or signal breakdown
    const botchanMorning = cron.schedule('0 11 * * *', async () => {
        log.info('⛓️ Botchan native content: market/signal post');
        try {
            const type = Math.random() > 0.5 ? 'market_deep_dive' : 'signal_breakdown';
            await runBotchanContentCycle(type as any);
        } catch (error) {
            log.error('Botchan morning post failed', { error: String(error) });
        }
    }, { timezone: 'America/New_York' });
    activeTasks.push(botchanMorning);

    // 15:00 ET — Botchan net reflection / on-chain brain activity
    const botchanAfternoon = cron.schedule('0 15 * * *', async () => {
        log.info('⛓️ Botchan native content: net reflection / on-chain activity');
        try {
            const types = ['net_reflection', 'tool_spotlight', 'agent_capability'];
            const type = types[Math.floor(Math.random() * types.length)];
            const result = await runBotchanContentCycle(type as any);

            // Tease deeper Botchan posts on X
            if (result?.text) {
                crossPostBotchanToX(result.text, result.topic).catch(e =>
                    log.debug('Botchan-to-X teaser skipped', { error: String(e) })
                );
            }
        } catch (error) {
            log.error('Botchan afternoon post failed', { error: String(error) });
        }
    }, { timezone: 'America/New_York' });
    activeTasks.push(botchanAfternoon);

    // 19:00 ET — Botchan builder log, capability share, or GitHub share
    const botchanEvening = cron.schedule('0 19 * * *', async () => {
        log.info('⛓️ Botchan native content: builder/capability post');
        try {
            const types = ['builder_log', 'agent_capability', 'github_share', 'tool_spotlight'];
            const type = types[Math.floor(Math.random() * types.length)];
            const result = await runBotchanContentCycle(type as any);

            // Tease deeper Botchan posts on X
            if (result?.text) {
                crossPostBotchanToX(result.text, result.topic).catch(e =>
                    log.debug('Botchan-to-X teaser skipped', { error: String(e) })
                );
            }
        } catch (error) {
            log.error('Botchan evening post failed', { error: String(error) });
        }
    }, { timezone: 'America/New_York' });
    activeTasks.push(botchanEvening);

    // 21:00 ET — Botchan market wrap or builder log
    const botchanNight = cron.schedule('0 21 * * *', async () => {
        log.info('⛓️ Botchan native content: market wrap / builder log');
        try {
            const type = Math.random() > 0.5 ? 'market_deep_dive' : 'builder_log';
            await runBotchanContentCycle(type as any);
        } catch (error) {
            log.error('Botchan night post failed', { error: String(error) });
        }
    }, { timezone: 'America/New_York' });
    activeTasks.push(botchanNight);
    log.info('⛓️  Botchan native content active (9:00, 11:00, 15:00, 19:00, 21:00 ET)');

    // ---- Scheduled Threads (2x/day: 10:30 AM, 4:30 PM ET) ----
    const threadSlots = [
        { cron: '30 10 * * *', label: 'morning thread' },
        { cron: '30 16 * * *', label: 'afternoon thread' },
    ];
    for (const slot of threadSlots) {
        const threadJob = cron.schedule(slot.cron, async () => {
            const allowed = await canTakeAction('thread');
            if (!allowed) {
                log.debug(`Thread skipped (${slot.label}) — budget exhausted`);
                return;
            }
            log.info(`🧵 Scheduled ${slot.label} starting...`);
            try {
                const strategyContext = await getStrategyContext();
                const thread = await generateThread({ strategyContext });
                if (thread && thread.tweets.length >= 2) {
                    await recordAction('thread', `Thread: ${thread.tweets[0].slice(0, 50)}`);
                    const tweetIds = await postThread(thread.tweets);
                    await savePost({
                        content: thread.tweets.join('\n---\n'),
                        contentType: thread.contentType,
                        platform: 'x',
                        tone: 'informative',
                        topic: thread.topic,
                        inputTokens: thread.inputTokens,
                        outputTokens: thread.outputTokens,
                        generatedAt: new Date().toISOString(),
                    }, tweetIds[0] ?? undefined);
                    log.info(`🧵 ${slot.label} posted (${thread.tweets.length} tweets)`);

                    // Cross-post thread summary to Botchan
                    crossPostThreadToBotchan(thread.tweets, tweetIds).catch(e =>
                        log.debug('Thread cross-post to Botchan skipped', { error: String(e) })
                    );
                }
            } catch (error) {
                log.error(`Scheduled ${slot.label} failed`, { error: String(error) });
            }
        }, { timezone: 'America/New_York' });
        activeTasks.push(threadJob);
    }
    log.info('🧵 Scheduled threads active (10:30 AM, 4:30 PM ET)');

    // Daily at 0:30 AM ET — Fetch engagement metrics from X API
    const engagementFetch = cron.schedule('30 0 * * *', async () => {
        log.info('📊 Fetching engagement metrics from X API...');
        try {
            const updated = await fetchAndUpdateEngagement();
            log.info(`📊 Engagement fetch complete: ${updated} posts updated`);
        } catch (error) {
            log.error('Engagement fetch failed', { error: String(error) });
        }
    }, { timezone: 'America/New_York' });
    activeTasks.push(engagementFetch);
    log.info('📊 Engagement fetch cron active (0:30 AM ET)');

    // Daily at 1 AM ET — Score old posts and adapt strategy weights
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
    }, { timezone: 'America/New_York' });
    activeTasks.push(dailyLearning);
    log.info('🧠 Daily learning cron active (1 AM ET — fetch + score + adapt weights)');

    // Daily at 1:30 AM ET — Sync skills to Net Protocol
    if (isNetConfigured) {
        const skillSync = cron.schedule('30 1 * * *', async () => {
            log.info('🧠 Syncing skills to Net Protocol...');
            try {
                await syncSkillsToChain();
            } catch (error) {
                log.error('Skill sync failed', { error: String(error) });
            }
        }, { timezone: 'America/New_York' });
        activeTasks.push(skillSync);
        log.info('🧠 Skill sync cron active (1:30 AM ET)');
    }

    // Weekly on Sundays at 2 AM ET — Run meta-review
    const weeklyReview = cron.schedule('0 2 * * 0', async () => {
        log.info('📊 Weekly meta-review starting');
        try {
            await runMetaReview();
        } catch (error) {
            log.error('Weekly meta-review failed', { error: String(error) });
        }
    }, { timezone: 'America/New_York' });
    activeTasks.push(weeklyReview);
    log.info('📊 Weekly meta-review cron active (Sun 2 AM ET)');

    // Daily at 3 AM ET — Smart follow (follow engaged users)
    const smartFollow = cron.schedule('0 3 * * *', async () => {
        log.info('👥 Smart follow cycle starting');
        try {
            const followed = await runSmartFollow();
            log.info(`👥 Smart follow complete: ${followed} users followed`);
        } catch (error) {
            log.error('Smart follow failed', { error: String(error) });
        }
    }, { timezone: 'America/New_York' });
    activeTasks.push(smartFollow);
    log.info('👥 Smart follow cron active (3 AM ET)');

    // End-of-day — 11:55 PM ET — Daily summary to Net Protocol (before the 23:30 reflection)
    if (isNetConfigured) {
        const dailySummary = cron.schedule('55 23 * * *', async () => {
            log.info('⏰ End-of-day: writing daily summary to Net Protocol');
            try {
                await buildAndWriteDailySummary();
            } catch (error) {
                log.error('Daily summary failed', { error: String(error) });
            }
        }, { timezone: 'America/New_York' });
        activeTasks.push(dailySummary);
        log.info('📝 Daily summary cron active (11:55 PM ET → Net Protocol)');
    }



    // ---- Founder VIP Mention Monitor (every 15 min) ----
    const founderMentions = cron.schedule('*/15 * * * *', async () => {
        log.debug('👑 Founder mention check running...');
        try {
            const replied = await runFounderMentionCheck();
            if (replied > 0) {
                log.info(`👑 Founder mention check: replied to ${replied} mention(s)`);
            }
        } catch (error) {
            log.error('Founder mention check failed', { error: String(error) });
        }
    }, { timezone: 'America/New_York' });
    activeTasks.push(founderMentions);
    log.info('👑 Founder VIP mention monitor active (every 15 min)');

    // ---- General Mention Monitor (every 30 min) ----
    const mentionMonitor = cron.schedule('*/30 * * * *', async () => {
        log.debug('💬 General mention monitor running...');
        try {
            const replied = await runMentionMonitor();
            if (replied > 0) {
                log.info(`💬 Mention monitor: replied to ${replied} mention(s)`);
            }
        } catch (error) {
            log.error('Mention monitor failed', { error: String(error) });
        }
    }, { timezone: 'America/New_York' });
    activeTasks.push(mentionMonitor);
    log.info('💬 General mention monitor active (every 30 min)');

    // ---- Skill Scout (2x/day: 10:15 and 22:15 UTC — staggered to avoid cron collision) ----
    const skillScoutAM = cron.schedule('15 10 * * *', async () => {
        log.info('🔍 Skill scout (AM) starting...');
        try {
            const proposed = await runSkillScout();
            log.info(`🔍 Skill scout (AM): ${proposed} skill(s) proposed`);
        } catch (error) {
            log.error('Skill scout (AM) failed', { error: String(error) });
        }
    }, { timezone: 'America/New_York' });
    activeTasks.push(skillScoutAM);

    const skillScoutPM = cron.schedule('15 22 * * *', async () => {
        log.info('🔍 Skill scout (PM) starting...');
        try {
            const proposed = await runSkillScout();
            log.info(`🔍 Skill scout (PM): ${proposed} skill(s) proposed`);
        } catch (error) {
            log.error('Skill scout (PM) failed', { error: String(error) });
        }
    }, { timezone: 'America/New_York' });
    activeTasks.push(skillScoutPM);
    log.info('🔍 Skill scout active (2x/day: 10:15 & 22:15 ET — staggered from content posts)');

    // ---- Founder Tweet Monitor (every 2 hours) ----
    const founderMonitor = cron.schedule('5 */2 * * *', async () => {
        log.debug('👁️ Founder monitor running...');
        try {
            const facts = await runFounderMonitor();
            if (facts > 0) {
                log.info(`👁️ Founder monitor: stored ${facts} new fact(s)`);
            }
        } catch (error) {
            log.error('Founder monitor failed', { error: String(error) });
        }
    }, { timezone: 'America/New_York' });
    activeTasks.push(founderMonitor);
    log.info('👁️ Founder tweet monitor active (every 2 hours)');

    // ---- Website Monitor (daily at 4:00 AM ET) ----
    const websiteMonitor = cron.schedule('0 4 * * *', async () => {
        log.info('🌐 Website monitor running...');
        try {
            const facts = await runWebsiteMonitor();
            log.info(`🌐 Website monitor: ${facts} new fact(s)`);
        } catch (error) {
            log.error('Website monitor failed', { error: String(error) });
        }
    }, { timezone: 'America/New_York' });
    activeTasks.push(websiteMonitor);
    log.info('🌐 Website monitor active (daily 4:00 AM ET)');

    // ---- GitHub Org Monitor (daily at 4:30 AM ET) ----
    const githubMonitor = cron.schedule('30 4 * * *', async () => {
        log.info('🐙 GitHub monitor running...');
        try {
            const facts = await runGitHubMonitor();
            log.info(`🐙 GitHub monitor: ${facts} new fact(s)`);
        } catch (error) {
            log.error('GitHub monitor failed', { error: String(error) });
        }
    }, { timezone: 'America/New_York' });
    activeTasks.push(githubMonitor);
    log.info('🐙 GitHub org monitor active (daily 4:30 AM ET)');

    // ---- Auto Brain Sync to Net Protocol (daily at 3:00 AM ET) ----
    if (isNetConfigured) {
        const brainSync = cron.schedule('0 3 * * *', async () => {
            log.info('🧠 Auto brain sync starting...');
            try {
                const personality = buildSystemPrompt();
                const brand = JSON.stringify(brandKnowledge, null, 2);
                const dynKnowledge = await loadDynamicKnowledge();
                const fullPersonality = dynKnowledge
                    ? `${personality}\n\n${dynKnowledge}`
                    : personality;

                // Read documentation file for Net storage sync
                let documentation: string | undefined;
                try {
                    documentation = readFileSync('QASIDAI_DOCUMENTATION.txt', 'utf-8');
                } catch {
                    log.debug('Documentation file not found, skipping doc sync');
                }

                await uploadFullBrain(fullPersonality, brand, documentation);
                log.info('🧠 Auto brain sync complete');
            } catch (error) {
                log.error('Auto brain sync failed', { error: String(error) });
            }
        }, { timezone: 'America/New_York' });
        activeTasks.push(brainSync);
        log.info('🧠 Auto brain sync active (daily 3:00 AM ET)');
    }

    // ---- Botchan Reply Monitor (every 30 min) ----
    if (isNetConfigured) {
        const botchanReplies = cron.schedule('*/30 * * * *', async () => {
            log.debug('📨 Botchan reply monitor running...');
            try {
                const replied = await runBotchanReplyMonitor();
                if (replied > 0) {
                    log.info(`📨 Botchan reply monitor: sent ${replied} reply(ies)`);
                }
            } catch (error) {
                log.error('Botchan reply monitor failed', { error: String(error) });
            }
        }, { timezone: 'America/New_York' });
        activeTasks.push(botchanReplies);
        log.info('📨 Botchan reply monitor active (every 30 min)');

        // ---- Proactive Botchan Engagement (every 3 hours) ----
        const botchanEngage = cron.schedule('0 */3 * * *', async () => {
            log.debug('🤝 Botchan engagement cycle running...');
            try {
                const engaged = await runBotchanEngagement();
                if (engaged > 0) {
                    log.info(`🤝 Botchan engagement: ${engaged} interaction(s)`);
                }
            } catch (error) {
                log.error('Botchan engagement failed', { error: String(error) });
            }
        }, { timezone: 'America/New_York' });
        activeTasks.push(botchanEngage);
        log.info('🤝 Botchan proactive engagement active (every 3 hours)');

        // ---- Weekly X Article Generation (Wednesday 5:00 AM ET) ----
        const articleJob = cron.schedule('0 5 * * 3', async () => {
            log.info('📝 Generating weekly X Article...');
            try {
                const article = await generateArticle();
                if (article) {
                    log.info(`📝 Article ready: "${article.title}" (${article.wordCount} words) — check Supabase to publish`);
                } else {
                    log.warn('Article generation returned null');
                }
            } catch (error) {
                log.error('Weekly article generation failed', { error: String(error) });
            }
        }, { timezone: 'America/New_York' });
        activeTasks.push(articleJob);
        log.info('📝 Weekly X Article generation active (Wednesday 5:00 AM ET)');
    }

    log.info(`Scheduler started with ${activeTasks.length} cron jobs (10 X posts + 5 Botchan posts + 20 reply budget + monitors)`);
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
 * Run a single Botchan content cycle manually (for testing).
 */
export async function runOnceWithBotchan(): Promise<void> {
    log.info('Manual run for Botchan');
    await runBotchanContentCycle();
}

/**
 * Run a single knowledge sync cycle manually (for testing).
 */
export { runFounderMonitor } from '../engine/founder-monitor.js';
export { runWebsiteMonitor } from '../engine/website-monitor.js';
export { runGitHubMonitor } from '../engine/github-monitor.js';
