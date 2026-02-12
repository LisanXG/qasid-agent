import { z } from 'zod';

// ============================================================================
// QasidAI Configuration
// Validates all environment variables at startup
// ============================================================================

const envSchema = z.object({
    // LLM
    ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),

    // Supabase
    SUPABASE_URL: z.string().url('SUPABASE_URL must be a valid URL'),
    SUPABASE_ANON_KEY: z.string().min(1, 'SUPABASE_ANON_KEY is required'),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY is required — anon key will be blocked by RLS'),

    // X / Twitter
    X_API_KEY: z.string().optional(),
    X_API_SECRET: z.string().optional(),
    X_ACCESS_TOKEN: z.string().optional(),
    X_ACCESS_SECRET: z.string().optional(),

    // LISAN Intelligence
    LISAN_INTEL_URL: z.string().url().default('https://lisanintel.com'),

    // Net Protocol (on-chain brain)
    NET_PRIVATE_KEY: z.string()
        .refine(
            (v) => v === '' || (v.startsWith('0x') && v.length === 66),
            'NET_PRIVATE_KEY must start with 0x and be 66 characters (32-byte hex key)'
        )
        .optional(),
    NET_ENABLED: z.string().transform(v => v === 'true').default('false'),

    // Agent Config
    POSTING_ENABLED: z.string().transform(v => v === 'true').default('false'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

function loadConfig() {
    const result = envSchema.safeParse(process.env);

    if (!result.success) {
        console.error('❌ Invalid environment configuration:');
        for (const issue of result.error.issues) {
            console.error(`  → ${issue.path.join('.')}: ${issue.message}`);
        }
        process.exit(1);
    }

    return result.data;
}

export const config = loadConfig();

// Derived config
export const isXConfigured = !!(config.X_API_KEY && config.X_API_SECRET && config.X_ACCESS_TOKEN && config.X_ACCESS_SECRET);
export const isNetConfigured = !!(config.NET_PRIVATE_KEY && config.NET_ENABLED);

export type Config = typeof config;

