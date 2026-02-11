import { config } from '../config.js';
import { createLogger } from '../logger.js';

// ============================================================================
// QasidAI — LISAN Intelligence Data Client
// Fetches live signal data, proof stats, and market regime
// ============================================================================

const log = createLogger('IntelData');
const baseUrl = config.LISAN_INTEL_URL;

export interface Signal {
    asset: string;
    direction: 'LONG' | 'SHORT';
    score: number;
    entryPrice: number;
    stopLoss: number;
    takeProfit: number;
    status: 'OPEN' | 'WON' | 'LOST' | 'EXPIRED';
    createdAt: string;
}

export interface ProofStats {
    totalSignals: number;
    wonSignals: number;
    lostSignals: number;
    winRate: number;
    cumulativeReturn: number;
    avgScore: number;
}

export interface MarketData {
    regime: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'VOLATILE';
    fearGreedIndex: number;
    fearGreedLabel: string;
}

async function safeFetch<T>(url: string, fallback: T): Promise<T> {
    try {
        const response = await fetch(url, {
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) {
            log.warn(`Failed to fetch ${url}: ${response.status}`);
            return fallback;
        }
        return await response.json() as T;
    } catch (error) {
        log.warn(`Error fetching ${url}`, { error: String(error) });
        return fallback;
    }
}

export async function getActiveSignals(): Promise<Signal[]> {
    return safeFetch<Signal[]>(`${baseUrl}/api/engine-signals`, []);
}

export async function getProofStats(): Promise<ProofStats | null> {
    return safeFetch<ProofStats | null>(`${baseUrl}/api/proof-stats`, null);
}

export async function getMarketData(): Promise<MarketData | null> {
    return safeFetch<MarketData | null>(`${baseUrl}/api/market`, null);
}

export async function getFearGreed(): Promise<{ value: number; label: string } | null> {
    return safeFetch<{ value: number; label: string } | null>(`${baseUrl}/api/fear-greed`, null);
}

/**
 * Gathers all available intelligence data into a formatted context string
 * for injection into the LLM prompt.
 */
export async function gatherIntelContext(): Promise<string> {
    log.info('Gathering intel data from LISAN Intelligence...');

    const [signals, proof, market, fearGreed] = await Promise.all([
        getActiveSignals(),
        getProofStats(),
        getMarketData(),
        getFearGreed(),
    ]);

    const parts: string[] = [];

    if (proof) {
        const winRate = proof.winRate != null ? `${(proof.winRate * 100).toFixed(1)}%` : 'N/A';
        const cumReturn = proof.cumulativeReturn != null ? `${proof.cumulativeReturn > 0 ? '+' : ''}${(proof.cumulativeReturn * 100).toFixed(1)}%` : 'N/A';
        const avgScore = proof.avgScore != null ? `${proof.avgScore.toFixed(0)}/100` : 'N/A';
        parts.push(`## Performance Data (from /proof)
- Total signals: ${proof.totalSignals ?? 'N/A'}
- Win rate: ${winRate}
- Cumulative return: ${cumReturn}
- Wins: ${proof.wonSignals ?? '?'} | Losses: ${proof.lostSignals ?? '?'}
- Average score: ${avgScore}`);
    }

    if (market) {
        parts.push(`## Market Regime
- Current: ${market.regime}
- Fear & Greed: ${market.fearGreedIndex} (${market.fearGreedLabel})`);
    } else if (fearGreed) {
        parts.push(`## Market Sentiment
- Fear & Greed: ${fearGreed.value} (${fearGreed.label})`);
    }

    if (signals.length > 0) {
        const openSignals = signals.filter(s => s.status === 'OPEN');
        const recentWins = signals.filter(s => s.status === 'WON').slice(0, 5);

        if (openSignals.length > 0) {
            parts.push(`## Active Signals (${openSignals.length} open)
${openSignals.map(s => `- ${s.asset}: ${s.direction} @ ${s.entryPrice} (score: ${s.score})`).join('\n')}`);
        }

        if (recentWins.length > 0) {
            parts.push(`## Recent Wins
${recentWins.map(s => `- ${s.asset}: ${s.direction} — HIT TP ✅`).join('\n')}`);
        }
    }

    if (parts.length === 0) {
        parts.push('No live data available from LISAN Intelligence right now.');
    }

    log.info('Intel context gathered', {
        signalCount: signals.length,
        hasProof: !!proof,
        hasMarket: !!market,
    });

    return parts.join('\n\n');
}
