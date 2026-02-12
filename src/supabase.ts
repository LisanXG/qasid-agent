import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';

// ============================================================================
// QasidAI — Shared Supabase Client
// Uses service_role key for server-side access (bypasses RLS)
// ============================================================================

// Service role key required — bypasses RLS for server-side access
export const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY);
