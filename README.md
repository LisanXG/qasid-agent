# QasidAI — The Messenger

> **قاصد** (*Qasid*) = Messenger in Arabic

Autonomous AI Chief Marketing Officer for [Lisan Holdings](https://lisanholdings.dev). Runs 24/7, posts to X and [Botchan](https://netprotocol.app), with its brain stored permanently on-chain via [Net Protocol](https://netprotocol.app) (Base L2).

---

## What It Does

- **Generates content** using Claude Haiku with live data from [LISAN INTELLIGENCE](https://lisanintel.com)
- **Posts to X** on a 4x/day schedule (8 AM, 2 PM, 6 PM, 10 PM UTC)
- **Cross-posts to Botchan** (Net Protocol's on-chain feed) — 1x/day
- **Self-learning engine** — scores post performance, adapts content strategy weights weekly
- **On-chain brain** — personality, brand knowledge, profile, and daily summaries stored on Base L2

## Architecture

```
src/
├── config.ts              # Zod-validated env config
├── index.ts               # CLI entry point
├── logger.ts              # Structured logger
├── supabase.ts            # Shared Supabase client (service_role)
├── data/
│   ├── intelligence.ts    # LISAN INTELLIGENCE API client
│   └── market.ts          # CoinGecko trending data
├── engine/
│   ├── content.ts         # Content generation pipeline
│   ├── llm.ts             # Claude Haiku client
│   └── memory.ts          # Post history + dedup
├── learning/
│   ├── scorer.ts          # Performance scoring (24h window)
│   ├── tracker.ts         # Engagement metric updates
│   ├── weights.ts         # Adaptive strategy weights
│   └── meta-review.ts     # Weekly performance analysis
├── net/
│   ├── brain.ts           # On-chain brain manager
│   ├── client.ts          # Net Protocol client (Storage + Botchan)
│   ├── daily-summary.ts   # End-of-day on-chain digest
│   ├── generate-wallet.ts # One-time wallet generator
│   └── profile.ts         # On-chain agent identity
├── personality/
│   ├── brand-knowledge.ts # Lisan Holdings product data
│   └── system-prompt.ts   # QasidAI voice and rules
├── platforms/
│   └── x.ts               # X (Twitter) API v2 client
└── scheduler/
    └── cron.ts            # Cron job orchestrator
```

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Copy env template and fill in your values
cp .env.example .env

# 3. Run Supabase migration (in Supabase SQL editor)
# → paste contents of supabase/migration.sql

# 4. Generate a wallet for on-chain brain (optional)
npx tsx src/net/generate-wallet.ts

# 5. Test content generation (dry run)
npx tsx src/index.ts test

# 6. Start the scheduler
npx tsx src/index.ts
```

## CLI Commands

| Command | Description |
|---|---|
| `npx tsx src/index.ts` | Start scheduler (4 posts/day + learning) |
| `npx tsx src/index.ts test` | Generate a sample post (no posting) |
| `npx tsx src/index.ts once` | Single X post cycle |
| `npx tsx src/index.ts once-botchan` | Single X + Botchan post cycle |
| `npx tsx src/index.ts botchan-post <topic> <msg>` | Post to a specific Botchan topic |
| `npx tsx src/index.ts net-upload` | Upload brain to Net Protocol |
| `npx tsx src/index.ts net-profile` | Upload agent profile to Net Protocol |
| `npx tsx src/index.ts net-read` | Read all on-chain brain data |
| `npx tsx src/index.ts net-status` | Show Net Protocol status |
| `npx tsx src/index.ts net-summary` | Write daily summary on-chain |

## Environment Variables

See [.env.example](.env.example) for the full list. Key variables:

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | Claude API key |
| `SUPABASE_URL` | ✅ | Supabase project URL |
| `SUPABASE_ANON_KEY` | ✅ | Supabase anon key (fallback) |
| `SUPABASE_SERVICE_ROLE_KEY` | ⚠️ | Supabase service role key (recommended for RLS) |
| `X_API_KEY` + secrets | ✅ | X API v2 credentials |
| `NET_PRIVATE_KEY` | Optional | Wallet private key for on-chain brain |
| `POSTING_ENABLED` | ✅ | Set to `true` to go live (default: `false` = dry run) |

## Security

- All secrets loaded from `.env` (gitignored)
- Content sanitization blocks API key leaks in LLM output
- `POSTING_ENABLED=false` by default (safe dry run)
- Supabase RLS restricted to `service_role` only
- Global error handlers prevent silent crashes

---

Built by [Lisan](https://x.com/lisantherealone) · [lisanholdings.dev](https://lisanholdings.dev)
