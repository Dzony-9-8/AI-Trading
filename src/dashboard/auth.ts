import type { Request, Response, NextFunction } from 'express';

/**
 * Auth middleware for state-mutating endpoints (kill switch, pause, resume).
 * Checks Authorization: Bearer {DASHBOARD_TOKEN} header.
 * Read-only GET endpoints do NOT use this middleware (localhost-only is sufficient).
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = process.env.DASHBOARD_TOKEN;
  if (!token) {
    res.status(500).json({ error: 'DASHBOARD_TOKEN not set. Run: npm run setup' });
    return;
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing Authorization: Bearer {token} header' });
    return;
  }

  const provided = authHeader.slice('Bearer '.length).trim();
  if (provided !== token) {
    res.status(403).json({ error: 'Invalid dashboard token' });
    return;
  }

  next();
}
