import 'dotenv/config';
import { config } from './config.js';
import { setLogLevel, createLogger } from './logger.js';
import { isXConfigured, isNetConfigured } from './config.js';
import { startScheduler, stopScheduler, runOnce, runOnceWithBotchan } from './scheduler/cron.js';
import { generatePost } from './engine/content.js';
import { uploadFullBrain, BRAIN_KEYS } from './net/brain.js';
import { uploadProfile, readProfile } from './net/profile.js';
import { getWalletAddress, readStorage, getTotalVersions, postToFeed } from './net/client.js';
import { buildSystemPrompt } from './personality/system-prompt.js';
import { brandKnowledge } from './personality/brand-knowledge.js';
import { buildAndWriteDailySummary } from './net/daily-summary.js';

// ============================================================================
// QasidAI — Entry Point
// "The Messenger" — Autonomous marketing agent for Lisan Holdings
// ============================================================================

const log = createLogger('QasidAI');

async function main() {
    console.log(`
  ╔═══════════════════════════════════════╗
  ║   QasidAI — The Messenger            ║
  ║   Autonomous CMO for Lisan Holdings   ║
  ╚═══════════════════════════════════════╝
  `);

    // Set log level from config
    setLogLevel(config.LOG_LEVEL);

    log.info('Starting QasidAI...');

    // Fix 9: Startup capability health check
    const xStatus = isXConfigured ? '[OK] Configured' : '[MISSING] Missing keys';
    const replicateStatus = config.REPLICATE_API_TOKEN ? '[OK] Configured' : '[MISSING] REPLICATE_API_TOKEN not set';
    const netStatus = isNetConfigured ? `[OK] Active (${getWalletAddress()})` : '[MISSING] Not configured';
    const postingStatus = config.POSTING_ENABLED ? '[LIVE]' : '[DRY RUN]';
    const anthropicStatus = config.ANTHROPIC_API_KEY ? '[OK] Ready' : '[MISSING] Missing';

    log.info('=== QasidAI Capability Check ===');
    log.info(`  X Posting:      ${xStatus}`);
    log.info(`  Image Gen:      ${replicateStatus}`);
    log.info(`  Net Protocol:   ${netStatus}`);
    log.info(`  Anthropic LLM:  ${anthropicStatus}`);
    log.info(`  Posting Mode:   ${postingStatus}`);
    log.info('================================');

    // Check for CLI arguments
    const args = process.argv.slice(2);

    if (args[0] === 'test') {
        // Test mode: generate one post and print it (no posting)
        log.info('Test mode: generating a sample X post...');

        const post = await generatePost();
        console.log('\n' + '═'.repeat(60));
        console.log(`Type: ${post.contentType}`);
        console.log(`Tone: ${post.tone} | Topic: ${post.topic}`);
        console.log('═'.repeat(60));
        console.log(post.content);
        console.log('═'.repeat(60));
        console.log(`Tokens: ${post.inputTokens} in / ${post.outputTokens} out`);
        console.log(`Estimated cost: $${((post.inputTokens / 1000000) * 1 + (post.outputTokens / 1000000) * 5).toFixed(4)}`);
        console.log();

        process.exit(0);
    }

    if (args[0] === 'once') {
        // Run a single posting cycle for X, then exit
        await runOnce();
        process.exit(0);
    }

    if (args[0] === 'once-botchan') {
        // Run a single native Botchan content cycle
        await runOnceWithBotchan();
        process.exit(0);
    }

    if (args[0] === 'botchan-post') {
        // Post a test message to a Botchan feed
        if (!isNetConfigured) {
            console.error('❌ Net Protocol not configured.');
            process.exit(1);
        }
        const topic = args[1] || 'lisan-holdings';
        const message = args.slice(2).join(' ') || 'QasidAI checking in ⛓️ — the autonomous marketer for Lisan Holdings is onchain. lisanintel.com';
        log.info(`Posting to Botchan feed: topic="${topic}"`);
        try {
            const txHash = await postToFeed(message, topic);
            console.log(`\n✅ Botchan post sent!`);
            console.log(`   Topic: ${topic}`);
            console.log(`   Tx: ${txHash}`);
            console.log(`   View: https://basescan.org/tx/${txHash}`);
        } catch (error) {
            console.error(`\n❌ Botchan post failed:`, String(error));
        }
        process.exit(0);
    }

    if (args[0] === 'x-check') {
        // Diagnose X API capabilities
        if (!isXConfigured) {
            console.error('❌ X (Twitter) API not configured. Set X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET in .env');
            process.exit(1);
        }

        console.log('\n🔍 X API Capability Diagnostic');
        console.log('─'.repeat(60));

        const { checkXCapabilities } = await import('./platforms/x.js');
        const results = await checkXCapabilities();

        for (const r of results) {
            const icon = r.status === 'pass' ? '✅' : r.status === 'fail' ? '❌' : '⏸️';
            console.log(`  ${icon} ${r.name}`);
            console.log(`     ${r.detail}`);
        }

        console.log('─'.repeat(60));

        const passCount = results.filter(r => r.status === 'pass').length;
        const failCount = results.filter(r => r.status === 'fail').length;

        if (failCount === 0) {
            console.log('🎉 Full access! All capabilities available.');
        } else if (passCount >= 3) {
            console.log(`⚠️  Partial access: ${passCount} passed, ${failCount} failed.`);
            console.log('   Some features (like mentions/search) may require upgrading to Basic tier ($100/mo).');
        } else {
            console.log(`🔴 Limited access: ${passCount} passed, ${failCount} failed.`);
            console.log('   Consider upgrading your X API tier for full QasidAI v2 capabilities.');
        }
        console.log();
        process.exit(0);
    }

    if (args[0] === 'knowledge-sync') {
        // Manually trigger all knowledge monitors
        const { runFounderMonitor } = await import('./engine/founder-monitor.js');
        const { runWebsiteMonitor } = await import('./engine/website-monitor.js');
        const { runGitHubMonitor } = await import('./engine/github-monitor.js');

        console.log('\n🔄 Running all knowledge monitors...\n');

        console.log('👁️  Founder tweet monitor...');
        const founderFacts = await runFounderMonitor();
        console.log(`   → ${founderFacts} fact(s) stored\n`);

        console.log('🌐 Website monitor...');
        const webFacts = await runWebsiteMonitor();
        console.log(`   → ${webFacts} fact(s) stored\n`);

        console.log('🐙 GitHub monitor...');
        const ghFacts = await runGitHubMonitor();
        console.log(`   → ${ghFacts} fact(s) stored\n`);

        const total = founderFacts + webFacts + ghFacts;
        console.log(`✅ Knowledge sync complete: ${total} total fact(s) stored`);
        process.exit(0);
    }

    if (args[0] === 'net-upload') {
        // Upload QasidAI's full brain to Net Protocol
        if (!isNetConfigured) {
            console.error('❌ Net Protocol not configured. Set NET_PRIVATE_KEY and NET_ENABLED=true in .env');
            process.exit(1);
        }
        log.info('Uploading QasidAI brain to Net Protocol...');
        const personality = buildSystemPrompt();
        const brand = JSON.stringify(brandKnowledge, null, 2);
        try {
            await uploadFullBrain(personality, brand);
            console.log('\n✅ Brain uploaded to Net Protocol on Base L2');
            console.log(`   Wallet: ${getWalletAddress()}`);
            process.exit(0);
        } catch (error: any) {
            console.error('\n❌ Failed to upload brain to Net Protocol:', String(error));
            process.exit(1);
        }
    }

    if (args[0] === 'net-profile') {
        // Upload QasidAI's public profile to Net Protocol
        if (!isNetConfigured) {
            console.error('❌ Net Protocol not configured. Set NET_PRIVATE_KEY and NET_ENABLED=true in .env');
            process.exit(1);
        }
        log.info('Uploading QasidAI profile to Net Protocol...');
        await uploadProfile();
        console.log('\n✅ Agent profile uploaded to Net Protocol');
        console.log(`   Wallet: ${getWalletAddress()}`);
        process.exit(0);
    }

    if (args[0] === 'net-summary') {
        // Manually trigger a daily summary write
        if (!isNetConfigured) {
            console.error('❌ Net Protocol not configured. Set NET_PRIVATE_KEY and NET_ENABLED=true in .env');
            process.exit(1);
        }
        log.info('Writing daily summary to Net Protocol...');
        await buildAndWriteDailySummary();
        console.log('\n✅ Daily summary written to Net Protocol');
        process.exit(0);
    }

    if (args[0] === 'net-status') {
        // Show Net Protocol brain status
        if (!isNetConfigured) {
            console.log('Net Protocol: ❌ Not configured');
            process.exit(0);
        }
        console.log('\n⛓️  Net Protocol Brain Status');
        console.log(`   Wallet:  ${getWalletAddress()}`);
        console.log(`   Chain:   Base (8453)`);
        console.log(`   Enabled: ${isNetConfigured ? '✅' : '❌'}`);
        process.exit(0);
    }

    if (args[0] === 'net-read') {
        // Read back all on-chain brain data and display it
        if (!isNetConfigured) {
            console.error('❌ Net Protocol not configured.');
            process.exit(1);
        }
        console.log('\n⛓️  Reading QasidAI brain from Net Protocol...');
        console.log(`   Wallet: ${getWalletAddress()}`);
        console.log('─'.repeat(60));

        const keys = [
            { key: BRAIN_KEYS.PERSONALITY, label: '🧠 Personality' },
            { key: BRAIN_KEYS.BRAND_KNOWLEDGE, label: '📚 Brand Knowledge' },
            { key: BRAIN_KEYS.STRATEGY, label: '🎯 Strategy' },
            { key: BRAIN_KEYS.META_REVIEW, label: '📊 Meta Review' },
            { key: BRAIN_KEYS.PROFILE, label: '👤 Profile' },
        ];

        for (const { key, label } of keys) {
            try {
                const versions = await getTotalVersions(key);
                const data = await readStorage(key);
                if (data) {
                    const preview = data.data.length > 200 ? data.data.slice(0, 200) + '...' : data.data;
                    console.log(`\n${label} (${versions} version${versions !== 1 ? 's' : ''})`);
                    console.log(`   Description: ${data.text}`);
                    console.log(`   Data: ${preview}`);
                } else {
                    console.log(`\n${label} — not uploaded yet`);
                }
            } catch (error) {
                console.log(`\n${label} — read failed: ${error}`);
            }
        }

        // Check today's daily summary
        const today = new Date().toISOString().split('T')[0];
        try {
            const daily = await readStorage(`${BRAIN_KEYS.DAILY_SUMMARY}-${today}`);
            if (daily) {
                console.log(`\n📝 Today's Daily Summary (${today})`);
                console.log(`   ${daily.data.slice(0, 200)}...`);
            } else {
                console.log(`\n📝 Today's Daily Summary — not written yet`);
            }
        } catch {
            console.log(`\n📝 Today's Daily Summary — not written yet`);
        }

        console.log('\n' + '─'.repeat(60));
        console.log('💡 To view on netprotocol.app:');
        console.log('   1. Go to https://netprotocol.app');
        console.log('   2. Connect your wallet or browse the feed');
        console.log(`   3. Look for messages from ${getWalletAddress()}`);
        console.log('   4. Net Storage entries appear under the "Storage" tab');
        console.log();
        process.exit(0);
    }

    // Default: start the scheduler
    startScheduler();

    // Graceful shutdown
    const shutdown = async () => {
        log.info('Shutting down QasidAI...');
        stopScheduler();
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    log.info('QasidAI is running. Press Ctrl+C to stop.');
}

// === Global Error Handlers ===
// Prevents silent crashes from unhandled promise rejections in cron jobs
process.on('unhandledRejection', (reason, promise) => {
    const log = createLogger('Process');
    log.error('Unhandled promise rejection — cron job or async task may have failed', {
        reason: String(reason),
    });
    // Don't exit — let other cron jobs continue running
});

process.on('uncaughtException', (error) => {
    const log = createLogger('Process');
    log.error('FATAL: Uncaught exception — process will exit', {
        error: error.message,
        stack: error.stack?.slice(0, 500),
    });
    process.exit(1);
});

main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
