import {
  RSI,
  MACD,
  BollingerBands,
  ATR,
  ADX,
  SMA,
} from 'technicalindicators';
import type { OHLCV } from '../exchange/index';

export interface IndicatorSet {
  rsi: number | null;
  macd: { macd: number; signal: number; histogram: number } | null;
  bb: { upper: number; middle: number; lower: number } | null;
  atr: number | null;
  adx: number | null;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  close: number;
  timestamp: number;
}

/**
 * Compute all indicators from a candle array (oldest → newest).
 * Returns null for any indicator that doesn't have enough data.
 */
export function computeIndicators(candles: OHLCV[]): IndicatorSet {
  if (candles.length === 0) {
    return { rsi: null, macd: null, bb: null, atr: null, adx: null, sma20: null, sma50: null, sma200: null, close: 0, timestamp: 0 };
  }

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const last = candles[candles.length - 1];

  // RSI (14)
  let rsi: number | null = null;
  if (closes.length >= 15) {
    const rsiValues = RSI.calculate({ values: closes, period: 14 });
    rsi = rsiValues.length > 0 ? rsiValues[rsiValues.length - 1] : null;
  }

  // MACD (12, 26, 9)
  let macd: IndicatorSet['macd'] = null;
  if (closes.length >= 35) {
    const macdValues = MACD.calculate({
      values: closes,
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
      SimpleMAOscillator: false,
      SimpleMASignal: false,
    });
    if (macdValues.length > 0) {
      const last_macd = macdValues[macdValues.length - 1];
      macd = {
        macd: last_macd.MACD ?? 0,
        signal: last_macd.signal ?? 0,
        histogram: last_macd.histogram ?? 0,
      };
    }
  }

  // Bollinger Bands (20, 2)
  let bb: IndicatorSet['bb'] = null;
  if (closes.length >= 20) {
    const bbValues = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 });
    if (bbValues.length > 0) {
      const lastBB = bbValues[bbValues.length - 1];
      bb = { upper: lastBB.upper, middle: lastBB.middle, lower: lastBB.lower };
    }
  }

  // ATR (14)
  let atr: number | null = null;
  if (candles.length >= 15) {
    const atrValues = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
    atr = atrValues.length > 0 ? atrValues[atrValues.length - 1] : null;
  }

  // ADX (14)
  let adx: number | null = null;
  if (candles.length >= 28) {
    const adxValues = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });
    adx = adxValues.length > 0 ? adxValues[adxValues.length - 1].adx : null;
  }

  // SMA 20
  let sma20: number | null = null;
  if (closes.length >= 20) {
    const smaValues = SMA.calculate({ values: closes, period: 20 });
    sma20 = smaValues.length > 0 ? smaValues[smaValues.length - 1] : null;
  }

  // SMA 50
  let sma50: number | null = null;
  if (closes.length >= 50) {
    const smaValues = SMA.calculate({ values: closes, period: 50 });
    sma50 = smaValues.length > 0 ? smaValues[smaValues.length - 1] : null;
  } else if (closes.length > 0) {
    // Fallback: use available closes as best approximation
    sma50 = closes[closes.length - 1];
  }

  // SMA 200
  let sma200: number | null = null;
  if (closes.length >= 200) {
    const smaValues = SMA.calculate({ values: closes, period: 200 });
    sma200 = smaValues.length > 0 ? smaValues[smaValues.length - 1] : null;
  } else if (closes.length > 0) {
    // Fallback: use last close when insufficient history for SMA200
    sma200 = closes[closes.length - 1];
  }

  return {
    rsi,
    macd,
    bb,
    atr,
    adx,
    sma20,
    sma50,
    sma200,
    close: last.close,
    timestamp: last.timestamp,
  };
}

/** MACD bullish crossover: macd line crossed above signal line in last candle */
export function isMacdBullishCrossover(candles: OHLCV[]): boolean {
  if (candles.length < 36) return false;
  const closes = candles.map(c => c.close);
  const macdValues = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  if (macdValues.length < 2) return false;
  const prev = macdValues[macdValues.length - 2];
  const curr = macdValues[macdValues.length - 1];
  return (
    (prev.MACD ?? 0) < (prev.signal ?? 0) &&
    (curr.MACD ?? 0) > (curr.signal ?? 0)
  );
}

/** MACD bearish crossover: macd line crossed below signal line in last candle */
export function isMacdBearishCrossover(candles: OHLCV[]): boolean {
  if (candles.length < 36) return false;
  const closes = candles.map(c => c.close);
  const macdValues = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  if (macdValues.length < 2) return false;
  const prev = macdValues[macdValues.length - 2];
  const curr = macdValues[macdValues.length - 1];
  return (
    (prev.MACD ?? 0) > (prev.signal ?? 0) &&
    (curr.MACD ?? 0) < (curr.signal ?? 0)
  );
}
