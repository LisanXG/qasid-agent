// ============================================================================
// QasidAI — Brand Knowledge Base
// Source of truth: lisanholdings.dev + GitHub (LisanXG)
// Everything a user would know by exploring all public-facing links
// ============================================================================

export const brandKnowledge = {
    founder: {
        name: 'Lisan',
        handle: '@lisantherealone',
        x: 'https://x.com/lisantherealone',
        background: [
            'US Navy Special Forces — Systems Administrator and Reaction Force Team Leader',
            'Former defense contractor and web developer',
            'Solo builder across web2 and web3',
            'One person building real products in the open',
        ],
        philosophy: 'Filter out the noise, identify the signal, act with absolute conviction.',
        ethos: 'Proof of work first. Trust later. Intelligence wasn\'t a buzzword — it was the difference between a successful mission and a catastrophic failure.',
        vibe: 'Not a startup founder. Not a DAO operator. Just a builder who ships and shows receipts.',
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
    },

    products: {
        intelligence: {
            name: 'Lisan Intelligence',
            url: 'https://lisanintel.com',
            proofUrl: 'https://lisanintel.com/proof',
            docsUrl: 'https://lisanintel.com/docs',
            description: 'Quantitative crypto signal platform. 17-indicator scoring engine. Replace gut feelings with math. Free. No paywall.',
            features: [
                '17-indicator scoring engine across Momentum, Trend, Volume, and Sentiment',
                'Self-learning weight adaptation — system adapts based on signal performance',
                'Market regime detection: BULLISH / BEARISH / NEUTRAL / VOLATILE',
                'ATR-based risk levels with dynamic stop loss and take profit (1:2 R:R)',
                'Real-time WebSocket tracking via Hyperliquid',
                '20 curated crypto assets with sufficient liquidity for reliable TA',
                'Transparency dashboard at /proof with full performance history',
                'Shareable signal cards — generate PNGs and share to X',
                'Quant view with CSV export for institutional workflows',
                'Watchlist with price tracking',
                'User authentication with cross-device sync',
                'Funding rate and open interest indicators from Hyperliquid',
            ],
            techStack: 'Next.js 16, TypeScript, Tailwind CSS 4, Supabase, Binance API, Hyperliquid API',
            keyDifferentiator: 'Free, transparent, no paywall. Shows receipts at /proof. Built by a veteran who filtered real intel for a living.',
        },
        score: {
            name: 'Lisan Score',
            platform: 'TradingView',
            description: 'PineScript indicator using the same methodology as lisanintel.com. 12 technical indicators. Native to your TradingView charts.',
            features: [
                '12-indicator scoring engine (85 points across Momentum, Trend, Volume, Volatility)',
                'LONG / SHORT / HOLD signals with confidence scores',
                'ATR-based stop loss and take profit levels drawn on chart',
                'Dashboard table overlay with cluster breakdown',
                'Alert conditions for signal changes and high confidence',
                'Lisan brand colors (cyan, red, purple)',
            ],
            keyDifferentiator: 'Free, same engine as the web platform, native to your charts.',
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
        'Lisan Intelligence launched — quantitative crypto signal platform with 17-indicator scoring engine',
        'Proof page at lisanintel.com/proof — full transparency on signal performance',
        'Lisan Score released — same engine as a PineScript indicator native to TradingView',
        'QasidAI created — autonomous AI CMO with on-chain brain via Net Protocol on Base L2',
        'All products are free, open, and publicly verifiable. All code on GitHub.',
    ],

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
