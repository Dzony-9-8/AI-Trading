import { Router } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { requireAuth } from '../auth';
import { setPaused, isPaused } from '../../core/state';
import { log } from '../../logger';

const router = Router();
const STOP_FILE = path.resolve(process.cwd(), 'STOP');

router.post('/', requireAuth, (req, res) => {
  const { action } = req.body as { action?: string };

  if (!action) {
    res.status(400).json({ error: 'action required: stop | pause | resume' });
    return;
  }

  switch (action) {
    case 'stop':
      log.warn('Kill switch triggered via dashboard');
      fs.writeFileSync(STOP_FILE, `Triggered via dashboard at ${new Date().toISOString()}\n`);
      res.json({ ok: true, message: 'STOP file created — bot will halt within 30s' });
      break;

    case 'pause': {
      const minutes = parseInt(String(req.body.minutes ?? '60'), 10);
      const until = new Date();
      until.setMinutes(until.getMinutes() + minutes);
      setPaused(until);
      log.warn(`Bot paused via dashboard for ${minutes} minutes`);
      res.json({ ok: true, message: `Bot paused until ${until.toISOString()}` });
      break;
    }

    case 'resume':
      setPaused(null);
      log.info('Bot resumed via dashboard');
      res.json({ ok: true, message: 'Bot resumed' });
      break;

    default:
      res.status(400).json({ error: `Unknown action: ${action}` });
  }
});

router.get('/status', (_req, res) => {
  res.json({
    paused: isPaused(),
    stopFileExists: fs.existsSync(STOP_FILE),
  });
});

export default router;
