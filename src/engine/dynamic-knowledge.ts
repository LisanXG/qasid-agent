import { supabase } from '../supabase.js';
import { createLogger } from '../logger.js';

// ============================================================================
// QasidAI — Dynamic Knowledge Layer
// Runtime-learned facts that supplement the static brand-knowledge.ts
// ============================================================================

const log = createLogger('DynKnowledge');

export interface KnowledgeFact {
    id: string;
    fact: string;
    source: 'founder_tweet' | 'founder_instruction' | 'website_scrape' | 'github_scrape';
    source_url?: string;
    created_at: string;
}

/**
 * Load all active dynamic knowledge facts, newest first.
 * Returns a formatted string for system prompt injection.
 */
export async function loadDynamicKnowledge(): Promise<string> {
    try {
        const { data, error } = await supabase
            .from('qasid_knowledge')
            .select('fact, source, created_at')
            .eq('active', true)
            .or('expires_at.is.null,expires_at.gt.' + new Date().toISOString())
            .order('created_at', { ascending: false })
            .limit(50);

        if (error || !data || data.length === 0) return '';

        const lines = data.map(d => `- [${d.source}] ${d.fact}`);
        return `## RECENT UPDATES (learned at runtime — ${data.length} facts)\n${lines.join('\n')}`;
    } catch (error) {
        log.warn('Could not load dynamic knowledge', { error: String(error) });
        return '';
    }
}

/** Meta-reasoning patterns that indicate observations, not actionable facts */
const KNOWLEDGE_BLOCKLIST: RegExp[] = [
    /^this is a casual/i,
    /^the founder is signaling/i,
    /^I can see the founder/i,
    /^I notice(d)?\s/i,
    /^it seems like/i,
    /^it appears that/i,
    /^this looks like/i,
    /^the tweet (is|was|seems)/i,
    /^qasidai (is|was) registered/i,
    /^based on (this|the|my)/i,
    /^from (this|the) (tweet|post|thread)/i,
];

/** Max active facts — prevents prompt bloat */
const MAX_ACTIVE_FACTS = 30;

/** Minimum fact length to prevent trivial entries */
const MIN_FACT_LENGTH = 20;

/**
 * Add a new fact to the dynamic knowledge store.
 * Applies quality filters: blocklist, length check, dedup, and cap.
 */
export async function addKnowledge(
    fact: string,
    source: KnowledgeFact['source'],
    sourceUrl?: string,
    expiresAt?: Date,
): Promise<boolean> {
    try {
        // Quality gate 1: minimum length
        if (fact.trim().length < MIN_FACT_LENGTH) {
            log.debug('Fact too short, skipping', { length: fact.length, fact });
            return false;
        }

        // Quality gate 2: blocklist — reject meta-reasoning, not actionable facts
        for (const pattern of KNOWLEDGE_BLOCKLIST) {
            if (pattern.test(fact.trim())) {
                log.debug('Fact matches blocklist pattern, skipping', { fact: fact.slice(0, 80) });
                return false;
            }
        }

        // Quality gate 3: dedup — check if an identical fact already exists
        const { data: existing } = await supabase
            .from('qasid_knowledge')
            .select('id')
            .eq('fact', fact)
            .eq('active', true)
            .limit(1);

        if (existing && existing.length > 0) {
            log.debug('Fact already exists, skipping', { fact: fact.slice(0, 80) });
            return false;
        }

        // Quality gate 4: cap active facts — prune oldest if at limit
        const { data: activeCount } = await supabase
            .from('qasid_knowledge')
            .select('id')
            .eq('active', true);

        if (activeCount && activeCount.length >= MAX_ACTIVE_FACTS) {
            // Deactivate the oldest facts to make room
            const excess = activeCount.length - MAX_ACTIVE_FACTS + 1;
            const { data: oldest } = await supabase
                .from('qasid_knowledge')
                .select('id')
                .eq('active', true)
                .order('created_at', { ascending: true })
                .limit(excess);

            if (oldest && oldest.length > 0) {
                await supabase
                    .from('qasid_knowledge')
                    .update({ active: false })
                    .in('id', oldest.map(o => o.id));
                log.info(`🗑️ Pruned ${oldest.length} oldest fact(s) to stay under cap of ${MAX_ACTIVE_FACTS}`);
            }
        }

        const { error } = await supabase
            .from('qasid_knowledge')
            .insert({
                fact,
                source,
                source_url: sourceUrl ?? null,
                expires_at: expiresAt?.toISOString() ?? null,
            });

        if (error) {
            log.error('Failed to add knowledge', { error: error.message });
            return false;
        }

        log.info('📚 New knowledge stored', { source, fact: fact.slice(0, 80) });
        return true;
    } catch (error) {
        log.error('Failed to add knowledge', { error: String(error) });
        return false;
    }
}

/**
 * Deactivate a specific fact by ID.
 */
export async function deactivateFact(id: string): Promise<boolean> {
    const { error } = await supabase
        .from('qasid_knowledge')
        .update({ active: false })
        .eq('id', id);

    if (error) {
        log.error('Failed to deactivate fact', { id, error: error.message });
        return false;
    }
    return true;
}

/**
 * Deactivate facts matching a keyword (for "forget" commands).
 * Returns count of deactivated facts.
 */
export async function deactivateByKeyword(keyword: string): Promise<number> {
    // Escape SQL wildcard characters to prevent matching all facts
    const escaped = keyword.replace(/[%_]/g, '\\$&');
    const { data, error } = await supabase
        .from('qasid_knowledge')
        .select('id, fact')
        .eq('active', true)
        .ilike('fact', `%${escaped}%`);

    if (error || !data || data.length === 0) return 0;

    const ids = data.map(d => d.id);
    const { error: updateError } = await supabase
        .from('qasid_knowledge')
        .update({ active: false })
        .in('id', ids);

    if (updateError) {
        log.error('Failed to deactivate facts by keyword', { keyword, error: updateError.message });
        return 0;
    }

    log.info(`🗑️ Deactivated ${ids.length} fact(s) matching "${keyword}"`);
    return ids.length;
}

/**
 * Get count of active facts by source.
 */
export async function getKnowledgeStats(): Promise<Record<string, number>> {
    const { data, error } = await supabase
        .from('qasid_knowledge')
        .select('source')
        .eq('active', true);

    if (error || !data) return {};

    const stats: Record<string, number> = {};
    for (const row of data) {
        stats[row.source] = (stats[row.source] || 0) + 1;
    }
    return stats;
}
