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
