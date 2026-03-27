import { getConfig } from '../config';
import type { IStrategy, StrategySignal } from './base';
import type { OHLCV } from '../exchange/index';
import type { IndicatorSet } from '../analysis/indicators';
import { getDb } from '../data/db';

/**
 * DCA (Dollar Cost Averaging) Strategy
 *
 * Places recurring buy orders on a time interval.
 * Adds "safety orders" when price drops by price_deviation_pct from last entry.
 * Smart sizing: reduces order size when ATR is extreme (> 4% of price).
 *
 * This strategy does NOT generate 'exit' signals — positions are managed
 * by the positionMonitor (trailing stop or take-profit via soul.md).
 */
export class DCAStrategy implements IStrategy {
  name = 'dca';
  private lastEntryTime: Map<string, number> = new Map(); // symbol → epoch ms
  private lastEntryPrice: Map<string, number> = new Map(); // symbol → price

  evaluate(params: {
    symbol: string;
    candles: OHLCV[];
    indicators: IndicatorSet;
    currentPrice: number;
    availableBalance: number;
  }): StrategySignal {
    const config = getConfig();
    const { order_count, price_deviation_pct, safety_orders, safety_order_multiplier } =
      config.strategies.dca;
    const { atr, close } = params.indicators;

    // Count existing open DCA positions for this symbol
    const openDcaCount = this.countOpenDcaPositions(params.symbol);
    if (openDcaCount >= order_count) {
      return {
        action: 'hold',
        symbol: params.symbol,
        reasoning: `DCA: max orders reached (${openDcaCount}/${order_count})`,
        confidence: 0,
      };
    }

    const now = Date.now();
    const lastEntry = this.lastEntryTime.get(params.symbol) ?? 0;
    const lastPrice = this.lastEntryPrice.get(params.symbol);

    // Base interval: 4 hours between regular DCA orders
    const intervalMs = 4 * 60 * 60 * 1000;
    const intervalElapsed = now - lastEntry > intervalMs;

    // Safety order: price dropped by deviation_pct from last entry
    const safetyOrderTriggered =
      safety_orders &&
      lastPrice !== undefined &&
      (lastPrice - params.currentPrice) / lastPrice >= price_deviation_pct;

    if (!intervalElapsed && !safetyOrderTriggered) {
      return {
        action: 'hold',
        symbol: params.symbol,
        reasoning: `DCA: waiting for next interval or safety order trigger`,
        confidence: 0,
      };
    }

    // Smart sizing: reduce in extreme volatility
    let sizeFraction = 1.0;
    if (atr !== null && close > 0) {
      const atrPct = atr / close;
      if (atrPct > 0.04) {
        sizeFraction = 0.5; // Half size in very high volatility
      } else if (atrPct > 0.02) {
        sizeFraction = 0.75;
      }
    }

    // Safety orders use multiplied size
    if (safetyOrderTriggered && !intervalElapsed) {
      sizeFraction *= safety_order_multiplier;
    }

    const reason = safetyOrderTriggered
      ? `DCA safety order: price dropped ${((lastPrice! - params.currentPrice) / lastPrice! * 100).toFixed(2)}% from last entry $${lastPrice!.toFixed(2)}`
      : `DCA interval order (${openDcaCount + 1}/${order_count}), ATR=${atr?.toFixed(2) ?? 'N/A'}`;

    // Record this entry
    this.lastEntryTime.set(params.symbol, now);
    this.lastEntryPrice.set(params.symbol, params.currentPrice);

    return {
      action: 'enter_long',
      symbol: params.symbol,
      suggestedSize: sizeFraction,
      reasoning: reason,
      confidence: 0.6,
    };
  }

  private countOpenDcaPositions(symbol: string): number {
    const db = getDb();
    const result = db.prepare(
      "SELECT COUNT(*) as cnt FROM positions WHERE symbol = ? AND strategy = 'dca' AND status = 'open'"
    ).get(symbol) as { cnt: number };
    return result.cnt;
  }
}
