import { EventEmitter } from 'events';
import { getConfig } from '../config';
import { log } from '../logger';
import { updateBalance, getTier, setTier, getBalance, getDrawdownFromPeak } from '../core/state';
import { upsertSurvivalLog } from '../data/db';
import type { SurvivalTier } from '../core/state';

export interface TierChangeEvent {
  from: SurvivalTier;
  to: SurvivalTier;
  balance: number;
}

class EconomicsEmitter extends EventEmitter {}
export const economicsEvents = new EconomicsEmitter();

let _todayAiCosts = 0;
let _todayApiCosts = 0;
let _dailyStartBalance = 0;
let _initialized = false;

export function initEconomics(startingBalance: number): void {
  _dailyStartBalance = startingBalance;
  _initialized = true;
}

export function recordApiCost(usd: number): void {
  _todayApiCosts += usd;
}

export function recordAiCost(usd: number): void {
  _todayAiCosts += usd;
}

/**
 * Main economics update — call with fresh balance from exchange.
 * Emits 'tier_change' if the survival tier changes.
 */
export function updateEconomics(newBalance: number): void {
  if (!_initialized) return;

  const config = getConfig();
  const prevTier = getTier();
  const initial = config.survival.initial_balance_usdt;

  updateBalance(newBalance);

  // Determine new tier
  const ratio = newBalance / initial;
  let newTier: SurvivalTier;

  if (ratio >= config.survival.cautious_threshold_pct) {
    newTier = 'normal';
  } else if (ratio >= config.survival.critical_threshold_pct) {
    newTier = 'cautious';
  } else if (ratio >= config.survival.stopped_threshold_pct) {
    newTier = 'critical';
  } else {
    newTier = 'stopped';
  }

  if (newTier !== prevTier) {
    setTier(newTier);
    log.warn(`Survival tier changed: ${prevTier} → ${newTier}`, {
      balance: newBalance.toFixed(2),
      ratio: (ratio * 100).toFixed(1) + '%',
    });

    const event: TierChangeEvent = { from: prevTier, to: newTier, balance: newBalance };
    economicsEvents.emit('tier_change', event);
  }

  // Persist daily survival log
  const today = new Date().toISOString().slice(0, 10);
  const drawdown = Math.abs(Math.min(getDrawdownFromPeak(), 0));

  upsertSurvivalLog({
    date: today,
    starting_balance: _dailyStartBalance,
    ending_balance: newBalance,
    peak_balance: Math.max(newBalance, _dailyStartBalance),
    drawdown_pct: drawdown,
    tier: newTier,
    api_costs_usd: _todayApiCosts,
    ai_costs_usd: _todayAiCosts,
    circuit_breaker_triggered: 0,
    notes: undefined,
  });
}

export function markCircuitBreaker(): void {
  const today = new Date().toISOString().slice(0, 10);
  const balance = getBalance();
  upsertSurvivalLog({
    date: today,
    starting_balance: _dailyStartBalance,
    ending_balance: balance,
    peak_balance: balance,
    drawdown_pct: Math.abs(Math.min(getDrawdownFromPeak(), 0)),
    tier: getTier(),
    api_costs_usd: _todayApiCosts,
    ai_costs_usd: _todayAiCosts,
    circuit_breaker_triggered: 1,
  });
}

export function resetDailyCounters(newStartBalance: number): void {
  _dailyStartBalance = newStartBalance;
  _todayApiCosts = 0;
  _todayAiCosts = 0;
}
