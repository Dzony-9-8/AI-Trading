import * as fs from 'fs';
import * as path from 'path';
import { Router } from 'express';
import { getDb } from '../../data/db';

const router = Router();

// GET /api/analytics/equity
router.get('/equity', (_req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(
      `SELECT date, starting_balance, ending_balance, peak_balance, drawdown_pct, tier
       FROM survival_log
       ORDER BY date ASC
       LIMIT 90`
    ).all() as {
      date: string;
      starting_balance: number;
      ending_balance: number;
      peak_balance: number;
      drawdown_pct: number;
      tier: string;
    }[];
    res.json({ equity: rows });
  } catch {
    res.json({ equity: [] });
  }
});

// GET /api/analytics/stats
router.get('/stats', (_req, res) => {
  try {
    const db = getDb();

    const trades = db.prepare(
      `SELECT t.pnl, t.action, p.strategy, t.timestamp, p.opened_at, p.entry_price, p.stop_loss
       FROM trades t
       JOIN positions p ON t.position_id = p.id
       WHERE t.pnl IS NOT NULL
         AND t.action IN ('sell','stop_loss','take_profit','emergency_liquidation')
       ORDER BY t.timestamp ASC`
    ).all() as {
      pnl: number; action: string; strategy: string;
      timestamp: string; opened_at: string; entry_price: number; stop_loss: number | null;
    }[];

    if (trades.length === 0) {
      return res.json({
        totalTrades: 0, winRate: 0, avgWin: 0, avgLoss: 0,
        profitFactor: 0, sharpe: 0, byStrategy: {}, dailyPnl: [],
      });
    }

    const wins   = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl <= 0);

    const winRate      = wins.length / trades.length;
    const avgWin       = wins.length   ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length   : 0;
    const avgLoss      = losses.length ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
    const grossProfit  = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss    = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0;

    const pnls   = trades.map(t => t.pnl);
    const mean   = pnls.reduce((a, b) => a + b, 0) / pnls.length;
    const std    = Math.sqrt(pnls.reduce((s, p) => s + Math.pow(p - mean, 2), 0) / pnls.length);
    const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

    // Per-strategy breakdown — group trades by strategy first to avoid cross-reference bugs
    const strategyData: Record<string, {
      trades: { pnl: number; opened_at: string; timestamp: string }[];
    }> = {};

    for (const t of trades) {
      const s = t.strategy || 'unknown';
      if (!strategyData[s]) strategyData[s] = { trades: [] };
      strategyData[s].trades.push(t);
    }

    const byStrategy: Record<string, {
      trades: number; wins: number; pnl: number;
      profitFactor: number; avgDurationMinutes: number;
      bestTrade: number; worstTrade: number;
    }> = {};

    for (const [stratName, { trades: sTrades }] of Object.entries(strategyData)) {
      const sWins   = sTrades.filter(t => t.pnl > 0);
      const sLosses = sTrades.filter(t => t.pnl <= 0);
      const gp = sWins.reduce((acc, t) => acc + t.pnl, 0);
      const gl = Math.abs(sLosses.reduce((acc, t) => acc + t.pnl, 0));
      const totalPnl = sTrades.reduce((acc, t) => acc + t.pnl, 0);
      const pnlValues = sTrades.map(t => t.pnl);

      let totalDuration = 0;
      for (const t of sTrades) {
        if (t.opened_at && t.timestamp) {
          totalDuration += (new Date(t.timestamp).getTime() - new Date(t.opened_at).getTime()) / 60000;
        }
      }

      byStrategy[stratName] = {
        trades: sTrades.length,
        wins: sWins.length,
        pnl: parseFloat(totalPnl.toFixed(2)),
        profitFactor: parseFloat((gl > 0 ? gp / gl : gp > 0 ? 99 : 0).toFixed(2)),
        avgDurationMinutes: parseFloat((sTrades.length > 0 ? totalDuration / sTrades.length : 0).toFixed(1)),
        bestTrade: parseFloat((pnlValues.length ? Math.max(...pnlValues) : 0).toFixed(2)),
        worstTrade: parseFloat((pnlValues.length ? Math.min(...pnlValues) : 0).toFixed(2)),
      };
    }

    // Daily P&L heatmap
    const dailyMap: Record<string, number> = {};
    for (const t of trades) {
      const day = t.timestamp?.slice(0, 10) || '';
      if (day) dailyMap[day] = (dailyMap[day] || 0) + t.pnl;
    }
    const dailyPnl = Object.entries(dailyMap)
      .map(([date, pnl]) => ({ date, pnl: parseFloat(pnl.toFixed(2)) }))
      .sort((a, b) => a.date.localeCompare(b.date));

    res.json({ totalTrades: trades.length, winRate, avgWin, avgLoss, profitFactor, sharpe, byStrategy, dailyPnl });
  } catch (e) {
    res.json({ error: String(e), totalTrades: 0, winRate: 0, avgWin: 0, avgLoss: 0, profitFactor: 0, sharpe: 0, byStrategy: {}, dailyPnl: [] });
  }
});

// GET /api/analytics/rolling-winrate — 20-trade rolling win rate
router.get('/rolling-winrate', (_req, res) => {
  try {
    const db = getDb();
    const trades = db.prepare(
      `SELECT t.pnl, t.timestamp
       FROM trades t
       JOIN positions p ON t.position_id = p.id
       WHERE t.pnl IS NOT NULL
         AND t.action IN ('sell','stop_loss','take_profit','emergency_liquidation')
       ORDER BY t.timestamp ASC`
    ).all() as { pnl: number; timestamp: string }[];

    const WINDOW = 20;
    const result: { index: number; date: string; winRate: number }[] = [];

    for (let i = WINDOW - 1; i < trades.length; i++) {
      const window = trades.slice(i - WINDOW + 1, i + 1);
      const wins = window.filter(t => t.pnl > 0).length;
      result.push({
        index: i + 1,
        date: trades[i].timestamp?.slice(0, 10) || '',
        winRate: parseFloat(((wins / WINDOW) * 100).toFixed(1)),
      });
    }

    res.json({ data: result, window: WINDOW });
  } catch (e) {
    res.json({ data: [], window: 20, error: String(e) });
  }
});

// GET /api/analytics/backtest — latest backtest results (saved by engine.ts)
router.get('/backtest', (_req, res) => {
  try {
    const p = path.join(process.cwd(), 'data', 'backtest_results.json');
    if (!fs.existsSync(p)) return res.json({ available: false });
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    res.json({ available: true, ...data });
  } catch (e) {
    res.json({ available: false, error: String(e) });
  }
});

export default router;
