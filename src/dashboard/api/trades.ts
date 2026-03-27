import { Router } from 'express';
import { getDb } from '../../data/db';

const router = Router();

router.get('/', (req, res) => {
  const limit  = Math.min(parseInt(String(req.query.limit ?? '50'), 10), 500);
  const page   = Math.max(parseInt(String(req.query.page ?? '1'), 10), 1);
  const symbol = req.query.symbol as string | undefined;
  const offset = (page - 1) * limit;

  const db = getDb();
  const baseQuery = symbol
    ? `SELECT t.*, p.symbol, p.strategy FROM trades t
       LEFT JOIN positions p ON t.position_id = p.id
       WHERE p.symbol = ?
       ORDER BY t.timestamp DESC LIMIT ? OFFSET ?`
    : `SELECT t.*, p.symbol, p.strategy FROM trades t
       LEFT JOIN positions p ON t.position_id = p.id
       ORDER BY t.timestamp DESC LIMIT ? OFFSET ?`;

  const params = symbol ? [symbol, limit, offset] : [limit, offset];
  const trades = db.prepare(baseQuery).all(...params);

  const countQuery = symbol
    ? `SELECT COUNT(*) as total FROM trades t LEFT JOIN positions p ON t.position_id = p.id WHERE p.symbol = ?`
    : `SELECT COUNT(*) as total FROM trades t`;
  const { total } = db.prepare(countQuery).get(...(symbol ? [symbol] : [])) as { total: number };

  res.json({ trades, total, page, limit, pages: Math.ceil(total / limit) });
});

export default router;
