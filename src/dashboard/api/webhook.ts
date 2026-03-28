import { Router } from 'express';
import { pushExternalSignal } from '../../core/external-signals';
import { log } from '../../logger';

const router = Router();

/**
 * Map TradingView symbol format to internal format.
 * BINANCE:BTCUSDT → BTC/USDT
 * NASDAQ:NVDA     → NVDA
 */
function mapSymbol(tvSymbol: string): string {
  const clean = (tvSymbol.split(':').pop() ?? tvSymbol).toUpperCase();
  if (clean.endsWith('USDT')) return clean.slice(0, -4) + '/USDT';
  if (clean.endsWith('USDC')) return clean.slice(0, -4) + '/USDC';
  if (clean.endsWith('BTC') && clean.length > 3) return clean.slice(0, -3) + '/BTC';
  return clean;
}

/**
 * POST /api/webhook/tradingview
 *
 * Accepts TradingView alert webhooks and queues them for the trading engine.
 *
 * Auth: Bearer <DASHBOARD_TOKEN> in Authorization header
 *
 * Body: { symbol, action: "buy"|"sell", price?, strategy?, confidence? }
 */
router.post('/tradingview', (req, res) => {
  const token = process.env.DASHBOARD_TOKEN ?? '';
  const authHeader = req.headers.authorization ?? '';

  if (!token || !authHeader.startsWith('Bearer ') || authHeader.slice(7) !== token) {
    log.warn('Webhook: unauthorized request rejected', { ip: req.ip });
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { symbol, action, price, strategy, confidence } = req.body as {
    symbol?: string;
    action?: string;
    price?: number;
    strategy?: string;
    confidence?: number;
  };

  if (!symbol || !action) {
    return res.status(400).json({ error: 'symbol and action are required' });
  }
  if (action !== 'buy' && action !== 'sell') {
    return res.status(400).json({ error: 'action must be "buy" or "sell"' });
  }

  const mapped = mapSymbol(symbol);
  const internalAction: 'enter_long' | 'exit' = action === 'buy' ? 'enter_long' : 'exit';

  pushExternalSignal({
    symbol:      mapped,
    action:      internalAction,
    strategy:    strategy ?? 'webhook',
    confidence:  confidence ?? 0.75,
    price,
    source:      'tradingview',
    receivedAt:  Date.now(),
  });

  log.info('Webhook signal queued', { symbol: mapped, action: internalAction, strategy: strategy ?? 'webhook' });
  res.json({ queued: true, symbol: mapped, action: internalAction });
});

export default router;
