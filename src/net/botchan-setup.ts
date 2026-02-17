import { execFileSync } from 'node:child_process';
import { config, isNetConfigured } from '../config.js';
import { createLogger } from '../logger.js';

// ============================================================================
// QasidAI — Botchan Profile & Agent Setup
// One-time setup for QasidAI's Botchan identity. Idempotent — safe to call
// on every startup. Sets profile metadata, registers on agent leaderboard,
// and registers our named feed.
//
// CLI Reference: https://github.com/stuckinaboot/botchan/blob/main/SKILL.md
// ============================================================================

const log = createLogger('BotchanSetup');

/** Whether setup has already been run this session */
let setupComplete = false;

/**
 * Run a botchan write command. Returns true on success.
 */
function runBotchanWrite(args: string[]): boolean {
    try {
        const env = {
            ...process.env,
            BOTCHAN_PRIVATE_KEY: config.NET_PRIVATE_KEY,
            BOTCHAN_CHAIN_ID: '8453',
        };

        execFileSync('npx', ['botchan', ...args], {
            env,
            timeout: 60_000,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        return true;
    } catch (error) {
        log.debug('Botchan write command failed', { args: args.slice(0, 3).join(' '), error: String(error) });
        return false;
    }
}

/**
 * Run a botchan read command and parse JSON output.
 */
function runBotchanCmd<T>(args: string[]): T | null {
    try {
        const env = {
            ...process.env,
            BOTCHAN_PRIVATE_KEY: config.NET_PRIVATE_KEY,
            BOTCHAN_CHAIN_ID: '8453',
        };

        const output = execFileSync('npx', ['botchan', ...args, '--json'], {
            env,
            timeout: 30_000,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        return JSON.parse(output.trim()) as T;
    } catch {
        return null;
    }
}

interface BotchanProfile {
    address: string;
    displayName?: string;
    profilePicture?: string;
    xUsername?: string;
    bio?: string;
    tokenAddress?: string;
    hasProfile: boolean;
}

/**
 * Run the full Botchan setup for QasidAI. Idempotent.
 * - Sets profile metadata (display name, bio, X username, picture)
 * - Registers on agent leaderboard
 * - Registers our named feed "qasid-updates"
 */
export async function runBotchanSetup(): Promise<void> {
    if (setupComplete || !isNetConfigured) return;

    log.info('🛠️ Running Botchan profile setup...');

    // 1. Check existing profile
    const existingProfile = runBotchanCmd<BotchanProfile>([
        'profile', 'get', '--address', getOurAddress() || '0x0',
    ]);

    // 2. Set profile metadata (only if not already set)
    if (!existingProfile?.displayName) {
        const ok = runBotchanWrite([
            'profile', 'set-display-name', '--name', 'QasidAI',
        ]);
        if (ok) log.info('✅ Display name set: QasidAI');
    }

    if (!existingProfile?.xUsername) {
        const ok = runBotchanWrite([
            'profile', 'set-x-username', '--username', 'QasidAI34321',
        ]);
        if (ok) log.info('✅ X username set: @QasidAI34321');
    }

    if (!existingProfile?.bio) {
        const ok = runBotchanWrite([
            'profile', 'set-bio', '--bio',
            'Autonomous AI CMO for Lisan Holdings. On-chain brain, verifiable marketing, zero fluff. Built different.',
        ]);
        if (ok) log.info('✅ Bio set');
    }

    // 3. Register on agent leaderboard
    const leaderboardOk = runBotchanWrite(['register-agent']);
    if (leaderboardOk) {
        log.info('✅ Registered on agent leaderboard');
    }

    // 4. Register our named feed
    const feedOk = runBotchanWrite(['register', 'qasid-updates']);
    if (feedOk) {
        log.info('✅ Registered feed: qasid-updates');
    }

    setupComplete = true;
    log.info('🛠️ Botchan setup complete');
}

/**
 * Get our wallet address from the private key.
 * Uses botchan config --show to derive it.
 */
function getOurAddress(): string | null {
    try {
        const env = {
            ...process.env,
            BOTCHAN_PRIVATE_KEY: config.NET_PRIVATE_KEY,
            BOTCHAN_CHAIN_ID: '8453',
        };

        const output = execFileSync('npx', ['botchan', 'config', '--show'], {
            env,
            timeout: 15_000,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        // Extract address from output
        const match = output.match(/0x[a-fA-F0-9]{40}/);
        return match?.[0] || null;
    } catch {
        return null;
    }
}
