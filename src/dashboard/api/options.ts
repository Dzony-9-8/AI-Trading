import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { log } from '../../logger';

const router = Router();

// Track whether a scan is currently running
let scanRunning = false;
let scanStarted = 0;

router.get('/api/options/latest', (_req, res) => {
  try {
    const outputDir = path.join(process.cwd(), 'scripts', 'output');

    if (!fs.existsSync(outputDir)) {
      return res.json({ available: false, message: 'No scan results yet. Run the options scanner first.' });
    }

    // Find latest options_results_*.json file
    const files = fs.readdirSync(outputDir)
      .filter(f => f.startsWith('options_results_') && f.endsWith('.json'))
      .sort()
      .reverse();

    if (files.length === 0) {
      return res.json({ available: false, message: 'No scan results yet. Run the options scanner first.' });
    }

    const latestFile = path.join(outputDir, files[0]);
    const data = JSON.parse(fs.readFileSync(latestFile, 'utf-8'));

    // Add filename and age info
    const stat = fs.statSync(latestFile);
    const ageMinutes = Math.floor((Date.now() - stat.mtimeMs) / 60000);

    return res.json({
      available: true,
      filename: files[0],
      age_minutes: ageMinutes,
      scan_running: scanRunning,
      data
    });
  } catch (err: any) {
    return res.status(500).json({ available: false, message: err.message });
  }
});

router.get('/api/options/history', (_req, res) => {
  try {
    const outputDir = path.join(process.cwd(), 'scripts', 'output');
    if (!fs.existsSync(outputDir)) {
      return res.json([]);
    }
    const files = fs.readdirSync(outputDir)
      .filter(f => f.startsWith('options_results_') && f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, 10);  // last 10 scans

    const history = files.map(f => {
      const stat = fs.statSync(path.join(outputDir, f));
      return { filename: f, scanned_at: stat.mtime.toISOString() };
    });
    return res.json(history);
  } catch {
    return res.json([]);
  }
});

// POST /api/options/run-scan — launch Python scanner in background
router.post('/api/options/run-scan', (req, res) => {
  if (scanRunning) {
    const elapsed = Math.floor((Date.now() - scanStarted) / 1000);
    return res.json({ ok: false, message: `Scan already running (${elapsed}s elapsed)` });
  }

  const cwd   = process.cwd();
  const script = path.join(cwd, 'scripts', 'options_scanner.py');

  if (!fs.existsSync(script)) {
    return res.json({ ok: false, message: 'options_scanner.py not found' });
  }

  // Parse optional flags from request body
  const body = req.body ?? {};
  const args: string[] = [script];
  if (body.no_ai)       args.push('--no-ai');
  if (body.relaxed)     args.push('--relaxed');
  if (body.ibkr)        args.push('--ibkr');
  if (body.ibkr_dry)    args.push('--ibkr-dry-run');
  if (body.telegram !== false) args.push('--telegram');

  scanRunning = true;
  scanStarted = Date.now();

  const proc = spawn('python', args, { cwd, detached: false });

  proc.stdout?.on('data', (chunk) => {
    log.debug(`[OptionsScan] ${chunk.toString().trim()}`);
  });
  proc.stderr?.on('data', (chunk) => {
    log.debug(`[OptionsScan stderr] ${chunk.toString().trim()}`);
  });
  proc.on('close', (code) => {
    scanRunning = false;
    log.info(`[OptionsScan] finished, exit code ${code}`);
  });
  proc.on('error', (err) => {
    scanRunning = false;
    log.error(`[OptionsScan] failed to start: ${err.message}`);
  });

  log.info('[OptionsScan] started via dashboard');
  return res.json({ ok: true, message: 'Scan started — results will appear here when complete (~10 min)' });
});

// GET /api/options/scan-status
router.get('/api/options/scan-status', (_req, res) => {
  res.json({
    running: scanRunning,
    elapsed_seconds: scanRunning ? Math.floor((Date.now() - scanStarted) / 1000) : 0,
  });
});

export default router;
