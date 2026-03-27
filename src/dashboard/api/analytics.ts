import { Router } from 'express';
import { getDb } from '../../data/db';

const router = Router();

// GET /api/analytics/equity — equity curve + drawdown from survival_log
router.get('/equity', (_req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(
      `SELECT date, starting_balance, ending_balance, peak_balance, drawdown_pct, tier
       FROM survival_log
       ORDER BY date ASC
       LIMIT 90`
    ).all() as any[];
    res.json({ equity: rows });
  } catch {
    res.json({ equity: [] });
  }
});

// GET /api/analytics/stats — win rate, profit factor, avg win/loss, Sharpe, by-strategy breakdown
router.get('/stats', (_req, res) => {
  try {
    const db = getDb();

    const trades = db.prepare(
      `SELECT t.pnl, t.action, p.strategy, t.timestamp
       FROM trades t
       JOIN positions p ON t.position_id = p.id
       WHERE t.pnl IS NOT NULL
         AND t.action IN ('sell','stop_loss','take_profit','emergency_liquidation')
       ORDER BY t.timestamp ASC`
    ).all() as { pnl: number; action: string; strategy: string; timestamp: string }[];

    if (trades.length === 0) {
      return res.json({
        totalTrades: 0, winRate: 0, avgWin: 0, avgLoss: 0,
        profitFactor: 0, sharpe: 0, byStrategy: {}, dailyPnl: [],
      });
    }

    const wins   = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl <= 0);

    const winRate     = wins.length / trades.length;
    const avgWin      = wins.length   ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length   : 0;
    const avgLoss     = losses.length ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
    const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss   = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0;

    // Sharpe ratio (annualised, simplified)
    const pnls    = trades.map(t => t.pnl);
    const mean    = pnls.reduce((a, b) => a + b, 0) / pnls.length;
    const std     = Math.sqrt(pnls.reduce((s, p) => s + Math.pow(p - mean, 2), 0) / pnls.length);
    const sharpe  = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

    // Per-strategy breakdown
    const byStrategy: Record<string, { trades: number; wins: number; pnl: number }> = {};
    for (const t of trades) {
      const s = t.strategy || 'unknown';
      if (!byStrategy[s]) byStrategy[s] = { trades: 0, wins: 0, pnl: 0 };
      byStrategy[s].trades++;
      if (t.pnl > 0) byStrategy[s].wins++;
      byStrategy[s].pnl += t.pnl;
    }

    // Daily P&L for heatmap
    const dailyMap: Record<string, number> = {};
    for (const t of trades) {
      const day = t.timestamp?.slice(0, 10) || '';
      if (day) dailyMap[day] = (dailyMap[day] || 0) + t.pnl;
    }
    const dailyPnl = Object.entries(dailyMap)
      .map(([date, pnl]) => ({ date, pnl }))
      .sort((a, b) => a.date.localeCompare(b.date));

    res.json({ totalTrades: trades.length, winRate, avgWin, avgLoss, profitFactor, sharpe, byStrategy, dailyPnl });
  } catch (e) {
    res.json({ error: String(e), totalTrades: 0, winRate: 0, avgWin: 0, avgLoss: 0, profitFactor: 0, sharpe: 0, byStrategy: {}, dailyPnl: [] });
  }
});

export default router;
