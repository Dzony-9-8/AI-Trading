import express from 'express';
import * as http from 'http';
import * as path from 'path';
import { getConfig } from '../config';
import { log } from '../logger';
import positionsRouter from './api/positions';
import tradesRouter from './api/trades';
import metricsRouter from './api/metrics';
import logsRouter from './api/logs';
import controlRouter from './api/control';
import candlesRouter from './api/candles';
import optionsRouter from './api/options';
import analyticsRouter from './api/analytics';
import ibkrRouter from './api/ibkr';
import webhookRouter from './api/webhook';
import { attachWsServer } from './ws-broadcaster';

export function startDashboard(): void {
  const config = getConfig();
  const app = express();
  const PORT = config.dashboard.port;

  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  // API routes
  app.use('/api/positions', positionsRouter);
  app.use('/api/trades', tradesRouter);
  app.use('/api/metrics', metricsRouter);
  app.use('/api/logs', logsRouter);
  app.use('/api/control', controlRouter);
  app.use('/api/candles', candlesRouter);
  app.use(optionsRouter);
  app.use('/api/analytics', analyticsRouter);
  app.use('/api/ibkr', ibkrRouter);
  app.use('/api/webhook', webhookRouter);

  // SPA fallback — serve index.html for known pages
  const pages = ['/', '/trades', '/risk', '/logs', '/chart', '/options', '/analytics'];
  pages.forEach(page => {
    const htmlFile = page === '/' ? 'index' : page.slice(1);
    app.get(page, (_req, res) => {
      res.sendFile(path.join(__dirname, 'public', `${htmlFile}.html`));
    });
  });

  // IMPORTANT: Bind to 127.0.0.1 only — never accessible from outside this machine
  const server = http.createServer(app);
  attachWsServer(server);

  server.listen(PORT, '127.0.0.1', () => {
    log.info(`Dashboard running at http://127.0.0.1:${PORT}`);
    log.info(`WebSocket available at ws://127.0.0.1:${PORT}/ws`);
  });
}
