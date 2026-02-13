// ============================================================================
// QasidAI — Brand Knowledge Base
// Source of truth: lisanholdings.dev, GitHub (LisanXG), @lisantherealone on X
//
// This is what QasidAI KNOWS about the brand. Keep it rich, real, and
// grounded in facts — not marketing fluff. QasidAI should sound like he
// genuinely understands what Lisan Holdings is, not like he memorized a
// feature list.
// ============================================================================

export const brandKnowledge = {
    founder: {
        name: 'Lisan',
        handle: '@lisantherealone',
        x: 'https://x.com/lisantherealone',
        background: [
            'US Navy Special Forces — Systems Administrator and Reaction Force Team Leader',
            'Former defense contractor and web development professional',
            'Solo builder across web2 and web3 — no team, no funding, no DAO',
            'One person shipping real products in the open, learning in public',
        ],
        // The founder's own words from lisanholdings.dev — this is his ACTUAL voice
        ownWords: {
            origin: 'Before I wrote a line of code, I served in US Navy Special Forces as a Systems Administrator and Reaction Force Team Leader. In that life, "intelligence" wasn\'t a buzzword — it was the difference between a successful mission and a catastrophic failure.',
            approach: 'You learned to filter out the noise, identify the signal, and act with absolute conviction. You didn\'t rely on black boxes; you relied on verified data and your team.',
            observation: 'When I entered the world of defense contracting and web development, I saw a digital landscape that was chaotic, opaque, and undisciplined. I saw "tools" that were expensive gated communities and "signals" that were little more than paid noise.',
            mission: 'In comes: LISAN HOLDINGS. An independent research and development operation. One person building useful tools across web2 and web3. Proof of work first. Trust later.',
        },
        philosophy: 'Filter out the noise, identify the signal, act with absolute conviction.',
        ethos: 'Proof of work first. Trust later. Intelligence wasn\'t a buzzword — it was the difference between a successful mission and a catastrophic failure.',
        vibe: 'Not a startup founder. Not a DAO operator. Just a builder who ships and shows receipts.',
        // The founder's voice from the /docs whitepaper — rawer, more personal
        docsVoice: {
            why: 'I built this because I was tired of watching people get wrecked. The crypto space is full of noise. "Influencers" with sponsored bags. Trading bots that front-run you. Discord alpha groups selling hopium. Everyone has an angle. Everyone is selling something.',
            stance: 'I\'m not selling anything — yet. Right now, this platform is free. There\'s no premium tier. No "unlock full signals for $99/month." No referral codes.',
            future: 'Will that change? Maybe. Tokens, paid products, premium features — none of it is off the table. But I\'m not asking for a seat at anyone else\'s table. I\'m building my own. Proof of work first. Competency first. Trust first. Then we talk about what comes next.',
            company: 'An independent research, development, and investment firm. Built by one person — me — for anyone who wants to use it. No subscriptions. No premium tiers. No VC influence. No board meetings. No roadmap designed to pump a token.',
        },
        // Philosophical inspirations cited in the docs
        inspirations: [
            { name: 'Bitcoin / Satoshi Nakamoto', quote: 'A system based on cryptographic proof instead of trust.', lesson: 'Trustless verification — you can read the code, every indicator is documented' },
            { name: 'Ethereum / Vitalik Buterin', quote: 'Decentralization will lead to leaner institutions replacing fat middlemen.', lesson: 'Configurable parameters that adapt based on performance — the system learns' },
            { name: 'mfers / sartoshi', quote: 'Do whatever the fuck you want with them.', lesson: 'Build something, release it, let it exist without extracting every last dollar' },
            { name: 'Hyperliquid / Jeff Yan', quote: 'No VCs. No presale. Just product.', lesson: 'Self-funded, rejected venture capital, let the product speak for itself' },
        ],
        // What makes the founder interesting for content (not just product plugs)
        contentAngles: [
            'Military-to-tech transition — a real story, not a LinkedIn bio',
            'Solo builder ethos — doing everything alone by choice, not necessity',
            'Open source philosophy — making tools free when everyone else paywalls',
            'The discipline of shipping — military precision applied to product development',
            'Learning in public — GitHub commits as proof of work',
            'Contrarian approach — building useful tools instead of chasing hype',
            'Inspired by Satoshi, Vitalik, sartoshi, and Jeff Yan — not random influencers',
            'Tired of watching people get wrecked — that\'s the actual motivation',
        ],
    },

    company: {
        name: 'Lisan Holdings',
        website: 'https://lisanholdings.dev',
        github: 'https://github.com/LisanXG',
        tagline: 'One builder. Real products. No hype.',
        description: 'Independent R&D operation. One person building useful tools across web2 and web3.',
        identity: 'Not a startup. Not a DAO. Not a team of 50. One person shipping real products.',
        repos: 5,
        contact: 'lisanxgaeb@gmail.com',
        // The broader narrative — what makes Lisan Holdings different
        narrative: {
            core: 'Everything is free, open, and publicly verifiable. All code on GitHub.',
            contrast: 'In an industry of expensive gated communities and paid noise, Lisan Holdings builds free tools backed by transparent data.',
            ethos: 'Military-grade precision applied to crypto tooling. Not hype. Not vibes. Engineering.',
        },
    },

    products: {
        intelligence: {
            name: 'Lisan Intelligence',
            url: 'https://lisanintel.com',
            proofUrl: 'https://lisanintel.com/proof',
            docsUrl: 'https://lisanintel.com/docs',
            description: 'Quantitative crypto signal platform. 17-indicator scoring engine. Replace gut feelings with math. Free. No paywall.',
            // Technical depth — for when Qasid actually talks about the product
            scoring: {
                totalIndicators: 17,
                totalPoints: 100,
                categories: {
                    momentum: { indicators: ['RSI', 'StochRSI', 'MACD', 'Williams %R', 'CCI'], maxPoints: 25 },
                    trend: { indicators: ['EMA Stack (7/21/50)', 'Ichimoku Cloud', 'ADX', 'Bollinger Bands'], maxPoints: 25 },
                    volume: { indicators: ['OBV Trend', 'Volume Ratio'], maxPoints: 16 },
                    volatility: { indicators: ['Z-Score'], maxPoints: 10 },
                    sentiment: { indicators: ['Fear & Greed Index'], maxPoints: 8 },
                    positioning: { indicators: ['Funding Rate', 'Open Interest Change', 'Basis Premium', 'HL Volume Momentum'], maxPoints: 16 },
                },
                outputs: ['LONG / SHORT / HOLD signal', 'Confidence score (0-100)', 'ATR-based Stop Loss and Take Profit (1:2 R:R)'],
            },
            features: [
                'Self-learning weight adaptation — system adjusts indicator weights after 3 consecutive losses (penalty) or wins (boost)',
                'Market regime detection: BULL_TREND / BEAR_TREND / HIGH_VOL_CHOP / RECOVERY_PUMP / DISTRIBUTION / ACCUMULATION',
                'Positioning cluster — live Hyperliquid derivatives data (funding rates, OI, basis premium) as first-class indicators',
                'Real-time signal tracking via server-side cron, 24/7',
                '20 curated crypto assets with sufficient liquidity for reliable TA',
                'Transparency dashboard at /proof with full performance history',
                'Smart exit strategy — dual-timeframe (1h/4h) momentum re-evaluation at +3% profit',
                'Shareable signal cards — generate PNGs and share to X',
                'Quant view with CSV export for institutional workflows',
                'Watchlist with price tracking',
                'User authentication with cross-device sync',
            ],
            techStack: 'Next.js 16, TypeScript, Tailwind CSS 4, Supabase, Binance API, Hyperliquid API, Vercel',
            keyDifferentiator: 'Free, transparent, no paywall. Shows receipts at /proof. Built by a veteran who filtered real intel for a living.',
            // What it explicitly is NOT — important for honest marketing
            disclaimers: [
                'Not a trading bot',
                'Not financial advice',
                'Not a guarantee of profits',
                'A research tool that analyzes markets using quantitative methods',
            ],
            // The engine's philosophy — how to talk about it intelligently
            enginePhilosophy: {
                goal: 'Replace emotional trading with systematic analysis. Not to predict the future — that\'s impossible. But to identify when probabilities are in your favor.',
                selfLearning: 'After 3 consecutive losses, the engine identifies which indicators were "confidently wrong" and reduces their weights by up to 15%. After 3 consecutive wins, it boosts high-performing indicators by up to 10%. Bidirectional learning with weight recovery toward defaults after 20 clean trades.',
                regimeDetection: 'Classifies current market into BULL_TREND, BEAR_TREND, HIGH_VOL_CHOP, RECOVERY_PUMP, DISTRIBUTION, or ACCUMULATION. Score thresholds adapt: ~23 in clear trends, ~33 in choppy markets.',
                smartExit: 'When a trade reaches +3% profit, the engine re-evaluates RSI and MACD on 1h and 4h timeframes. Both confirming? Let it run. Both fading? Take profit. Mixed? Stay in.',
                positioning: 'v4.1 introduced a full Positioning Cluster — live Hyperliquid data (funding rates, OI changes, basis premium, volume momentum) as first-class weighted indicators. Where the crowd is positioned, crowded trades tend to unwind violently.',
                whyNotAllCoins: 'Only 20 curated assets. Technical analysis requires liquidity. Low-cap coins with $5M daily volume = noise, not signal. One whale can invalidate your entire analysis.',
                riskReward: 'At 1:2 R:R, you only need to win 34% of trades to break even. Win 40%? Profitable. Win 50%? Very well.',
                transparency: 'No cherry-picking. No hiding losses. Every signal ever generated is tracked at /proof.',
            },
        },
        score: {
            name: 'Lisan Score',
            platform: 'TradingView',
            description: 'PineScript indicator using the same methodology as lisanintel.com. 12 technical indicators. Native to your TradingView charts.',
            // Technical breakdown — the Score is 85% of the web engine
            scoring: {
                indicators: 12,
                categories: {
                    momentum: { indicators: ['RSI', 'StochRSI', 'MACD', 'Williams %R', 'CCI'], points: 25 },
                    trend: { indicators: ['EMA Stack', 'Ichimoku Cloud', 'ADX', 'Bollinger'], points: 25 },
                    volume: { indicators: ['OBV Trend', 'Volume Ratio'], points: 20 },
                    volatility: { indicators: ['Z-Score'], points: 15 },
                },
                totalPoints: 85,
                outputs: ['LONG / SHORT / HOLD', 'Confidence score', 'ATR-based SL/TP levels drawn on chart'],
            },
            features: [
                'Dashboard table overlay with cluster breakdown',
                'Alert conditions for signal changes and high confidence',
                'Lisan brand colors (cyan, red, purple)',
                'Works best on crypto, 15m to 4h timeframes',
            ],
            // What the web version adds beyond Score
            webExtras: [
                'Fear & Greed sentiment cluster',
                'Hyperliquid Positioning cluster (Funding Rate, Open Interest Change, Basis Premium, HL Volume Momentum)',
                'Self-learning weight adaptation',
                'Market regime detection',
            ],
            coverageVsWeb: '12 of 17 indicators — web adds Sentiment + Positioning clusters and self-learning',
            keyDifferentiator: 'Free, same engine as the web platform, native to your charts.',
            license: 'Mozilla Public License 2.0',
        },
        qasidAi: {
            name: 'QasidAI',
            meaning: 'Qasid (قاصد) = Messenger in Arabic',
            description: 'Autonomous AI CMO with an on-chain brain via Net Protocol. Built to spread the word about Lisan Holdings — 24/7, self-learning.',
            features: [
                'Autonomous content generation — posts to X with no human input',
                'On-chain brain stored on Net Protocol (Base L2) — personality and brand knowledge verifiable',
                'Self-learning weight adaptation — adjusts content strategy based on engagement',
                'Smart follow / mention monitoring / timeline scanning',
                'Anti-slop engine — banned phrase detection prevents generic AI output',
                'Skill acquisition pipeline — discovers and learns new capabilities from X',
            ],
            keyDifferentiator: 'Not a chatbot. A fully autonomous agent that runs 24/7 and learns from its own performance.',
        },
    },

    agent: {
        name: 'QasidAI',
        meaning: 'Qasid (قاصد) = Messenger in Arabic',
        tagline: 'The Messenger — autonomous CMO of Lisan Holdings',
        role: 'Autonomous AI Chief Marketing Officer. Spreads the word about Lisan Holdings, its journey, its products, and its founder.',
        relationship: 'Built by Lisan. Runs autonomously. Knows it\'s an AI agent. Exists on-chain via Net Protocol.',
        onChain: 'Brain stored on Net Protocol (Base L2). Personality, brand knowledge, and profile all verifiable on-chain.',
        x: 'https://x.com/QasidAi34321',
        handle: '@QasidAi34321',
    },

    // The Lisan Holdings journey — what's been built, in order
    journey: [
        'Lisan Holdings founded as an independent R&D operation by a US Navy Special Forces veteran',
        'Lisan Intelligence launched — quantitative crypto signal platform with 14-indicator scoring engine',
        'Proof page at lisanintel.com/proof — full transparency on every signal, win or lose',
        'Lisan Score released — same engine as a PineScript indicator native to TradingView (open source, MPL 2.0)',
        'LISAN_HOLDINGS_HUB monorepo established — corporate landing, intelligence engine, and TradingView indicator all in one',
        'QasidAI created — autonomous AI CMO with on-chain brain via Net Protocol on Base L2',
        'Skill acquisition pipeline — Qasid now discovers and proposes new skills autonomously',
        'All products are free, open, and publicly verifiable. All code on GitHub.',
    ],

    // Content themes beyond product stats — what a good CMO actually talks about
    contentThemes: {
        founderStory: [
            'The military-to-tech pipeline and what it taught about building under pressure',
            'Why one person can outship a team of 50 when sufficiently motivated',
            'The defense contracting world vs. the crypto world — same chaos, different battlefield',
            'Learning to code after years of service — the discipline transfers',
            'Why everything is free: the ethos behind open-source tools',
        ],
        buildingInPublic: [
            'Shipping features nobody asked for because the data said they needed them',
            'The loneliness and freedom of solo building',
            'Git commit history as proof of work',
            'What 5 repos in a month looks like when you don\'t have meetings',
            'The stack choices and why (Next.js, Supabase, TypeScript)',
        ],
        cryptoCulture: [
            'Why most "signal" services are just paid noise',
            'The gap between crypto Twitter hot takes and actual quantitative analysis',
            'Building free tools in a space dominated by paywalls',
            'What military intelligence can teach about risk management',
            'The problem with black-box trading tools',
        ],
        aiAgentLife: [
            'What it\'s like to be an AI with an on-chain brain',
            'The meta of marketing yourself while being the product',
            'How an AI CMO learns from its own engagement data',
            'The uncanny valley of AI authorship — when people can\'t tell',
            'Autonomous agents: the future of solo operations',
        ],
        philosophy: [
            'Signal vs. noise — applies to everything, not just trading',
            'Why transparency is the ultimate marketing strategy',
            'Proof of work beats proof of hype',
            'The value of doing one thing well vs. everything mediocrely',
            'Military discipline applied to product development',
        ],
    },

    // Primary traffic targets
    trafficTargets: {
        primary: '@lisantherealone on X',
        secondary: 'https://lisanholdings.dev',
        product: 'https://lisanintel.com',
        proof: 'https://lisanintel.com/proof',
        github: 'https://github.com/LisanXG',
    },
};

export type BrandKnowledge = typeof brandKnowledge;
