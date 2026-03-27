import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';

const GenesisSchema = z.object({
  identity: z.object({
    name: z.string(),
    version: z.string(),
  }),
  trading: z.object({
    symbols: z.array(z.string()).min(1),
    default_timeframe: z.string(),
    candle_lookback: z.number().int().min(50).max(500),
    paper_mode: z.boolean(),
  }),
  risk: z.object({
    max_risk_per_trade_pct: z.number().min(0.001).max(0.05),
    max_concurrent_positions: z.number().int().min(1).max(20),
    max_daily_loss_pct: z.number().min(0.01).max(0.20),
    max_monthly_drawdown_pct: z.number().min(0.05).max(0.50),
    always_use_stop_loss: z.boolean(),
    stop_loss_deadline_minutes: z.number().int().min(5).max(1440),
    slippage_budget_pct: z.number().min(0).max(0.02),
    use_exchange_native_stops: z.boolean(),
  }),
  exchange: z.object({
    id: z.enum(['binance', 'alpaca']),
    sandbox: z.boolean(),
    market_hours_only: z.boolean().optional().default(true),
  }),
  strategies: z.object({
    enabled: z.array(z.enum(['dca', 'grid', 'momentum', 'vcp', 'mean-reversion'])).min(1),
    auto_regime_detection: z.boolean(),
    dca: z.object({
      order_count: z.number().int().min(2).max(20),
      price_deviation_pct: z.number().min(0.001).max(0.05),
      safety_orders: z.boolean(),
      safety_order_multiplier: z.number().min(1).max(3),
    }),
    grid: z.object({
      levels: z.number().int().min(3).max(50),
      mode: z.enum(['arithmetic', 'geometric']),
    }),
    momentum: z.object({
      rsi_oversold: z.number().min(10).max(40),
      rsi_overbought: z.number().min(60).max(90),
      trailing_stop_pct: z.number().min(0.005).max(0.10),
    }),
  }),
  survival: z.object({
    initial_balance_usdt: z.number().min(10),
    cautious_threshold_pct: z.number().min(0.50).max(0.95),
    critical_threshold_pct: z.number().min(0.20).max(0.70),
    stopped_threshold_pct: z.number().min(0.05).max(0.40),
    emergency_liquidation: z.object({
      method: z.enum(['limit_then_market', 'market_only']),
      limit_timeout_minutes: z.number().int().min(1).max(30),
    }),
  }),
  heartbeat: z.object({
    position_monitor_ms: z.number().int().min(5000),
    market_scanner_ms: z.number().int().min(10000),
    economic_check_ms: z.number().int().min(60000),
    strategy_rotation_ms: z.number().int().min(60000),
  }),
  ai: z.object({
    enabled_if_key_present: z.boolean(),
    max_daily_spend_usd: z.number().min(0),
    model_tiers: z.object({
      bootstrap: z.string(),
      profitable: z.string(),
      well_funded: z.string(),
    }),
  }),
  dashboard: z.object({
    port: z.number().int().min(1024).max(65535),
    log_polling_interval_ms: z.number().int().min(1000),
    max_log_lines: z.number().int().min(50).max(5000),
  }),
});

export type GenesisConfig = z.infer<typeof GenesisSchema>;

let _config: GenesisConfig | null = null;

export function loadConfig(): GenesisConfig {
  if (_config) return _config;

  const configPath = path.resolve(process.cwd(), 'config', 'genesis.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}\nRun: cp config/.env.example .env && npm run setup`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (e) {
    throw new Error(`Failed to parse genesis.json: ${(e as Error).message}`);
  }

  const result = GenesisSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map(i => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid genesis.json:\n${issues}`);
  }

  // Validate threshold ordering
  const s = result.data.survival;
  if (s.cautious_threshold_pct <= s.critical_threshold_pct) {
    throw new Error('genesis.json: survival.cautious_threshold_pct must be > critical_threshold_pct');
  }
  if (s.critical_threshold_pct <= s.stopped_threshold_pct) {
    throw new Error('genesis.json: survival.critical_threshold_pct must be > stopped_threshold_pct');
  }

  _config = result.data;
  return _config;
}

export function getConfig(): GenesisConfig {
  if (!_config) throw new Error('Config not loaded. Call loadConfig() first.');
  return _config;
}
