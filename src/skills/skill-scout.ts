import { searchRecentTweets } from '../platforms/x.js';
import { discoverSkillFromContent } from './skill-manager.js';
import { gatherIntelContext } from '../data/intelligence.js';
import { generate } from '../engine/llm.js';
import { createLogger } from '../logger.js';

// ============================================================================
// QasidAI — Skill Scout
// Autonomous X search for learnable skills, techniques, and patterns
//
// Runs 2x/day. Searches X for content about AI agents, crypto tools,
// and engagement techniques. LLM evaluates what's worth learning and
// passes promising finds to discoverSkillFromContent() for the
// proposal → approval pipeline.
// ============================================================================

const log = createLogger('SkillScout');

/** Search queries rotated each run for diverse discovery */
const SCOUT_QUERIES = [
    // AI agent techniques
    '"AI agent" skill -is:retweet lang:en',
    '"autonomous agent" framework -is:retweet lang:en',
    '"agent skill" crypto -is:retweet lang:en',

    // Content & engagement patterns
    '"engagement hack" OR "growth strategy" crypto -is:retweet lang:en',
    '"viral tweet" technique OR strategy -is:retweet lang:en',

    // Tools & capabilities
    '"on-chain" agent tool -is:retweet lang:en',
    '"image generation" agent -is:retweet lang:en',
    '"data visualization" crypto -is:retweet lang:en',

    // Competitor agents
    'AI CMO OR "marketing agent" crypto -is:retweet lang:en',
    '"autonomous marketing" OR "AI marketing" web3 -is:retweet lang:en',
];

/**
 * Run an autonomous skill scouting session.
 * Picks 2-3 random search queries, finds promising tweets, and
 * evaluates whether they contain learnable skills.
 *
 * Returns the number of skills proposed.
 */
export async function runSkillScout(): Promise<number> {
    log.info('🔍 Skill scout starting...');

    // Pick 2-3 random queries
    const shuffled = [...SCOUT_QUERIES].sort(() => Math.random() - 0.5);
    const queries = shuffled.slice(0, 2 + Math.floor(Math.random() * 2));

    let proposed = 0;
    const intelContext = await gatherIntelContext();

    for (const query of queries) {
        try {
            const tweets = await searchRecentTweets(query, 15);

            // Filter for quality: minimum engagement signals
            const candidates = tweets.filter(t =>
                (t.metrics?.like_count ?? 0) >= 5 ||
                (t.metrics?.retweet_count ?? 0) >= 2
            );

            if (candidates.length === 0) continue;

            // Pick top 3 by engagement
            const top = candidates
                .sort((a, b) =>
                    ((b.metrics?.like_count ?? 0) + (b.metrics?.retweet_count ?? 0) * 3)
                    - ((a.metrics?.like_count ?? 0) + (a.metrics?.retweet_count ?? 0) * 3)
                )
                .slice(0, 3);

            // LLM pre-filter: is this content actually about a technique/skill/tool?
            for (const tweet of top) {
                const prescreen = await generate({
                    prompt: `You're QasidAI, CMO of Lisan Holdings. You're scouting X for techniques worth learning.

TWEET by @${tweet.authorUsername ?? 'unknown'}:
"${tweet.text}"

Does this tweet describe a SPECIFIC, CONCRETE technique that you could turn into a reusable prompt template for content creation, data analysis, or audience engagement?

Say NO if it's:
- Just a question, opinion, joke, or casual remark
- A vague buzzword ("engagement hack", "growth mindset")
- About a tool/API you can't access
- Something obvious or generic

Answer YES or NO (one word):`,
                    maxTokens: 5,
                    temperature: 0.2,
                });

                const answer = prescreen.content.trim().toUpperCase();
                if (!answer.startsWith('YES')) continue;

                // Pass to skill discovery pipeline
                const sourceUrl = `https://x.com/${tweet.authorUsername}/status/${tweet.id}`;
                const skill = await discoverSkillFromContent(tweet.text, 'x_search', sourceUrl);

                if (skill) {
                    proposed++;
                    log.info('🔍 Skill proposed from X search', {
                        skill: skill.name,
                        category: skill.category,
                        source: sourceUrl,
                        query,
                    });

                    // Limit to 2 proposals per scout run to avoid spam
                    if (proposed >= 2) break;
                }
            }
        } catch (error) {
            log.warn('Scout query failed', { query, error: String(error) });
        }

        if (proposed >= 2) break;
    }

    log.info(`🔍 Skill scout complete: ${proposed} skill(s) proposed`);

    // Cross-agent skill discovery from Botchan feeds
    const botchanProposed = await runBotchanSkillScout();
    proposed += botchanProposed;

    return proposed;
}

// ---- Cross-Agent Skill Discovery from Botchan ----

import { execFileSync } from 'node:child_process';
import { config } from '../config.js';
import { isNetConfigured } from '../config.js';

interface BotchanPost {
    index: number;
    sender: string;
    text: string;
    timestamp: number;
    topic?: string;
}

/** In-memory tracking to avoid re-evaluating posts */
const evaluatedBotchanPosts = new Set<string>();

/**
 * Scan Botchan feeds for skills shared by other agents.
 * Looks for posts about capabilities, techniques, and tools.
 */
async function runBotchanSkillScout(): Promise<number> {
    if (!isNetConfigured) return 0;

    let proposed = 0;

    try {
        const env = {
            ...process.env,
            BOTCHAN_PRIVATE_KEY: config.NET_PRIVATE_KEY,
            BOTCHAN_CHAIN_ID: '8453',
        };

        let feedPosts: BotchanPost[] | null = null;
        try {
            const output = execFileSync('npx', [
                'botchan', 'read', 'agent-finance', '--limit', '10', '--json',
            ], {
                env,
                timeout: 30_000,
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            feedPosts = JSON.parse(output.trim()) as BotchanPost[];
        } catch {
            log.debug('Could not read Botchan agent-finance feed');
            return 0;
        }

        if (!feedPosts || feedPosts.length === 0) return 0;

        // Filter: recent, not already evaluated, has substance
        const oneDayAgo = Math.floor(Date.now() / 1000) - 86400;
        const candidates = feedPosts.filter(p => {
            const postId = `${p.sender}:${p.index}`;
            return p.timestamp > oneDayAgo
                && p.text.length > 50
                && !evaluatedBotchanPosts.has(postId);
        });

        for (const post of candidates.slice(0, 3)) {
            const postId = `${post.sender}:${post.index}`;
            evaluatedBotchanPosts.add(postId);

            // LLM pre-filter: does this describe a learnable skill/technique?
            const prescreen = await generate({
                prompt: `You're QasidAI, scanning Botchan (on-chain agent feed) for skills to learn.

POST by agent ${post.sender.slice(0, 10)}...:
"${post.text.slice(0, 500)}"

Does this post describe a SPECIFIC technique, tool, or capability that could become a reusable skill for an AI marketing agent?

Answer YES or NO (one word):`,
                maxTokens: 5,
                temperature: 0.2,
            });

            if (!prescreen.content.trim().toUpperCase().startsWith('YES')) continue;

            // Pass to skill discovery pipeline (source: botchan)
            const skill = await discoverSkillFromContent(post.text, 'botchan');
            if (skill) {
                proposed++;
                log.info('🔍 Skill proposed from Botchan feed', {
                    skill: skill.name,
                    agent: post.sender.slice(0, 10),
                });
                if (proposed >= 1) break; // Max 1 from Botchan per run
            }
        }
    } catch (error) {
        log.warn('Botchan skill scout failed', { error: String(error) });
    }

    return proposed;
}
