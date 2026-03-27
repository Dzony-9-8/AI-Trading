import type Database from 'better-sqlite3';
import { log } from '../logger';

export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        side TEXT CHECK(side IN ('long', 'short', 'spot')) NOT NULL,
        strategy TEXT NOT NULL,
        entry_price REAL NOT NULL,
        current_price REAL,
        size REAL NOT NULL,
        stop_loss REAL,
        take_profit REAL,
        exchange_stop_order_id TEXT,
        stop_loss_deadline TEXT,
        status TEXT CHECK(status IN ('open', 'closed', 'cancelled')) NOT NULL DEFAULT 'open',
        opened_at TEXT NOT NULL DEFAULT (datetime('now')),
        closed_at TEXT,
        metadata TEXT
      );

      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        position_id INTEGER REFERENCES positions(id),
        exchange_order_id TEXT UNIQUE,
        action TEXT CHECK(action IN ('buy', 'sell', 'stop_loss', 'take_profit', 'emergency_liquidation')) NOT NULL,
        price REAL NOT NULL,
        size REAL NOT NULL,
        fee REAL NOT NULL DEFAULT 0,
        pnl REAL,
        reasoning TEXT,
        ai_model TEXT,
        ai_cost REAL,
        timestamp TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        rsi REAL,
        macd_line REAL,
        macd_signal REAL,
        macd_histogram REAL,
        bb_upper REAL,
        bb_lower REAL,
        bb_middle REAL,
        atr REAL,
        adx REAL,
        regime TEXT CHECK(regime IN ('trending', 'ranging', 'volatile')),
        timestamp TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_signals_symbol_time ON signals(symbol, timestamp);
      CREATE INDEX IF NOT EXISTS idx_trades_position ON trades(position_id);
      CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);

      CREATE TABLE IF NOT EXISTS survival_log (
        date TEXT PRIMARY KEY,
        starting_balance REAL,
        ending_balance REAL,
        peak_balance REAL,
        drawdown_pct REAL,
        tier TEXT CHECK(tier IN ('normal', 'cautious', 'critical', 'stopped')),
        api_costs_usd REAL NOT NULL DEFAULT 0,
        ai_costs_usd REAL NOT NULL DEFAULT 0,
        circuit_breaker_triggered INTEGER NOT NULL DEFAULT 0,
        notes TEXT
      );

      CREATE TABLE IF NOT EXISTS ohlcv_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        open REAL NOT NULL,
        high REAL NOT NULL,
        low REAL NOT NULL,
        close REAL NOT NULL,
        volume REAL NOT NULL,
        UNIQUE(symbol, timeframe, timestamp)
      );

      CREATE INDEX IF NOT EXISTS idx_ohlcv_symbol_tf_time ON ohlcv_cache(symbol, timeframe, timestamp);

      CREATE TABLE IF NOT EXISTS ai_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        context TEXT NOT NULL,
        reasoning TEXT NOT NULL,
        decision TEXT NOT NULL,
        model TEXT NOT NULL,
        tokens_used INTEGER,
        cost_usd REAL,
        confidence REAL,
        timestamp TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    version: 2,
    sql: `
      -- Add tp1_hit column to positions for tracking partial take-profit state
      ALTER TABLE positions ADD COLUMN tp1_hit INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 3,
    sql: `
      CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp DESC);
    `,
  },
];

export function runMigrations(db: Database.Database): void {
  // Create schema_version table if it doesn't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const getVersion = db.prepare('SELECT MAX(version) as v FROM schema_version');
  const row = getVersion.get() as { v: number | null };
  const currentVersion = row.v ?? 0;

  const pending = MIGRATIONS.filter(m => m.version > currentVersion);
  if (pending.length === 0) return;

  for (const migration of pending) {
    try {
      db.transaction(() => {
        db.exec(migration.sql);
        db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(migration.version);
      })();
    } catch (e) {
      const msg = (e as Error).message.toLowerCase();
      // Migration 2 adds tp1_hit which may already exist in DBs created when
      // migration 1's CREATE TABLE included it. Mark it applied and continue.
      if (migration.version === 2 && msg.includes('duplicate column')) {
        log.warn('Migration 2: tp1_hit column already exists — marking as applied', {
          version: migration.version,
        });
        db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(migration.version);
      } else {
        throw e; // Re-throw anything unexpected
      }
    }
  }
}
