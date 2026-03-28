import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env before any other imports
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

import { loadConfig } from './config';
import { log } from './logger';
import { openDb } from './data/db';
import { initState } from './core/state';
import { initEconomics } from './survival/economics';
import { startDashboard } from './dashboard/server';

async function main(): Promise<void> {
  const config = loadConfig();
  openDb();
  initState(config, config.survival.initial_balance_usdt);
  initEconomics(config.survival.initial_balance_usdt);
  startDashboard();
  log.info('Dashboard-only mode — no trading active', {
    dashboard: `http://127.0.0.1:${config.dashboard.port}`,
  });
}

main();
