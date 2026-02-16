-- QasidAI Migration v4: X Articles Table
-- Generated: February 2026
-- Purpose: Store generated long-form articles for manual X Premium publishing

CREATE TABLE IF NOT EXISTS qasid_articles (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  article_type TEXT NOT NULL,
  word_count INTEGER NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published BOOLEAN NOT NULL DEFAULT FALSE,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for finding unpublished articles
CREATE INDEX IF NOT EXISTS idx_qasid_articles_unpublished
  ON qasid_articles (published, created_at DESC)
  WHERE published = FALSE;

-- Index for article type filtering
CREATE INDEX IF NOT EXISTS idx_qasid_articles_type
  ON qasid_articles (article_type, created_at DESC);
