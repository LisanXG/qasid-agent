-- ============================================================================
-- QasidAI — Supabase Schema
-- Run this in your Supabase SQL editor to set up the required tables
-- ============================================================================

-- Posts table: stores all generated and posted content
CREATE TABLE IF NOT EXISTS qasid_posts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  content TEXT NOT NULL,
  content_type TEXT NOT NULL,
  platform TEXT NOT NULL,
  tone TEXT,
  topic TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  posted_at TIMESTAMPTZ DEFAULT NOW(),
  external_id TEXT,
  -- Engagement metrics (populated by learning engine)
  reactions INTEGER,
  replies INTEGER,
  link_clicks INTEGER,
  performance_score INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for common queries
CREATE INDEX IF NOT EXISTS idx_qasid_posts_platform ON qasid_posts(platform);
CREATE INDEX IF NOT EXISTS idx_qasid_posts_content_type ON qasid_posts(content_type);
CREATE INDEX IF NOT EXISTS idx_qasid_posts_posted_at ON qasid_posts(posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_qasid_posts_unscored ON qasid_posts(performance_score) WHERE performance_score IS NULL;

-- Strategy weights table: stores current learning weights
CREATE TABLE IF NOT EXISTS qasid_strategy (
  id TEXT PRIMARY KEY DEFAULT 'current',
  content_type_weights JSONB DEFAULT '{}',
  time_weights JSONB DEFAULT '{}',
  tone_weights JSONB DEFAULT '{}',
  topic_weights JSONB DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Meta reviews table: stores weekly performance reports
CREATE TABLE IF NOT EXISTS qasid_meta_reviews (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  week_start TEXT NOT NULL,
  week_end TEXT NOT NULL,
  total_posts INTEGER,
  avg_performance_score INTEGER,
  best_content_type TEXT,
  worst_content_type TEXT,
  report JSONB DEFAULT '{}',
  trend TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable Row Level Security
ALTER TABLE qasid_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE qasid_strategy ENABLE ROW LEVEL SECURITY;
ALTER TABLE qasid_meta_reviews ENABLE ROW LEVEL SECURITY;

-- Policy: restrict to service_role only (server-side agent)
-- The agent uses SUPABASE_SERVICE_ROLE_KEY which bypasses RLS,
-- but these policies ensure no anonymous/public access is possible.
CREATE POLICY "Service role only" ON qasid_posts FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
CREATE POLICY "Service role only" ON qasid_strategy FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
CREATE POLICY "Service role only" ON qasid_meta_reviews FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
