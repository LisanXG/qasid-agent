-- ============================================================================
-- QasidAI — Migration Update (run this in Supabase SQL Editor)
-- Fixes: RLS policies (security) + meta_reviews schema mismatch
-- Safe to run on existing tables — uses IF NOT EXISTS and DROP IF EXISTS
-- ============================================================================

-- 1. Fix meta_reviews table: drop and recreate with correct columns
DROP TABLE IF EXISTS qasid_meta_reviews;

CREATE TABLE qasid_meta_reviews (
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

-- 2. Fix RLS policies: drop old permissive ones, create restrictive ones
-- Drop old policies (ignore errors if they don't exist)
DROP POLICY IF EXISTS "Allow all for anon" ON qasid_posts;
DROP POLICY IF EXISTS "Allow all for anon" ON qasid_strategy;
DROP POLICY IF EXISTS "Allow all for anon" ON qasid_meta_reviews;
DROP POLICY IF EXISTS "Service role only" ON qasid_posts;
DROP POLICY IF EXISTS "Service role only" ON qasid_strategy;
DROP POLICY IF EXISTS "Service role only" ON qasid_meta_reviews;

-- Ensure RLS is enabled
ALTER TABLE qasid_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE qasid_strategy ENABLE ROW LEVEL SECURITY;
ALTER TABLE qasid_meta_reviews ENABLE ROW LEVEL SECURITY;

-- Create restrictive policies (service_role bypasses RLS automatically,
-- so these effectively block all anon/public access)
CREATE POLICY "Service role only" ON qasid_posts FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
CREATE POLICY "Service role only" ON qasid_strategy FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
CREATE POLICY "Service role only" ON qasid_meta_reviews FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- Done! You should see "Success. No rows returned" in the Supabase SQL editor.
