-- ============================================================================
-- QasidAI v2 — Migration Update: Timeline Scanner + Engagement
-- Run this in your Supabase SQL editor
-- ============================================================================

-- Replies table: tracks all contextual replies from the timeline scanner
-- Used for dedup (never reply twice to same tweet) and analytics
CREATE TABLE IF NOT EXISTS qasid_replies (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  target_tweet_id TEXT NOT NULL,
  target_author TEXT,
  reply_tweet_id TEXT,
  reply_text TEXT,
  search_query TEXT,
  replied_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_qasid_replies_target ON qasid_replies(target_tweet_id);
CREATE INDEX IF NOT EXISTS idx_qasid_replies_replied_at ON qasid_replies(replied_at DESC);

-- Unique constraint: never reply to the same tweet twice
CREATE UNIQUE INDEX IF NOT EXISTS idx_qasid_replies_unique_target ON qasid_replies(target_tweet_id);

-- RLS
ALTER TABLE qasid_replies ENABLE ROW LEVEL SECURITY;

-- Service role only policy (QasidAI uses service_role key which bypasses RLS)
CREATE POLICY "Service role only" ON qasid_replies FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- ============================================================================
-- Mention state: watermark for tracking last processed mention
-- ============================================================================

CREATE TABLE IF NOT EXISTS qasid_mention_state (
  id TEXT PRIMARY KEY DEFAULT 'current',
  last_mention_id TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE qasid_mention_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role only" ON qasid_mention_state FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- ============================================================================
-- Smart follow tracking: records who QasidAI has followed and why
-- ============================================================================

CREATE TABLE IF NOT EXISTS qasid_follows (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  target_user_id TEXT NOT NULL,
  target_username TEXT,
  source TEXT NOT NULL,  -- 'mention', 'reply', 'scanner', 'manual'
  reason TEXT,
  followed_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_qasid_follows_user ON qasid_follows(target_user_id);
CREATE INDEX IF NOT EXISTS idx_qasid_follows_followed_at ON qasid_follows(followed_at DESC);

ALTER TABLE qasid_follows ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role only" ON qasid_follows FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
