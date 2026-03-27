import { Router } from 'express';
import https from 'https';
import { getCandles } from '../../core/state';
import { getDb } from '../../data/db';
import { getConfig } from '../../config';

const router = Router();

// In-memory cache for on-demand fetched timeframes (5 min TTL)
const onDemandCache = new Map<string, { candles: any[]; expires: number }>();

// Convert "BTC/USDT" → "BTCUSDT" for Binance REST API
function toBinanceSymbol(symbol: string): string {
  return symbol.replace('/', '');
}

// Fetch OHLCV from Binance public REST API (no auth required)
async function fetchFromBinance(symbol: string, timeframe: string, limit: number): Promise<any[]> {
  const cacheKey = `${symbol}:${timeframe}:${limit}`;
  const cached = onDemandCache.get(cacheKey);
  if (cached && Date.now() < cached.expires) return cached.candles;

  return new Promise((resolve) => {
    const binanceSymbol = toBinanceSymbol(symbol);
    const url = `https://api.binance.com/api/v3/klines?symbol=${binanceSymbol}&interval=${timeframe}&limit=${limit}`;
    const req = https.get(url, { timeout: 8000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const raw = JSON.parse(body) as any[][];
          const candles = raw.map(k => ({
            timestamp: Number(k[0]),
            open:      parseFloat(k[1]),
            high:      parseFloat(k[2]),
            low:       parseFloat(k[3]),
            close:     parseFloat(k[4]),
            volume:    parseFloat(k[5]),
          }));
          onDemandCache.set(cacheKey, { candles, expires: Date.now() + 5 * 60 * 1000 });
          resolve(candles);
        } catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
  });
}

// GET /api/candles?symbol=BTC/USDT&timeframe=1h&limit=200
router.get('/', async (req, res) => {
  const config = getConfig();
  const symbol    = String(req.query.symbol    ?? config.trading.symbols[0]);
  const timeframe = String(req.query.timeframe ?? config.trading.default_timeframe);
  const limit     = Math.min(Number(req.query.limit ?? 200), 1000);

  // 1. Try live in-memory buffer first (freshest data)
  const live = getCandles(symbol, timeframe);

  // 2. If buffer is thin, pad with ohlcv_cache from DB
  let candles = live;
  if (live.length < limit) {
    try {
      const db = getDb();
      const rows = db.prepare(
        `SELECT timestamp, open, high, low, close, volume
         FROM ohlcv_cache
         WHERE symbol = ? AND timeframe = ?
         ORDER BY timestamp ASC
         LIMIT ?`
      ).all(symbol, timeframe, limit) as { timestamp: number | string; open: number; high: number; low: number; close: number; volume: number }[];

      if (rows.length > 0) {
        // Convert DB rows — timestamps may be stored as ISO strings or ms integers
        const dbCandles = rows.map(r => ({
          timestamp: typeof r.timestamp === 'string'
            ? new Date(r.timestamp).getTime()
            : r.timestamp,
          open: r.open, high: r.high, low: r.low,
          close: r.close, volume: r.volume,
        }));

        // Merge: DB candles first, then live (live takes precedence for duplicates)
        const liveSet = new Set(live.map(c => c.timestamp));
        const merged = [
          ...dbCandles.filter(c => !liveSet.has(c.timestamp)),
          ...live,
        ].sort((a, b) => a.timestamp - b.timestamp);

        candles = merged.slice(-limit);
      }
    } catch {
      // DB not available yet — just use live buffer
    }
  } else {
    candles = live.slice(-limit);
  }

  // 3. If still empty (timeframe not seeded), fetch on-demand from Binance public API
  if (candles.length === 0) {
    candles = await fetchFromBinance(symbol, timeframe, limit);
  }

  // Format for TradingView Lightweight Charts
  // It expects { time (Unix seconds), open, high, low, close } for candlestick
  // and { time, value } for volume
  const candleSeries = candles.map(c => ({
    time: Math.floor(c.timestamp / 1000), // seconds
    open:  c.open,
    high:  c.high,
    low:   c.low,
    close: c.close,
  }));

  const volumeSeries = candles.map(c => ({
    time:  Math.floor(c.timestamp / 1000),
    value: c.volume,
    color: c.close >= c.open ? '#3fb95033' : '#f8514933',
  }));

  // Compute SMA50 and SMA200 arrays via sliding window for every candle point
  function computeSMAArray(period: number): { time: number; value: number }[] {
    const result: { time: number; value: number }[] = [];
    for (let i = period - 1; i < candles.length; i++) {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += candles[j].close;
      result.push({ time: Math.floor(candles[i].timestamp / 1000), value: sum / period });
    }
    return result;
  }

  const sma50Series  = computeSMAArray(50);
  const sma200Series = computeSMAArray(200);

  res.json({ symbol, timeframe, candles: candleSeries, volume: volumeSeries, sma50: sma50Series, sma200: sma200Series });
});

// GET /api/candles/markers?symbol=BTC/USDT — entry/exit points for chart markers
router.get('/markers', (req, res) => {
  const config = getConfig();
  const symbol = String(req.query.symbol ?? config.trading.symbols[0]);

  try {
    const db = getDb();
    const rows = db.prepare(
      `SELECT t.action, t.price, t.pnl, t.timestamp
       FROM trades t
       JOIN positions p ON t.position_id = p.id
       WHERE p.symbol = ?
       ORDER BY t.timestamp ASC
       LIMIT 500`
    ).all(symbol) as { action: string; price: number; pnl: number | null; timestamp: string }[];

    const markers = rows.map(r => ({
      time:     Math.floor(new Date(r.timestamp).getTime() / 1000),
      position: (r.action === 'buy') ? 'belowBar' : 'aboveBar',
      color:    (r.action === 'buy') ? '#3fb950' : (r.pnl != null && r.pnl >= 0 ? '#58a6ff' : '#f85149'),
      shape:    (r.action === 'buy') ? 'arrowUp' : 'arrowDown',
      text:     r.action === 'buy'
        ? 'BUY'
        : `${r.action.toUpperCase()}${r.pnl != null ? ' ' + (r.pnl >= 0 ? '+' : '') + r.pnl.toFixed(2) : ''}`,
    }));

    res.json({ symbol, markers });
  } catch {
    res.json({ symbol, markers: [] });
  }
});

// GET /api/candles/symbols — list of configured symbols
router.get('/symbols', (_req, res) => {
  const config = getConfig();
  res.json({ symbols: config.trading.symbols });
});

export default router;
