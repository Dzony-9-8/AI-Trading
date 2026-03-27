import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// Load .env from project root
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

import { loadConfig } from '../src/config';
import { openDb } from '../src/data/db';
import { log } from '../src/logger';
import { BinanceExchange } from '../src/exchange/binance';

async function setup() {
  console.log('\n=== LocalTrader Setup ===\n');

  // 1. Validate genesis.json
  console.log('1. Validating genesis.json...');
  let config;
  try {
    config = loadConfig();
    console.log(`   ✓ Config valid — ${config.identity.name} v${config.identity.version}`);
  } catch (e) {
    console.error(`   ✗ ${(e as Error).message}`);
    process.exit(1);
  }

  // 2. Check .env
  console.log('2. Checking .env...');
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) {
    console.error('   ✗ .env file not found. Copy config/.env.example to .env and fill in your keys.');
    process.exit(1);
  }

  if (!process.env.BINANCE_API_KEY || process.env.BINANCE_API_KEY === 'your_binance_api_key_here') {
    console.warn('   ⚠ BINANCE_API_KEY not set — running in paper mode only');
  } else {
    console.log('   ✓ BINANCE_API_KEY present');
  }

  if (!process.env.BINANCE_SECRET || process.env.BINANCE_SECRET === 'your_binance_secret_here') {
    console.warn('   ⚠ BINANCE_SECRET not set — running in paper mode only');
  }

  // Auto-generate DASHBOARD_TOKEN if missing
  if (!process.env.DASHBOARD_TOKEN) {
    const token = crypto.randomBytes(32).toString('hex');
    let envContent = fs.readFileSync(envPath, 'utf-8');
    if (envContent.includes('DASHBOARD_TOKEN=')) {
      envContent = envContent.replace(/DASHBOARD_TOKEN=.*/, `DASHBOARD_TOKEN=${token}`);
    } else {
      envContent += `\nDASHBOARD_TOKEN=${token}`;
    }
    fs.writeFileSync(envPath, envContent);
    console.log(`   ✓ DASHBOARD_TOKEN generated and saved to .env`);
    console.log(`   ⚠ Save this token — needed for kill-switch: ${token}`);
  } else {
    console.log('   ✓ DASHBOARD_TOKEN present');
  }

  // 3. Initialize database
  console.log('3. Initializing database...');
  try {
    const db = openDb();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).all() as { name: string }[];
    console.log(`   ✓ Database ready — tables: ${tables.map(t => t.name).join(', ')}`);
  } catch (e) {
    console.error(`   ✗ Database error: ${(e as Error).message}`);
    process.exit(1);
  }

  // 4. Test Binance connection (only if keys provided)
  if (
    process.env.BINANCE_API_KEY &&
    process.env.BINANCE_API_KEY !== 'your_binance_api_key_here' &&
    process.env.BINANCE_SECRET
  ) {
    console.log('4. Testing Binance connection...');
    try {
      const exchange = new BinanceExchange(
        process.env.BINANCE_API_KEY,
        process.env.BINANCE_SECRET,
        config.exchange.sandbox
      );

      const ticker = await exchange.getTicker('BTC/USDT');
      console.log(`   ✓ Binance connected — BTC/USDT: $${ticker.last.toLocaleString()}`);

      // 5. Validate API key permissions
      console.log('5. Checking API key permissions...');
      const hasWithdraw = await exchange.hasWithdrawalPermission();
      if (hasWithdraw) {
        console.error('   ✗ CRITICAL: API key has withdrawal permissions enabled!');
        console.error('     Go to Binance → API Management and DISABLE "Enable Withdrawals"');
        console.error('     This bot will NOT start with withdrawal-enabled keys. Your safety comes first.');
        process.exit(1);
      }
      console.log('   ✓ API key has NO withdrawal permission (safe)');

      // 6. Fetch balance
      console.log('6. Fetching account balance...');
      const balance = await exchange.getBalance();
      console.log(`   ✓ USDT Balance: $${balance.total.toFixed(2)} (free: $${balance.free.toFixed(2)})`);

      if (balance.total < 10) {
        console.warn('   ⚠ Balance is very low. Minimum recommended is $50 USDT for meaningful trading.');
      }
    } catch (e) {
      console.error(`   ✗ Binance connection failed: ${(e as Error).message}`);
      console.log('   Continuing in paper mode...');
    }
  } else {
    console.log('4. Skipping Binance connection test (no API keys)');
    console.log('5. Skipping permission check');
    console.log('6. Skipping balance check');
  }

  // 7. Check paper mode
  console.log(`7. Trading mode: ${config.trading.paper_mode ? '📄 PAPER (simulated)' : '💰 LIVE'}`);
  if (!config.trading.paper_mode) {
    console.warn('   ⚠ LIVE MODE — real money will be traded. Ensure you have backtested first!');
  }

  // 8. Validate soul.md exists
  const soulPath = path.resolve(process.cwd(), 'config', 'soul.md');
  if (fs.existsSync(soulPath)) {
    console.log('8. ✓ soul.md (trading constitution) present');
  } else {
    console.warn('8. ⚠ soul.md not found — creating default');
  }

  console.log('\n=== Setup Complete ===');
  console.log(`\nRun the bot with: ${config.trading.paper_mode ? 'npm run dev' : 'npm start'}`);
  console.log(`Dashboard will be at: http://127.0.0.1:${config.dashboard.port}\n`);
}

setup().catch(e => {
  console.error('Setup failed:', e);
  process.exit(1);
});
