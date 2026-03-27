import { Router } from 'express';
import {
  getBalance, getTier, getDailyPnLPct, getDrawdownFromPeak, getAiSpendToday,
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

  const db = getDb();
  const todayTrades = db.prepare(
    "SELECT COUNT(*) as cnt, SUM(pnl) as total_pnl FROM trades WHERE date(timestamp) = date('now')"
  ).get() as { cnt: number; total_pnl: number | null };

  res.json({
    balance,
    initialBalance: config.survival.initial_balance_usdt,
    tier,
    dailyPnLPct: parseFloat((dailyPnLPct * 100).toFixed(2)),
    drawdownFromPeakPct: parseFloat((Math.abs(Math.min(drawdownPct, 0)) * 100).toFixed(2)),
    openPositions: openPositions.length,
    todayTrades: todayTrades.cnt,
    todayPnL: parseFloat((todayTrades.total_pnl ?? 0).toFixed(2)),
    aiSpendToday: parseFloat(aiSpend.toFixed(4)),
    paper: config.trading.paper_mode,
    survivalLog: getSurvivalLog(30),
  });
});

export default router;
