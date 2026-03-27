import type { OHLCV } from '../exchange/index';
import type { IndicatorSet } from '../analysis/indicators';

export type SignalAction = 'enter_long' | 'exit' | 'hold';

export interface StrategySignal {
  action: SignalAction;
  symbol: string;
  suggestedSize?: number;    // Fraction of available balance (0–1)
  suggestedStopLoss?: number;
  suggestedTakeProfit?: number;
  reasoning: string;
  confidence: number;        // 0–1
}

export interface IStrategy {
  name: string;
  /**
   * Evaluate the current candle data and indicators.
   * Returns a signal for the heartbeat to act on.
   */
  evaluate(params: {
    symbol: string;
    candles: OHLCV[];
    indicators: IndicatorSet;
    currentPrice: number;
    availableBalance: number;
  }): StrategySignal;
}
