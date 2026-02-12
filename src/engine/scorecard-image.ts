import sharp from 'sharp';
import { getEngineData, getProofData, type Signal, type EngineSignalsResponse } from '../data/intelligence.js';
import { createLogger } from '../logger.js';

// ============================================================================
// QasidAI — Signal Scorecard Image Generator
// Generates branded signal scorecard images using SVG → PNG via sharp
// ============================================================================

const log = createLogger('Scorecard');

// Lisan brand palette
const COLORS = {
    bg: '#0a0f1a',              // Deep dark navy
    cardBg: '#111827',          // Card background
    border: '#1e293b',          // Subtle border
    cyan: '#22d3ee',            // Primary accent (Lisan cyan)
    purple: '#a855f7',          // Secondary accent
    green: '#10b981',           // LONG / win
    red: '#ef4444',             // SHORT / loss
    yellow: '#f59e0b',          // HOLD / neutral
    textPrimary: '#f1f5f9',     // White text
    textSecondary: '#94a3b8',   // Muted text
    textDim: '#64748b',         // Dim text
};

/**
 * Generate a signal scorecard image buffer (PNG).
 * Shows top signals, regime, win rate, and branding.
 */
export async function generateScorecardImage(): Promise<{
    buffer: Buffer;
    caption: string;
} | null> {
    try {
        const [engine, proof] = await Promise.all([
            getEngineData(),
            getProofData(),
        ]);

        if (!engine?.signals?.length) {
            log.warn('No signal data available for scorecard');
            return null;
        }

        // Pick top 5 directional signals (highest score)
        const activeSignals = engine.signals
            .filter(s => s.direction !== 'HOLD')
            .sort((a, b) => b.score - a.score)
            .slice(0, 5);

        // Build the SVG
        const svg = buildScorecardSvg(engine, proof, activeSignals);

        // Convert SVG → PNG
        const buffer = await sharp(Buffer.from(svg))
            .png({ quality: 90 })
            .toBuffer();

        // Build a caption
        const topSignal = activeSignals[0];
        const winRate = proof?.summary?.overallWinRate ?? '?';
        const caption = topSignal
            ? `📊 Signal scorecard | Top: ${topSignal.coin} ${topSignal.direction} (${topSignal.score}/100) | Win rate: ${winRate}% | lisanintel.com/proof`
            : `📊 Market scorecard | Win rate: ${winRate}% | lisanintel.com/proof`;

        log.info('Scorecard image generated', { signals: activeSignals.length, size: buffer.length });
        return { buffer, caption };
    } catch (error) {
        log.error('Failed to generate scorecard image', { error: String(error) });
        return null;
    }
}

function escapeXml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildScorecardSvg(
    engine: EngineSignalsResponse,
    proof: any,
    signals: Signal[],
): string {
    const width = 1200;
    const height = 630; // Twitter card ratio
    const padding = 40;

    const regime = engine.regime ?? 'UNKNOWN';
    const regimeColor = regime === 'BULLISH' ? COLORS.green
        : regime === 'BEARISH' ? COLORS.red
            : COLORS.yellow;

    const winRate = proof?.summary?.overallWinRate ?? '—';
    const totalSignals = proof?.summary?.totalSignals ?? '—';
    const cumReturn = proof?.summary?.totalPct != null
        ? `${proof.summary.totalPct > 0 ? '+' : ''}${proof.summary.totalPct.toFixed(1)}%`
        : '—';
    const fearGreed = engine.fearGreed ?? 0;

    // Signal rows
    const signalRows = signals.map((s, i) => {
        const y = 280 + i * 60;
        const dirColor = s.direction === 'LONG' ? COLORS.green : COLORS.red;
        const scoreWidth = Math.max(4, (s.score / 100) * 180);

        return `
            <!-- Signal ${i + 1}: ${s.coin} -->
            <text x="${padding + 10}" y="${y}" fill="${COLORS.textPrimary}" font-size="20" font-weight="bold" font-family="monospace">${escapeXml(s.coin)}</text>
            <text x="${padding + 120}" y="${y}" fill="${dirColor}" font-size="18" font-weight="bold" font-family="monospace">${s.direction}</text>
            <text x="${padding + 210}" y="${y}" fill="${COLORS.textSecondary}" font-size="16" font-family="monospace">$${s.entryPrice < 1 ? s.entryPrice.toFixed(4) : s.entryPrice.toFixed(2)}</text>

            <!-- Score bar -->
            <rect x="${padding + 380}" y="${y - 14}" width="180" height="16" rx="4" fill="${COLORS.border}"/>
            <rect x="${padding + 380}" y="${y - 14}" width="${scoreWidth}" height="16" rx="4" fill="${dirColor}" opacity="0.8"/>
            <text x="${padding + 570}" y="${y}" fill="${COLORS.textSecondary}" font-size="16" font-weight="bold" font-family="monospace">${s.score}/100</text>

            <!-- R:R -->
            <text x="${padding + 660}" y="${y}" fill="${COLORS.textDim}" font-size="15" font-family="monospace">R:R ${s.riskRewardRatio.toFixed(1)}</text>

            <!-- Cluster breakdown -->
            <text x="${padding + 780}" y="${y}" fill="${COLORS.textDim}" font-size="13" font-family="monospace">M:${s.breakdown.momentum.score.toFixed(0)} T:${s.breakdown.trend.score.toFixed(0)} V:${s.breakdown.volume.score.toFixed(0)}</text>
        `;
    }).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs>
        <linearGradient id="bgGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="${COLORS.bg}"/>
            <stop offset="100%" stop-color="#0f172a"/>
        </linearGradient>
        <linearGradient id="accentLine" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stop-color="${COLORS.cyan}"/>
            <stop offset="100%" stop-color="${COLORS.purple}"/>
        </linearGradient>
    </defs>

    <!-- Background -->
    <rect width="${width}" height="${height}" fill="url(#bgGrad)" rx="20"/>

    <!-- Top accent line -->
    <rect x="0" y="0" width="${width}" height="4" fill="url(#accentLine)" rx="2"/>

    <!-- Header -->
    <text x="${padding}" y="55" fill="${COLORS.cyan}" font-size="28" font-weight="bold" font-family="monospace">LISAN INTELLIGENCE</text>
    <text x="${padding}" y="82" fill="${COLORS.textDim}" font-size="16" font-family="monospace">Signal Scorecard — ${new Date().toISOString().slice(0, 10)}</text>

    <!-- Regime badge -->
    <rect x="${width - padding - 220}" y="30" width="220" height="60" rx="12" fill="${regimeColor}" opacity="0.15"/>
    <rect x="${width - padding - 220}" y="30" width="220" height="60" rx="12" stroke="${regimeColor}" stroke-width="1.5" fill="none"/>
    <text x="${width - padding - 110}" y="55" fill="${regimeColor}" font-size="14" font-weight="bold" font-family="monospace" text-anchor="middle">MARKET REGIME</text>
    <text x="${width - padding - 110}" y="78" fill="${regimeColor}" font-size="22" font-weight="bold" font-family="monospace" text-anchor="middle">${regime}</text>

    <!-- Stats row -->
    <line x1="${padding}" y1="110" x2="${width - padding}" y2="110" stroke="${COLORS.border}" stroke-width="1"/>

    <!-- Win Rate -->
    <text x="${padding + 10}" y="145" fill="${COLORS.textDim}" font-size="13" font-family="monospace">WIN RATE</text>
    <text x="${padding + 10}" y="175" fill="${COLORS.green}" font-size="28" font-weight="bold" font-family="monospace">${winRate}%</text>

    <!-- Total Signals -->
    <text x="${padding + 200}" y="145" fill="${COLORS.textDim}" font-size="13" font-family="monospace">TOTAL SIGNALS</text>
    <text x="${padding + 200}" y="175" fill="${COLORS.textPrimary}" font-size="28" font-weight="bold" font-family="monospace">${totalSignals}</text>

    <!-- Cumulative Return -->
    <text x="${padding + 420}" y="145" fill="${COLORS.textDim}" font-size="13" font-family="monospace">CUMULATIVE</text>
    <text x="${padding + 420}" y="175" fill="${COLORS.cyan}" font-size="28" font-weight="bold" font-family="monospace">${cumReturn}</text>

    <!-- Fear & Greed -->
    <text x="${padding + 640}" y="145" fill="${COLORS.textDim}" font-size="13" font-family="monospace">FEAR &amp; GREED</text>
    <text x="${padding + 640}" y="175" fill="${fearGreed > 60 ? COLORS.green : fearGreed < 40 ? COLORS.red : COLORS.yellow}" font-size="28" font-weight="bold" font-family="monospace">${fearGreed}</text>

    <!-- Active Signals label -->
    <text x="${padding + 860}" y="145" fill="${COLORS.textDim}" font-size="13" font-family="monospace">ACTIVE SIGNALS</text>
    <text x="${padding + 860}" y="175" fill="${COLORS.purple}" font-size="28" font-weight="bold" font-family="monospace">${signals.length}</text>

    <line x1="${padding}" y1="200" x2="${width - padding}" y2="200" stroke="${COLORS.border}" stroke-width="1"/>

    <!-- Column headers -->
    <text x="${padding + 10}" y="240" fill="${COLORS.textDim}" font-size="13" font-family="monospace">ASSET</text>
    <text x="${padding + 120}" y="240" fill="${COLORS.textDim}" font-size="13" font-family="monospace">DIR</text>
    <text x="${padding + 210}" y="240" fill="${COLORS.textDim}" font-size="13" font-family="monospace">ENTRY</text>
    <text x="${padding + 380}" y="240" fill="${COLORS.textDim}" font-size="13" font-family="monospace">SCORE</text>
    <text x="${padding + 660}" y="240" fill="${COLORS.textDim}" font-size="13" font-family="monospace">R:R</text>
    <text x="${padding + 780}" y="240" fill="${COLORS.textDim}" font-size="13" font-family="monospace">CLUSTERS</text>

    <line x1="${padding}" y1="252" x2="${width - padding}" y2="252" stroke="${COLORS.border}" stroke-width="0.5"/>

    <!-- Signal rows -->
    ${signalRows}

    <!-- Footer -->
    <line x1="${padding}" y1="${height - 50}" x2="${width - padding}" y2="${height - 50}" stroke="${COLORS.border}" stroke-width="0.5"/>
    <text x="${padding + 10}" y="${height - 20}" fill="${COLORS.textDim}" font-size="14" font-family="monospace">lisanintel.com/proof</text>
    <text x="${width - padding - 10}" y="${height - 20}" fill="${COLORS.cyan}" font-size="14" font-weight="bold" font-family="monospace" text-anchor="end">QasidAI — The Messenger 🎯</text>

    <!-- Bottom accent line -->
    <rect x="0" y="${height - 4}" width="${width}" height="4" fill="url(#accentLine)" rx="2"/>
</svg>`;
}
