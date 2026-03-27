import { ATR, SMA } from 'technicalindicators';
import type { IStrategy, StrategySignal } from './base';
import type { OHLCV } from '../exchange/index';
import type { IndicatorSet } from '../analysis/indicators';

/**
 * VCP (Volatility Contraction Pattern) Strategy
 * Adapted from Mark Minervini's method for crypto intraday (1h candles).
 *
 * A VCP forms when price consolidates near a high with progressively shrinking
 * volatility (ATR contracting) and drying volume — a spring being coiled.
 * The breakout above the pattern's resistance is the entry trigger.
 *
 * Entry conditions (ALL must be true):
 *   1. Price above SMA20 AND SMA50 — uptrend filter
 *   2. SMA20 > SMA50 — short-term trend aligned with medium-term
 *   3. ATR contracted ≥ 25% vs ATR 20 candles ago — coiling volatility
 *   4. Price within 15% of 30-candle high — coiling near resistance
 *   5. Current volume < 80% of 20-bar average — dry-up during contraction
 *   6. RSI 40–65 — not overbought, not oversold
 *
 * Entry trigger:
 *   Current close breaks above the highest close of prior 10 candles
 *
 * Stop-loss:  entry − 2×ATR
 * Take-profit: entry + 3×ATR  (1.5R minimum)
 */
export class VCPStrategy implements IStrategy {
  name = 'vcp';

  evaluate(params: {
    symbol: string;
    candles: OHLCV[];
    indicators: IndicatorSet;
    currentPrice: number;
    availableBalance: number;
  }): StrategySignal {
    const { candles, indicators, currentPrice, symbol } = params;
    const { rsi, atr, sma20 } = indicators;

    // Need at least 60 candles for SMA50 + ATR comparison window
    if (candles.length < 60 || rsi === null || atr === null || sma20 === null) {
      return { action: 'hold', symbol, reasoning: 'VCP: insufficient data', confidence: 0 };
    }

    const closes  = candles.map(c => c.close);
    const highs   = candles.map(c => c.high);
    const volumes = candles.map(c => c.volume);

    // ── 1. Uptrend filter: price above SMA50 ─────────────────────────────────
    const sma50Vals = SMA.calculate({ values: closes, period: 50 });
    const sma50 = sma50Vals.length > 0 ? sma50Vals[sma50Vals.length - 1] : null;

    if (!sma50 || currentPrice < sma50) {
      return {
        action: 'hold', symbol,
        reasoning: `VCP: price below SMA50 $${sma50?.toFixed(2) ?? '?'} — no uptrend`,
        confidence: 0,
      };
    }

    // ── 2. Trend alignment: SMA20 above SMA50 ────────────────────────────────
    if (sma20 < sma50) {
      return {
        action: 'hold', symbol,
        reasoning: `VCP: SMA20 $${sma20.toFixed(2)} < SMA50 $${sma50.toFixed(2)} — trend not aligned`,
        confidence: 0,
      };
    }

    // ── 3. Volatility contraction ─────────────────────────────────────────────
    // Compare current ATR with ATR from 20 candles ago (need slice to avoid look-ahead)
    const prevSlice = candles.slice(0, candles.length - 20);
    if (prevSlice.length < 15) {
      return { action: 'hold', symbol, reasoning: 'VCP: not enough history for ATR comparison', confidence: 0 };
    }
    const prevAtrVals = ATR.calculate({
      high:  prevSlice.map(c => c.high),
      low:   prevSlice.map(c => c.low),
      close: prevSlice.map(c => c.close),
      period: 14,
    });
    const prevAtr = prevAtrVals.length > 0 ? prevAtrVals[prevAtrVals.length - 1] : null;

    if (!prevAtr || atr >= prevAtr * 0.75) {
      // ATR hasn't contracted by at least 25% — no VCP forming
      return {
        action: 'hold', symbol,
        reasoning: `VCP: volatility not coiling (ATR ${atr.toFixed(2)} vs ${prevAtr?.toFixed(2) ?? '?'} prior)`,
        confidence: 0,
      };
    }
    const contractionPct = ((prevAtr - atr) / prevAtr) * 100;

    // ── 4. Coiling near resistance: within 15% of 30-candle high ─────────────
    const recent30High = Math.max(...highs.slice(-30));
    const distFromHighPct = ((recent30High - currentPrice) / recent30High) * 100;

    if (distFromHighPct > 15) {
      return {
        action: 'hold', symbol,
        reasoning: `VCP: ${distFromHighPct.toFixed(1)}% below 30-bar high — too far from resistance`,
        confidence: 0,
      };
    }

    // ── 5. Volume dry-up ──────────────────────────────────────────────────────
    const currentVol = volumes[volumes.length - 1];
    const volSmaVals = SMA.calculate({ values: volumes, period: 20 });
    const volSma = volSmaVals.length > 0 ? volSmaVals[volSmaVals.length - 1] : null;
    const volumeDryUp = volSma ? currentVol < volSma * 0.80 : false;

    // ── 6. RSI neutral (not extended, not oversold) ───────────────────────────
    const rsiNeutral = rsi >= 40 && rsi <= 65;

    // ── Entry trigger: breakout above prior 10-candle high ───────────────────
    // Use prior 10 closes (exclude current bar) to define resistance
    const resistanceLevel = Math.max(...closes.slice(-11, -1));
    const isBreakout = currentPrice > resistanceLevel;

    if (isBreakout && volumeDryUp && rsiNeutral) {
      const stopLoss   = currentPrice - 2 * atr;
      const takeProfit = currentPrice + 3 * atr;
      const confidence = Math.min(0.85, 0.50 + (contractionPct / 100) * 0.50);
      const volDropPct = volSma ? ((1 - currentVol / volSma) * 100).toFixed(0) : '?';

      return {
        action: 'enter_long',
        symbol,
        suggestedSize: 0.8,
        suggestedStopLoss: stopLoss,
        suggestedTakeProfit: takeProfit,
        reasoning: [
          `VCP breakout above $${resistanceLevel.toFixed(2)}`,
          `ATR contracted ${contractionPct.toFixed(0)}% (${prevAtr.toFixed(2)}→${atr.toFixed(2)})`,
          `Volume dried up ${volDropPct}% below 20-bar avg`,
          `RSI=${rsi.toFixed(1)}  SMA20=${sma20.toFixed(2)} > SMA50=${sma50.toFixed(2)}`,
          `Stop $${stopLoss.toFixed(2)} | TP $${takeProfit.toFixed(2)} | 1.5R`,
        ].join(' | '),
        confidence,
      };
    }

    // Pattern forming — contraction in progress but no breakout yet
    if (volumeDryUp && rsiNeutral && distFromHighPct <= 10) {
      return {
        action: 'hold',
        symbol,
        reasoning: `VCP forming: ATR −${contractionPct.toFixed(0)}%, ${distFromHighPct.toFixed(1)}% from high, waiting breakout above $${resistanceLevel.toFixed(2)}`,
        confidence: 0.25,
      };
    }

    // Conditions partially met
    const missing = [
      !volumeDryUp  ? 'vol-not-dry' : '',
      !rsiNeutral   ? `RSI=${rsi.toFixed(0)}-out-of-range` : '',
    ].filter(Boolean).join(',');

    return {
      action: 'hold',
      symbol,
      reasoning: `VCP: not set up (contract=${contractionPct.toFixed(0)}% dist=${distFromHighPct.toFixed(1)}% ${missing})`,
      confidence: 0,
    };
  }
}
