import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env before any other imports
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

import { loadConfig } from './config';
import { log } from './logger';
import { openDb } from './data/db';
import { initState, seedCandles, getTier, getBalance, resetDailyBalance } from './core/state';
import { BinanceExchange } from './exchange/binance';
import { AlpacaExchange } from './exchange/alpaca';
import { PaperExchange } from './exchange/paper';
import { reconcileOnStartup } from './execution/fill-tracker';
import { OrderManager } from './execution/order-manager';
import { initHeartbeat, startHeartbeat } from './core/heartbeat';
import { initEconomics, updateEconomics } from './survival/economics';
import { startStopFileWatcher } from './risk/circuit-breaker';
import { startDashboard } from './dashboard/server';
import { isAIEnabled } from './ai/index';
import type { IExchange } from './exchange/index';

async function main(): Promise<void> {
  log.info('=== LocalTrader starting ===');

  // ── Step 1: Load + validate config ────────────────────────────────────────
  let config;
  try {
    config = loadConfig();
    log.info(`Config loaded — ${config.identity.name} v${config.identity.version}`);
  } catch (e) {
    log.error('Config validation failed', { error: (e as Error).message });
    process.exit(1);
  }

  // ── Step 2: Open DB + run migrations ──────────────────────────────────────
  try {
    openDb();
  } catch (e) {
    log.error('Database initialization failed', { error: (e as Error).message });
    process.exit(1);
  }

  // ── Step 3: Connect to exchange ───────────────────────────────────────────
  const isAlpaca       = config.exchange.id === 'alpaca';
  const hasAlpacaKeys  = Boolean(process.env.ALPACA_API_KEY && process.env.ALPACA_SECRET_KEY);
  const hasBinanceKeys = Boolean(process.env.BINANCE_API_KEY && process.env.BINANCE_SECRET);
  const hasKeys        = isAlpaca ? hasAlpacaKeys : hasBinanceKeys;
  const forcesPaper    = config.trading.paper_mode || !hasKeys;

  let exchange: IExchange;
  let liveExchange: BinanceExchange | AlpacaExchange | null = null;

  if (isAlpaca) {
    // ── Alpaca exchange ──────────────────────────────────────────────────────
    liveExchange = new AlpacaExchange(
      process.env.ALPACA_API_KEY ?? '',
      process.env.ALPACA_SECRET_KEY ?? '',
      config.exchange.sandbox
    );
    log.info(`Connecting to Alpaca ${config.exchange.sandbox ? 'Paper' : 'Live'} trading...`);

    let initialBalance: number;
    try {
      const balance = await liveExchange.getBalance();
      initialBalance = balance.total;
      log.info(`Alpaca balance: $${initialBalance.toFixed(2)}`);
    } catch (e) {
      log.warn('Could not fetch Alpaca balance — using configured initial balance', {
        error: (e as Error).message,
      });
      initialBalance = config.survival.initial_balance_usdt;
    }

    if (forcesPaper) {
      exchange = new PaperExchange(liveExchange, config.survival.initial_balance_usdt);
      log.info('Running in PAPER mode (paper_mode=true in genesis.json)');
    } else {
      exchange = liveExchange;
      log.info('Running in LIVE mode — real capital at risk');
    }

    initState(config, forcesPaper ? config.survival.initial_balance_usdt : initialBalance);
    initEconomics(forcesPaper ? config.survival.initial_balance_usdt : initialBalance);
    // No withdrawal permission check needed for Alpaca

  } else {
    // ── Binance exchange ─────────────────────────────────────────────────────
    if (hasBinanceKeys) {
      liveExchange = new BinanceExchange(
        process.env.BINANCE_API_KEY!,
        process.env.BINANCE_SECRET!,
        config.exchange.sandbox
      );

      // ── Step 3b: Sync clock before any authenticated request ──────────────
      await liveExchange.syncTime();

      // ── Step 4: Validate API key — no withdrawal permission ───────────────
      try {
        const hasWithdraw = await liveExchange.hasWithdrawalPermission();
        if (hasWithdraw) {
          log.error('CRITICAL: API key has withdrawal permissions. Refusing to start.');
          log.error('Go to Binance → API Management → disable "Enable Withdrawals"');
          process.exit(1);
        }
        log.info('API key validated — no withdrawal permission (safe)');
      } catch (e) {
        log.warn('Could not verify withdrawal permission — proceeding with caution', {
          error: (e as Error).message,
        });
      }

      // ── Step 5: Fetch initial balance ─────────────────────────────────────
      let initialBalance: number;
      try {
        const balance = await liveExchange.getBalance();
        initialBalance = balance.total;
        log.info(`Balance fetched: $${initialBalance.toFixed(2)} USDT`);
      } catch (e) {
        log.error('Failed to fetch balance', { error: (e as Error).message });
        process.exit(1);
      }

      if (forcesPaper) {
        exchange = new PaperExchange(liveExchange, config.survival.initial_balance_usdt);
        log.info('Running in PAPER mode (paper_mode=true in genesis.json)');
      } else {
        exchange = liveExchange;
        log.info('Running in LIVE mode — real capital at risk');
      }

      // ── Step 6: Init state with real balance ────────────────────────────
      initState(config, initialBalance);
      initEconomics(initialBalance);
    } else {
      // No API keys — paper mode with configured initial balance
      log.warn('No Binance API keys found — starting in PAPER mode with simulated balance');

      // We still need a live exchange reference for market data (public endpoints)
      liveExchange = new BinanceExchange('', '', false);
      exchange = new PaperExchange(liveExchange, config.survival.initial_balance_usdt);

      initState(config, config.survival.initial_balance_usdt);
      initEconomics(config.survival.initial_balance_usdt);
    }
  }

  // ── Step 7: Reconcile open positions on startup ───────────────────────────
  try {
    await reconcileOnStartup(exchange);
  } catch (e) {
    log.warn('Reconciliation failed — continuing', { error: (e as Error).message });
  }

  // ── Step 8: Seed initial candle buffers (1h + 4h) ────────────────────────
  log.info('Seeding candle buffers...');
  for (const symbol of config.trading.symbols) {
    try {
      // 1h — primary timeframe
      const candles = await exchange.getOHLCV(
        symbol,
        config.trading.default_timeframe,
        config.trading.candle_lookback
      );
      seedCandles(symbol, config.trading.default_timeframe, candles);

      // 4h — higher-timeframe trend filter
      const candles4h = await exchange.getOHLCV(symbol, '4h', 100);
      seedCandles(symbol, '4h', candles4h);

      log.info(`Seeded candles for ${symbol}`, {
        '1h': candles.length,
        '4h': candles4h.length,
      });
    } catch (e) {
      log.warn(`Failed to seed candles for ${symbol}`, { error: (e as Error).message });
    }
  }

  // ── Step 9: Start STOP file watcher ──────────────────────────────────────
  startStopFileWatcher();

  // ── Step 10: Start dashboard ──────────────────────────────────────────────
  startDashboard();

  // ── Step 11: Init and start heartbeat ─────────────────────────────────────
  const orderManager = new OrderManager(exchange);
  initHeartbeat(exchange, orderManager);
  startHeartbeat();

  // ── Step 11b: Periodic Binance clock re-sync (Windows drift prevention) ───
  // Only for live Binance — paper mode and Alpaca don't need this.
  let binanceResyncTimer: NodeJS.Timeout | undefined;
  if (liveExchange instanceof BinanceExchange && !forcesPaper) {
    const RESYNC_INTERVAL_MS = 30 * 60 * 1000; // every 30 minutes
    binanceResyncTimer = setInterval(() => {
      (liveExchange as BinanceExchange).syncTime().catch((e: Error) => {
        log.warn('Periodic Binance time sync failed', { error: e.message });
      });
    }, RESYNC_INTERVAL_MS);
    log.info('Binance clock re-sync scheduled every 30 minutes');
  }

  // ── Step 12: Log startup summary ──────────────────────────────────────────
  log.info('=== LocalTrader started ===', {
    name: config.identity.name,
    mode: forcesPaper ? 'PAPER' : 'LIVE',
    tier: getTier(),
    balance: getBalance().toFixed(2),
    symbols: config.trading.symbols,
    strategies: config.strategies.enabled,
    ai: isAIEnabled() ? 'enabled' : 'disabled (no API key)',
    dashboard: `http://127.0.0.1:${config.dashboard.port}`,
  });

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    log.warn(`Received ${signal} — shutting down gracefully`);

    // Stop the clock re-sync interval
    if (binanceResyncTimer) clearInterval(binanceResyncTimer);

    // Cancel pending entry orders
    try {
      await orderManager.cancelPendingEntries();
    } catch (e) {
      log.error('Failed to cancel orders on shutdown', { error: (e as Error).message });
    }

    // Final survival log write
    try {
      const balance = await exchange.getBalance();
      updateEconomics(balance.total);
    } catch {
      // Best effort
    }

    log.info('Shutdown complete. Goodbye.');
    process.exit(0);
  };

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Keep process alive
  process.on('uncaughtException', e => {
    log.error('Uncaught exception', { error: e.message, stack: e.stack });
  });
  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled rejection', { reason: String(reason) });
  });
}

main();
