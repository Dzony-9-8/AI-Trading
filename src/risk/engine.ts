import { getConfig } from '../config';
import { getOpenPositions, getRecentTrades } from '../data/db';
import { getBalance } from '../core/state';
import type { IExchange, SymbolFilters } from '../exchange/index';
import { log } from '../logger';

// Correlation groups — assets that move together >80% of the time
const CORR_GROUPS: string[][] = [
  ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT', 'AVAX/USDT'],  // large-cap crypto
  ['LINK/USDT', 'DOT/USDT', 'MATIC/USDT'],                           // mid-cap alts
];

export interface RiskValidation {
  approved: boolean;
  reason: string;
  adjustedSize?: number; // Size after Kelly + lot-size rounding
}

/**
 * Calculates Kelly Criterion fraction.
 * Falls back to max_risk_per_trade_pct for first 20 trades (no historical data).
 */
export function kellyFraction(): number {
  const config = getConfig();
  const maxRisk = config.risk.max_risk_per_trade_pct;

  const recentTrades = getRecentTrades(50).filter(t => t.pnl !== null);
  if (recentTrades.length < 20) return maxRisk; // Not enough data yet

  const wins = recentTrades.filter(t => (t.pnl ?? 0) > 0);
  const losses = recentTrades.filter(t => (t.pnl ?? 0) <= 0);
  if (wins.length === 0 || losses.length === 0) return maxRisk;

  const winRate = wins.length / recentTrades.length;
  const avgWin = wins.reduce((sum, t) => sum + (t.pnl ?? 0), 0) / wins.length;
  const avgLoss = Math.abs(losses.reduce((sum, t) => sum + (t.pnl ?? 0), 0) / losses.length);

  if (avgWin === 0) return maxRisk;

  const kelly = (winRate * avgWin - (1 - winRate) * avgLoss) / avgWin;
  // Use half-Kelly for safety, capped at max_risk_per_trade_pct
  return Math.min(Math.max(kelly * 0.5, 0.005), maxRisk);
}

/**
 * Validates a proposed trade against all risk rules.
 * Returns approved=false with a reason if any rule is violated.
 */
export async function validateTrade(params: {
  symbol: string;
  side: 'buy' | 'sell';
  suggestedSize: number;
  price: number;
  exchange: IExchange;
}): Promise<RiskValidation> {
  const config = getConfig();
  const balance = getBalance();

  // 1. Check concurrent position limit
  const openPositions = getOpenPositions();
  if (openPositions.length >= config.risk.max_concurrent_positions) {
    return {
      approved: false,
      reason: `Max concurrent positions reached (${config.risk.max_concurrent_positions})`,
    };
  }

  // 2. Correlation filter — max 2 positions from same correlated group
  const maxCorrelated = (config.risk as any).max_correlated_positions ?? 2;
  const openSymbols = openPositions.map(p => p.symbol);
  for (const group of CORR_GROUPS) {
    if (!group.includes(params.symbol)) continue;
    const groupOpen = openSymbols.filter(s => group.includes(s));
    if (groupOpen.length >= maxCorrelated) {
      return {
        approved: false,
        reason: `Correlation limit: ${groupOpen.length}/${maxCorrelated} positions already open in correlated group [${groupOpen.join(', ')}]`,
      };
    }
  }

  // 3. Calculate Kelly-adjusted size
  const fraction = kellyFraction();
  const maxPositionValue = balance * fraction;
  const maxSize = maxPositionValue / params.price;

  // 4. Validate against exchange lot-size filters
  let filters: SymbolFilters;
  try {
    filters = await params.exchange.getSymbolFilters(params.symbol);
  } catch (e) {
    return { approved: false, reason: `Cannot fetch symbol filters: ${(e as Error).message}` };
  }

  const roundedSize = roundToStepSize(Math.min(params.suggestedSize, maxSize), filters.stepSize);

  if (roundedSize < filters.minQty) {
    return {
      approved: false,
      reason: `Size ${roundedSize} < exchange minQty ${filters.minQty}`,
    };
  }

  const notional = roundedSize * params.price;
  if (notional < filters.minNotional) {
    return {
      approved: false,
      reason: `Notional $${notional.toFixed(2)} < exchange minNotional $${filters.minNotional}`,
    };
  }

  // 5. Ensure we have enough free balance
  const cost = notional * (1 + config.risk.slippage_budget_pct);
  if (cost > balance * 0.95) { // Keep 5% as fee reserve
    return {
      approved: false,
      reason: `Insufficient balance ($${balance.toFixed(2)}) for order cost $${cost.toFixed(2)}`,
    };
  }

  log.debug('Risk validation passed', {
    symbol: params.symbol,
    kelly: fraction.toFixed(4),
    adjustedSize: roundedSize,
    notional: notional.toFixed(2),
  });

  return { approved: true, reason: 'OK', adjustedSize: roundedSize };
}

/**
 * Sets stop-loss deadline for a newly opened position.
 * Returns the ISO deadline string.
 */
export function getStopLossDeadline(): string {
  const config = getConfig();
  const deadline = new Date();
  deadline.setMinutes(deadline.getMinutes() + config.risk.stop_loss_deadline_minutes);
  return deadline.toISOString();
}

/**
 * Checks all open positions for expired stop-loss deadlines.
 * Returns IDs of positions past deadline with no stop-loss set.
 */
export function findStopLossViolations(): number[] {
  const config = getConfig();
  if (!config.risk.always_use_stop_loss) return [];

  const positions = getOpenPositions();
  const now = new Date();
  const violations: number[] = [];

  for (const pos of positions) {
    if (pos.stop_loss !== null) continue; // Has stop-loss, fine
    if (!pos.stop_loss_deadline) continue;

    const deadline = new Date(pos.stop_loss_deadline);
    if (now > deadline) {
      violations.push(pos.id);
      log.warn('Stop-loss deadline expired', {
        positionId: pos.id,
        symbol: pos.symbol,
        deadline: pos.stop_loss_deadline,
      });
    }
  }

  return violations;
}

function roundToStepSize(value: number, stepSize: number): number {
  if (stepSize <= 0) return value;
  const precision = Math.max(0, Math.round(-Math.log10(stepSize)));
  return parseFloat((Math.floor(value / stepSize) * stepSize).toFixed(precision));
}
