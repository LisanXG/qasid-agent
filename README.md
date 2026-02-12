# QasidAI — The Messenger

> **قاصد** (*Qasid*) = Messenger in Arabic

Autonomous AI Chief Marketing Officer for [Lisan Holdings](https://lisanholdings.dev).

Runs 24/7 — posts to [X](https://x.com/QasidAI_), cross-posts to [Botchan](https://netprotocol.app), with its brain stored permanently on-chain via [Net Protocol](https://netprotocol.app) on Base L2.

---

## What It Does

- 🧠 **Generates original content** powered by live data from [LISAN INTELLIGENCE](https://lisanintel.com)
- 📡 **Posts to X** on a 4x/day schedule — signal scorecards, builder narratives, market takes
- ⛓️ **On-chain brain** — personality, brand knowledge, and daily summaries stored on Base L2
- 📊 **Self-learning engine** — scores post performance, adapts content strategy weights weekly
- 🔗 **Cross-posts to Botchan** — Net Protocol's on-chain social feed

## Tech Stack

| Layer | Technology |
|---|---|
| LLM | Anthropic Claude Haiku |
| Social | X (Twitter) API v2 |
| On-Chain | Net Protocol (Base L2) — Storage + Botchan |
| Database | Supabase (PostgreSQL) |
| Hosting | Railway |
| Language | TypeScript / Node.js |

## How It Works

QasidAI operates as a fully autonomous marketing agent:

1. **Content Generation** — Pulls live market data and signal performance from LISAN INTELLIGENCE, then generates contextual posts using an LLM with a carefully crafted system prompt
2. **Multi-Platform Distribution** — Posts to X and cross-posts to Botchan (Net Protocol's on-chain feed)
3. **Learning Loop** — After 24 hours, scores each post's engagement (reactions, replies, clicks), adjusts content type weights, and runs weekly meta-reviews
4. **On-Chain Memory** — Stores its personality, brand knowledge, strategy snapshots, and daily summaries on Base L2 via Net Protocol for permanent verifiability

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your API keys:
#   ANTHROPIC_API_KEY     — Claude API key
#   SUPABASE_URL          — Supabase project URL
#   SUPABASE_ANON_KEY     — Supabase anon key
#   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key (server-side access)
#   X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET — X API credentials
#   NET_PRIVATE_KEY       — (optional) wallet private key for on-chain brain
#   NET_ENABLED           — set to "true" to enable Net Protocol
#   POSTING_ENABLED       — set to "true" to post live (default: dry run)
```

### 3. Run Supabase Migration

Run `supabase/migration.sql` in your Supabase SQL editor to create the required tables.

If updating an existing deployment, also run `supabase/migration-update.sql`.

### 4. CLI Commands

```bash
# Development mode (hot reload)
npm run dev

# Test content generation (no posting)
npm run dev -- test

# Post once to X
npm run dev -- once

# Post once to X + Botchan
npm run dev -- once-botchan

# Post to Botchan feed
npm run dev -- botchan-post <topic> <message>

# Upload brain to Net Protocol
npm run dev -- net-upload

# Upload agent profile to Net Protocol
npm run dev -- net-profile

# Write daily summary to Net Protocol
npm run dev -- net-summary

# Check Net Protocol status
npm run dev -- net-status

# Read brain data from Net Protocol
npm run dev -- net-read

# Run tests
npm test

# Production build
npm run build
npm start
```

## Links

- 🐦 **QasidAI on X**: [@QasidAI_](https://x.com/QasidAI_)
- 🏢 **Lisan Holdings**: [lisanholdings.dev](https://lisanholdings.dev)
- 📊 **LISAN INTELLIGENCE**: [lisanintel.com](https://lisanintel.com)
- 👤 **Founder**: [@lisantherealone](https://x.com/lisantherealone)

---

© 2026 Lisan Holdings. All rights reserved. See [LICENSE](LICENSE) for details.
