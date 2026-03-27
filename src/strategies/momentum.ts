import { SMA } from 'technicalindicators';
import { getConfig } from '../config';
import type { IStrategy, StrategySignal } from './base';
import type { OHLCV } from '../exchange/index';
import type { IndicatorSet } from '../analysis/indicators';
import { isMacdBullishCrossover } from '../analysis/indicators';

/**
 * Momentum Strategy
 *
 * Entry conditions (ALL must be true):
 *   1. RSI < rsi_oversold (default: 30) — oversold
 *   2. MACD bullish crossover in current or previous candle
 *   3. Price above lower Bollinger Band (not in freefall)
 *
 * Exit conditions (ANY):
 *   1. RSI > rsi_overbought (default: 70) — overbought
 *   2. MACD bearish crossover
 *   3. Trailing stop hit (managed by positionMonitor)
 *
 * Stop-loss: placed at (1 - trailing_stop_pct) * entry_price
 * Take-profit: placed at (1 + 2 * trailing_stop_pct) * entry_price (2:1 R/R)
 */
export class MomentumStrategy implements IStrategy {
  name = 'momentum';

  evaluate(params: {
    symbol: string;
    candles: OHLCV[];
    indicators: IndicatorSet;
    currentPrice: number;
    availableBalance: number;
  }): StrategySignal {
    const config = getConfig();
    const { rsi_oversold, rsi_overbought, trailing_stop_pct } = config.strategies.momentum;
    const { rsi, macd, bb, close } = params.indicators;

    // Not enough data yet
    if (rsi === null || macd === null || bb === null) {
      return {
        action: 'hold',
        symbol: params.symbol,
        reasoning: 'Insufficient indicator data',
        confidence: 0,
      };
    }

    // ── Entry ──────────────────────────────────────────────────────────────
    const isOversold = rsi < rsi_oversold;
    const hasMacdCrossover = isMacdBullishCrossover(params.candles);
    const aboveLowerBand = close > bb.lower;

    // Volume confirmation: reversal candle must have above-average volume (weak reversals are traps)
    const volumes = params.candles.map(c => c.volume);
    const volSmaVals = SMA.calculate({ values: volumes, period: 20 });
    const volSma = volSmaVals.length > 0 ? volSmaVals[volSmaVals.length - 1] : 0;
    const currentVol = volumes[volumes.length - 1];
    const hasVolumeConfirmation = volSma > 0 && currentVol > volSma * 1.15;

    if (isOversold && hasMacdCrossover && aboveLowerBand && hasVolumeConfirmation) {
      const stopLoss = params.currentPrice * (1 - trailing_stop_pct);
      const takeProfit = params.currentPrice * (1 + trailing_stop_pct * 2);

      const confidence = computeConfidence(rsi, rsi_oversold, macd.histogram);

      return {
        action: 'enter_long',
        symbol: params.symbol,
        suggestedSize: 1.0, // Use full Kelly-calculated position size from risk engine
        suggestedStopLoss: stopLoss,
        suggestedTakeProfit: takeProfit,
        reasoning: [
          `RSI=${rsi.toFixed(1)} (oversold <${rsi_oversold})`,
          `MACD bullish crossover (histogram: ${macd.histogram.toFixed(4)})`,
          `Price $${params.currentPrice.toFixed(2)} above BB lower $${bb.lower.toFixed(2)}`,
          `Volume ${((currentVol / volSma - 1) * 100).toFixed(0)}% above avg`,
          `Stop: $${stopLoss.toFixed(2)} | TP: $${takeProfit.toFixed(2)}`,
        ].join(' | '),
        confidence,
      };
    }

    // ── Exit signal ────────────────────────────────────────────────────────
    const isOverbought = rsi > rsi_overbought;
    const macdBearish = macd.histogram < 0 && macd.macd < macd.signal;

    if (isOverbought || macdBearish) {
      return {
        action: 'exit',
        symbol: params.symbol,
        reasoning: [
          isOverbought ? `RSI=${rsi.toFixed(1)} overbought (>${rsi_overbought})` : '',
          macdBearish ? `MACD bearish (histogram: ${macd.histogram.toFixed(4)})` : '',
        ].filter(Boolean).join(' | '),
        confidence: isOverbought ? 0.8 : 0.6,
      };
    }

    return {
      action: 'hold',
      symbol: params.symbol,
      reasoning: `RSI=${rsi.toFixed(1)}, MACD=${macd.macd.toFixed(4)}, no signal`,
      confidence: 0,
    };
  }
}

function computeConfidence(rsi: number, oversoldThreshold: number, macdHistogram: number): number {
  // More oversold = more confident
  const rsiScore = Math.min(1, (oversoldThreshold - rsi) / oversoldThreshold);
  // Stronger MACD histogram = more confident
  const macdScore = Math.min(1, Math.abs(macdHistogram) / 100);
  return Math.round((rsiScore * 0.6 + macdScore * 0.4) * 100) / 100;
}
