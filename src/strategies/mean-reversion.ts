import type { IStrategy, StrategySignal } from './base';
import type { OHLCV } from '../exchange/index';
import type { IndicatorSet } from '../analysis/indicators';

export class MeanReversionStrategy implements IStrategy {
  name = 'mean-reversion';

  evaluate(params: {
    symbol: string;
    candles: OHLCV[];
    indicators: IndicatorSet;
    currentPrice: number;
    availableBalance: number;
  }): StrategySignal {
    const { symbol, candles, indicators, currentPrice } = params;

    if (!indicators || candles.length < 30) {
      return { symbol, action: 'hold', confidence: 0, reasoning: 'Insufficient data' };
    }

    const { rsi, bb, atr, sma200 } = indicators;

    if (!bb || atr === undefined || atr === null) {
      return { symbol, action: 'hold', confidence: 0, reasoning: 'Missing indicators' };
    }

    const lastCandle  = candles[candles.length - 1];
    const close       = lastCandle.close;
    const volume      = lastCandle.volume;

    // Compute 20-bar average volume
    const avgVol20 = candles.slice(-21, -1).reduce((s, c) => s + c.volume, 0) / 20;

    // ── Exit conditions ─────────────────────────────────────────────────────
    // Price returned to BB middle or RSI overbought
    if (rsi !== null && rsi > 60) {
      return {
        symbol,
        action: 'exit',
        confidence: 0.7,
        reasoning: `Mean reversion complete — RSI recovered to ${rsi.toFixed(1)}`,
      };
    }
    if (close >= bb.middle) {
      return {
        symbol,
        action: 'exit',
        confidence: 0.8,
        reasoning: `Price ${close.toFixed(4)} returned to BB middle ${bb.middle.toFixed(4)}`,
      };
    }

    // ── Entry conditions ────────────────────────────────────────────────────
    // 1. Price below BB lower band by at least 0.5%
    const belowBand = (bb.lower - close) / bb.lower;
    if (belowBand < 0.005) {
      return {
        symbol,
        action: 'hold',
        confidence: 0,
        reasoning: `Price not stretched enough below BB lower (${(belowBand * 100).toFixed(2)}% < 0.5%)`,
      };
    }

    // 2. Volume exhaustion spike (>2× 20-bar average)
    if (avgVol20 <= 0 || volume < avgVol20 * 2) {
      return {
        symbol,
        action: 'hold',
        confidence: 0,
        reasoning: `No volume exhaustion spike (${(volume / avgVol20).toFixed(1)}× avg, need 2×)`,
      };
    }

    // 3. RSI in weak zone (25–45)
    if (rsi === null || rsi < 25 || rsi > 45) {
      return {
        symbol,
        action: 'hold',
        confidence: 0,
        reasoning: `RSI ${rsi?.toFixed(1)} outside mean-reversion zone (25–45)`,
      };
    }

    // 4. Price above SMA200 (overall uptrend)
    if (sma200 && close < sma200 * 0.98) {
      return {
        symbol,
        action: 'hold',
        confidence: 0,
        reasoning: `Price below SMA200 — not in uptrend (${close.toFixed(4)} < ${sma200.toFixed(4)})`,
      };
    }

    // All conditions met — enter
    const stretchScore  = Math.min(belowBand / 0.03, 1);   // Max at 3% below band
    const volScore      = Math.min((volume / avgVol20 - 2) / 3, 1); // Max at 5× volume
    const rsiScore      = 1 - (rsi - 25) / 20;            // Higher score deeper in zone
    const confidence    = Math.min(0.3 + (stretchScore + volScore + rsiScore) / 3 * 0.55, 0.85);

    const stopLoss   = close - 2 * atr;
    const takeProfit = bb.middle;                           // TP = return to mean

    return {
      symbol,
      action: 'enter_long',
      confidence,
      suggestedStopLoss:   stopLoss,
      suggestedTakeProfit: takeProfit,
      reasoning: [
        `Mean reversion setup:`,
        `Price ${(belowBand * 100).toFixed(2)}% below BB lower`,
        `Volume spike ${(volume / avgVol20).toFixed(1)}× avg`,
        `RSI=${rsi.toFixed(1)} (weak zone)`,
        `TP=BB middle ${bb.middle.toFixed(4)}`,
        `SL=entry−2ATR`,
      ].join(' | '),
    };
  }
}
