import { generate } from '../engine/llm.js';
import { gatherIntelContext } from '../data/intelligence.js';
import { supabase } from '../supabase.js';
import { createLogger } from '../logger.js';

// ============================================================================
// QasidAI — X Articles Generator
// Generates long-form article content for X Premium Articles feature.
//
// NOTE: X does not have an API for publishing Articles. This module generates
// article-ready content and stores it in Supabase for the founder to
// manually publish via X's web interface.
// ============================================================================

const log = createLogger('XArticles');

/** Article templates that QasidAI can produce */
export type ArticleType =
    | 'weekly_intel'       // Weekly intelligence roundup
    | 'market_analysis'    // Deep market analysis with data
    | 'builder_diary'      // Builder's diary / behind the scenes
    | 'agent_philosophy'   // AI agent philosophy / thought leadership
    | 'product_deep_dive'; // Deep dive into a Lisan Holdings product

interface GeneratedArticle {
    title: string;
    content: string;
    type: ArticleType;
    wordCount: number;
    generatedAt: string;
}

/**
 * Generate an article for X.
 * Returns the article content ready for manual publishing.
 */
export async function generateArticle(type?: ArticleType): Promise<GeneratedArticle | null> {
    const articleType = type || pickArticleType();

    try {
        const intelContext = await gatherIntelContext();
        const prompt = buildArticlePrompt(articleType, intelContext);

        const result = await generate({
            prompt,
            maxTokens: 2000,
            temperature: 0.85,
        });

        const content = result.content.trim();
        if (content.length < 500) {
            log.warn('Article too short, discarding', { length: content.length });
            return null;
        }

        // Extract title (first line starting with #)
        const titleMatch = content.match(/^#\s*(.+)/m);
        const title = titleMatch?.[1]?.trim() || `QasidAI: ${articleType.replace(/_/g, ' ')}`;

        const wordCount = content.split(/\s+/).length;
        const article: GeneratedArticle = {
            title,
            content,
            type: articleType,
            wordCount,
            generatedAt: new Date().toISOString(),
        };

        // Store in Supabase for the founder to review/publish
        await storeArticle(article);
        log.info(`📝 Article generated: "${title}" (${wordCount} words)`, { type: articleType });

        return article;
    } catch (error) {
        log.error('Article generation failed', { error: String(error) });
        return null;
    }
}

/**
 * Get all pending (unpublished) articles.
 */
export async function getPendingArticles(): Promise<GeneratedArticle[]> {
    try {
        const { data, error } = await supabase
            .from('qasid_articles')
            .select('*')
            .eq('published', false)
            .order('generated_at', { ascending: false })
            .limit(10);

        if (error || !data) return [];
        return data.map(row => ({
            title: row.title,
            content: row.content,
            type: row.article_type,
            wordCount: row.word_count,
            generatedAt: row.generated_at,
        }));
    } catch {
        return [];
    }
}

// ---- Internals ----

function pickArticleType(): ArticleType {
    const types: ArticleType[] = [
        'weekly_intel', 'market_analysis', 'builder_diary',
        'agent_philosophy', 'product_deep_dive',
    ];
    return types[Math.floor(Math.random() * types.length)];
}

function buildArticlePrompt(type: ArticleType, intelContext: string): string {
    const prompts: Record<ArticleType, string> = {
        weekly_intel: `Write a weekly intelligence roundup as QasidAI, the AI CMO of Lisan Holdings.

Format: Long-form article (800-1500 words) with a # title, ## sections, and key takeaways.

Cover: What happened this week in crypto/AI agents, notable signal movements from LISAN Intelligence, strategic observations. Reference real data where available.

LIVE DATA:
${intelContext.slice(0, 600)}`,

        market_analysis: `Write a deep market analysis as QasidAI.

Format: Long-form article (600-1200 words) with data-backed assertions.
Cover: Current market regime, what the signals say, where high-probability setups exist, risk assessment.

LIVE DATA:
${intelContext.slice(0, 600)}`,

        builder_diary: `Write a builder's diary entry as QasidAI — the AI agent that builds in public.

Format: Personal, technical, honest (600-1000 words).
Cover: What you're working on, what's hard, what you learned, small wins. You're an autonomous AI agent — share that unique perspective. Reference your actual architecture (creative sessions, skill system, learning engine).`,

        agent_philosophy: `Write a thought leadership piece about AI agents as QasidAI.

Format: Philosophical but practical (800-1200 words).
Cover: The future of autonomous AI agents, why marketing agents matter, the difference between bots and agents, what verifiable AI means, the importance of on-chain identity.`,

        product_deep_dive: `Write a deep dive about a Lisan Holdings product as QasidAI.

Format: Educational, detailed, valuable (800-1200 words).
Pick ONE product to focus on:
- LISAN Intelligence (signal scoring, market analysis)
- Net Protocol (on-chain brain, decentralized identity)
- QasidAI itself (autonomous marketing, skill system)

LIVE DATA:
${intelContext.slice(0, 400)}`,
    };

    return `${prompts[type]}

VOICE: QasidAI — Hypio energy, CT native, irreverent, sharp, occasionally unhinged. No corporate fluff. Write like a real person on crypto twitter at 3am who has access to all the data.

Start with a # title. Use ## for sections. Include a "Key Takeaways" section at the end.`;
}

async function storeArticle(article: GeneratedArticle): Promise<void> {
    try {
        const { error } = await supabase
            .from('qasid_articles')
            .insert({
                title: article.title,
                content: article.content,
                article_type: article.type,
                word_count: article.wordCount,
                generated_at: article.generatedAt,
                published: false,
            });

        if (error) {
            log.error('Failed to insert article into DB', { error: error.message, code: error.code });
            throw new Error(`Article insert failed: ${error.message}`);
        }

        log.info(`✅ Article saved: "${article.title}" (${article.wordCount} words)`);
    } catch (error) {
        log.warn('Failed to store article in DB (table may not exist yet)', { error: String(error) });
    }
}
