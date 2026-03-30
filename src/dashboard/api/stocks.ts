import { Router } from 'express';
import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

const router = Router();

const PYTHON = process.platform === 'win32'
  ? 'C:\\Users\\dzoni\\AppData\\Local\\Programs\\Python\\Python312\\python.exe'
  : 'python3';

const PY_ENV = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', NO_COLOR: '1' };

const DEFAULT_WATCHLIST = [
  'SPY', 'QQQ', 'IWM', 'DIA',
  'NVDA', 'AAPL', 'MSFT', 'AMZN', 'META', 'GOOGL', 'TSLA',
  'JPM', 'GS', 'BAC',
  'XLE', 'XLF', 'XLK', 'XLV',
];

// GET /api/stocks/symbols — watchlist + latest scan tickers
router.get('/symbols', (_req, res) => {
  const scanTickers: string[] = [];
  try {
    const outputDir = path.join(process.cwd(), 'scripts', 'output');
    if (fs.existsSync(outputDir)) {
      const files = fs.readdirSync(outputDir)
        .filter(f => f.startsWith('options_results_') && f.endsWith('.json'))
        .map(f => ({ f, mt: fs.statSync(path.join(outputDir, f)).mtimeMs }))
        .sort((a, b) => b.mt - a.mt);
      if (files.length > 0) {
        const raw = JSON.parse(fs.readFileSync(path.join(outputDir, files[0].f), 'utf8'));
        (raw.top_stocks ?? []).slice(0, 15).forEach((s: Record<string, unknown>) => {
          const t = s.ticker as string;
          if (t && !DEFAULT_WATCHLIST.includes(t) && !scanTickers.includes(t)) {
            scanTickers.push(t);
          }
        });
      }
    }
  } catch { /* ignore */ }

  res.json({ symbols: [...DEFAULT_WATCHLIST, ...scanTickers] });
});

// GET /api/stocks/candles?symbol=NVDA&timeframe=1d&limit=300
router.get('/candles', (req, res) => {
  const symbol    = ((req.query.symbol    as string) || 'SPY').toUpperCase().replace(/[^A-Z0-9.^-]/g, '');
  const timeframe = ((req.query.timeframe as string) || '1d').replace(/[^a-z0-9]/g, '');
  const limit     = Math.min(parseInt((req.query.limit as string) || '300', 10), 1000);

  try {
    const scriptPath = path.join(process.cwd(), 'scripts', 'fetch_stock_candles.py');
    const raw = execSync(
      `"${PYTHON}" "${scriptPath}" "${symbol}" "${timeframe}" "${limit}"`,
      { timeout: 30000, encoding: 'utf8', env: PY_ENV }
    );
    const data = JSON.parse(raw.trim());
    if (data.error) {
      res.status(502).json(data);
    } else {
      res.json(data);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300);
    res.status(500).json({ error: msg, candles: [], volume: [] });
  }
});

export default router;
