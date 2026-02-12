import { describe, it, expect, vi } from 'vitest';

// Mock config before any imports that depend on it
vi.mock('../config.js', () => ({
    config: {
        ANTHROPIC_API_KEY: 'test-key',
        SUPABASE_URL: 'http://localhost:54321',
        SUPABASE_ANON_KEY: 'test-anon-key',
        SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
        POSTING_ENABLED: false,
        LOG_LEVEL: 'info',
    },
    isXConfigured: false,
    isNetConfigured: false,
}));

// Now import the functions — config will be mocked
import { pickContentType, sanitizeContent, inferTopic, inferTone, getTimeContext } from './content.js';

// ---------- pickContentType ----------
describe('pickContentType', () => {
    it('should return a valid content type', () => {
        const type = pickContentType();
        const validTypes = [
            'gm_post', 'signal_scorecard', 'win_streak', 'market_regime',
            'challenge', 'founder_journey', 'builder_narrative',
            'countdown_tease', 'product_spotlight', 'educational',
            'social_proof', 'engagement_bait', 'self_aware', 'cross_platform',
        ];
        expect(validTypes).toContain(type);
    });

    it('should respect weight overrides', () => {
        const weights: Record<string, number> = {
            gm_post: 100,
            signal_scorecard: 0, win_streak: 0, market_regime: 0,
            challenge: 0, founder_journey: 0, builder_narrative: 0,
            countdown_tease: 0, product_spotlight: 0, educational: 0,
            social_proof: 0, engagement_bait: 0, self_aware: 0, cross_platform: 0,
        };
        const type = pickContentType(weights);
        expect(type).toBe('gm_post');
    });
});

// ---------- sanitizeContent ----------
describe('sanitizeContent', () => {
    it('should strip surrounding double quotes', () => {
        expect(sanitizeContent('"Hello world"')).toBe('Hello world');
    });

    it('should strip surrounding single quotes', () => {
        expect(sanitizeContent("'Hello world'")).toBe('Hello world');
    });

    it('should strip LLM preamble: Here\'s a tweet:', () => {
        expect(sanitizeContent("Here's a tweet:\nBuy BTC now")).toBe('Buy BTC now');
    });

    it('should strip LLM preamble: Sure! Here is a post:', () => {
        expect(sanitizeContent('Sure! Here is a post:\nBTC is pumping')).toBe('BTC is pumping');
    });

    it('should strip LLM preamble: Tweet:', () => {
        expect(sanitizeContent('Tweet: BTC looking bullish')).toBe('BTC looking bullish');
    });

    it('should strip residual punctuation after preamble removal', () => {
        expect(sanitizeContent(': BTC is king')).toBe('BTC is king');
    });

    it('should block content with sensitive key patterns', () => {
        const result = sanitizeContent('My ANTHROPIC_API_KEY is sk-ant-xxx');
        expect(result).not.toContain('ANTHROPIC_API_KEY');
        expect(result).toContain('lisanintel.com');
    });

    it('should return clean content unchanged', () => {
        const clean = 'BTC signals looking clean today 🎯';
        expect(sanitizeContent(clean)).toBe(clean);
    });
});

// ---------- inferTopic ----------
describe('inferTopic', () => {
    it('should detect BTC topic', () => {
        expect(inferTopic('BTC looking strong today')).toBe('BTC');
    });

    it('should detect ETH topic', () => {
        expect(inferTopic('ETH breaking above resistance')).toBe('ETH');
    });

    it('should detect performance topic', () => {
        expect(inferTopic('Our win rate is 72% this week')).toBe('performance');
    });

    it('should detect founder story', () => {
        expect(inferTopic('A navy veteran building real products')).toBe('founder_story');
    });

    it('should detect self-aware topic', () => {
        expect(inferTopic('Being an AI agent running marketing is a vibe')).toBe('self_aware');
    });

    it('should detect company topic', () => {
        expect(inferTopic('Lisan Holdings shipping products weekly')).toBe('company');
    });

    it('should fallback to general', () => {
        expect(inferTopic('Good morning everyone')).toBe('general');
    });
});

// ---------- inferTone ----------
describe('inferTone', () => {
    it('should return warm for gm_post', () => {
        expect(inferTone('gm_post')).toBe('warm');
    });

    it('should return data-heavy for signal_scorecard', () => {
        expect(inferTone('signal_scorecard')).toBe('data-heavy');
    });

    it('should return philosophical for self_aware', () => {
        expect(inferTone('self_aware')).toBe('philosophical');
    });

    it('should return story-driven for founder_journey', () => {
        expect(inferTone('founder_journey')).toBe('story-driven');
    });

    it('should return informative for product_spotlight', () => {
        expect(inferTone('product_spotlight')).toBe('informative');
    });
});

// ---------- getTimeContext ----------
describe('getTimeContext', () => {
    it('should return a string containing UTC', () => {
        const context = getTimeContext();
        expect(typeof context).toBe('string');
        expect(context.length).toBeGreaterThan(10);
        expect(context).toContain('UTC');
    });
});
