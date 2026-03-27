import BetterSqlite3 from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { runMigrations } from './schema';
import { log } from '../logger';

const DB_PATH = path.resolve(process.cwd(), 'data', 'trades.db');

let _db: BetterSqlite3.Database | null = null;

export function openDb(): BetterSqlite3.Database {
  if (_db) return _db;

  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  _db = new BetterSqlite3(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('synchronous = NORMAL');

  runMigrations(_db);
  log.info('Database initialized', { path: DB_PATH });

  return _db;
}

export function getDb(): BetterSqlite3.Database {
  if (!_db) throw new Error('DB not opened. Call openDb() first.');
  return _db;
}

// ─── Position helpers ───────────────────────────────────────────────────────

export interface Position {
  id: number;
  symbol: string;
  side: 'long' | 'short' | 'spot';
  strategy: string;
  entry_price: number;
  current_price: number | null;
  size: number;
  stop_loss: number | null;
  take_profit: number | null;
  exchange_stop_order_id: string | null;
  stop_loss_deadline: string | null;
  status: 'open' | 'closed' | 'cancelled';
  opened_at: string;
  closed_at: string | null;
  metadata: string | null;
}

export interface Trade {
  id: number;
  position_id: number | null;
  exchange_order_id: string | null;
  action: 'buy' | 'sell' | 'stop_loss' | 'take_profit' | 'emergency_liquidation';
  price: number;
  size: number;
  fee: number;
  pnl: number | null;
  reasoning: string | null;
  ai_model: string | null;
  ai_cost: number | null;
  timestamp: string;
}

export function getOpenPositions(): Position[] {
  return getDb().prepare('SELECT * FROM positions WHERE status = ?').all('open') as Position[];
}

export function getPositionById(id: number): Position | null {
  return (getDb().prepare('SELECT * FROM positions WHERE id = ?').get(id) as Position) ?? null;
}

export function insertPosition(p: Omit<Position, 'id' | 'opened_at' | 'closed_at'>): number {
  const result = getDb().prepare(`
    INSERT INTO positions (symbol, side, strategy, entry_price, current_price, size,
      stop_loss, take_profit, exchange_stop_order_id, stop_loss_deadline, status, metadata)
    VALUES (@symbol, @side, @strategy, @entry_price, @current_price, @size,
      @stop_loss, @take_profit, @exchange_stop_order_id, @stop_loss_deadline, @status, @metadata)
  `).run(p);
  return result.lastInsertRowid as number;
}

export function updatePositionPrice(id: number, currentPrice: number): void {
  getDb().prepare('UPDATE positions SET current_price = ? WHERE id = ?').run(currentPrice, id);
}

export function updatePositionStopOrder(id: number, orderId: string): void {
  getDb().prepare('UPDATE positions SET exchange_stop_order_id = ? WHERE id = ?').run(orderId, id);
}

export function updatePositionSize(id: number, newSize: number): void {
  getDb().prepare('UPDATE positions SET size = ? WHERE id = ?').run(newSize, id);
}

export function updatePositionMeta(id: number, metadata: string): void {
  getDb().prepare('UPDATE positions SET metadata = ? WHERE id = ?').run(metadata, id);
}

export function updatePositionStop(id: number, stopLoss: number): void {
  getDb().prepare('UPDATE positions SET stop_loss = ? WHERE id = ?').run(stopLoss, id);
}

export function closePosition(id: number): void {
  getDb().prepare("UPDATE positions SET status = 'closed', closed_at = datetime('now') WHERE id = ?").run(id);
}

export function insertTrade(t: Omit<Trade, 'id' | 'timestamp'>): number {
  const result = getDb().prepare(`
    INSERT OR IGNORE INTO trades (position_id, exchange_order_id, action, price, size,
      fee, pnl, reasoning, ai_model, ai_cost)
    VALUES (@position_id, @exchange_order_id, @action, @price, @size,
      @fee, @pnl, @reasoning, @ai_model, @ai_cost)
  `).run(t);
  return result.lastInsertRowid as number;
}

export function getTradesForPosition(positionId: number): Trade[] {
  return getDb().prepare('SELECT * FROM trades WHERE position_id = ? ORDER BY timestamp ASC').all(positionId) as Trade[];
}

export function getRecentTrades(limit = 50): Trade[] {
  return getDb().prepare('SELECT * FROM trades ORDER BY timestamp DESC LIMIT ?').all(limit) as Trade[];
}

// ─── Signal helpers ──────────────────────────────────────────────────────────

export interface Signal {
  id?: number;
  symbol: string;
  timeframe: string;
  rsi?: number;
  macd_line?: number;
  macd_signal?: number;
  macd_histogram?: number;
  bb_upper?: number;
  bb_lower?: number;
  bb_middle?: number;
  atr?: number;
  adx?: number;
  regime?: 'trending' | 'ranging' | 'volatile';
}

export function insertSignal(s: Signal): void {
  getDb().prepare(`
    INSERT INTO signals (symbol, timeframe, rsi, macd_line, macd_signal, macd_histogram,
      bb_upper, bb_lower, bb_middle, atr, adx, regime)
    VALUES (@symbol, @timeframe, @rsi, @macd_line, @macd_signal, @macd_histogram,
      @bb_upper, @bb_lower, @bb_middle, @atr, @adx, @regime)
  `).run(s);
}

export function purgeOldSignals(daysToKeep = 30): number {
  const result = getDb().prepare(
    "DELETE FROM signals WHERE timestamp < datetime('now', ?)"
  ).run(`-${daysToKeep} days`);
  return result.changes;
}

// ─── Survival log helpers ────────────────────────────────────────────────────

export interface SurvivalLogEntry {
  date: string;
  starting_balance: number;
  ending_balance: number;
  peak_balance: number;
  drawdown_pct: number;
  tier: 'normal' | 'cautious' | 'critical' | 'stopped';
  api_costs_usd: number;
  ai_costs_usd: number;
  circuit_breaker_triggered: number;
  notes?: string;
}

export function upsertSurvivalLog(entry: SurvivalLogEntry): void {
  getDb().prepare(`
    INSERT INTO survival_log (date, starting_balance, ending_balance, peak_balance,
      drawdown_pct, tier, api_costs_usd, ai_costs_usd, circuit_breaker_triggered, notes)
    VALUES (@date, @starting_balance, @ending_balance, @peak_balance,
      @drawdown_pct, @tier, @api_costs_usd, @ai_costs_usd, @circuit_breaker_triggered, @notes)
    ON CONFLICT(date) DO UPDATE SET
      ending_balance = excluded.ending_balance,
      peak_balance = excluded.peak_balance,
      drawdown_pct = excluded.drawdown_pct,
      tier = excluded.tier,
      api_costs_usd = excluded.api_costs_usd,
      ai_costs_usd = excluded.ai_costs_usd,
      circuit_breaker_triggered = excluded.circuit_breaker_triggered,
      notes = excluded.notes
  `).run(entry);
}

export function getSurvivalLog(days = 30): SurvivalLogEntry[] {
  return getDb().prepare(
    "SELECT * FROM survival_log WHERE date >= date('now', ?) ORDER BY date DESC"
  ).all(`-${days} days`) as SurvivalLogEntry[];
}

export function getLatestSurvivalLog(): SurvivalLogEntry | null {
  return (getDb().prepare('SELECT * FROM survival_log ORDER BY date DESC LIMIT 1').get() as SurvivalLogEntry) ?? null;
}

// ─── OHLCV cache helpers ─────────────────────────────────────────────────────

export interface OHLCVCandle {
  symbol: string;
  timeframe: string;
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function insertOHLCVBatch(candles: OHLCVCandle[]): number {
  const stmt = getDb().prepare(`
    INSERT OR IGNORE INTO ohlcv_cache (symbol, timeframe, timestamp, open, high, low, close, volume)
    VALUES (@symbol, @timeframe, @timestamp, @open, @high, @low, @close, @volume)
  `);
  const insertMany = getDb().transaction((rows: OHLCVCandle[]) => {
    for (const row of rows) stmt.run(row);
  });
  insertMany(candles);
  return candles.length;
}

export function getCachedOHLCV(symbol: string, timeframe: string, limit: number): OHLCVCandle[] {
  return getDb().prepare(
    'SELECT * FROM ohlcv_cache WHERE symbol = ? AND timeframe = ? ORDER BY timestamp DESC LIMIT ?'
  ).all(symbol, timeframe, limit) as OHLCVCandle[];
}

/**
 * Returns the most recent signal row for a symbol recorded at or before the given timestamp.
 * Accepts both ISO 8601 and SQLite datetime('now') format — datetime() normalises the input.
 * Used to recover entry RSI/MACD for postmortem analysis.
 */
export function getLastSignalForSymbol(
  symbol: string,
  atOrBeforeIso: string
): Signal | null {
  return (
    getDb()
      .prepare(
        `SELECT * FROM signals
         WHERE symbol = ? AND timestamp <= datetime(?)
         ORDER BY timestamp DESC
         LIMIT 1`
      )
      .get(symbol, atOrBeforeIso) as Signal
  ) ?? null;
}
