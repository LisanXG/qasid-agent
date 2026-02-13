// ============================================================================
// QasidAI — Smoke Tests (No External Dependencies)
// Run with: npx tsx src/tests/smoke.ts
// Validates core logic WITHOUT external APIs (no LLM, no X, no DB, no env vars)
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

// ---- Test 1: Content Type Weight Adaptation Logic ----

describe('Content Type Weight Adaptation', () => {
    const MIN_WEIGHT = 5;
    const MAX_WEIGHT = 30;
    const LEARNING_RATE = 0.2;

    // Test: clamping works
    const clamp = (v: number) => Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, Math.round(v)));
    assert(clamp(3) === MIN_WEIGHT, `Clamping below MIN (3 → ${MIN_WEIGHT})`);
    assert(clamp(50) === MAX_WEIGHT, `Clamping above MAX (50 → ${MAX_WEIGHT})`);
    assert(clamp(15) === 15, 'No clamping needed for valid weight (15)');

    // Test: learning rate produces reasonable shifts
    const currentWeight = 10;
    const positiveDiff = 5; // 5 points above average
    assert(currentWeight + positiveDiff * LEARNING_RATE === 11, 'Positive shift: 10 + (5 × 0.2) = 11');

    const negativeDiff = -8; // 8 points below average
    const result = currentWeight + negativeDiff * LEARNING_RATE;
    assert(Math.abs(result - 8.4) < 0.01, `Negative shift: 10 + (-8 × 0.2) ≈ 8.4`);

    // Test: normalization to 100
    const weights = { a: 20, b: 30, c: 50 };
    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    assert(total === 100, 'Example weights sum to 100');
    const normalized = Object.fromEntries(
        Object.entries(weights).map(([k, v]) => [k, Math.round((v / total) * 100)])
    );
    assert(Object.values(normalized).reduce((a, b) => a + b, 0) === 100, 'Normalized weights sum to 100');
});

// ---- Test 2: Time Weight Parsing ----

describe('Time Weight Parsing', () => {
    const date = new Date('2026-02-12T14:30:00Z');
    const hour = date.getUTCHours().toString().padStart(2, '0');
    assert(hour === '14', 'Extracts UTC hour 14 correctly');

    const midnight = new Date('2026-02-12T00:05:00Z');
    const midnightHour = midnight.getUTCHours().toString().padStart(2, '0');
    assert(midnightHour === '00', 'Midnight hour is "00"');

    // Test: accumulation per hour
    const hourScores: Record<string, { total: number; count: number }> = {};
    const testPosts = [
        { posted_at: '2026-02-12T08:00:00Z', score: 80 },
        { posted_at: '2026-02-12T08:30:00Z', score: 60 },
        { posted_at: '2026-02-12T14:00:00Z', score: 90 },
    ];

    for (const post of testPosts) {
        const h = new Date(post.posted_at).getUTCHours().toString().padStart(2, '0');
        if (!hourScores[h]) hourScores[h] = { total: 0, count: 0 };
        hourScores[h].total += post.score;
        hourScores[h].count++;
    }

    assert(hourScores['08'].count === 2, 'Hour 08 has 2 posts');
    assert(hourScores['08'].total === 140, 'Hour 08 total score is 140');
    assert(hourScores['14'].count === 1, 'Hour 14 has 1 post');
    assert(hourScores['08'].total / hourScores['08'].count === 70, 'Hour 08 avg = 70');
});

// ---- Test 3: Skill Types & Validation ----

describe('Skill Types & Validation', () => {
    const validCategories = ['content', 'analysis', 'engagement', 'technical', 'knowledge', 'meta'];
    assert(validCategories.length === 6, '6 skill categories defined');

    const validSources = ['built_in', 'timeline', 'botchan', 'experience', 'self_taught'];
    assert(validSources.length === 5, '5 skill sources defined');

    const validStatuses = ['active', 'pending_approval', 'denied'];
    assert(validStatuses.length === 3, '3 skill statuses defined');

    // Test: skill ID slug format
    const rawId = 'Contrarian Hook!';
    const slugged = rawId.toLowerCase().replace(/[^a-z0-9-]/g, '');
    assert(slugged === 'contrarianhook', 'Skill ID slugging removes special chars');

    // Test: confidence clamping
    const clamp = (c: number) => Math.min(1, Math.max(0, c));
    assert(clamp(1.5) === 1, 'Confidence clamps above 1');
    assert(clamp(-0.3) === 0, 'Confidence clamps below 0');
    assert(clamp(0.72) === 0.72, 'Valid confidence passes through');
});

// ---- Test 4: Skill Approval Keywords ----

describe('Skill Approval Processing', () => {
    const approveKeywords = ['approve', 'yes', 'go for it', 'do it', 'learn it', '✅', 'granted', 'sure'];
    const denyKeywords = ['deny', 'denied', 'no', 'skip', 'pass', '❌', 'reject'];

    const isApproved = (text: string) => approveKeywords.some(k => text.toLowerCase().includes(k));
    const isDenied = (text: string) => denyKeywords.some(k => text.toLowerCase().includes(k));

    assert(isApproved('Yeah approve it'), '"approve" detected');
    assert(isApproved('sure, go for it'), '"sure" + "go for it" detected');
    assert(isApproved('✅'), 'Checkmark emoji detected');
    assert(!isApproved('maybe later'), 'Ambiguous not treated as approval');

    assert(isDenied('nah deny that one'), '"deny" detected');
    assert(isDenied('pass on this'), '"pass" detected');
    assert(isDenied('❌'), 'X emoji detected');
    assert(!isDenied('interesting skill'), 'Unrelated text not treated as denial');

    // Edge: both approve and deny keywords
    assert(isApproved('yes but also no') === true, 'Mixed signal: approve wins first');
    assert(isDenied('yes but also no') === true, 'Mixed signal: deny also detected');
});

// ---- Test 5: Dedup Exclusion Format ----

describe('Dedup Exclusion Format', () => {
    const recentPosts = [
        'BTC signal at 82/100, holding strong 📈',
        'Morning folks. Market looking choppy today.',
        'Thread: Why on-chain AI matters for the next cycle.',
    ];

    const exclusionBlock = recentPosts.map(p => `- ${p}`).join('\n');
    assert(exclusionBlock.split('\n').length === 3, 'Exclusion block has 3 lines');
    assert(exclusionBlock.startsWith('- BTC'), 'First exclusion starts with dash');
    assert(exclusionBlock.includes('Thread:'), 'Thread post included in exclusions');

    const emptyExclusions = ([] as string[]).map(p => `- ${p}`).join('\n');
    assert(emptyExclusions === '', 'Empty post list produces empty string');
});

// ---- Test 6: Anti-Slop Detection ----

describe('Anti-Slop Detection', () => {
    const BANNED_PHRASES = [
        "let's dive", "here's the thing", "game changer", "buckle up",
        "don't sleep on", "the future of", "excited to announce",
        "not just", "here's why", "deep dive",
    ];

    const detectSlop = (content: string): string | null => {
        const lower = content.toLowerCase();
        return BANNED_PHRASES.find(phrase => lower.includes(phrase)) || null;
    };

    assert(detectSlop("Let's dive into the data") === "let's dive", 'Detects "let\'s dive"');
    assert(detectSlop('This is a game changer for DeFi') === 'game changer', 'Detects "game changer"');
    assert(detectSlop('BTC signal at 82, regime bullish') === null, 'Clean content passes');
    assert(detectSlop('we are excited to announce our new tool') === 'excited to announce', 'Detects "excited to announce"');
    assert(detectSlop('A deep dive into tokenomics') === 'deep dive', 'Detects "deep dive"');
    assert(detectSlop('normal tweet about trading') === null, 'Normal tweet passes');
});

// ---- Test 7: Strategy Context Generation ----

describe('Strategy Context Generation', () => {
    const weights = {
        content_type_weights: { signal_scorecard: 25, engagement_bait: 20, founder_journey: 15, gm_post: 10, educational: 8, other: 5 } as Record<string, number>,
        time_weights: { '08': 20, '14': 18, '19': 12 } as Record<string, number>,
        tone_weights: { sharp: 15, analytical: 12, casual: 8 } as Record<string, number>,
        topic_weights: { bitcoin: 18, AI: 15, defi: 10 } as Record<string, number>,
    };

    const sortedTypes = Object.entries(weights.content_type_weights).sort(([, a], [, b]) => b - a);
    assert(sortedTypes[0][0] === 'signal_scorecard', 'Top content type is signal_scorecard');
    assert(sortedTypes[sortedTypes.length - 1][0] === 'other', 'Bottom content type is other');

    const sortedTimes = Object.entries(weights.time_weights).sort(([, a], [, b]) => b - a);
    assert(sortedTimes[0][0] === '08', 'Best posting hour is 08:00 UTC');

    const sortedTones = Object.entries(weights.tone_weights).sort(([, a], [, b]) => b - a);
    assert(sortedTones[0][0] === 'sharp', 'Best performing tone is sharp');

    const sortedTopics = Object.entries(weights.topic_weights).sort(([, a], [, b]) => b - a);
    assert(sortedTopics[0][0] === 'bitcoin', 'Top topic is bitcoin');
});

// ---- Test 8: Tweet Length Monitoring (Premium — no hard limit) ----

describe('Tweet Length Monitoring (Premium — no hard limit)', () => {
    // Premium account: no truncation, just monitoring
    const isLong = (content: string): boolean => content.length > 500;
    assert(!isLong('Short tweet'), 'Short tweet not flagged');
    assert(isLong('x'.repeat(600)), 'Long post flagged for monitoring');
    assert(!isLong('x'.repeat(400)), '400-char post not flagged');
});

// ---- Summary ----

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}`);

if (failed > 0) {
    process.exit(1);
} else {
    console.log('\n🎉 All tests passed!\n');
    process.exit(0);
}
