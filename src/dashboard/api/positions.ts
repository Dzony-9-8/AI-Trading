import { Router } from 'express';
import { getOpenPositions, getDb } from '../../data/db';

const router = Router();

router.get('/', (_req, res) => {
  const positions = getOpenPositions();
  const enriched = positions.map(p => {
    const currentPrice = p.current_price ?? p.entry_price;
    const pnl = (currentPrice - p.entry_price) * p.size;
    const pnlPct = ((currentPrice - p.entry_price) / p.entry_price) * 100;
    return { ...p, pnl: parseFloat(pnl.toFixed(2)), pnlPct: parseFloat(pnlPct.toFixed(2)) };
  });
  res.json(enriched);
});

router.get('/history', (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10), 200);
  const symbol = req.query.symbol as string | undefined;

  const db = getDb();
  let query = 'SELECT * FROM positions WHERE status != ? ORDER BY opened_at DESC LIMIT ?';
  const params: unknown[] = ['open', limit];

  if (symbol) {
    query = 'SELECT * FROM positions WHERE status != ? AND symbol = ? ORDER BY opened_at DESC LIMIT ?';
    params.splice(1, 0, symbol);
  }

  res.json(db.prepare(query).all(...params));
});

export default router;
