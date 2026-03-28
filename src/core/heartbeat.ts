import { getConfig } from '../config';
import { log } from '../logger';
import {
  getCandles, appendCandle, seedCandles,
  isPaused, getBalance, setRegime, getRegime,
  setActiveStrategy, getActiveStrategy, recordApiResult,
  getTier, resetDailyBalance, getDrawdownFromPeak, getDailyPnLPct,
} from './state';
import { computeIndicators } from '../analysis/indicators';
import { detectRegime, regimeToStrategy } from '../analysis/market-regime';
import { insertSignal, purgeOldSignals, updatePositionPrice, getDb, getOpenPositions, getTradesForPosition, getLastSignalForSymbol } from '../data/db';
import { runChecks, recordConnected, recordDisconnected } from '../risk/circuit-breaker';
import { findStopLossViolations } from '../risk/engine';
import { updateEconomics, economicsEvents, resetDailyCounters, markCircuitBreaker } from '../survival/economics';
import { MomentumStrategy } from '../strategies/momentum';
import { DCAStrategy } from '../strategies/dca';
import { GridStrategy } from '../strategies/grid';
import { VCPStrategy } from '../strategies/vcp';
import { MeanReversionStrategy } from '../strategies/mean-reversion';
import { runPostmortem } from '../analysis/postmortem';
import { analyzeMarketContext } from '../analysis/market-context';
import { getFearGreedIndex, fearGreedMultiplier } from '../analysis/fear-greed';
import { getNewsSentiment, sentimentSizeMultiplier } from '../analysis/news';
import { sendAlert, alerts, telegramEnabled } from '../notifications/telegram';
import { strategyAgent, riskAgent, postmortemAgent } from '../ai/agents';
import { updatePositionMeta, updatePositionStop } from '../data/db';
import type { IExchange } from '../exchange/index';
import type { IStrategy } from '../strategies/base';
import type { OrderManager } from '../execution/order-manager';
import type { TierChangeEvent } from '../survival/economics';
import { reconcileOnStartup } from '../execution/fill-tracker';
import { broadcast } from '../dashboard/ws-broadcaster';
import { drainExternalSignals } from './external-signals';

const STAGGER_DELAY_MS = 250; // Between symbol fetches

/** Push metrics + positions snapshot to all WebSocket clients */
function broadcastMetrics(): void {
  try {
    const config = getConfig();
    const balance = getBalance();
    const tier = getTier();
    const positions = getOpenPositions();
    broadcast({
      type: 'metrics',
      data: {
        balance,
        tier,
        dailyPnLPct: parseFloat((getDailyPnLPct() * 100).toFixed(2)),
        drawdownFromPeakPct: parseFloat((Math.abs(Math.min(getDrawdownFromPeak(), 0)) * 100).toFixed(2)),
        openPositions: positions.length,
        paper: config.trading.paper_mode,
      },
    });
    broadcast({ type: 'positions', data: positions });
  } catch { /* non-critical */ }
}

// Strategy registry
const strategies: Record<string, IStrategy> = {
  momentum: new MomentumStrategy(),
  dca:      new DCAStrategy(),
  grid:     new GridStrategy(),
  vcp:      new VCPStrategy(),
  'mean-reversion': new MeanReversionStrategy(),
};

let _exchange: IExchange;
let _orderManager: OrderManager;

export function initHeartbeat(exchange: IExchange, orderManager: OrderManager): void {
  _exchange = exchange;
  _orderManager = orderManager;

  // Wire tier-change events to order manager
  economicsEvents.on('tier_change', async (event: TierChangeEvent) => {
    log.warn(`Tier change handler: ${event.from} → ${event.to}`);
    sendAlert(alerts.tierChange(event.from, event.to, getBalance()));
    broadcast({ type: 'tier_change', data: { from: event.from, to: event.to, balance: getBalance() } });

    if (event.to === 'cautious') {
      await _orderManager.cancelPendingEntries();
    }
    if (event.to === 'critical' || event.to === 'stopped') {
      await _orderManager.cancelPendingEntries();
    }
    if (event.to === 'stopped') {
      log.error('STOPPED tier reached — triggering emergency liquidation');
    }
  });
}

/** Self-serializing async loop — skips tick if previous hasn't finished */
function runLoop(name: string, fn: () => Promise<void>, intervalMs: number): void {
  let running = false;
  const tick = async () => {
    if (running) {
      log.debug(`[${name}] previous tick still running — skipping`);
      return;
    }
    running = true;
    try {
      await fn();
    } catch (e) {
      log.error(`[${name}] unhandled error`, { error: (e as Error).message });
    } finally {
      running = false;
    }
  };
  // Run immediately on start, then on interval
  tick();
  setInterval(tick, intervalMs);
}

/**
 * Run rules-based postmortem AND AI postmortem (if API key set).
 * Fire-and-forget — never awaited so it never blocks trade flow.
 */
function runFullPostmortem(positionId: number): void {
  const result = runPostmortem(positionId);
  if (!result) return;

  // Look up the signal snapshot closest to entry time for richer postmortem context
  const entrySignal = getLastSignalForSymbol(result.symbol, result.openedAt);

  // AI postmortem runs asynchronously — never blocks trade flow
  postmortemAgent({
    symbol: result.symbol,
    strategy: result.strategy,
    entryPrice: result.entryPrice,
    exitPrice: result.exitPrice,
    pnl: result.pnl,
    holdingHours: result.holdDurationMs / 3_600_000,
    action: result.exitReasoning,
    entryRsi: entrySignal?.rsi ?? null,
    entryMacd: entrySignal?.macd_line ?? null,
    balance: getBalance(),
  }).catch((e: Error) => {
    log.debug('Postmortem AI agent failed', { positionId, error: e.message });
  });
}

/** Start all 4 heartbeat loops */
export function startHeartbeat(): void {
  const config = getConfig();
  const hb = config.heartbeat;

  log.info('Starting heartbeat loops', hb);

  runLoop('positionMonitor', positionMonitor, hb.position_monitor_ms);
  runLoop('marketScanner', marketScanner, hb.market_scanner_ms);
  runLoop('economicCheck', economicCheck, hb.economic_check_ms);
  runLoop('strategyRotation', strategyRotation, hb.strategy_rotation_ms);
}

// ─── Loop 1: Position Monitor (30s) ────────────────────────────────────────

async function positionMonitor(): Promise<void> {
  const config = getConfig();

  // Market hours gate for stock exchanges
  if ('isMarketOpen' in _exchange) {
    try {
      const open = await (_exchange as any).isMarketOpen();
      if (!open) {
        log.debug('Market closed — skipping positionMonitor');
        return;
      }
    } catch { /* ignore — proceed if clock check fails */ }
  }

  // Run circuit breaker checks first
  const triggered = runChecks();
  if (triggered) {
    await handleCircuitBreaker(triggered);
    return;
  }

  if (isPaused()) {
    log.debug('positionMonitor: bot is paused');
    return;
  }

  const positions = getOpenPositions();
  if (positions.length === 0) return;

  for (const pos of positions) {
    try {
      const ticker = await _exchange.getTicker(pos.symbol);
      recordConnected();
      updatePositionPrice(pos.id, ticker.last);

      // ── Partial take-profit (TP1) ──────────────────────────────────────────
      // Close 50% at 1R target, move stop to breakeven, let the rest run to TP2
      if (pos.metadata) {
        try {
          const meta = JSON.parse(pos.metadata) as { tp1_price?: number; tp1_hit?: boolean; original_size?: number };
          if (meta.tp1_price && !meta.tp1_hit && ticker.last >= meta.tp1_price) {
            const closeSize    = pos.size * 0.5;
            const remainSize   = pos.size * 0.5;
            const tp1Closed = await _orderManager.closePartialPosition({
              positionId:    pos.id,
              symbol:        pos.symbol,
              closeSize,
              remainingSize: remainSize,
              currentPrice:  ticker.last,
              reasoning:     `TP1 at $${ticker.last.toFixed(2)} (+1R) — 50% closed, stop moved to breakeven`,
            });
            if (tp1Closed) {
              // Mark TP1 done and move stop to entry price (breakeven)
              updatePositionMeta(pos.id, JSON.stringify({ ...meta, tp1_hit: true }));
              updatePositionStop(pos.id, pos.entry_price);
              const entryTrades = getTradesForPosition(pos.id);
              const entryPrice  = entryTrades[0]?.price ?? pos.entry_price;
              const pnl         = (ticker.last - entryPrice) * closeSize;
              sendAlert(alerts.partialClose(pos.symbol, ticker.last, pnl));
              log.info('TP1 hit — stop moved to breakeven', {
                positionId: pos.id,
                symbol:     pos.symbol,
                newStop:    pos.entry_price,
              });
            }
          }
        } catch {
          // Bad metadata — ignore
        }
      }

      // Check trailing stop
      const strategy = strategies[pos.strategy];
      if (!strategy) continue;

      const trailingStopPct = config.strategies.momentum.trailing_stop_pct;
      const stopPrice = pos.stop_loss;

      if (stopPrice && ticker.last <= stopPrice) {
        log.warn('Stop-loss hit', {
          positionId: pos.id,
          symbol: pos.symbol,
          price: ticker.last,
          stopLoss: stopPrice,
        });
        const slClosed = await _orderManager.closePosition({
          positionId: pos.id,
          symbol: pos.symbol,
          size: pos.size,
          currentPrice: ticker.last,
          action: 'stop_loss',
          reasoning: `Stop-loss triggered at $${ticker.last.toFixed(2)} (stop: $${stopPrice.toFixed(2)})`,
        });
        if (slClosed) {
          const slPnl = (ticker.last - pos.entry_price) * pos.size;
          sendAlert(alerts.tradeClosed(pos.symbol, pos.strategy, 'stop_loss', ticker.last, slPnl));
          runFullPostmortem(pos.id);
          broadcast({ type: 'trade', data: { event: 'closed', symbol: pos.symbol, strategy: pos.strategy, action: 'stop_loss', price: ticker.last, pnl: slPnl } });
          broadcastMetrics();
        }
        continue;
      }

      // Check take-profit
      if (pos.take_profit && ticker.last >= pos.take_profit) {
        log.info('Take-profit hit', {
          positionId: pos.id,
          symbol: pos.symbol,
          price: ticker.last,
        });
        const tpClosed = await _orderManager.closePosition({
          positionId: pos.id,
          symbol: pos.symbol,
          size: pos.size,
          currentPrice: ticker.last,
          action: 'take_profit',
          reasoning: `Take-profit triggered at $${ticker.last.toFixed(2)}`,
        });
        if (tpClosed) {
          const tpPnl = (ticker.last - pos.entry_price) * pos.size;
          sendAlert(alerts.tradeClosed(pos.symbol, pos.strategy, 'take_profit', ticker.last, tpPnl));
          runFullPostmortem(pos.id);
          broadcast({ type: 'trade', data: { event: 'closed', symbol: pos.symbol, strategy: pos.strategy, action: 'take_profit', price: ticker.last, pnl: tpPnl } });
          broadcastMetrics();
        }
        continue;
      }

      // Update trailing stop upward (ratchet)
      if (pos.strategy === 'momentum' && ticker.last > (pos.entry_price ?? 0)) {
        const newStop = ticker.last * (1 - trailingStopPct);
        if (stopPrice === null || newStop > stopPrice) {
          // Update stop in DB
          const db = getDb();
          db.prepare('UPDATE positions SET stop_loss = ? WHERE id = ?').run(newStop, pos.id);
        }
      }
    } catch (e) {
      recordDisconnected();
      log.error('positionMonitor error for position', {
        positionId: pos.id,
        error: (e as Error).message,
      });
    }
  }

  // Check stop-loss deadline violations
  const violations = findStopLossViolations();
  for (const posId of violations) {
    log.warn('Stop-loss deadline violation — forcing close', { positionId: posId });
    const pos = positions.find(p => p.id === posId);
    if (pos) {
      const ticker = await _exchange.getTicker(pos.symbol);
      const dlClosed = await _orderManager.closePosition({
        positionId: posId,
        symbol: pos.symbol,
        size: pos.size,
        currentPrice: ticker.last,
        action: 'sell',
        reasoning: 'Stop-loss deadline expired without stop set — forced exit per constitution',
      });
      if (dlClosed) runFullPostmortem(posId);
    }
  }

  // Push updated metrics + positions to WebSocket clients every positionMonitor cycle (30s)
  broadcastMetrics();
}

// ─── Loop 2: Market Scanner (60s) ────────────────────────────────────────────

async function marketScanner(): Promise<void> {
  const config = getConfig();

  // Market hours gate for stock exchanges
  if ('isMarketOpen' in _exchange) {
    try {
      const open = await (_exchange as any).isMarketOpen();
      if (!open) {
        log.debug('Market closed — skipping scan');
        return;
      }
    } catch { /* ignore — proceed if clock check fails */ }
  }

  if (isPaused()) {
    log.debug('marketScanner: bot is paused');
    return;
  }

  // ── Process external signals (webhooks) ──────────────────────────────────
  const extSignals = drainExternalSignals();
  for (const sig of extSignals) {
    try {
      log.info(`[webhook] Processing ${sig.action} signal from ${sig.source}`, { symbol: sig.symbol, strategy: sig.strategy });

      if (sig.action === 'enter_long') {
        const balance = getBalance();
        const ticker = await _exchange.getTicker(sig.symbol);
        const size = (balance * 0.02) / ticker.ask;
        const posId = await _orderManager.openPosition({
          symbol:    sig.symbol,
          side:      'buy',
          size,
          type:      'limit',
          price:     ticker.ask * 1.001,
          strategy:  sig.strategy,
          reasoning: `External signal from ${sig.source}`,
        });
        if (posId !== null) {
          sendAlert(alerts.tradeOpened(sig.symbol, sig.strategy, 'buy', ticker.ask, size, undefined, undefined, undefined));
          broadcastMetrics();
        }
      } else if (sig.action === 'exit') {
        const open = getOpenPositions().filter(p => p.symbol === sig.symbol);
        for (const pos of open) {
          const ticker = await _exchange.getTicker(sig.symbol);
          const closed = await _orderManager.closePosition({
            positionId:   pos.id,
            symbol:       pos.symbol,
            size:         pos.size,
            currentPrice: ticker.last,
            action:       'sell',
            reasoning:    `External exit signal from ${sig.source}`,
          });
          if (closed) {
            const pnl = (ticker.last - pos.entry_price) * pos.size;
            sendAlert(alerts.tradeClosed(sig.symbol, sig.strategy, 'sell', ticker.last, pnl));
            broadcastMetrics();
          }
        }
      }
    } catch (e) {
      log.error('[webhook] Error processing external signal', { symbol: sig.symbol, error: (e as Error).message });
    }
  }
  // ── End external signals ──────────────────────────────────────────────────

  for (const symbol of config.trading.symbols) {
    try {
      // Stagger fetches to avoid rate limit spikes
      await sleep(STAGGER_DELAY_MS);

      const candles = await _exchange.getOHLCV(
        symbol,
        config.trading.default_timeframe,
        config.trading.candle_lookback
      );
      recordConnected();
      recordApiResult(true);

      // Seed/update 1h rolling buffer
      if (candles.length > 0) {
        seedCandles(symbol, config.trading.default_timeframe, candles);
        // Push latest candle to dashboard WebSocket clients
        const lastCandle = candles[candles.length - 1];
        broadcast({ type: 'candle', data: { symbol, timeframe: config.trading.default_timeframe, candle: lastCandle } });
      }

      // Refresh 4h candles (higher-timeframe context)
      try {
        const candles4h = await _exchange.getOHLCV(symbol, '4h', 100);
        if (candles4h.length > 0) seedCandles(symbol, '4h', candles4h);
      } catch {
        // 4h fetch is best-effort — never block 1h logic
      }

      const bufferedCandles = getCandles(symbol, config.trading.default_timeframe);
      if (bufferedCandles.length < 35) continue; // Not enough data

      const indicators = computeIndicators(bufferedCandles);

      // Persist signal to DB
      insertSignal({
        symbol,
        timeframe: config.trading.default_timeframe,
        rsi: indicators.rsi ?? undefined,
        macd_line: indicators.macd?.macd,
        macd_signal: indicators.macd?.signal,
        macd_histogram: indicators.macd?.histogram,
        bb_upper: indicators.bb?.upper,
        bb_lower: indicators.bb?.lower,
        bb_middle: indicators.bb?.middle,
        atr: indicators.atr ?? undefined,
        adx: indicators.adx ?? undefined,
        regime: detectRegime(indicators) === 'unknown' ? undefined : detectRegime(indicators) as any,
      });

      // Run active strategy
      const strategyName = getActiveStrategy(symbol);
      const strategy = strategies[strategyName];
      if (!strategy) continue;

      const balance = getBalance();
      const signal = strategy.evaluate({
        symbol,
        candles: bufferedCandles,
        indicators,
        currentPrice: indicators.close,
        availableBalance: balance,
      });

      log.debug(`[${symbol}] ${strategyName} signal`, {
        action: signal.action,
        confidence: signal.confidence,
        reasoning: signal.reasoning,
      });

      if (signal.action === 'enter_long' && signal.confidence > 0.4) {
        // ── Gate 1: 200 SMA trend filter ─────────────────────────────────────
        // Only enter long positions when price is above the 200 SMA.
        // Based on backtested research: cuts max drawdown ~50% vs buy-hold.
        if (indicators.sma200 !== null && indicators.close < indicators.sma200) {
          log.debug(`[${symbol}] Entry blocked — price below 200 SMA`, {
            price: indicators.close.toFixed(2),
            sma200: indicators.sma200.toFixed(2),
          });
          continue;
        }

        // ── Gate 2: Market context (distribution days) ───────────────────────
        const mctx = analyzeMarketContext(bufferedCandles);
        if (mctx.isDistributed) {
          log.warn(`[${symbol}] Entry blocked — heavy distribution`, { summary: mctx.summary });
          continue;
        }

        // ── Gate 3: 4h higher-timeframe confirmation ──────────────────────────
        const candles4h = getCandles(symbol, '4h');
        if (candles4h.length >= 20) {
          const ind4h = computeIndicators(candles4h);
          if (ind4h.sma20 && indicators.close < ind4h.sma20) {
            log.debug(`[${symbol}] 4h trend filter: price below 4h SMA20 $${ind4h.sma20.toFixed(2)} — skip entry`);
            continue;
          }
          if (ind4h.rsi !== null && ind4h.rsi > 75) {
            log.debug(`[${symbol}] 4h overbought: RSI=${ind4h.rsi.toFixed(1)} — skip entry`);
            continue;
          }
        }

        // ── Gate 4: Fear & Greed size multiplier ─────────────────────────────
        const fg = await getFearGreedIndex();
        const fgMult = fg ? fearGreedMultiplier(fg.value) : 1.0;
        if (fgMult < 1.0) {
          log.debug(`[${symbol}] Fear & Greed ${fg?.value} (${fg?.classification}) — sizing at ${(fgMult * 100).toFixed(0)}%`);
        }

        // ── Gate 5: News sentiment size multiplier ────────────────────────────
        const sentiment = await getNewsSentiment(symbol);
        const newsMult = sentimentSizeMultiplier(sentiment);
        if (newsMult !== 1.0) {
          log.debug(`[${symbol}] News sentiment ${sentiment.label} (${sentiment.score}) — sizing at ${(newsMult * 100).toFixed(0)}%`);
        }

        // ── Gate 6: AI strategy validation (if API key present) ──────────────
        const aiDecision = await strategyAgent({
          symbol,
          strategy: strategyName,
          action: signal.action,
          ruleReasoning: signal.reasoning,
          indicators: {
            rsi: indicators.rsi,
            macd: indicators.macd?.macd ?? null,
            bb_upper: indicators.bb?.upper ?? null,
            bb_lower: indicators.bb?.lower ?? null,
            atr: indicators.atr,
            sma50: indicators.sma50,
            sma200: indicators.sma200,
          },
          newsSentiment: sentiment,
          balance,
          tier: getTier(),
        });
        if (aiDecision && !aiDecision.approve) {
          log.debug(`[${symbol}] AI strategy agent blocked entry`, { reasoning: aiDecision.reasoning });
          continue;
        }

        // ── Execute entry ─────────────────────────────────────────────────────
        const ticker = await _exchange.getTicker(symbol);
        let baseRiskPct = 0.02; // 2% base

        // ── AI risk sizing ────────────────────────────────────────────────────
        const openPositions = getOpenPositions();
        const riskDecision = await riskAgent({
          symbol,
          proposedRiskPct: baseRiskPct,
          currentDrawdownPct: Math.abs(Math.min(getDrawdownFromPeak(), 0)),
          openPositionsCount: openPositions.length,
          regime: getRegime(symbol) ?? 'unknown',
          fearGreedValue: fg?.value ?? null,
          balance,
        });
        if (riskDecision && !riskDecision.approve) {
          log.debug(`[${symbol}] AI risk agent blocked entry`, { reasoning: riskDecision.reasoning });
          continue;
        }
        if (riskDecision) baseRiskPct = riskDecision.adjustedRiskPct;

        const baseSize     = (signal.suggestedSize ?? 1.0) * balance * baseRiskPct;
        const adjustedSize = baseSize * fgMult * newsMult;
        const positionId = await _orderManager.openPosition({
          symbol,
          side: 'buy',
          size: adjustedSize / ticker.ask,
          type: 'limit',
          price: ticker.ask * (1 + config.risk.slippage_budget_pct),
          stopLoss:   signal.suggestedStopLoss,
          takeProfit: signal.suggestedTakeProfit,
          strategy:   strategyName,
          reasoning:  signal.reasoning,
        });

        if (positionId !== null) {
          sendAlert(alerts.tradeOpened(
            symbol, strategyName, 'buy',
            ticker.ask, adjustedSize / ticker.ask,
            signal.suggestedStopLoss,
            signal.suggestedTakeProfit,
            sentiment
          ));
          broadcast({ type: 'trade', data: { event: 'opened', symbol, strategy: strategyName, side: 'buy', price: ticker.ask } });
          broadcastMetrics();
        }
      }

      if (signal.action === 'exit') {
        // Exit all open positions for this symbol with this strategy
        const positions = getOpenPositions().filter(
          p => p.symbol === symbol && p.strategy === strategyName
        );
        for (const pos of positions) {
          const ticker = await _exchange.getTicker(symbol);
          const exitClosed = await _orderManager.closePosition({
            positionId: pos.id,
            symbol,
            size: pos.size,
            currentPrice: ticker.last,
            action: 'sell',
            reasoning: signal.reasoning,
          });
          if (exitClosed) {
            const exitPnl = (ticker.last - pos.entry_price) * pos.size;
            sendAlert(alerts.tradeClosed(symbol, strategyName, 'strategy_exit', ticker.last, exitPnl));
            runFullPostmortem(pos.id);
            broadcast({ type: 'trade', data: { event: 'closed', symbol, strategy: strategyName, action: 'strategy_exit', price: ticker.last, pnl: exitPnl } });
            broadcastMetrics();
          }
        }
      }
    } catch (e) {
      recordDisconnected();
      recordApiResult(false);
      log.error(`marketScanner error for ${symbol}`, { error: (e as Error).message });
    }
  }
}

// ─── Loop 3: Economic Check (300s) ───────────────────────────────────────────

async function economicCheck(): Promise<void> {
  try {
    const balance = await _exchange.getBalance();
    recordConnected();
    recordApiResult(true);

    updateEconomics(balance.total);

    // Periodic reconciliation — catch fills that happened while we were running
    // (e.g. stop triggered by exchange while positionMonitor was between ticks)
    try {
      await reconcileOnStartup(_exchange);
    } catch (e) {
      log.warn('Periodic reconciliation error', { error: (e as Error).message });
    }

    // Purge old signals (30-day retention)
    const purged = purgeOldSignals(30);
    if (purged > 0) log.debug(`Purged ${purged} old signal records`);

    // Reset daily counters at midnight
    const hour = new Date().getHours();
    const minute = new Date().getMinutes();
    if (hour === 0 && minute < 5) {
      resetDailyCounters(balance.total);
      resetDailyBalance();
      log.info('Daily counters reset', { newStartBalance: balance.total });
    }

    log.info('Economic check', {
      balance: balance.total.toFixed(2),
      tier: getTier(),
      paper: _exchange.isPaper,
    });
  } catch (e) {
    recordDisconnected();
    recordApiResult(false);
    log.error('economicCheck error', { error: (e as Error).message });
  }
}

// ─── Loop 4: Strategy Rotation (900s) ────────────────────────────────────────

async function strategyRotation(): Promise<void> {
  const config = getConfig();
  if (!config.strategies.auto_regime_detection) return;

  for (const symbol of config.trading.symbols) {
    const candles = getCandles(symbol, config.trading.default_timeframe);
    if (candles.length < 35) continue;

    const indicators = computeIndicators(candles);
    const regime = detectRegime(indicators);
    const prevRegime = getRegime(symbol);

    setRegime(symbol, regime);

    if (regime !== prevRegime) {
      const newStrategy = regimeToStrategy(regime, config.strategies.enabled);
      const prevStrategy = getActiveStrategy(symbol);

      if (newStrategy !== prevStrategy) {
        setActiveStrategy(symbol, newStrategy);
        log.info(`Strategy rotated for ${symbol}`, {
          regime,
          prevStrategy,
          newStrategy,
        });
      }
    }
  }
}

// ─── Circuit breaker handler ──────────────────────────────────────────────────

async function handleCircuitBreaker(event: string): Promise<void> {
  markCircuitBreaker();
  sendAlert(alerts.circuitBreaker(event));

  switch (event) {
    case 'daily_loss_limit':
      log.warn('Daily loss limit — cancelling pending entries');
      await _orderManager.cancelPendingEntries();
      break;

    case 'monthly_drawdown':
      log.warn('Monthly drawdown — liquidating 50% of positions (worst first)');
      await liquidateWorstHalf();
      break;

    case 'api_error_rate':
      log.warn('API errors — pausing, retrying in 10 minutes');
      await _orderManager.cancelPendingEntries();
      break;

    case 'exchange_disconnect':
      log.warn('Exchange disconnected — cancelling pending entry orders only');
      await _orderManager.cancelPendingEntries();
      // OCO stops remain on exchange
      break;

    case 'stop_file':
      log.error('STOP file detected — emergency liquidation');
      await emergencyLiquidateAll();
      process.exit(0);
      break;
  }
}

async function liquidateWorstHalf(): Promise<void> {
  const positions = getOpenPositions().sort((a, b) => {
    const pnlA = (a.current_price ?? a.entry_price) - a.entry_price;
    const pnlB = (b.current_price ?? b.entry_price) - b.entry_price;
    return pnlA - pnlB; // Ascending: worst first
  });

  const toClose = positions.slice(0, Math.ceil(positions.length / 2));
  for (const pos of toClose) {
    const ticker = await _exchange.getTicker(pos.symbol);
    await _orderManager.closePosition({
      positionId: pos.id,
      symbol: pos.symbol,
      size: pos.size,
      currentPrice: ticker.last,
      action: 'emergency_liquidation',
      reasoning: 'Monthly drawdown circuit breaker: 50% liquidation',
    });
  }
}

async function emergencyLiquidateAll(): Promise<void> {
  const positions = getOpenPositions().sort((a, b) => {
    const pnlA = (a.current_price ?? a.entry_price) - a.entry_price;
    const pnlB = (b.current_price ?? b.entry_price) - b.entry_price;
    return pnlA - pnlB; // Worst first
  });

  for (const pos of positions) {
    const ticker = await _exchange.getTicker(pos.symbol);
    await _orderManager.closePosition({
      positionId: pos.id,
      symbol: pos.symbol,
      size: pos.size,
      currentPrice: ticker.last,
      action: 'emergency_liquidation',
      reasoning: 'STOP file detected — emergency liquidation of all positions',
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
