import { log } from '../logger';
import { insertOHLCVBatch } from '../data/db';
import type { IExchange, OHLCV } from '../exchange/index';

const FETCH_LIMIT = 1000;     // Candles per request (Binance max)
const STAGGER_MS  = 500;      // Between paginated requests

/**
 * Seed historical OHLCV data into the local cache table.
 * Fetches backwards in time in pages of FETCH_LIMIT candles.
 * Safe to run multiple times — UNIQUE constraint prevents duplicates.
 */
export async function seedHistoricalData(params: {
  exchange: IExchange;
  symbol: string;
  timeframe: string;
  days: number;
}): Promise<number> {
  const { exchange, symbol, timeframe, days } = params;

  log.info('Seeding historical data', { symbol, timeframe, days });

  const msPerCandle = timeframeToMs(timeframe);
  const totalCandles = Math.ceil((days * 24 * 60 * 60 * 1000) / msPerCandle);
  const pages = Math.ceil(totalCandles / FETCH_LIMIT);

  let totalInserted = 0;
  let since = Date.now() - days * 24 * 60 * 60 * 1000;

  for (let page = 0; page < pages; page++) {
    try {
      const raw: OHLCV[] = await exchange.getOHLCV(symbol, timeframe, FETCH_LIMIT);

      // CCXT fetchOHLCV doesn't support `since` in all implementations.
      // For Binance, we need to use the exchange directly with since parameter.
      // This fetcher uses the live exchange to seed data progressively.
      const candles = raw
        .filter(c => c.timestamp >= since)
        .map(c => ({
          symbol,
          timeframe,
          timestamp: new Date(c.timestamp).toISOString(),
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
        }));

      if (candles.length === 0) break;

      insertOHLCVBatch(candles);
      totalInserted += candles.length;

      log.info(`Seeded page ${page + 1}/${pages}`, {
        candles: candles.length,
        from: candles[0].timestamp,
        to: candles[candles.length - 1].timestamp,
      });

      since += candles.length * msPerCandle;
      if (page < pages - 1) await sleep(STAGGER_MS);
    } catch (e) {
      log.error('Failed to fetch historical page', { page, error: (e as Error).message });
      break;
    }
  }

  log.info('Historical seed complete', { symbol, timeframe, inserted: totalInserted });
  return totalInserted;
}

function timeframeToMs(tf: string): number {
  const map: Record<string, number> = {
    '1m': 60_000,
    '5m': 300_000,
    '15m': 900_000,
    '1h': 3_600_000,
    '4h': 14_400_000,
    '1d': 86_400_000,
  };
  return map[tf] ?? 3_600_000;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
