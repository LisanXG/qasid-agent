import { describe, it, expect } from 'vitest';
import { withRetry } from './retry.js';

// ============================================================================
// Retry Utility — Unit Tests
// ============================================================================

describe('withRetry', () => {
    it('returns result on first successful attempt', async () => {
        const result = await withRetry(async () => 'success');
        expect(result).toBe('success');
    });

    it('retries on failure and returns on eventual success', async () => {
        let attempts = 0;
        const result = await withRetry(async () => {
            attempts++;
            if (attempts < 3) throw new Error('transient error');
            return 'recovered';
        }, { maxRetries: 3, baseDelayMs: 10 });

        expect(result).toBe('recovered');
        expect(attempts).toBe(3);
    });

    it('throws after exhausting all retries', async () => {
        let attempts = 0;
        await expect(
            withRetry(async () => {
                attempts++;
                throw new Error('persistent error');
            }, { maxRetries: 2, baseDelayMs: 10 })
        ).rejects.toThrow('persistent error');
        expect(attempts).toBe(2);
    });

    it('does not retry on insufficient funds', async () => {
        let attempts = 0;
        await expect(
            withRetry(async () => {
                attempts++;
                throw new Error('insufficient funds for gas');
            }, { maxRetries: 3, baseDelayMs: 10 })
        ).rejects.toThrow('insufficient funds');
        expect(attempts).toBe(1);
    });

    it('does not retry on 4xx client errors when skipClientErrors is true', async () => {
        let attempts = 0;
        const error: any = new Error('Unauthorized');
        error.status = 401;

        await expect(
            withRetry(async () => {
                attempts++;
                throw error;
            }, { maxRetries: 3, baseDelayMs: 10, skipClientErrors: true })
        ).rejects.toThrow('Unauthorized');
        expect(attempts).toBe(1);
    });

    it('retries 4xx errors when skipClientErrors is false', async () => {
        let attempts = 0;
        const error: any = new Error('Bad Request');
        error.status = 400;

        await expect(
            withRetry(async () => {
                attempts++;
                throw error;
            }, { maxRetries: 2, baseDelayMs: 10, skipClientErrors: false })
        ).rejects.toThrow('Bad Request');
        expect(attempts).toBe(2);
    });
});
