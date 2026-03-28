import { Router } from 'express';
import { execSync } from 'child_process';
import * as path from 'path';

const router = Router();

// GET /api/ibkr/positions — fetch IBKR paper positions + portfolio Greeks via ibkr_trader.py --status-json
router.get('/positions', (_req, res) => {
  try {
    const scriptPath = path.join(process.cwd(), 'scripts', 'ibkr_trader.py');
    const python = process.platform === 'win32'
      ? 'C:\\Users\\dzoni\\AppData\\Local\\Programs\\Python\\Python312\\python.exe'
      : 'python3';

    const raw = execSync(`"${python}" "${scriptPath}" --status-json 2>/dev/null`, {
      timeout: 20000,
      encoding: 'utf8',
    });

    const data = JSON.parse(raw.trim());
    res.json(data);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message?.slice(0, 200) : String(e).slice(0, 200);
    res.json({ connected: false, positions: [], orders: [], has_options: false,
               portfolio_greeks: {}, error: message });
  }
});

export default router;
