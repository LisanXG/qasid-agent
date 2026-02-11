import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';

// ============================================================================
// QasidAI — Shared Supabase Client
// Uses service_role key for server-side access (bypasses RLS)
// ============================================================================

// Prefer service role key for full access; fall back to anon key for read-only
const supabaseKey = config.SUPABASE_SERVICE_ROLE_KEY || config.SUPABASE_ANON_KEY;

export const supabase = createClient(config.SUPABASE_URL, supabaseKey);
