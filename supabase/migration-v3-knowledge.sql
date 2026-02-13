-- ============================================================================
-- QasidAI v3 — Self-Updating Knowledge System
-- Run after migration.sql and migration-v2-replies.sql
-- ============================================================================

-- Dynamic knowledge facts (learned at runtime)
create table if not exists qasid_knowledge (
  id          uuid primary key default gen_random_uuid(),
  fact        text not null,
  source      text not null,        -- 'founder_tweet' | 'founder_instruction' | 'website_scrape' | 'github_scrape'
  source_url  text,
  created_at  timestamptz default now(),
  expires_at  timestamptz,          -- optional TTL for temporary facts
  active      boolean default true
);

-- Content hashes for change detection (websites, READMEs)
create table if not exists qasid_content_hashes (
  url         text primary key,
  hash        text not null,
  raw_text    text,                  -- last known content (for diffing)
  checked_at  timestamptz default now()
);

-- Founder tweets already processed (dedup)
create table if not exists qasid_founder_tweets (
  tweet_id    text primary key,
  text        text not null,
  processed   boolean default false,
  created_at  timestamptz default now()
);

-- Indexes
create index if not exists idx_knowledge_active on qasid_knowledge(active, created_at desc);
create index if not exists idx_knowledge_source on qasid_knowledge(source);
create index if not exists idx_founder_tweets_processed on qasid_founder_tweets(processed);
