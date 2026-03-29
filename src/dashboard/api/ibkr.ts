import { Router } from 'express';
import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

const router = Router();

const PYTHON = process.platform === 'win32'
  ? 'C:\\Users\\dzoni\\AppData\\Local\\Programs\\Python\\Python312\\python.exe'
  : 'python3';

// GET /api/ibkr/positions — legacy endpoint (keep for backwards compat with index.html Greeks strip)
router.get('/positions', (_req, res) => {
  try {
    const scriptPath = path.join(process.cwd(), 'scripts', 'ibkr_trader.py');
    const raw = execSync(`"${PYTHON}" "${scriptPath}" --status-json 2>/dev/null`, {
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

// GET /api/ibkr/status — consolidated status: live positions + bot state + latest scan summary
router.get('/status', (_req, res) => {
  // 1) Live positions from ibkr_trader.py --status-json
  let connection = { connected: false, error: null as string | null };
  let positions: unknown[] = [];
  let orders: unknown[] = [];
  let portfolio_greeks = {};

  try {
    const scriptPath = path.join(process.cwd(), 'scripts', 'ibkr_trader.py');
    const raw = execSync(`"${PYTHON}" "${scriptPath}" --status-json 2>/dev/null`, {
      timeout: 20000,
      encoding: 'utf8',
    });
    const live = JSON.parse(raw.trim());
    connection.connected = live.connected ?? false;
    portfolio_greeks = live.portfolio_greeks ?? {};
    orders = live.orders ?? [];

    // Annotate each position with an exit_rule indicator
    positions = (live.positions ?? []).map((pos: Record<string, unknown>) => {
      const greeks = (pos.greeks ?? {}) as Record<string, number>;
      const dte = greeks.dte ?? 999;
      let exit_rule = 'hold';
      if (dte <= 21) exit_rule = 'dte_stop';
      else if (dte <= 28) exit_rule = 'dte_warn';
      return { ...pos, exit_rule };
    });
  } catch (e: unknown) {
    connection.error = e instanceof Error ? e.message?.slice(0, 200) : String(e).slice(0, 200);
  }

  // 2) Bot state from bot_state.json
  let bot_state: Record<string, unknown> = { open_trades: [], last_scan_date: null };
  try {
    const statePath = path.join(process.cwd(), 'scripts', 'output', 'bot_state.json');
    if (fs.existsSync(statePath)) {
      bot_state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    }
  } catch { /* no bot state yet */ }

  // 3) Latest scan summary from newest options_results_*.json
  let latest_scan: Record<string, unknown> | null = null;
  try {
    const outputDir = path.join(process.cwd(), 'scripts', 'output');
    if (fs.existsSync(outputDir)) {
      const files = fs.readdirSync(outputDir)
        .filter(f => f.startsWith('options_results_') && f.endsWith('.json'))
        .map(f => ({ f, mt: fs.statSync(path.join(outputDir, f)).mtimeMs }))
        .sort((a, b) => b.mt - a.mt);

      if (files.length > 0) {
        const raw = JSON.parse(fs.readFileSync(path.join(outputDir, files[0].f), 'utf8'));
        const meta = raw.scan_metadata ?? {};
        const top5 = (raw.top_stocks ?? []).slice(0, 5).map((s: Record<string, unknown>) => ({
          ticker: s.ticker,
          score: s.score,
          sector: s.sector,
          iv_rank: (s.metrics as Record<string, unknown>)?.iv_rank,
          dte: (s.metrics as Record<string, unknown>)?.dte,
          best_strategy: (() => {
            const strats = s.strategies as Record<string, { valid: boolean; prob_of_profit: number }> | undefined;
            if (!strats) return null;
            const valid = Object.entries(strats).filter(([, v]) => v.valid);
            if (!valid.length) return null;
            return valid.sort((a, b) => b[1].prob_of_profit - a[1].prob_of_profit)[0][0];
          })(),
          pop: (() => {
            const strats = s.strategies as Record<string, { valid: boolean; prob_of_profit: number }> | undefined;
            if (!strats) return null;
            const valid = Object.entries(strats).filter(([, v]) => v.valid);
            if (!valid.length) return null;
            const best = valid.sort((a, b) => b[1].prob_of_profit - a[1].prob_of_profit)[0];
            return Math.round(best[1].prob_of_profit * 100);
          })(),
        }));
        latest_scan = {
          timestamp: meta.timestamp ?? null,
          total_scanned: meta.total_scanned ?? 0,
          passed_gates: meta.passed_gates ?? 0,
          filename: files[0].f,
          age_minutes: Math.round((Date.now() - files[0].mt) / 60000),
          top_stocks: top5,
        };
      }
    }
  } catch { /* no scan results yet */ }

  res.json({ connection, portfolio_greeks, positions, orders, bot_state, latest_scan });
});

export default router;
