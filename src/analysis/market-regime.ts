import type { IndicatorSet } from './indicators';
import type { MarketRegime } from '../core/state';

/**
 * Detect the current market regime from indicator values.
 *
 * Rules:
 *   volatile  — 1h ATR > 3% of close price
 *   trending  — ADX > 25 AND close > SMA20 (uptrend) or close < SMA20 (downtrend)
 *   ranging   — ADX < 25 AND ATR < 2% of close price
 *   unknown   — insufficient data
 */
export function detectRegime(indicators: IndicatorSet): MarketRegime {
  const { rsi, adx, atr, sma20, close } = indicators;

  if (close === 0 || adx === null || atr === null) return 'unknown';

  const atrPct = atr / close;

  // Volatile: extreme price swings
  if (atrPct > 0.03) return 'volatile';

  // Trending: strong directional move
  if (adx > 25) return 'trending';

  // Ranging: low ADX, low volatility
  if (adx < 25 && atrPct < 0.02) return 'ranging';

  // Default to volatile if ambiguous
  return 'volatile';
}

/**
 * Map regime to best strategy from the enabled list.
 */
export function regimeToStrategy(
  regime: MarketRegime,
  enabledStrategies: string[]
): string {
  const preference: Record<MarketRegime, string[]> = {
    trending:  ['vcp', 'momentum', 'dca', 'grid'],
    ranging:   ['grid', 'dca', 'momentum', 'vcp'],
    volatile:  ['dca', 'momentum', 'grid', 'vcp'],
    unknown:   ['dca', 'momentum', 'grid', 'vcp'],
  };

  const ordered = preference[regime];
  for (const strategy of ordered) {
    if (enabledStrategies.includes(strategy)) return strategy;
  }

  return enabledStrategies[0];
}
