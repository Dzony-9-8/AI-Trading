import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

import { loadConfig } from '../src/config';
import { openDb } from '../src/data/db';
import { BinanceExchange } from '../src/exchange/binance';
import { MomentumStrategy } from '../src/strategies/momentum';
import { DCAStrategy } from '../src/strategies/dca';
import { GridStrategy } from '../src/strategies/grid';
import { runBacktest } from '../src/backtesting/engine';
import { seedHistoricalData } from '../src/backtesting/fetcher';

// Parse CLI args
const args = process.argv.slice(2);
const getArg = (name: string, def: string) => {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : def;
};

const symbol    = getArg('symbol', 'BTC/USDT');
const strategy  = getArg('strategy', 'momentum');
const days      = parseInt(getArg('days', '90'), 10);
const timeframe = getArg('timeframe', '1h');
const seed      = args.includes('--seed');

async function main() {
  console.log(`\n=== LocalTrader Backtest ===`);
  console.log(`Symbol: ${symbol} | Strategy: ${strategy} | Days: ${days} | TF: ${timeframe}\n`);

  const config = loadConfig();
  openDb();

  const exchange = new BinanceExchange(
    process.env.BINANCE_API_KEY ?? '',
    process.env.BINANCE_SECRET ?? '',
    config.exchange.sandbox
  );

  // Optionally seed historical data first
  if (seed) {
    console.log('Seeding historical data...');
    await seedHistoricalData({ exchange, symbol, timeframe, days: days + 10 });
  }

  // Select strategy
  const strategyMap: Record<string, () => import('../src/strategies/base').IStrategy> = {
    momentum: () => new MomentumStrategy(),
    dca:      () => new DCAStrategy(),
    grid:     () => new GridStrategy(),
  };

  const strat = strategyMap[strategy]?.();
  if (!strat) {
    console.error(`Unknown strategy: ${strategy}. Valid: momentum, dca, grid`);
    process.exit(1);
  }

  await runBacktest({
    symbol,
    timeframe,
    strategy: strat,
    days,
    startingBalance: config.survival.initial_balance_usdt,
    liveExchange: exchange,
  });
}

main().catch(e => {
  console.error('Backtest failed:', e.message);
  process.exit(1);
});
