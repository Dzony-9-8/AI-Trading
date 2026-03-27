import * as https from 'https';
import { log } from '../logger';

interface FGResult {
  value: number;            // 0–100
  classification: string;   // "Extreme Fear" | "Fear" | "Neutral" | "Greed" | "Extreme Greed"
  cachedAt: number;         // Date.now() of last fetch
}

let _cache: FGResult | null = null;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour — index updates once daily

/**
 * Fetch the Crypto Fear & Greed Index from alternative.me.
 * Caches for 1 hour. Returns null on network error (fail-open: don't block trades).
 */
export async function getFearGreedIndex(): Promise<FGResult | null> {
  if (_cache && Date.now() - _cache.cachedAt < CACHE_TTL_MS) {
    return _cache;
  }

  return new Promise((resolve) => {
    const req = https.get('https://api.alternative.me/fng/?limit=1', (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const item = parsed?.data?.[0];
          if (!item?.value) { resolve(null); return; }

          _cache = {
            value:          parseInt(item.value, 10),
            classification: item.value_classification ?? 'Unknown',
            cachedAt:       Date.now(),
          };

          log.info('Fear & Greed updated', {
            value: _cache.value,
            label: _cache.classification,
          });
          resolve(_cache);
        } catch {
          resolve(null);
        }
      });
    });

    req.on('error', (err) => {
      log.debug('Fear & Greed API error', { error: err.message });
      resolve(null);
    });

    req.setTimeout(8000, () => {
      req.destroy();
      resolve(null);
    });
  });
}

/**
 * Position-size multiplier based on Fear & Greed value.
 *
 * The index is a contrarian signal:
 *   Extreme Greed (>80) → market overextended → trade smaller (0.50×)
 *   Greed        (65–80) →                    → slightly smaller (0.75×)
 *   Neutral      (40–65) →                    → full size (1.00×)
 *   Fear         (25–40) → contrarian opportunity → slightly larger (1.20×)
 *   Extreme Fear  (<25)  → strong opportunity   → larger (1.40×)
 *
 * Max multiplier is capped — the Kelly Criterion and risk engine still apply on top.
 */
export function fearGreedMultiplier(value: number): number {
  if (value > 80) return 0.50;
  if (value > 65) return 0.75;
  if (value >= 40) return 1.00;
  if (value >= 25) return 1.20;
  return 1.40;
}

/** Last cached value — may be null if never fetched yet */
export function getCachedFearGreed(): FGResult | null {
  return _cache;
}
