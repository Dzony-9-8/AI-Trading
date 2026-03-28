import { Router } from 'express';
import {
  getBalance, getTier, getDailyPnLPct, getDrawdownFromPeak, getAiSpendToday,
  getApiErrorRate, getState,
} from '../../core/state';
import { getOpenPositions, getSurvivalLog, getDb } from '../../data/db';
import { getConfig } from '../../config';

const router = Router();

router.get('/', (_req, res) => {
  const config = getConfig();
  const balance = getBalance();
  const tier = getTier();
  const dailyPnLPct = getDailyPnLPct();
  const drawdownPct = getDrawdownFromPeak();
  const openPositions = getOpenPositions();
  const aiSpend = getAiSpendToday();
  const apiErrorRate = getApiErrorRate();

  const db = getDb();

  // Today trades
  const todayTrades = db.prepare(
    "SELECT COUNT(*) as cnt, SUM(pnl) as total_pnl FROM trades WHERE date(timestamp) = date('now')"
  ).get() as { cnt: number; total_pnl: number | null };

  // Week P&L (Mon–today)
  const weekRow = db.prepare(
    `SELECT SUM(pnl) as total FROM trades
     WHERE pnl IS NOT NULL AND date(timestamp) >= date('now', 'weekday 0', '-7 days')`
  ).get() as { total: number | null };

  // Month P&L
  const monthRow = db.prepare(
    `SELECT SUM(pnl) as total FROM trades
     WHERE pnl IS NOT NULL AND strftime('%Y-%m', timestamp) = strftime('%Y-%m', 'now')`
  ).get() as { total: number | null };

  // Best/worst day from survival_log (last 30 days)
  const dayStats = db.prepare(
    `SELECT date,
            (ending_balance - starting_balance) as day_pnl
     FROM survival_log
     ORDER BY date DESC LIMIT 30`
  ).all() as { date: string; day_pnl: number }[];

  const bestDay  = dayStats.length ? dayStats.reduce((a, b) => a.day_pnl > b.day_pnl ? a : b) : null;
  const worstDay = dayStats.length ? dayStats.reduce((a, b) => a.day_pnl < b.day_pnl ? a : b) : null;

  // Streak from recent closed trades
  const recentTrades = db.prepare(
    `SELECT pnl FROM trades
     WHERE pnl IS NOT NULL AND action IN ('sell','stop_loss','take_profit','emergency_liquidation')
     ORDER BY timestamp DESC LIMIT 100`
  ).all() as { pnl: number }[];

  let currentStreak = 0;
  let streakType: 'win' | 'loss' | 'none' = 'none';
  let maxConsecLosses = 0;
  let tempLosses = 0;

  if (recentTrades.length > 0) {
    const first = recentTrades[0];
    streakType = first.pnl > 0 ? 'win' : 'loss';
    for (const t of recentTrades) {
      const isWin = t.pnl > 0;
      if ((streakType === 'win' && isWin) || (streakType === 'loss' && !isWin)) {
        currentStreak++;
      } else {
        break;
      }
    }
    // Max consecutive losses (scan all)
    for (const t of recentTrades) {
      if (t.pnl <= 0) { tempLosses++; if (tempLosses > maxConsecLosses) maxConsecLosses = tempLosses; }
      else tempLosses = 0;
    }
  }

  // Market regimes and active strategies from in-memory state
  const appState = getState();
  const marketRegimes: Record<string, string> = {};
  const activeStrategies: Record<string, string> = {};
  appState.regimes.forEach((regime, symbol) => { marketRegimes[symbol] = regime; });
  appState.activeStrategies.forEach((strat, symbol) => { activeStrategies[symbol] = strat; });

  // AI daily budget from config
  const aiDailyBudget: number = (config as Record<string, unknown> & { ai?: { daily_budget_usd?: number } }).ai?.daily_budget_usd ?? 1.0;

  res.json({
    balance,
    initialBalance: config.survival.initial_balance_usdt,
    tier,
    dailyPnLPct: parseFloat((dailyPnLPct * 100).toFixed(2)),
    drawdownFromPeakPct: parseFloat((Math.abs(Math.min(drawdownPct, 0)) * 100).toFixed(2)),
    openPositions: openPositions.length,
    todayTrades: todayTrades.cnt,
    todayPnL: parseFloat((todayTrades.total_pnl ?? 0).toFixed(2)),
    weekPnL: parseFloat((weekRow.total ?? 0).toFixed(2)),
    monthPnL: parseFloat((monthRow.total ?? 0).toFixed(2)),
    bestDay:  bestDay  ? { date: bestDay.date,  pnl: parseFloat(bestDay.day_pnl.toFixed(2)) }  : null,
    worstDay: worstDay ? { date: worstDay.date, pnl: parseFloat(worstDay.day_pnl.toFixed(2)) } : null,
    currentStreak,
    streakType,
    maxConsecLosses,
    aiSpendToday: parseFloat(aiSpend.toFixed(4)),
    aiDailyBudget,
    apiErrorRate: parseFloat((apiErrorRate * 100).toFixed(1)),
    marketRegimes,
    activeStrategies,
    paper: config.trading.paper_mode,
    survivalLog: getSurvivalLog(30),
  });
});

export default router;
