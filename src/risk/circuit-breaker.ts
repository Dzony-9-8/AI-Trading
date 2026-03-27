import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from '../config';
import { log } from '../logger';
import {
  getDailyPnLPct,
  getDrawdownFromPeak,
  getApiErrorRate,
  setPaused,
  isPaused,
} from '../core/state';

export type CircuitBreakerEvent =
  | 'daily_loss_limit'
  | 'monthly_drawdown'
  | 'api_error_rate'
  | 'exchange_disconnect'
  | 'stop_file';

const STOP_FILE = path.resolve(process.cwd(), 'STOP');

let _onTrigger: ((event: CircuitBreakerEvent) => void) | null = null;
let _stopFileWatcher: fs.FSWatcher | null = null;
let _lastConnectedAt = Date.now();
let _disconnectedSince: number | null = null;

export function onCircuitBreaker(handler: (event: CircuitBreakerEvent) => void): void {
  _onTrigger = handler;
}

function trigger(event: CircuitBreakerEvent): void {
  log.warn(`Circuit breaker triggered: ${event}`);
  if (_onTrigger) _onTrigger(event);
}

/** Start watching for the STOP file (fs.watch) */
export function startStopFileWatcher(): void {
  if (_stopFileWatcher) return;

  // Check immediately on start
  if (fs.existsSync(STOP_FILE)) {
    log.warn('STOP file found at startup — triggering emergency stop');
    trigger('stop_file');
    return;
  }

  const dir = path.dirname(STOP_FILE);
  _stopFileWatcher = fs.watch(dir, (_event, filename) => {
    if (filename === 'STOP' && fs.existsSync(STOP_FILE)) {
      log.warn('STOP file detected — triggering emergency stop');
      trigger('stop_file');
    }
  });

  log.info('STOP file watcher active', { path: STOP_FILE });
}

/** Called on every successful exchange API response */
export function recordConnected(): void {
  _lastConnectedAt = Date.now();
  _disconnectedSince = null;
}

/** Called on every failed exchange API response */
export function recordDisconnected(): void {
  if (_disconnectedSince === null) {
    _disconnectedSince = Date.now();
  }
}

/**
 * Run all circuit breaker checks. Call this every 30s in positionMonitor.
 * Returns the triggered event if any, null otherwise.
 */
export function runChecks(): CircuitBreakerEvent | null {
  const config = getConfig();

  // 1. STOP file (fastest check)
  if (fs.existsSync(STOP_FILE)) {
    trigger('stop_file');
    return 'stop_file';
  }

  // 2. Already paused? Don't double-trigger
  if (isPaused()) return null;

  // 3. Daily loss limit
  const dailyPnL = getDailyPnLPct();
  if (dailyPnL < -config.risk.max_daily_loss_pct) {
    log.warn('Daily loss limit hit', {
      pnlPct: (dailyPnL * 100).toFixed(2) + '%',
      limit: (config.risk.max_daily_loss_pct * 100).toFixed(2) + '%',
    });
    const until = new Date();
    until.setHours(until.getHours() + 24);
    setPaused(until);
    trigger('daily_loss_limit');
    return 'daily_loss_limit';
  }

  // 4. Monthly drawdown (from peak)
  const drawdown = getDrawdownFromPeak();
  if (drawdown < -config.risk.max_monthly_drawdown_pct) {
    log.warn('Monthly drawdown limit hit', {
      drawdown: (drawdown * 100).toFixed(2) + '%',
      limit: (config.risk.max_monthly_drawdown_pct * 100).toFixed(2) + '%',
    });
    trigger('monthly_drawdown');
    return 'monthly_drawdown';
  }

  // 5. API error rate
  const errorRate = getApiErrorRate();
  if (errorRate > 0.05) {
    log.warn('API error rate too high', { errorRate: (errorRate * 100).toFixed(1) + '%' });
    const until = new Date();
    until.setMinutes(until.getMinutes() + 10);
    setPaused(until);
    trigger('api_error_rate');
    return 'api_error_rate';
  }

  // 6. Exchange disconnect > 2 minutes
  if (_disconnectedSince !== null) {
    const disconnectedMs = Date.now() - _disconnectedSince;
    if (disconnectedMs > 2 * 60 * 1000) {
      log.warn('Exchange disconnected for >2 minutes', {
        durationMs: disconnectedMs,
      });
      trigger('exchange_disconnect');
      return 'exchange_disconnect';
    }
  }

  return null;
}

export function stopStopFileWatcher(): void {
  _stopFileWatcher?.close();
  _stopFileWatcher = null;
}
