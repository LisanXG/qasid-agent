import { supabase } from '../supabase.js';
import { writeDailySummary } from './brain.js';
import { isNetConfigured } from '../config.js';
import { createLogger } from '../logger.js';

// ============================================================================
// QasidAI — Daily Summary Builder
// Aggregates the day's posts from Supabase into an on-chain digest
// ============================================================================

const log = createLogger('DailySummary');

export interface DailySummaryData {
    date: string;
    totalPosts: number;
    platforms: string[];
    contentTypes: string[];
    posts: Array<{
        content: string;
        contentType: string;
        platform: string;
        tone: string;
        topic: string;
        postedAt: string;
    }>;
    tokenUsage: {
        totalInput: number;
        totalOutput: number;
    };
}

/**
 * Build and write a daily summary to Net Protocol.
 * Called by the end-of-day cron job.
 */
export async function buildAndWriteDailySummary(): Promise<void> {
    if (!isNetConfigured) {
        log.debug('Net Protocol not configured, skipping daily summary');
        return;
    }

    const today = new Date().toISOString().split('T')[0];
    const startOfDay = `${today}T00:00:00.000Z`;
    const endOfDay = `${today}T23:59:59.999Z`;

    log.info(`Building daily summary for ${today}...`);


    const { data: posts, error } = await supabase
        .from('qasid_posts')
        .select('content, content_type, platform, tone, topic, input_tokens, output_tokens, posted_at')
        .gte('posted_at', startOfDay)
        .lte('posted_at', endOfDay)
        .order('posted_at', { ascending: true });

    if (error) {
        log.error('Failed to fetch posts for daily summary', { error: error.message });
        return;
    }

    if (!posts || posts.length === 0) {
        log.info('No posts today, skipping daily summary');
        return;
    }

    const summary: DailySummaryData = {
        date: today,
        totalPosts: posts.length,
        platforms: [...new Set(posts.map(p => p.platform))],
        contentTypes: [...new Set(posts.map(p => p.content_type))],
        posts: posts.map(p => ({
            content: p.content,
            contentType: p.content_type,
            platform: p.platform,
            tone: p.tone,
            topic: p.topic,
            postedAt: p.posted_at,
        })),
        tokenUsage: {
            totalInput: posts.reduce((sum, p) => sum + (p.input_tokens || 0), 0),
            totalOutput: posts.reduce((sum, p) => sum + (p.output_tokens || 0), 0),
        },
    };

    await writeDailySummary(today, summary);
    log.info(`✅ Daily summary for ${today}: ${posts.length} posts across ${summary.platforms.join(', ')}`);
}
