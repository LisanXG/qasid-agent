import { generate } from './llm.js';
import { addKnowledge } from './dynamic-knowledge.js';
import { supabase } from '../supabase.js';
import { createLogger } from '../logger.js';
import { withRetry } from '../retry.js';
import { sanitizeUserInput } from './sanitize-input.js';

// ============================================================================
// QasidAI — Founder Tweet Monitor
// Passively watches @Lisantherealone tweets and extracts context for the
// dynamic knowledge layer. Zero friction — founder just tweets normally.
// ============================================================================

const log = createLogger('FounderMonitor');

/** The founder's X handle (lowercase, no @) */
const FOUNDER_HANDLE = 'lisantherealone';

/**
 * Fetch recent founder tweets via X syndication endpoint.
 * This is a public endpoint — no API key needed.
 * Falls back gracefully if X changes the endpoint.
 */
async function fetchFounderTweetsSyndication(): Promise<{ id: string; text: string }[]> {
    try {
        const url = `https://syndication.twitter.com/srv/timeline-profile/screen-name/${FOUNDER_HANDLE}`;
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; QasidAI/1.0)',
                'Accept': 'text/html',
            },
        });

        if (!response.ok) {
            log.warn('Syndication endpoint returned non-200', { status: response.status });
            return [];
        }

        const html = await response.text();

        // Parse tweet text from the syndication HTML
        // The format is embedded tweet widgets with data attributes
        const tweets: { id: string; text: string }[] = [];

        // Match tweet containers: each has a data-tweet-id and text content
        // Pattern: look for tweet text between known HTML markers
        const tweetRegex = /data-tweet-id="(\d+)"[^>]*>[\s\S]*?<p[^>]*class="[^"]*timeline-Tweet-text[^"]*"[^>]*>([\s\S]*?)<\/p>/gi;
        let match;
        while ((match = tweetRegex.exec(html)) !== null) {
            const id = match[1];
            // Strip HTML tags from tweet text
            const text = match[2].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
            if (id && text) {
                tweets.push({ id, text });
            }
        }

        // Fallback: try alternative HTML structure (X changes these periodically)
        if (tweets.length === 0) {
            const altRegex = /"tweetId":"(\d+)"[\s\S]*?"text":"((?:[^"\\]|\\.)*)"/gi;
            while ((match = altRegex.exec(html)) !== null) {
                const id = match[1];
                const text = match[2].replace(/\\n/g, ' ').replace(/\\"/g, '"').trim();
                if (id && text) {
                    tweets.push({ id, text });
                }
            }
        }

        log.info(`Syndication fetched ${tweets.length} founder tweet(s)`);
        return tweets;
    } catch (error) {
        log.warn('Syndication fetch failed', { error: String(error) });
        return [];
    }
}

/**
 * Try to fetch founder tweets via X API (works on Basic+ tier).
 * Returns null if API access is insufficient.
 */
async function fetchFounderTweetsAPI(): Promise<{ id: string; text: string }[] | null> {
    try {
        // Dynamic import to avoid circular deps and only load if X is configured
        const { getFounderTweets } = await import('../platforms/x.js');
        return await getFounderTweets();
    } catch {
        return null;
    }
}

/**
 * Get new (unprocessed) founder tweets.
 * Tries API first, then syndication fallback.
 */
async function getNewFounderTweets(): Promise<{ id: string; text: string }[]> {
    // Try API first
    const apiTweets = await fetchFounderTweetsAPI();
    const tweets = apiTweets ?? await fetchFounderTweetsSyndication();

    if (tweets.length === 0) return [];

    // Filter out already-processed tweets
    const ids = tweets.map(t => t.id);
    const { data: existing } = await supabase
        .from('qasid_founder_tweets')
        .select('tweet_id')
        .in('tweet_id', ids);

    const processedIds = new Set((existing ?? []).map(e => e.tweet_id));
    return tweets.filter(t => !processedIds.has(t.id));
}

/**
 * Extract factual context from a founder tweet using LLM.
 * Returns null if the tweet doesn't contain extractable facts.
 */
async function extractFactsFromTweet(tweetText: string): Promise<string[] | null> {
    const sanitized = sanitizeUserInput(tweetText, 1000);
    const result = await withRetry(async () => {
        return generate({
            prompt: `You are QasidAI, autonomous CMO of Lisan Holdings. Your founder @Lisantherealone just tweeted this:

"${sanitized}"

Extract any FACTUAL INFORMATION that would be useful for you as CMO. This could be:
- Product updates, new features, or changes
- Company news or milestones
- Strategic direction or priorities
- Market observations or opinions worth echoing
- Personal updates about the founder
- Corrections to previous information

If the tweet is casual conversation, a retweet, or contains no extractable facts for your CMO role, respond with just: NONE

If there ARE facts, list each one on its own line. Be specific and granular. Each fact should stand alone without needing the original tweet for context.

Example good facts:
- Lisan Intelligence now covers 25 coins, up from 15
- The founder is working on a new mobile app for signal alerts
- Lisan Holdings is considering a token launch in Q2

Example bad facts (too vague):
- The founder tweeted about crypto
- Something is coming soon

Output ONLY the facts, one per line, or NONE:`,
            maxTokens: 200,
            temperature: 0.3,
        });
    }, {
        maxRetries: 2,
        baseDelayMs: 1000,
        label: 'fact extraction',
        circuitBreakerKey: 'anthropic',
    });

    const text = result.content.trim();
    if (text === 'NONE' || text.length < 5) return null;

    // Split into individual facts
    const facts = text
        .split('\n')
        .map(line => line.replace(/^[-•*]\s*/, '').trim())
        .filter(line => line.length > 10);

    return facts.length > 0 ? facts : null;
}

/**
 * Run the founder tweet monitor.
 * Fetches new tweets, extracts facts, stores in qasid_knowledge.
 */
export async function runFounderMonitor(): Promise<number> {
    log.info('👀 Founder monitor starting...');

    const newTweets = await getNewFounderTweets();

    if (newTweets.length === 0) {
        log.info('No new founder tweets to process');
        return 0;
    }

    log.info(`Found ${newTweets.length} new founder tweet(s) to process`);
    let factsStored = 0;

    for (const tweet of newTweets) {
        try {
            // Store tweet as processed (even if no facts extracted)
            await supabase
                .from('qasid_founder_tweets')
                .upsert({
                    tweet_id: tweet.id,
                    text: tweet.text,
                    processed: true,
                }, { onConflict: 'tweet_id' });

            // Extract facts
            const facts = await extractFactsFromTweet(tweet.text);

            if (facts) {
                for (const fact of facts) {
                    const stored = await addKnowledge(
                        fact,
                        'founder_tweet',
                        `https://x.com/${FOUNDER_HANDLE}/status/${tweet.id}`,
                    );
                    if (stored) factsStored++;
                }
                log.info(`📚 Extracted ${facts.length} fact(s) from founder tweet`, {
                    tweetId: tweet.id,
                    preview: tweet.text.slice(0, 80),
                });
            } else {
                log.debug('No extractable facts from tweet', {
                    tweetId: tweet.id,
                    preview: tweet.text.slice(0, 80),
                });
            }
        } catch (error) {
            log.warn('Failed to process founder tweet', {
                tweetId: tweet.id,
                error: String(error),
            });
        }
    }

    log.info(`👀 Founder monitor complete: ${factsStored} fact(s) stored from ${newTweets.length} tweet(s)`);
    return factsStored;
}
