import { TwitterApi } from 'twitter-api-v2';
import { config, isXConfigured } from '../config.js';
import { createLogger } from '../logger.js';

// ============================================================================
// QasidAI — X (Twitter) Connector
// Posts tweets and threads using the X API v2
// ============================================================================

const log = createLogger('X');

let client: TwitterApi | null = null;

function getClient(): TwitterApi {
    if (!client) {
        if (!isXConfigured) {
            throw new Error('X API credentials not configured. Set X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET in .env');
        }
        client = new TwitterApi({
            appKey: config.X_API_KEY!,
            appSecret: config.X_API_SECRET!,
            accessToken: config.X_ACCESS_TOKEN!,
            accessSecret: config.X_ACCESS_SECRET!,
        });
    }
    return client;
}

/**
 * Post a single tweet. Returns the tweet ID.
 */
export async function postTweet(text: string): Promise<string | null> {
    if (!config.POSTING_ENABLED) {
        log.info('[DRY RUN] Would post tweet:', { text });
        return `dry-run-${Date.now()}`;
    }

    try {
        const result = await getClient().v2.tweet(text);
        log.info('Tweet posted', { id: result.data.id, length: text.length });
        return result.data.id;
    } catch (error: any) {
        // Retry once on rate limit (429)
        if (error?.code === 429 || error?.data?.status === 429) {
            log.warn('Rate limited by X API, retrying in 60s...');
            await new Promise(resolve => setTimeout(resolve, 60_000));
            try {
                const retry = await getClient().v2.tweet(text);
                log.info('Tweet posted (after rate limit retry)', { id: retry.data.id });
                return retry.data.id;
            } catch (retryError) {
                log.error('Failed to post tweet after rate limit retry', { error: String(retryError) });
                return null;
            }
        }
        log.error('Failed to post tweet', { error: String(error) });
        return null;
    }
}

/**
 * Post a thread (array of tweets). Returns the IDs of all tweets.
 */
export async function postThread(tweets: string[]): Promise<string[]> {
    if (!config.POSTING_ENABLED) {
        log.info('[DRY RUN] Would post thread:', { tweets });
        return tweets.map((_, i) => `dry-run-thread-${i}-${Date.now()}`);
    }

    const ids: string[] = [];
    let replyToId: string | undefined;

    for (const tweet of tweets) {
        try {
            const options = replyToId ? { reply: { in_reply_to_tweet_id: replyToId } } : {};
            const result = await getClient().v2.tweet(tweet, options);
            ids.push(result.data.id);
            replyToId = result.data.id;
            log.info('Thread tweet posted', { id: result.data.id, position: ids.length });
        } catch (error) {
            log.error('Failed to post thread tweet', { error: String(error), position: ids.length + 1 });
            break;
        }
    }

    return ids;
}

/**
 * Post a tweet with an image attachment. Returns the tweet ID.
 * @param text Tweet text
 * @param imageBuffer The image data as a Buffer
 * @param mimeType MIME type of the image (default: image/png)
 */
export async function postTweetWithImage(
    text: string,
    imageBuffer: Buffer,
    mimeType: string = 'image/png',
): Promise<string | null> {
    if (!config.POSTING_ENABLED) {
        log.info('[DRY RUN] Would post tweet with image:', { text, imageSize: imageBuffer.length });
        return `dry-run-img-${Date.now()}`;
    }

    try {
        // Upload the image via v1 media upload
        const mediaId = await getClient().v1.uploadMedia(imageBuffer, {
            mimeType,
        });
        log.info('Image uploaded to X', { mediaId, size: imageBuffer.length });

        // Post tweet with the uploaded media
        const result = await getClient().v2.tweet(text, {
            media: { media_ids: [mediaId] },
        });
        log.info('Tweet with image posted', { id: result.data.id, length: text.length });
        return result.data.id;
    } catch (error: any) {
        log.error('Failed to post tweet with image', { error: String(error) });
        return null;
    }
}

// ============================================================================
// X API Diagnostics — Test what the current credentials can do
// ============================================================================

let cachedUserId: string | null = null;

/**
 * Get the authenticated user's ID (cached after first call).
 */
export async function getMyUserId(): Promise<string> {
    if (cachedUserId) return cachedUserId;
    const me = await getClient().v2.me();
    cachedUserId = me.data.id;
    return cachedUserId;
}

export interface XCapabilityResult {
    name: string;
    status: 'pass' | 'fail' | 'skip';
    detail: string;
}

/**
 * Run a comprehensive diagnostic of X API capabilities.
 * Tests: auth, profile read, mentions, tweet metrics, search, DMs.
 */
export async function checkXCapabilities(): Promise<XCapabilityResult[]> {
    const results: XCapabilityResult[] = [];

    // 1. Auth check — can we read our own profile?
    let userId: string | null = null;
    try {
        const me = await getClient().v2.me({ 'user.fields': ['public_metrics', 'description'] });
        userId = me.data.id;
        cachedUserId = userId;
        const metrics = me.data.public_metrics;
        results.push({
            name: 'Auth + Profile Read',
            status: 'pass',
            detail: `@${me.data.username} (ID: ${userId}) | ${metrics?.followers_count ?? '?'} followers | ${metrics?.tweet_count ?? '?'} tweets`,
        });
    } catch (error: any) {
        results.push({
            name: 'Auth + Profile Read',
            status: 'fail',
            detail: `Auth failed: ${String(error).slice(0, 150)}`,
        });
        // If auth fails, everything else will too
        return results;
    }

    // 2. Read mentions timeline
    try {
        const mentions = await getClient().v2.userMentionTimeline(userId!, {
            max_results: 5,
            'tweet.fields': ['created_at', 'author_id', 'text'],
        });
        const count = mentions.data?.data?.length ?? 0;
        results.push({
            name: 'Read Mentions',
            status: 'pass',
            detail: `${count} recent mention(s) found`,
        });
    } catch (error: any) {
        const msg = String(error);
        const isForbidden = msg.includes('403') || msg.includes('Forbidden');
        results.push({
            name: 'Read Mentions',
            status: 'fail',
            detail: isForbidden
                ? 'Forbidden (403) — Free tier does not support reading mentions. Upgrade to Basic ($100/mo).'
                : `Error: ${msg.slice(0, 150)}`,
        });
    }

    // 3. Tweet lookup with public_metrics
    try {
        // Use our own user timeline to get a tweet ID for testing
        const timeline = await getClient().v2.userTimeline(userId!, {
            max_results: 5,
            'tweet.fields': ['public_metrics', 'created_at'],
        });
        const tweets = timeline.data?.data ?? [];
        if (tweets.length > 0) {
            const t = tweets[0];
            const m = t.public_metrics;
            results.push({
                name: 'Tweet Metrics (public_metrics)',
                status: 'pass',
                detail: `Latest tweet: ${m?.like_count ?? 0} likes, ${m?.reply_count ?? 0} replies, ${m?.impression_count ?? 0} impressions`,
            });
        } else {
            results.push({
                name: 'Tweet Metrics (public_metrics)',
                status: 'pass',
                detail: 'Timeline readable but no tweets found',
            });
        }
    } catch (error: any) {
        const msg = String(error);
        const isForbidden = msg.includes('403') || msg.includes('Forbidden');
        results.push({
            name: 'Tweet Metrics (public_metrics)',
            status: 'fail',
            detail: isForbidden
                ? 'Forbidden (403) — Free tier does not support reading tweets. Upgrade to Basic ($100/mo).'
                : `Error: ${msg.slice(0, 150)}`,
        });
    }

    // 4. Search recent tweets
    try {
        const search = await getClient().v2.search('"crypto trading" OR "AI agent"', {
            max_results: 10,
            'tweet.fields': ['created_at', 'author_id'],
        });
        const count = search.data?.data?.length ?? 0;
        results.push({
            name: 'Search Tweets',
            status: 'pass',
            detail: `${count} result(s) for test query`,
        });
    } catch (error: any) {
        const msg = String(error);
        const isForbidden = msg.includes('403') || msg.includes('Forbidden');
        results.push({
            name: 'Search Tweets',
            status: 'fail',
            detail: isForbidden
                ? 'Forbidden (403) — Free tier does not support search. Upgrade to Basic ($100/mo).'
                : `Error: ${msg.slice(0, 150)}`,
        });
    }

    // 5. DM check — try to list DM conversations
    try {
        const dms = await getClient().v2.listDmEvents({ 'dm_event.fields': ['created_at'] });
        results.push({
            name: 'Direct Messages',
            status: 'pass',
            detail: `DM access available (${dms.data?.data?.length ?? 0} recent event(s))`,
        });
    } catch (error: any) {
        const msg = String(error);
        const isForbidden = msg.includes('403') || msg.includes('Forbidden');
        const isNotFound = msg.includes('404') || msg.includes('Not Found');
        results.push({
            name: 'Direct Messages',
            status: 'fail',
            detail: isForbidden || isNotFound
                ? 'Not available — DMs may require Basic tier or elevated OAuth2 access.'
                : `Error: ${msg.slice(0, 150)}`,
        });
    }

    // 6. Write check (we don't actually post, just confirm POSTING_ENABLED status)
    results.push({
        name: 'Write (Post Tweets)',
        status: config.POSTING_ENABLED ? 'pass' : 'skip',
        detail: config.POSTING_ENABLED
            ? 'POSTING_ENABLED=true — live posting active'
            : 'POSTING_ENABLED=false — dry run mode (safe)',
    });

    return results;
}

// ============================================================================
// X API Interactions — Reply, Follow, Mentions, Metrics, Search
// ============================================================================

export interface PublicMetrics {
    like_count: number;
    reply_count: number;
    retweet_count: number;
    quote_count: number;
    impression_count: number;
    bookmark_count: number;
}

export interface MentionTweet {
    id: string;
    text: string;
    authorId: string;
    authorUsername?: string;
    createdAt?: string;
    conversationId?: string;
    inReplyToUserId?: string;
}

export interface SearchResult {
    id: string;
    text: string;
    authorId: string;
    authorUsername?: string;
    createdAt?: string;
    metrics?: PublicMetrics;
}

/**
 * Fetch a single tweet by ID. Returns text and author info.
 * Useful for fetching parent tweet context when replying in threads.
 */
export async function getTweetById(tweetId: string): Promise<{ text: string; authorUsername?: string } | null> {
    try {
        const response = await getClient().v2.tweets([tweetId], {
            'tweet.fields': ['author_id', 'text', 'created_at'],
            expansions: ['author_id'],
            'user.fields': ['username'],
        });
        const tweet = response.data?.[0];
        if (!tweet) return null;

        const users = response.includes?.users ?? [];
        const author = users.find(u => u.id === tweet.author_id);

        return {
            text: tweet.text,
            authorUsername: author?.username,
        };
    } catch (error: any) {
        log.error('Failed to fetch tweet by ID', { error: String(error), tweetId });
        return null;
    }
}

/**
 * Reply to a specific tweet. Returns the reply tweet ID.
 */
export async function replyToTweet(tweetId: string, text: string): Promise<string | null> {
    if (!config.POSTING_ENABLED) {
        log.info('[DRY RUN] Would reply to tweet:', { tweetId, text });
        return `dry-run-reply-${Date.now()}`;
    }

    try {
        const result = await getClient().v2.tweet(text, {
            reply: { in_reply_to_tweet_id: tweetId },
        });
        log.info('Reply posted', { replyId: result.data.id, inReplyTo: tweetId });
        return result.data.id;
    } catch (error: any) {
        if (error?.code === 429 || error?.data?.status === 429) {
            log.warn('Rate limited on reply, retrying in 60s...');
            await new Promise(resolve => setTimeout(resolve, 60_000));
            try {
                const retry = await getClient().v2.tweet(text, {
                    reply: { in_reply_to_tweet_id: tweetId },
                });
                log.info('Reply posted (after rate limit retry)', { replyId: retry.data.id });
                return retry.data.id;
            } catch (retryError) {
                log.error('Failed to reply after rate limit retry', { error: String(retryError) });
                return null;
            }
        }
        log.error('Failed to reply to tweet', { error: String(error), tweetId });
        return null;
    }
}

/**
 * Follow a user by their user ID. Returns true on success.
 */
export async function followUser(userId: string): Promise<boolean> {
    if (!config.POSTING_ENABLED) {
        log.info('[DRY RUN] Would follow user:', { userId });
        return true;
    }

    try {
        const myId = await getMyUserId();
        await getClient().v2.follow(myId, userId);
        log.info('Followed user', { userId });
        return true;
    } catch (error: any) {
        if (error?.code === 429 || error?.data?.status === 429) {
            log.warn('Rate limited on follow, retrying in 60s...');
            await new Promise(resolve => setTimeout(resolve, 60_000));
            try {
                const myId = await getMyUserId();
                await getClient().v2.follow(myId, userId);
                log.info('Followed user (after rate limit retry)', { userId });
                return true;
            } catch (retryError) {
                log.error('Failed to follow after rate limit retry', { error: String(retryError), userId });
                return false;
            }
        }
        log.error('Failed to follow user', { error: String(error), userId });
        return false;
    }
}

/**
 * Fetch recent mentions of the authenticated user.
 * @param sinceId Only return mentions newer than this tweet ID
 * @param maxResults Max number of results (5-100, default 10)
 */
export async function getMentions(sinceId?: string, maxResults: number = 10): Promise<MentionTweet[]> {
    try {
        const userId = await getMyUserId();
        const params: Record<string, any> = {
            max_results: Math.min(Math.max(maxResults, 5), 100),
            'tweet.fields': ['created_at', 'author_id', 'conversation_id', 'in_reply_to_user_id'],
            expansions: ['author_id'],
            'user.fields': ['username'],
        };
        if (sinceId) params.since_id = sinceId;

        const response = await getClient().v2.userMentionTimeline(userId, params);
        const tweets = response.data?.data ?? [];
        const users = response.data?.includes?.users ?? [];

        // Build username lookup from includes
        const userMap = new Map(users.map(u => [u.id, u.username]));

        return tweets.map(t => ({
            id: t.id,
            text: t.text,
            authorId: t.author_id ?? '',
            authorUsername: userMap.get(t.author_id ?? '') ?? undefined,
            createdAt: t.created_at,
            conversationId: t.conversation_id,
            inReplyToUserId: t.in_reply_to_user_id,
        }));
    } catch (error: any) {
        log.error('Failed to fetch mentions', { error: String(error) });
        return [];
    }
}

/**
 * Fetch public metrics for a batch of tweet IDs.
 * X API allows up to 100 tweet IDs per lookup call.
 */
export async function getTweetMetrics(tweetIds: string[]): Promise<Map<string, PublicMetrics>> {
    const metricsMap = new Map<string, PublicMetrics>();
    if (tweetIds.length === 0) return metricsMap;

    // Process in batches of 100
    const batchSize = 100;
    for (let i = 0; i < tweetIds.length; i += batchSize) {
        const batch = tweetIds.slice(i, i + batchSize);
        try {
            const response = await getClient().v2.tweets(batch, {
                'tweet.fields': ['public_metrics'],
            });
            const tweets = response.data ?? [];
            for (const tweet of tweets) {
                if (tweet.public_metrics) {
                    metricsMap.set(tweet.id, {
                        like_count: tweet.public_metrics.like_count ?? 0,
                        reply_count: tweet.public_metrics.reply_count ?? 0,
                        retweet_count: tweet.public_metrics.retweet_count ?? 0,
                        quote_count: tweet.public_metrics.quote_count ?? 0,
                        impression_count: tweet.public_metrics.impression_count ?? 0,
                        bookmark_count: tweet.public_metrics.bookmark_count ?? 0,
                    });
                }
            }
        } catch (error: any) {
            log.error('Failed to fetch tweet metrics batch', { error: String(error), batchStart: i });
        }
    }

    log.info('Fetched tweet metrics', { requested: tweetIds.length, found: metricsMap.size });
    return metricsMap;
}

/**
 * Search recent tweets matching a query.
 * @param query Twitter search query (supports operators like OR, -is:retweet, etc.)
 * @param maxResults Max results (10-100, default 10)
 */
export async function searchRecentTweets(query: string, maxResults: number = 10): Promise<SearchResult[]> {
    try {
        const response = await getClient().v2.search(query, {
            max_results: Math.min(Math.max(maxResults, 10), 100),
            'tweet.fields': ['created_at', 'author_id', 'public_metrics'],
            expansions: ['author_id'],
            'user.fields': ['username'],
        });

        const tweets = response.data?.data ?? [];
        const users = response.data?.includes?.users ?? [];
        const userMap = new Map(users.map(u => [u.id, u.username]));

        return tweets.map(t => ({
            id: t.id,
            text: t.text,
            authorId: t.author_id ?? '',
            authorUsername: userMap.get(t.author_id ?? '') ?? undefined,
            createdAt: t.created_at,
            metrics: t.public_metrics ? {
                like_count: t.public_metrics.like_count ?? 0,
                reply_count: t.public_metrics.reply_count ?? 0,
                retweet_count: t.public_metrics.retweet_count ?? 0,
                quote_count: t.public_metrics.quote_count ?? 0,
                impression_count: t.public_metrics.impression_count ?? 0,
                bookmark_count: t.public_metrics.bookmark_count ?? 0,
            } : undefined,
        }));
    } catch (error: any) {
        log.error('Failed to search tweets', { error: String(error), query });
        return [];
    }
}

/**
 * Get replies to a specific tweet (via search for conversation_id).
 * Note: This uses search which has rate limits — use sparingly.
 */
export async function getRepliesTo(tweetId: string): Promise<SearchResult[]> {
    try {
        // Search for tweets in the same conversation that are replies
        const query = `conversation_id:${tweetId} -from:${(await getClient().v2.me()).data.username}`;
        return await searchRecentTweets(query, 20);
    } catch (error: any) {
        log.error('Failed to get replies to tweet', { error: String(error), tweetId });
        return [];
    }
}
