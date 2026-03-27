import { getConfig } from '../config';
import type { IStrategy, StrategySignal } from './base';
import type { OHLCV } from '../exchange/index';
import type { IndicatorSet } from '../analysis/indicators';
import { getDb } from '../data/db';

/**
 * Grid Strategy
 *
 * Places a series of buy/sell orders at price intervals above and below current price.
 * The entire grid is treated as ONE logical position in the DB (metadata stores grid state).
 * ATR determines grid width automatically.
 *
 * Entry: Create grid when regime is 'ranging' (ADX < 25)
 * Exit: Grid naturally profits as price oscillates within range
 *
 * Note: Grid only starts if no active grid exists for the symbol.
 */
export class GridStrategy implements IStrategy {
  name = 'grid';

  evaluate(params: {
    symbol: string;
    candles: OHLCV[];
    indicators: IndicatorSet;
    currentPrice: number;
    availableBalance: number;
  }): StrategySignal {
    const config = getConfig();
    const { levels, mode } = config.strategies.grid;
    const { adx, atr, close } = params.indicators;

    // Check if a grid already exists for this symbol
    if (this.hasActiveGrid(params.symbol)) {
      return {
        action: 'hold',
        symbol: params.symbol,
        reasoning: 'Grid already active for this symbol',
        confidence: 0,
      };
    }

    // Only enter grid in ranging market
    if (adx === null || atr === null || close === 0) {
      return {
        action: 'hold',
        symbol: params.symbol,
        reasoning: 'Insufficient indicator data for grid setup',
        confidence: 0,
      };
    }

    if (adx > 25) {
      return {
        action: 'hold',
        symbol: params.symbol,
        reasoning: `ADX=${adx.toFixed(1)} too high — grid requires ranging market (ADX < 25)`,
        confidence: 0,
      };
    }

    // Calculate grid bounds from ATR (2x ATR as grid range)
    const gridRange = atr * 2;
    const upper = params.currentPrice + gridRange;
    const lower = params.currentPrice - gridRange;
    const gridLevels = generateGridLevels(lower, upper, levels, mode);

    const metadata = JSON.stringify({
      upper,
      lower,
      levels: gridLevels,
      mode,
      createdAt: new Date().toISOString(),
    });

    return {
      action: 'enter_long',
      symbol: params.symbol,
      suggestedSize: 1.0,
      reasoning: [
        `Grid: ADX=${adx.toFixed(1)} (ranging)`,
        `Range: $${lower.toFixed(2)} – $${upper.toFixed(2)}`,
        `${levels} levels (${mode})`,
        `ATR=${atr.toFixed(2)} (${((atr / close) * 100).toFixed(2)}%)`,
      ].join(' | '),
      confidence: 0.7,
    };
  }

  private hasActiveGrid(symbol: string): boolean {
    const db = getDb();
    const result = db.prepare(
      "SELECT COUNT(*) as cnt FROM positions WHERE symbol = ? AND strategy = 'grid' AND status = 'open'"
    ).get(symbol) as { cnt: number };
    return result.cnt > 0;
  }
}

function generateGridLevels(
  lower: number,
  upper: number,
  count: number,
  mode: 'arithmetic' | 'geometric'
): number[] {
  const levels: number[] = [];
  if (mode === 'arithmetic') {
    const step = (upper - lower) / (count - 1);
    for (let i = 0; i < count; i++) {
      levels.push(lower + i * step);
    }
  } else {
    // Geometric
    const ratio = Math.pow(upper / lower, 1 / (count - 1));
    for (let i = 0; i < count; i++) {
      levels.push(lower * Math.pow(ratio, i));
    }
  }
  return levels;
}
