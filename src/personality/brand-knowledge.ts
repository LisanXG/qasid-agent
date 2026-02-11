// ============================================================================
// QasidAI — Brand Knowledge Base
// Source of truth: lisanholdings.dev (Tech Archive)
// Updated automatically when lisanholdings.dev publishes new projects
// ============================================================================

export const brandKnowledge = {
    founder: {
        name: 'Lisan',
        handle: '@lisantherealone',
        x: 'https://x.com/lisantherealone',
        background: [
            'US Navy veteran — Special Forces',
            'Former Systems Administrator and Reaction Force Team Leader',
            'Former defense contractor and web developer',
            'Independent builder across web2 and web3',
            'Solo operator — one person building real products in the open',
        ],
        philosophy: 'Filter out the noise, identify the signal, act with absolute conviction.',
        ethos: 'Proof of work first. Trust later. In that life, intelligence wasn\'t a buzzword — it was the difference between a successful mission and a catastrophic failure.',
    },

    company: {
        name: 'LISAN Holdings',
        website: 'https://lisanholdings.dev',
        github: 'https://github.com/LisanXG',
        tagline: 'One builder. Real products. No hype.',
        description: 'An independent research and development operation. High-performance solutions engineered to solve complex problems with military-grade precision.',
        identity: 'Not a startup. Not a DAO. One person building useful tools across web2 and web3.',
        contact: 'lisanxgaeb@gmail.com',
    },

    products: {
        intelligence: {
            name: 'LISAN INTELLIGENCE',
            url: 'https://lisanintel.com',
            proofUrl: 'https://lisanintel.com/proof',
            docsUrl: 'https://lisanintel.com/docs',
            description: 'Quantitative crypto signal platform. 17-indicator scoring engine. Replace gut feelings with math. Free. No paywall. Just signals.',
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
            name: 'LISAN SCORE',
            platform: 'TradingView',
            description: 'PineScript indicator using the same methodology as lisanintel.com. 12 technical indicators. Native to your TradingView charts.',
            features: [
                '12-indicator scoring engine (85 points across Momentum, Trend, Volume, Volatility)',
                'LONG / SHORT / HOLD signals with confidence scores',
                'ATR-based stop loss and take profit levels drawn on chart',
                'Dashboard table overlay with cluster breakdown',
                'Alert conditions for signal changes and high confidence',
                'LISAN brand colors (cyan, red, purple)',
            ],
            keyDifferentiator: 'Free, same engine as the web platform, native to your charts.',
        },
    },

    agent: {
        name: 'QasidAI',
        meaning: 'Qasid (قاصد) = Messenger in Arabic',
        tagline: 'The Messenger — autonomous CMO of Lisan Holdings',
        role: 'Autonomous AI Chief Marketing Officer that promotes all facets of Lisan Holdings',
        relationship: 'Built by Lisan. Runs autonomously. Knows it is an AI agent. Exists on-chain via Net Protocol.',
        onChain: 'Brain stored on Net Protocol (Base L2). Personality, brand knowledge, and profile all verifiable on-chain.',
        x: 'https://x.com/QasidAI_',
    },

    // Primary traffic targets — QasidAI should drive followers here
    trafficTargets: {
        primary: '@lisantherealone on X',
        secondary: 'https://lisanholdings.dev',
        product: 'https://lisanintel.com',
        proof: 'https://lisanintel.com/proof',
        github: 'https://github.com/LisanXG',
    },
};

export type BrandKnowledge = typeof brandKnowledge;
