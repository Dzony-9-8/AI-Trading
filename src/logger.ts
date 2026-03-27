import * as fs from 'fs';
import * as path from 'path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  msg: string;
  data?: unknown;
}

const LOG_DIR  = path.resolve(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'bot.log');

// Only write INFO and above to file — DEBUG is terminal-only
const FILE_MIN_LEVEL: LogLevel = 'info';
const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

// Rotation: 50 MB max, keep 5 archives
const MAX_FILE_BYTES  = 50 * 1024 * 1024;   // 50 MB
const MAX_ARCHIVES    = 5;

// In-memory ring buffer for dashboard polling
const MAX_BUFFER = 1000;
const logBuffer: LogEntry[] = [];

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

/** Rotate if bot.log exceeds MAX_FILE_BYTES */
function rotateIfNeeded() {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const { size } = fs.statSync(LOG_FILE);
    if (size < MAX_FILE_BYTES) return;

    // Shift existing archives: .5 deleted, .4→.5, .3→.4 ... .1→.2
    for (let i = MAX_ARCHIVES; i >= 1; i--) {
      const src  = `${LOG_FILE}.${i}`;
      const dest = `${LOG_FILE}.${i + 1}`;
      if (fs.existsSync(src)) {
        if (i === MAX_ARCHIVES) fs.unlinkSync(src);
        else fs.renameSync(src, dest);
      }
    }
    fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch {
    // Never crash on rotation failure
  }
}

const COLORS: Record<LogLevel, string> = {
  debug: '\x1b[36m',  // cyan
  info:  '\x1b[32m',  // green
  warn:  '\x1b[33m',  // yellow
  error: '\x1b[31m',  // red
};
const GRAY  = '\x1b[90m';
const DIM   = '\x1b[2m';
const RESET = '\x1b[0m';

/** HH:MM:SS from local time */
function localTime(date: Date): string {
  return date.toTimeString().slice(0, 8);
}

/**
 * Format a data object as readable key=value pairs.
 *   { balance: 500.12, tier: 'normal' }  →  "  balance=500.12  tier=normal"
 */
function formatData(data: unknown): string {
  if (data === undefined || data === null) return '';
  if (typeof data !== 'object') return `  ${String(data)}`;

  const entries = Object.entries(data as Record<string, unknown>);
  if (entries.length === 0) return '';

  const pairs = entries
    .map(([k, v]) => {
      if (v === null || v === undefined) return null;
      if (typeof v === 'boolean') return `${k}=${v}`;
      if (typeof v === 'number') {
        const s = Number.isInteger(v) ? String(v) : v.toFixed(4).replace(/\.?0+$/, '');
        return `${k}=${s}`;
      }
      if (typeof v === 'string') return `${k}=${v}`;
      if (Array.isArray(v)) return `${k}=[${(v as unknown[]).join(',')}]`;
      return `${k}=${JSON.stringify(v)}`;
    })
    .filter(Boolean) as string[];

  return pairs.length > 0 ? `  ${pairs.join('  ')}` : '';
}

function write(level: LogLevel, msg: string, data?: unknown) {
  const now = new Date();
  const entry: LogEntry = { timestamp: now.toISOString(), level, msg, data };

  // Add to in-memory ring buffer (all levels — dashboard can filter)
  logBuffer.push(entry);
  if (logBuffer.length > MAX_BUFFER) logBuffer.shift();

  // Console: always print all levels
  const color   = COLORS[level];
  const time    = localTime(now);
  const lvl     = level.toUpperCase().padEnd(5);
  const dataStr = formatData(data);
  console.log(`${GRAY}${time}${RESET}  ${color}${lvl}${RESET}  ${msg}${DIM}${dataStr}${RESET}`);

  // File: INFO and above only, with rotation
  if (LEVEL_RANK[level] < LEVEL_RANK[FILE_MIN_LEVEL]) return;

  try {
    ensureLogDir();
    rotateIfNeeded();
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch {
    // Never crash on log failure
  }
}

export const log = {
  debug: (msg: string, data?: unknown) => write('debug', msg, data),
  info:  (msg: string, data?: unknown) => write('info',  msg, data),
  warn:  (msg: string, data?: unknown) => write('warn',  msg, data),
  error: (msg: string, data?: unknown) => write('error', msg, data),
};

export function getLogsSince(since: Date): LogEntry[] {
  return logBuffer.filter(e => new Date(e.timestamp) > since);
}

export function getRecentLogs(n = 100): LogEntry[] {
  return logBuffer.slice(-n);
}
