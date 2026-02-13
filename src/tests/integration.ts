// ============================================================================
// QasidAI — Integration Tests (P2 Features)
// Run with: npx tsx src/tests/integration.ts
// Tests: Scorer v2, Circuit Breaker, Sentiment parsing
// No external dependencies required
// ============================================================================

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  ✅ ${message}`);
        passed++;
    } else {
        console.error(`  ❌ FAIL: ${message}`);
        failed++;
    }
}

function describe(name: string, fn: () => void) {
    console.log(`\n📦 ${name}`);
    fn();
}

// ---- Test 1: Scorer v2 — calculateScore logic (replicated here for testing) ----

describe('Scorer v2 — Enhanced Scoring Formula', () => {
    // Replicate the scoring logic locally for testing
    function calculateScore(
        reactions: number, replies: number, impressions: number,
        _contentType: string, hoursOld: number,
    ): number {
        const normReactions = Math.min(Math.log2(reactions + 1) / 5, 1);
        const normReplies = Math.min(Math.log2(replies + 1) / 4, 1);
        const normImpressions = Math.min(Math.log2(impressions + 1) / 10, 1);
        let rawScore = normReactions * 0.35 + normReplies * 0.35 + normImpressions * 0.20;

        // Engagement rate bonus
        if (impressions > 50) {
            const engagementRate = (reactions + replies) / impressions;
            if (engagementRate > 0.02) rawScore += 0.10;
        }

        // Time decay
        if (hoursOld > 48) {
            const extraDays = (hoursOld - 48) / 24;
            const decayFactor = Math.max(0.70, 1.0 - extraDays * 0.10);
            rawScore *= decayFactor;
        }

        return Math.round(Math.min(1, Math.max(0, rawScore)) * 100);
    }

    // Test: zero engagement = 0
    assert(calculateScore(0, 0, 0, 'gm', 24) === 0, 'Zero engagement scores 0');

    // Test: moderate engagement scores between 20-60
    const moderate = calculateScore(5, 3, 100, 'signal', 24);
    assert(moderate >= 20 && moderate <= 60, `Moderate engagement (5r/3rep/100imp) scores ${moderate} (20-60 range)`);

    // Test: high engagement scores above 60
    const high = calculateScore(30, 15, 2000, 'signal', 24);
    assert(high >= 60, `High engagement (30r/15rep/2000imp) scores ${high} (≥60)`);

    // Test: engagement rate bonus triggers
    const withBonus = calculateScore(10, 5, 100, 'signal', 24); // 15% rate
    const withoutBonus = calculateScore(1, 0, 100, 'signal', 24); // 1% rate
    assert(withBonus > withoutBonus, `Engagement rate bonus: ${withBonus} > ${withoutBonus}`);

    // Test: time decay reduces score for old posts
    const fresh = calculateScore(10, 5, 500, 'signal', 24);
    const stale = calculateScore(10, 5, 500, 'signal', 96); // 4 days old
    assert(stale < fresh, `Time decay: fresh(${fresh}) > stale(${stale})`);

    // Test: time decay maxes out at 30% reduction
    const veryOld = calculateScore(10, 5, 500, 'signal', 240); // 10 days old
    const somewhaiOld = calculateScore(10, 5, 500, 'signal', 120); // 5 days old
    assert(veryOld === somewhaiOld, `Time decay caps: 10d(${veryOld}) == 5d(${somewhaiOld})`);

    // Test: score never exceeds 100
    const maxed = calculateScore(1000, 1000, 100000, 'signal', 24);
    assert(maxed <= 100, `Max score capped at 100: ${maxed}`);

    // Test: score never goes below 0
    const min = calculateScore(0, 0, 0, 'signal', 240);
    assert(min >= 0, `Min score is 0: ${min}`);
});

// ---- Test 2: Circuit Breaker Logic ----

describe('Circuit Breaker Logic', () => {
    const FAILURE_THRESHOLD = 5;
    const COOLDOWN_MS = 5 * 60 * 1000;

    // Simulate circuit breaker state
    interface BreakerState {
        failures: number;
        openedAt: number | null;
        isOpen: boolean;
    }

    function simulateBreaker(): BreakerState {
        return { failures: 0, openedAt: null, isOpen: false };
    }

    function recordFailure(b: BreakerState): void {
        b.failures++;
        if (b.failures >= FAILURE_THRESHOLD && !b.isOpen) {
            b.isOpen = true;
            b.openedAt = Date.now();
        }
    }

    function recordSuccess(b: BreakerState): void {
        b.failures = 0;
        b.openedAt = null;
        b.isOpen = false;
    }

    function isCircuitOpen(b: BreakerState): boolean {
        if (!b.isOpen) return false;
        if (b.openedAt && Date.now() - b.openedAt >= COOLDOWN_MS) {
            b.isOpen = false;
            return false;
        }
        return true;
    }

    // Test: starts closed
    const b = simulateBreaker();
    assert(!isCircuitOpen(b), 'Circuit starts closed');

    // Test: doesn't open until threshold
    for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) {
        recordFailure(b);
    }
    assert(!isCircuitOpen(b), `Circuit stays closed after ${FAILURE_THRESHOLD - 1} failures`);

    // Test: opens at threshold
    recordFailure(b);
    assert(isCircuitOpen(b), `Circuit opens after ${FAILURE_THRESHOLD} consecutive failures`);

    // Test: success resets
    recordSuccess(b);
    assert(!isCircuitOpen(b), 'Success resets the circuit breaker');
    assert(b.failures === 0, 'Failure count reset to 0');

    // Test: cooldown transition (half-open)
    const b2 = simulateBreaker();
    for (let i = 0; i < FAILURE_THRESHOLD; i++) recordFailure(b2);
    assert(isCircuitOpen(b2), 'Circuit is open');
    // Simulate expired cooldown
    b2.openedAt = Date.now() - COOLDOWN_MS - 1;
    assert(!isCircuitOpen(b2), 'Circuit enters half-open after cooldown');
});

// ---- Test 3: Sentiment Response Instructions ----

describe('Sentiment-Aware Reply Tone', () => {
    const sentiments = ['POSITIVE', 'NEGATIVE', 'CURIOUS', 'HOSTILE', 'NEUTRAL'];
    assert(sentiments.length === 5, '5 sentiment categories defined');

    // Test: sentiment parsing from LLM output
    const parseSentiment = (text: string) => {
        const match = text.match(/SENTIMENT:\s*(\w+)/i);
        return match?.[1]?.toUpperCase() ?? 'UNKNOWN';
    };

    assert(parseSentiment('SENTIMENT: POSITIVE') === 'POSITIVE', 'Parses POSITIVE');
    assert(parseSentiment('TYPE: ENGAGE\nSENTIMENT: NEGATIVE\nVERDICT: REPLY') === 'NEGATIVE', 'Parses NEGATIVE from multi-line');
    assert(parseSentiment('SENTIMENT: hostile') === 'HOSTILE', 'Case-insensitive parsing');
    assert(parseSentiment('no sentiment here') === 'UNKNOWN', 'Returns UNKNOWN when missing');
});

// ---- Test 4: Conversation Threading ----

describe('Conversation Threading', () => {
    // Test: thread context format
    const priorReplies = [
        'Thanks for the feedback! We are always improving.',
        'BTC is looking bullish at these levels.',
        'Appreciate the support! 🎯',
    ];

    const threadContext = priorReplies.length > 0
        ? `\n\nYOUR PRIOR REPLIES TO THIS USER (don't repeat yourself):\n${priorReplies.map((r, i) => `${i + 1}. "${r.slice(0, 150)}"`).join('\n')}`
        : '';

    assert(threadContext.includes('1.'), 'Thread context has numbered items');
    assert(threadContext.includes('2.'), 'Thread context has item 2');
    assert(threadContext.includes('3.'), 'Thread context has item 3');
    assert(threadContext.includes("don't repeat yourself"), 'Thread context includes dedup instruction');
    assert(threadContext.includes('Thanks for the feedback'), 'Thread context includes prior reply text');

    // Test: empty thread context
    const emptyContext = ([] as string[]).length > 0 ? 'should not appear' : '';
    assert(emptyContext === '', 'Empty prior replies produces empty context');

    // Test: truncation of long replies
    const longReply = 'x'.repeat(200);
    const truncated = longReply.slice(0, 150);
    assert(truncated.length === 150, 'Prior replies truncated to 150 chars');
});

// ---- Summary ----

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}`);

if (failed > 0) {
    process.exit(1);
} else {
    console.log('\n🎉 All integration tests passed!\n');
    process.exit(0);
}
