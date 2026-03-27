import { Router } from 'express';
import { getLogsSince, getRecentLogs } from '../../logger';

const router = Router();

// Polling endpoint — no persistent connections
router.get('/', (req, res) => {
  const sinceParam = req.query.since as string | undefined;

  if (sinceParam) {
    const since = new Date(sinceParam);
    if (isNaN(since.getTime())) {
      res.status(400).json({ error: 'Invalid since parameter (use ISO timestamp)' });
      return;
    }
    res.json(getLogsSince(since));
  } else {
    res.json(getRecentLogs(100));
  }
});

export default router;
