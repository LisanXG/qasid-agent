import { config } from '../config.js';
import { createLogger } from '../logger.js';

// ============================================================================
// QasidAI — LISAN Intelligence Data Client
// Fetches live signal data, proof stats, and market regime
// ============================================================================

const log = createLogger('IntelData');
const baseUrl = config.LISAN_INTEL_URL;

// --- Signal types (match actual API response) ---

export interface SignalBreakdown {
    momentum: { score: number; max: number };
    trend: { score: number; max: number };
    volume: { score: number; max: number };
    sentiment: { score: number; max: number };
    volatility: { score: number; max: number };
    positioning: { score: number; max: number };
}

export interface Signal {
    coin: string;
    name: string;
    direction: 'LONG' | 'SHORT' | 'HOLD';
    score: number;
    agreement: number;
    timeframe: string;
    entryPrice: number;
    stopLoss: number;
    takeProfit: number;
    riskRewardRatio: number;
    breakdown: SignalBreakdown;
    timestamp: string;
    image?: string;
}

export interface EngineSignalsResponse {
    signals: Signal[];
    fearGreed: number;
    regime: string;
    regimeConfidence: number;
    lastUpdated: string;
}

// --- Proof stats types (match actual API response) ---

export interface BucketStat {
    range: string;
    minScore: number;
    maxScore: number;
    total: number;
    wins: number;
    losses: number;
    open: number;
    winRate: number;
}

export interface ProofSummary {
    totalSignals: number;
    completedSignals: number;
    openSignals: number;
    wins: number;
    losses: number;
    overallWinRate: number;
    avgWinPct: number;
    avgLossPct: number;
    totalPct: number;
    isEarlyData: boolean;
}

export interface RecentOutcome {
    coin: string;
    direction: string;
    score: number;
    entry_price: number;
    exit_price: number;
    profit_pct: number;
    outcome: 'WON' | 'LOST';
    exit_reason: string;
    created_at: string;
    closed_at: string;
}

export interface ProofStatsResponse {
    bucketStats: BucketStat[];
    summary: ProofSummary;
    recentOutcomes: RecentOutcome[];
    bestTrade?: { coin: string; direction: string; profitPct: number };
    worstTrade?: { coin: string; direction: string; profitPct: number };
    avgDurationHours?: number;
}

// --- Market data types (match actual API response) ---

export interface MarketCoin {
    symbol: string;
    name: string;
    current_price: number;
    price_change_percentage_24h: number;
    market_cap: number;
}

export interface MarketDataResponse {
    coins: MarketCoin[];
}

// --- Legacy types (kept for backward compatibility) ---

export interface ProofStats {
    totalSignals: number;
    wonSignals: number;
    lostSignals: number;
    winRate: number;
    cumulativeReturn: number;
    avgScore: number;
}

export interface MarketData {
    regime: string;
    fearGreedIndex: number;
    fearGreedLabel: string;
}

// --- Data fetching ---

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

/**
 * Fetch the full engine signals response (signals + regime + fear/greed).
 */
export async function getEngineData(): Promise<EngineSignalsResponse | null> {
    return safeFetch<EngineSignalsResponse | null>(`${baseUrl}/api/engine-signals`, null);
}

/**
 * Get active signals from the engine data.
 */
export async function getActiveSignals(): Promise<Signal[]> {
    const data = await getEngineData();
    return data?.signals ?? [];
}

/**
 * Fetch proof stats (full response with buckets, outcomes, learning events).
 */
export async function getProofData(): Promise<ProofStatsResponse | null> {
    return safeFetch<ProofStatsResponse | null>(`${baseUrl}/api/proof-stats`, null);
}

/**
 * Get proof stats in the legacy format (for backward compatibility).
 */
export async function getProofStats(): Promise<ProofStats | null> {
    const data = await getProofData();
    if (!data?.summary) return null;

    const s = data.summary;
    const avgScore = data.recentOutcomes?.length
        ? data.recentOutcomes.reduce((sum, o) => sum + o.score, 0) / data.recentOutcomes.length
        : 0;

    return {
        totalSignals: s.totalSignals,
        wonSignals: s.wins,
        lostSignals: s.losses,
        winRate: s.overallWinRate / 100, // API returns percentage, legacy expects decimal
        cumulativeReturn: s.totalPct / 100, // API returns percentage, legacy expects decimal
        avgScore,
    };
}

/**
 * Get market data (coin prices and 24h changes).
 */
export async function getMarketCoins(): Promise<MarketCoin[]> {
    const data = await safeFetch<MarketDataResponse | null>(`${baseUrl}/api/market`, null);
    return data?.coins ?? [];
}

/**
 * Get market regime + fear/greed from the engine signals response.
 */
export async function getMarketData(): Promise<MarketData | null> {
    const data = await getEngineData();
    if (!data) return null;

    const fgLabel = getFearGreedLabel(data.fearGreed);

    return {
        regime: data.regime,
        fearGreedIndex: data.fearGreed,
        fearGreedLabel: fgLabel,
    };
}

/**
 * Fetch fear & greed index from dedicated endpoint.
 */
export async function getFearGreed(): Promise<{ value: number; label: string } | null> {
    const data = await safeFetch<{ value: number; value_classification: string } | null>(
        `${baseUrl}/api/fear-greed`, null,
    );
    if (!data) return null;
    return { value: data.value, label: data.value_classification };
}

function getFearGreedLabel(value: number): string {
    if (value <= 10) return 'Extreme Fear';
    if (value <= 25) return 'Fear';
    if (value <= 45) return 'Neutral';
    if (value <= 75) return 'Greed';
    return 'Extreme Greed';
}

/**
 * Gathers all available intelligence data into a formatted context string
 * for injection into the LLM prompt. Now uses the REAL data structure.
 */
export async function gatherIntelContext(): Promise<string> {
    log.info('Gathering intel data from LISAN Intelligence...');

    const [engineData, proofData, fearGreed, marketCoins] = await Promise.all([
        getEngineData(),
        getProofData(),
        getFearGreed(),
        getMarketCoins(),
    ]);

    const parts: string[] = [];

    // Market regime from engine data
    if (engineData) {
        const fgLabel = fearGreed?.label ?? getFearGreedLabel(engineData.fearGreed);
        parts.push(`## Market Regime
- Current: ${engineData.regime} (confidence: ${(engineData.regimeConfidence * 100).toFixed(0)}%)
- Fear & Greed: ${engineData.fearGreed} (${fgLabel})
- Last updated: ${engineData.lastUpdated}`);
    }

    // Proof stats — performance-aware framing
    // A good CMO doesn't repeatedly broadcast losses. Focus on methodology and transparency.
    if (proofData?.summary) {
        const s = proofData.summary;
        const isPerformingWell = s.overallWinRate >= 40 && s.totalPct > -10;

        if (isPerformingWell) {
            // Good performance: show real numbers proudly
            parts.push(`## Performance Data (from /proof)
- Total signals: ${s.totalSignals} (${s.completedSignals} completed, ${s.openSignals} open)
- Win rate: ${s.overallWinRate}%
- Cumulative return: ${s.totalPct > 0 ? '+' : ''}${s.totalPct.toFixed(1)}%
- Avg win: +${s.avgWinPct.toFixed(1)}% | Avg loss: -${s.avgLossPct.toFixed(1)}%`);

            if (proofData.bestTrade) {
                parts.push(`- Best trade: ${proofData.bestTrade.coin} ${proofData.bestTrade.direction} → +${proofData.bestTrade.profitPct.toFixed(1)}%`);
            }
        } else {
            // Rough period: focus on methodology and transparency, NOT raw loss numbers.
            // A CMO never hammers negative stats. Reframe around the journey.
            parts.push(`## Performance Note
- ${s.totalSignals} signals shipped, all tracked transparently at lisanintel.com/proof
- Currently in a drawdown period — the engine adapts its weights based on outcomes
- Key differentiator: we show EVERY trade, win or lose. Most platforms hide this
- Focus: the scoring methodology and self-learning system, not short-term P&L`);
        }
    }

    // Active signals from engine
    // ⚠️ CRITICAL: These are CURRENT/OPEN positions — NOT completed trades.
    // The LLM must never treat active signals as "wins" or "completed trades".
    if (engineData?.signals?.length) {
        const activeSignals = engineData.signals.filter(s => s.direction !== 'HOLD');
        const holdSignals = engineData.signals.filter(s => s.direction === 'HOLD');

        if (activeSignals.length > 0) {
            parts.push(`## Active Signals — CURRENT POSITIONS (NOT completed trades)
⚠️ These are LIVE entry signals showing the engine's current stance. They have NOT been resolved yet — no win/loss outcome exists for these. Do NOT describe these as "wins" or "consecutive wins". They are open positions.
${activeSignals.slice(0, 8).map(s => {
                const breakdownStr = `M:${s.breakdown.momentum.score.toFixed(0)}/${s.breakdown.momentum.max} T:${s.breakdown.trend.score.toFixed(0)}/${s.breakdown.trend.max} V:${s.breakdown.volume.score.toFixed(0)}/${s.breakdown.volume.max}`;
                return `- ${s.coin} (${s.name}): ${s.direction} @ $${s.entryPrice} | Score: ${s.score}/100 | R:R ${s.riskRewardRatio} | ${breakdownStr}`;
            }).join('\n')}`);
        }
    }

    // Recent COMPLETED outcomes (wins and losses) — from /proof page
    // These ARE resolved trades with actual P&L. Only THESE can be called "wins" or "losses".
    if (proofData?.recentOutcomes?.length) {
        const recent = proofData.recentOutcomes.slice(0, 5);
        parts.push(`## Recent COMPLETED Trade Outcomes (from /proof — these ARE resolved)
These trades have ACTUALLY closed with a result. Only reference these when discussing wins, losses, or streaks.
${recent.map(o => `- ${o.coin} ${o.direction}: ${o.outcome} (${o.profit_pct > 0 ? '+' : ''}${o.profit_pct.toFixed(1)}%) via ${o.exit_reason}`).join('\n')}`);
    }

    // Top market movers
    if (marketCoins.length > 0) {
        const sorted = [...marketCoins].sort((a, b) => Math.abs(b.price_change_percentage_24h) - Math.abs(a.price_change_percentage_24h));
        const topMovers = sorted.slice(0, 5);
        parts.push(`## Market Movers (24h)
${topMovers.map(c => `- ${c.symbol.toUpperCase()} ($${c.current_price}): ${c.price_change_percentage_24h > 0 ? '+' : ''}${c.price_change_percentage_24h.toFixed(1)}%`).join('\n')}`);
    }

    if (parts.length === 0) {
        parts.push('No live data available from LISAN Intelligence right now.');
    }

    log.info('Intel context gathered', {
        signalCount: engineData?.signals?.length ?? 0,
        hasProof: !!proofData,
        hasMarket: !!engineData,
        hasCoinPrices: marketCoins.length > 0,
    });

    return parts.join('\n\n');
}
