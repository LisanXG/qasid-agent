// ============================================================================
// QasidAI — Retry Utility
// Shared exponential backoff retry logic
// ============================================================================

import { createLogger } from './logger.js';

const log = createLogger('Retry');

export interface RetryOptions {
    /** Maximum number of attempts (default: 3) */
    maxRetries?: number;
    /** Base delay in ms, doubled each attempt (default: 2000) */
    baseDelayMs?: number;
    /** If true, don't retry on 4xx errors (default: true) */
    skipClientErrors?: boolean;
    /** Custom label for log messages */
    label?: string;
}

/**
 * Execute an async function with exponential backoff retries.
 * Skips retries on client errors (4xx) and insufficient funds by default.
 */
export async function withRetry<T>(
    fn: () => Promise<T>,
    options?: RetryOptions,
): Promise<T> {
    const {
        maxRetries = 3,
        baseDelayMs = 2000,
        skipClientErrors = true,
        label = 'operation',
    } = options || {};

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error: any) {
            // Don't retry on insufficient funds
            const msg = String(error).toLowerCase();
            if (msg.includes('insufficient funds') || msg.includes('exceeds balance')) {
                log.error(`${label}: insufficient funds — not retrying`, { error: msg.slice(0, 200) });
                throw error;
            }

            // Don't retry on client errors (4xx)
            if (skipClientErrors) {
                const status = error?.status ?? error?.statusCode;
                if (status && status >= 400 && status < 500) {
                    log.error(`${label}: client error (${status}) — not retrying`);
                    throw error;
                }
            }

            if (attempt < maxRetries) {
                const delay = Math.pow(2, attempt) * baseDelayMs;
                log.warn(`${label}: attempt ${attempt}/${maxRetries} failed, retrying in ${delay}ms...`, {
                    error: String(error).slice(0, 200),
                });
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                log.error(`${label}: failed after ${maxRetries} attempts`, {
                    error: String(error).slice(0, 200),
                });
                throw error;
            }
        }
    }

    // Unreachable, but TypeScript needs it
    throw new Error(`${label} failed`);
}
