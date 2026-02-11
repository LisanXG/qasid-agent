import { createLogger } from '../logger.js';

// ============================================================================
// QasidAI — Market Data
// Fetches external market data for trending topics and context
// ============================================================================

const log = createLogger('MarketData');

export interface TrendingCoin {
    symbol: string;
    name: string;
    priceChange24h: number;
}

/**
 * Fetch top movers from CoinGecko (free, no API key required).
 * Returns symbols with significant 24h price changes.
 */
export async function getTrendingCoins(): Promise<TrendingCoin[]> {
    try {
        const response = await fetch(
            'https://api.coingecko.com/api/v3/search/trending',
            { signal: AbortSignal.timeout(10000) },
        );

        if (!response.ok) {
            log.warn('CoinGecko API failed', { status: response.status });
            return [];
        }

        const data = await response.json() as {
            coins: Array<{
                item: { symbol: string; name: string; data?: { price_change_percentage_24h?: { usd?: number } } };
            }>;
        };

        return data.coins.slice(0, 5).map(c => ({
            symbol: c.item.symbol.toUpperCase(),
            name: c.item.name,
            priceChange24h: c.item.data?.price_change_percentage_24h?.usd ?? 0,
        }));
    } catch (error) {
        log.warn('Failed to fetch trending coins', { error: String(error) });
        return [];
    }
}

/**
 * Build a market context string for LLM injection.
 */
export async function gatherMarketContext(): Promise<string> {
    const trending = await getTrendingCoins();

    if (trending.length === 0) {
        return 'No external market data available.';
    }

    return `## Trending Coins (CoinGecko)
${trending.map(c => `- ${c.symbol} (${c.name}): ${c.priceChange24h > 0 ? '+' : ''}${c.priceChange24h.toFixed(1)}% 24h`).join('\n')}`;
}
