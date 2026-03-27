import { SMA } from 'technicalindicators';
import type { OHLCV } from '../exchange/index';

export interface MarketContext {
  /** Distribution days in last 25 candles */
  distributionDayCount: number;
  /** Follow-Through Day detected in last 5 candles */
  followThroughDay: boolean;
  /**
   * Heavy distribution: ≥ 4 distribution days in 25 candles.
   * When true, heartbeat skips new long entries.
   */
  isDistributed: boolean;
  /** Timestamp of most recent FTD (null if none) */
  lastFTD: number | null;
  /** Human-readable summary for logs */
  summary: string;
}

/**
 * Distribution Day
 * A high-volume down candle that signals institutional selling.
 *   — Close < Open (red candle)
 *   — Price change < -0.2%
 *   — Volume > 1.1× 20-period average
 */
function isDistributionDay(candle: OHLCV, volSma20: number): boolean {
  const change = (candle.close - candle.open) / candle.open;
  if (change >= -0.002) return false;           // Must be down > 0.2%
  if (candle.volume <= volSma20 * 1.10) return false;  // Must have elevated volume
  return true;
}

/**
 * Follow-Through Day (FTD)
 * A strong up day on volume that confirms a new uptrend attempt.
 *   — Price up > 1.7% from prior close
 *   — Volume > 1.1× 20-period average
 *   — Occurs on day 4+ of a rally attempt (low somewhere in prior 4–10 candles)
 */
function isFollowThroughDay(candles: OHLCV[], idx: number, volSma20: number): boolean {
  if (idx < 4) return false;

  const candle    = candles[idx];
  const prevClose = candles[idx - 1].close;

  const gain = (candle.close - prevClose) / prevClose;
  if (gain < 0.017) return false;                      // Need > 1.7% gain
  if (candle.volume <= volSma20 * 1.10) return false;  // Need elevated volume

  // Verify a recent low in the prior 4–10 candles (rally attempt started from a low)
  const lookbackStart = Math.max(0, idx - 10);
  const lookbackEnd   = Math.max(0, idx - 3);
  if (lookbackEnd <= lookbackStart) return false;

  const priorCandles = candles.slice(lookbackStart, lookbackEnd);
  const rallyLow = Math.min(...priorCandles.map(c => c.low));

  // The rally must have started from near the low (day 1 of rally attempt was close to low)
  const rallyStartClose = candles[Math.max(0, idx - 4)].close;
  return rallyStartClose <= rallyLow * 1.03; // Started within 3% of the low
}

/**
 * Analyze candle history for distribution days and follow-through days.
 *
 * Used by heartbeat.ts to gate new long entries:
 *   - 4+ distribution days in 25 candles → skip entries until reset by FTD
 *   - FTD clears the distribution day concern
 *
 * @param candles  Rolling candle buffer (oldest → newest), minimum 25 required
 */
export function analyzeMarketContext(candles: OHLCV[]): MarketContext {
  const empty: MarketContext = {
    distributionDayCount: 0,
    followThroughDay: false,
    isDistributed: false,
    lastFTD: null,
    summary: 'insufficient data',
  };

  if (candles.length < 25) return empty;

  const volumes    = candles.map(c => c.volume);
  const volSmaVals = SMA.calculate({ values: volumes, period: 20 });

  // SMA values are offset: first value corresponds to candle index (period - 1)
  const smaOffset = candles.length - volSmaVals.length;

  let distributionDayCount = 0;
  let followThroughDay     = false;
  let lastFTD: number | null = null;

  // Scan last 25 candles for distribution days
  const windowStart = Math.max(0, candles.length - 25);

  for (let i = windowStart; i < candles.length; i++) {
    const smaIdx = i - smaOffset;
    if (smaIdx < 0 || smaIdx >= volSmaVals.length) continue;
    const volSma = volSmaVals[smaIdx];

    if (isDistributionDay(candles[i], volSma)) {
      distributionDayCount++;
    }
  }

  // Scan last 5 candles for FTD
  const ftdWindowStart = Math.max(0, candles.length - 5);
  for (let i = ftdWindowStart; i < candles.length; i++) {
    const smaIdx = i - smaOffset;
    if (smaIdx < 0 || smaIdx >= volSmaVals.length) continue;
    const volSma = volSmaVals[smaIdx];

    if (isFollowThroughDay(candles, i, volSma)) {
      followThroughDay = true;
      lastFTD = candles[i].timestamp;
    }
  }

  // FTD resets the distribution day concern
  const isDistributed = !followThroughDay && distributionDayCount >= 4;

  const summary = [
    `dist=${distributionDayCount}/25`,
    followThroughDay ? 'FTD=yes' : 'FTD=no',
    isDistributed ? 'CAUTION:distribution' : '',
  ].filter(Boolean).join('  ');

  return {
    distributionDayCount,
    followThroughDay,
    isDistributed,
    lastFTD,
    summary,
  };
}
