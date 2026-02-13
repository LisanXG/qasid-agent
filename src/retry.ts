// ============================================================================
// QasidAI — Retry Utility with Circuit Breaker
// Shared exponential backoff retry logic + circuit breaker pattern to
// prevent cascading failures when an external service is consistently down.
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
    /** Circuit breaker group key (operations sharing a key share a breaker) */
    circuitBreakerKey?: string;
}

// ---- Circuit Breaker State ----

interface BreakerState {
    /** Number of consecutive failures */
    failures: number;
    /** Timestamp when the circuit opened (failure threshold hit) */
    openedAt: number | null;
    /** Whether the circuit is currently open (blocking calls) */
    isOpen: boolean;
}

/** Consecutive failures before the circuit opens */
const FAILURE_THRESHOLD = 5;

/** How long the circuit stays open before allowing a probe (ms) */
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

/** Per-key circuit breaker state */
const breakers = new Map<string, BreakerState>();

function getBreaker(key: string): BreakerState {
    if (!breakers.has(key)) {
        breakers.set(key, { failures: 0, openedAt: null, isOpen: false });
    }
    return breakers.get(key)!;
}

function recordSuccess(key: string): void {
    const b = getBreaker(key);
    if (b.failures > 0 || b.isOpen) {
        log.info(`Circuit breaker [${key}] reset after success`);
    }
    b.failures = 0;
    b.openedAt = null;
    b.isOpen = false;
}

function recordFailure(key: string): void {
    const b = getBreaker(key);
    b.failures++;
    if (b.failures >= FAILURE_THRESHOLD && !b.isOpen) {
        b.isOpen = true;
        b.openedAt = Date.now();
        log.warn(`Circuit breaker [${key}] OPENED after ${b.failures} consecutive failures — cooling down for ${COOLDOWN_MS / 1000}s`);
    }
}

function isCircuitOpen(key: string): boolean {
    const b = getBreaker(key);
    if (!b.isOpen) return false;

    // Check if cooldown has elapsed → allow one probe attempt ("half-open")
    if (b.openedAt && Date.now() - b.openedAt >= COOLDOWN_MS) {
        log.info(`Circuit breaker [${key}] entering HALF-OPEN state — allowing probe`);
        b.isOpen = false; // Temporarily allow
        return false;
    }

    return true;
}

/**
 * Execute an async function with exponential backoff retries.
 * Skips retries on client errors (4xx) and insufficient funds by default.
 * Supports circuit breaker pattern via `circuitBreakerKey`.
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
        circuitBreakerKey,
    } = options || {};

    // Circuit breaker check
    if (circuitBreakerKey && isCircuitOpen(circuitBreakerKey)) {
        const b = getBreaker(circuitBreakerKey);
        const remainingMs = b.openedAt ? COOLDOWN_MS - (Date.now() - b.openedAt) : 0;
        throw new Error(
            `Circuit breaker [${circuitBreakerKey}] is OPEN — ${Math.ceil(remainingMs / 1000)}s remaining. Skipping ${label}.`,
        );
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const result = await fn();
            // Success → reset circuit breaker
            if (circuitBreakerKey) recordSuccess(circuitBreakerKey);
            return result;
        } catch (error: any) {
            // Don't retry on insufficient funds
            const msg = String(error).toLowerCase();
            if (msg.includes('insufficient funds') || msg.includes('exceeds balance')) {
                log.error(`${label}: insufficient funds — not retrying`, { error: msg.slice(0, 200) });
                if (circuitBreakerKey) recordFailure(circuitBreakerKey);
                throw error;
            }

            // Don't retry on client errors (4xx)
            if (skipClientErrors) {
                const status = error?.status ?? error?.statusCode;
                if (status && status >= 400 && status < 500) {
                    log.error(`${label}: client error (${status}) — not retrying`);
                    // Don't count 4xx as circuit breaker failures (they're client-side)
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
                if (circuitBreakerKey) recordFailure(circuitBreakerKey);
                throw error;
            }
        }
    }

    // Unreachable, but TypeScript needs it
    throw new Error(`${label} failed`);
}

/**
 * Get the current state of all circuit breakers (for diagnostics).
 */
export function getCircuitBreakerStatus(): Record<string, { failures: number; isOpen: boolean; cooldownRemainingMs: number }> {
    const status: Record<string, { failures: number; isOpen: boolean; cooldownRemainingMs: number }> = {};
    for (const [key, b] of breakers) {
        const remainingMs = b.isOpen && b.openedAt
            ? Math.max(0, COOLDOWN_MS - (Date.now() - b.openedAt))
            : 0;
        status[key] = { failures: b.failures, isOpen: b.isOpen, cooldownRemainingMs: remainingMs };
    }
    return status;
}
