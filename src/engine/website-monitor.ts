import { generate } from './llm.js';
import { addKnowledge } from './dynamic-knowledge.js';
import { supabase } from '../supabase.js';
import { createLogger } from '../logger.js';
import { createHash } from 'node:crypto';
import { withRetry } from '../retry.js';

// ============================================================================
// QasidAI — Website Monitor
// Scrapes public pages for changes, extracts updates via LLM
// ============================================================================

const log = createLogger('WebMonitor');

/** Pages to monitor for changes */
const MONITORED_PAGES = [
    { url: 'https://lisanholdings.dev', label: 'Lisan Holdings corporate site' },
    { url: 'https://lisanintel.com', label: 'Lisan Intelligence platform' },
    { url: 'https://lisanintel.com/proof', label: 'Lisan Intelligence proof page' },
];

/**
 * Fetch a page and extract its text content.
 * Strips HTML tags and returns clean text.
 */
async function fetchPageText(url: string): Promise<string | null> {
    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; QasidAI/1.0)',
                'Accept': 'text/html',
            },
            signal: AbortSignal.timeout(15_000),
        });

        if (!response.ok) {
            log.warn('Page fetch failed', { url, status: response.status });
            return null;
        }

        const html = await response.text();

        // Strip scripts, styles, and HTML tags
        const text = html
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&#39;/g, "'")
            .replace(/&quot;/g, '"')
            .replace(/&nbsp;/g, ' ')
            .trim()
            .slice(0, 5000); // Cap at 5K chars

        return text;
    } catch (error) {
        log.warn('Page fetch error', { url, error: String(error) });
        return null;
    }
}

/**
 * Hash content for change detection.
 */
function hashContent(text: string): string {
    return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * Check a page for changes and extract new facts.
 */
async function checkPage(url: string, label: string): Promise<number> {
    const newText = await fetchPageText(url);
    if (!newText || newText.length < 50) return 0;

    const newHash = hashContent(newText);

    // Check stored hash
    const { data: existing } = await supabase
        .from('qasid_content_hashes')
        .select('hash, raw_text')
        .eq('url', url)
        .single();

    if (existing?.hash === newHash) {
        log.debug('No changes detected', { url });
        return 0;
    }

    log.info(`Changes detected on ${label}`, { url });

    // Extract what changed
    const oldText = existing?.raw_text ?? '(first scan — no previous content)';
    const result = await withRetry(async () => {
        return generate({
            prompt: `You are QasidAI, autonomous CMO of Lisan Holdings. A website you monitor has changed.

WEBSITE: ${label} (${url})

PREVIOUS CONTENT (summary):
${oldText.slice(0, 1500)}

CURRENT CONTENT (summary):
${newText.slice(0, 1500)}

What's NEW or CHANGED? Extract specific factual updates about products, features, numbers, or company information.

If this is the first scan (no previous content), extract the key facts about the page.

If nothing meaningful changed (just layout/styling), respond with: NONE

Output specific facts, one per line:`,
            maxTokens: 300,
            temperature: 0.3,
        });
    }, {
        maxRetries: 2,
        baseDelayMs: 1000,
        label: 'website diff extraction',
        circuitBreakerKey: 'anthropic',
    });

    // Update stored hash
    await supabase
        .from('qasid_content_hashes')
        .upsert({
            url,
            hash: newHash,
            raw_text: newText.slice(0, 3000),
            checked_at: new Date().toISOString(),
        }, { onConflict: 'url' });

    const text = result.content.trim();
    if (text === 'NONE' || text.length < 5) return 0;

    const facts = text
        .split('\n')
        .map(line => line.replace(/^[-•*]\s*/, '').trim())
        .filter(line => line.length > 10);

    let stored = 0;
    for (const fact of facts) {
        const added = await addKnowledge(fact, 'website_scrape', url);
        if (added) stored++;
    }

    return stored;
}

/**
 * Run the website monitor — checks all monitored pages for changes.
 */
export async function runWebsiteMonitor(): Promise<number> {
    log.info('🌐 Website monitor starting...');

    let totalFacts = 0;

    for (const page of MONITORED_PAGES) {
        try {
            const facts = await checkPage(page.url, page.label);
            totalFacts += facts;
        } catch (error) {
            log.warn('Failed to check page', { url: page.url, error: String(error) });
        }
    }

    log.info(`🌐 Website monitor complete: ${totalFacts} new fact(s) extracted`);
    return totalFacts;
}
