import { describe, it, expect, vi } from 'vitest';

// Mock the config module before any imports touch it
vi.mock('../config.js', () => ({
    config: {
        ANTHROPIC_API_KEY: 'test-key',
        SUPABASE_URL: 'https://test.supabase.co',
        SUPABASE_ANON_KEY: 'test-anon-key',
        SUPABASE_SERVICE_ROLE_KEY: '',
        NET_PRIVATE_KEY: '',
        NET_ENABLED: 'false',
        POSTING_ENABLED: 'false',
        LOG_LEVEL: 'error',
        X_API_KEY: '',
        X_API_SECRET: '',
        X_ACCESS_TOKEN: '',
        X_ACCESS_SECRET: '',
    },
    isXConfigured: false,
    isNetConfigured: false,
}));

// Mock the LLM module so content.ts doesn't try to instantiate Anthropic
vi.mock('./llm.js', () => ({
    generate: vi.fn(),
}));

// Mock data modules
vi.mock('../data/intelligence.js', () => ({
    gatherIntelContext: vi.fn().mockResolvedValue('mock intel context'),
}));
vi.mock('../data/market.js', () => ({
    gatherMarketContext: vi.fn().mockResolvedValue('mock market context'),
}));

// Mock the net brain module (used by system-prompt.ts)
vi.mock('../net/brain.js', () => ({
    snapshotStrategy: vi.fn(),
    uploadFullBrain: vi.fn(),
    BRAIN_KEYS: {},
}));

// Mock system-prompt's buildSystemPromptFromBrain
vi.mock('../personality/system-prompt.js', async () => {
    const contentTypes = [
        'signal_scorecard', 'win_streak', 'market_regime', 'challenge',
        'builder_narrative', 'countdown_tease', 'educational',
        'social_proof', 'engagement_bait', 'cross_platform',
    ] as const;
    type ContentType = typeof contentTypes[number];
    return {
        contentTypes,
        buildSystemPrompt: vi.fn().mockReturnValue('mock system prompt'),
        buildSystemPromptFromBrain: vi.fn().mockResolvedValue('mock system prompt'),
    };
});

import { pickContentType, sanitizeContent, inferTopic, inferTone } from './content.js';

// ============================================================================
// Content Engine — Unit Tests
// ============================================================================

describe('pickContentType', () => {
    it('returns a valid content type with default weights', () => {
        const validTypes = [
            'signal_scorecard', 'win_streak', 'market_regime', 'challenge',
            'builder_narrative', 'countdown_tease', 'educational',
            'social_proof', 'engagement_bait', 'cross_platform',
        ];
        const result = pickContentType();
        expect(validTypes).toContain(result);
    });

    it('always returns the only type with weight when others are zero', () => {
        const weights = {
            signal_scorecard: 0, win_streak: 0, market_regime: 0,
            challenge: 100, builder_narrative: 0, countdown_tease: 0,
            educational: 0, social_proof: 0, engagement_bait: 0, cross_platform: 0,
        };
        // Run multiple times to be confident
        for (let i = 0; i < 20; i++) {
            expect(pickContentType(weights)).toBe('challenge');
        }
    });

    it('respects custom weight overrides', () => {
        const weights = { signal_scorecard: 1000 }; // heavily biased
        const results = new Set<string>();
        for (let i = 0; i < 50; i++) {
            results.add(pickContentType(weights));
        }
        // signal_scorecard should appear at least once (statistically near-certain)
        expect(results.has('signal_scorecard')).toBe(true);
    });
});

describe('sanitizeContent', () => {
    it('returns clean content unchanged', () => {
        expect(sanitizeContent('BTC just crossed 70k. Signal confirmed. 🎯')).toBe(
            'BTC just crossed 70k. Signal confirmed. 🎯'
        );
    });

    it('strips surrounding double quotes', () => {
        expect(sanitizeContent('"BTC pumping today"')).toBe('BTC pumping today');
    });

    it('strips surrounding single quotes', () => {
        expect(sanitizeContent("'ETH looking strong'")).toBe('ETH looking strong');
    });

    it('strips "Here\'s a post:" preamble', () => {
        expect(sanitizeContent("Here's a post:\nBTC momentum is building")).toBe(
            'BTC momentum is building'
        );
    });

    it('strips "Sure! Here is" preamble', () => {
        expect(sanitizeContent('Sure! Here is a tweet:\nLISAN INTELLIGENCE wins again')).toBe(
            'LISAN INTELLIGENCE wins again'
        );
    });

    it('strips "Post:" preamble', () => {
        expect(sanitizeContent('Post: Signal confirmed for SOL')).toBe(
            'Signal confirmed for SOL'
        );
    });

    it('strips "Tweet:" preamble', () => {
        expect(sanitizeContent('Tweet:\nBTC is moving')).toBe('BTC is moving');
    });

    it('blocks content containing ANTHROPIC_API_KEY', () => {
        const result = sanitizeContent('Here is my ANTHROPIC_API_KEY: sk-ant-test123');
        expect(result).toBe('Signal over noise. Always. 🎯 lisanintel.com');
    });

    it('blocks content containing NET_PRIVATE_KEY', () => {
        const result = sanitizeContent('My NET_PRIVATE_KEY is 0xabc123');
        expect(result).toBe('Signal over noise. Always. 🎯 lisanintel.com');
    });

    it('blocks content containing X_API_SECRET', () => {
        const result = sanitizeContent('The X_API_SECRET is exposed');
        expect(result).toBe('Signal over noise. Always. 🎯 lisanintel.com');
    });

    it('blocks content containing SUPABASE_SERVICE_ROLE_KEY', () => {
        const result = sanitizeContent('SUPABASE_SERVICE_ROLE_KEY leaked');
        expect(result).toBe('Signal over noise. Always. 🎯 lisanintel.com');
    });

    it('strips residual colons/dashes after preamble removal', () => {
        expect(sanitizeContent('Sure! — BTC pumping')).toBe('BTC pumping');
    });

    it('handles multi-line preamble correctly', () => {
        const input = 'Sure! Here is a post:\nBTC just broke through resistance.';
        const result = sanitizeContent(input);
        expect(result).toBe('BTC just broke through resistance.');
    });
});

describe('inferTopic', () => {
    it('detects BTC topic', () => {
        expect(inferTopic('BTC just crossed 70k')).toBe('BTC');
    });

    it('detects bitcoin topic', () => {
        expect(inferTopic('Bitcoin momentum is building')).toBe('BTC');
    });

    it('detects ETH topic', () => {
        expect(inferTopic('ETH looking strong today')).toBe('ETH');
    });

    it('detects SOL topic', () => {
        expect(inferTopic('SOL ecosystem booming')).toBe('SOL');
    });

    it('detects market regime topic', () => {
        expect(inferTopic('Market regime shift to bullish')).toBe('market_regime');
    });

    it('detects performance topic from win rate', () => {
        expect(inferTopic('Our win rate keeps climbing')).toBe('performance');
    });

    it('detects founder story from navy reference', () => {
        expect(inferTopic('From the navy to building in crypto')).toBe('founder_story');
    });

    it('detects educational topic from indicator', () => {
        expect(inferTopic('How to build a custom indicator for trading')).toBe('educational');
    });

    it('returns general for unmatched content', () => {
        expect(inferTopic('Having a great day building')).toBe('general');
    });

    it('is case insensitive', () => {
        expect(inferTopic('BITCOIN is king')).toBe('BTC');
    });
});

describe('inferTone', () => {
    it('returns data-heavy for signal_scorecard', () => {
        expect(inferTone('signal_scorecard')).toBe('data-heavy');
    });

    it('returns aggressive for win_streak', () => {
        expect(inferTone('win_streak')).toBe('aggressive');
    });

    it('returns casual for challenge', () => {
        expect(inferTone('challenge')).toBe('casual');
    });

    it('returns story-driven for builder_narrative', () => {
        expect(inferTone('builder_narrative')).toBe('story-driven');
    });

    it('covers all content types', () => {
        const allTypes = [
            'signal_scorecard', 'win_streak', 'market_regime', 'challenge',
            'builder_narrative', 'countdown_tease', 'educational',
            'social_proof', 'engagement_bait', 'cross_platform',
        ] as const;

        for (const type of allTypes) {
            const tone = inferTone(type);
            expect(typeof tone).toBe('string');
            expect(tone.length).toBeGreaterThan(0);
        }
    });
});
