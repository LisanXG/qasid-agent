import { supabase } from '../supabase.js';
import { createLogger } from '../logger.js';
import type { GeneratedPost } from '../engine/content.js';

// ============================================================================
// QasidAI — Memory System
// Tracks posted content to avoid repetition and stores history in Supabase
// ============================================================================

const log = createLogger('Memory');

export interface PostRecord {
    id?: string;
    content: string;
    content_type: string;
    platform: string;
    tone: string;
    topic: string;
    input_tokens: number;
    output_tokens: number;
    posted_at: string;
    // Engagement metrics (filled in later by learning engine)
    reactions?: number;
    replies?: number;
    link_clicks?: number;
    performance_score?: number;
    external_id?: string; // tweet ID, telegram message ID, etc.
}

/**
 * Save a posted content record to Supabase.
 */
export async function savePost(post: GeneratedPost, externalId?: string): Promise<string | null> {
    const record: PostRecord = {
        content: post.content,
        content_type: post.contentType,
        platform: post.platform,
        tone: post.tone,
        topic: post.topic,
        input_tokens: post.inputTokens,
        output_tokens: post.outputTokens,
        posted_at: post.generatedAt,
        external_id: externalId,
    };

    const { data, error } = await supabase
        .from('qasid_posts')
        .insert(record)
        .select('id')
        .single();

    if (error) {
        log.error('Failed to save post', { error: error.message });
        return null;
    }

    log.info('Post saved to memory', { id: data.id, platform: post.platform });
    return data.id;
}

/**
 * Get recent posts to avoid repetition.
 */
export async function getRecentPosts(limit = 20): Promise<PostRecord[]> {
    const { data, error } = await supabase
        .from('qasid_posts')
        .select('*')
        .order('posted_at', { ascending: false })
        .limit(limit);

    if (error) {
        log.warn('Failed to fetch recent posts', { error: error.message });
        return [];
    }

    return data || [];
}

/**
 * Check if a similar content type was recently posted on the same platform.
 * Prevents repetitive content.
 */
export async function wasRecentlyPosted(
    contentType: string,
    platform: string,
    windowHours = 6,
): Promise<boolean> {
    const since = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
        .from('qasid_posts')
        .select('id')
        .eq('content_type', contentType)
        .eq('platform', platform)
        .gte('posted_at', since)
        .limit(1);

    if (error) {
        log.warn('Dedup check failed', { error: error.message });
        return false;
    }

    return (data?.length || 0) > 0;
}

/**
 * Get token usage stats for cost tracking.
 */
export async function getTokenUsage(sinceDaysAgo = 30): Promise<{ totalInput: number; totalOutput: number; postCount: number }> {
    const since = new Date(Date.now() - sinceDaysAgo * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
        .from('qasid_posts')
        .select('input_tokens, output_tokens')
        .gte('posted_at', since);

    if (error || !data) {
        return { totalInput: 0, totalOutput: 0, postCount: 0 };
    }

    return {
        totalInput: data.reduce((sum, r) => sum + (r.input_tokens || 0), 0),
        totalOutput: data.reduce((sum, r) => sum + (r.output_tokens || 0), 0),
        postCount: data.length,
    };
}
