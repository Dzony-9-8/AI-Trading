import { log } from '../logger';
import { getCachedOHLCV } from '../data/db';
import { computeIndicators } from '../analysis/indicators';
import { computeMetrics, printMetrics } from './metrics';
import type { BacktestTrade } from './metrics';
import type { IStrategy } from '../strategies/base';
import type { OHLCV } from '../exchange/index';
import { PaperExchange } from '../exchange/paper';

interface BacktestParams {
  symbol: string;
  timeframe: string;
  strategy: IStrategy;
  days: number;
  startingBalance: number;
  liveExchange: import('../exchange/index').IExchange;
}

/**
 * Run a backtest using cached OHLCV data.
 * Uses the same strategy classes as live trading for consistency.
 * PaperExchange handles fill simulation.
 */
export async function runBacktest(params: BacktestParams): Promise<void> {
  const { symbol, timeframe, strategy, days, startingBalance, liveExchange } = params;

  log.info('Starting backtest', { symbol, timeframe, strategy: strategy.name, days });

  // Load cached candles
  const candles = getCachedOHLCV(symbol, timeframe, days * 24);
  if (candles.length === 0) {
    console.error(`No cached data for ${symbol} ${timeframe}. Run setup --seed first.`);
    return;
  }

  // Convert to OHLCV format (sorted oldest → newest)
  const ohlcv: OHLCV[] = candles
    .map(c => ({
      timestamp: new Date(c.timestamp).getTime(),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }))
    .sort((a, b) => a.timestamp - b.timestamp);

  const paper = new PaperExchange(liveExchange, startingBalance);
  const completedTrades: BacktestTrade[] = [];
  const MIN_CANDLES = 35;

  let openEntry: { price: number; size: number; entryTime: number; stopLoss?: number; takeProfit?: number } | null = null;

  for (let i = MIN_CANDLES; i < ohlcv.length; i++) {
    const windowCandles = ohlcv.slice(0, i + 1);
    const currentCandle = ohlcv[i];
    const indicators = computeIndicators(windowCandles);
    const balance = (await paper.getBalance()).total;

    paper.setCurrentPrice(symbol, currentCandle.close);

    // Simulate fills on this candle
    const fills = paper.simulateCandle(symbol, currentCandle);
    for (const fill of fills) {
      if (fill.side === 'sell' && openEntry) {
        const pnl = (fill.price - openEntry.price) * fill.size - (fill.fee ?? 0);
        completedTrades.push({
          entryPrice: openEntry.price,
          exitPrice: fill.price,
          size: fill.size,
          pnl,
          entryTime: openEntry.entryTime,
          exitTime: currentCandle.timestamp,
          action: fill.status,
        });
        openEntry = null;
      }
    }

    // Only evaluate strategy if no open position
    if (openEntry) continue;

    const signal = strategy.evaluate({
      symbol,
      candles: windowCandles,
      indicators,
      currentPrice: currentCandle.close,
      availableBalance: balance,
    });

    if (signal.action === 'enter_long' && signal.confidence > 0.4) {
      const positionValue = balance * 0.02; // 2% per trade
      const size = positionValue / currentCandle.close;

      const order = await paper.placeOrder({
        symbol,
        side: 'buy',
        type: 'market',
        size,
        price: currentCandle.close,
      });

      openEntry = {
        price: order.price,
        size,
        entryTime: currentCandle.timestamp,
        stopLoss: signal.suggestedStopLoss,
        takeProfit: signal.suggestedTakeProfit,
      };

      // Register stop-loss for fill simulation
      if (signal.suggestedStopLoss) {
        await paper.placeOCO({
          symbol,
          side: 'sell',
          size,
          price: signal.suggestedTakeProfit ?? order.price * 1.06,
          stopPrice: signal.suggestedStopLoss,
          stopLimitPrice: signal.suggestedStopLoss * 0.999,
        });
      }
    }

    if (signal.action === 'exit' && openEntry) {
      const order = await paper.placeOrder({
        symbol,
        side: 'sell',
        type: 'market',
        size: openEntry.size,
        price: currentCandle.close,
      });

      const pnl = (order.price - openEntry.price) * openEntry.size - (order.fee ?? 0);
      completedTrades.push({
        entryPrice: openEntry.price,
        exitPrice: order.price,
        size: openEntry.size,
        pnl,
        entryTime: openEntry.entryTime,
        exitTime: currentCandle.timestamp,
        action: 'exit_signal',
      });
      openEntry = null;
    }
  }

  const durationDays = (ohlcv[ohlcv.length - 1].timestamp - ohlcv[MIN_CANDLES].timestamp) / 86_400_000;
  const metrics = computeMetrics(completedTrades, startingBalance, durationDays);
  printMetrics(metrics);
}
