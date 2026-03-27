import type { OHLCV } from '../exchange/index';
import type { GenesisConfig } from '../config';

export type SurvivalTier = 'normal' | 'cautious' | 'critical' | 'stopped';
export type MarketRegime = 'trending' | 'ranging' | 'volatile' | 'unknown';

export interface CandleBuffer {
  candles: OHLCV[];   // Ordered oldest → newest
  maxSize: number;
}

interface AppState {
  // Balance
  balance: number;
  initialBalance: number;
  peakBalance: number;
  dailyStartBalance: number;

  // Tier
  tier: SurvivalTier;

  // Candle rolling buffers per symbol per timeframe
  candleBuffers: Map<string, CandleBuffer>; // key: `${symbol}:${timeframe}`

  // Market regime per symbol
  regimes: Map<string, MarketRegime>;

  // Runtime flags
  paused: boolean;
  pausedUntil: Date | null;
  initialized: boolean;

  // API error tracking (ring buffer of last 20 results)
  apiResults: boolean[]; // true = success, false = error

  // AI daily spend
  aiSpendToday: number;
  aiSpendDate: string; // YYYY-MM-DD

  // Current active strategy per symbol
  activeStrategies: Map<string, string>;
}

let state: AppState | null = null;

export function initState(config: GenesisConfig, initialBalance: number): void {
  const buffers = new Map<string, CandleBuffer>();
  const regimes = new Map<string, MarketRegime>();
  const activeStrategies = new Map<string, string>();

  for (const symbol of config.trading.symbols) {
    const key = `${symbol}:${config.trading.default_timeframe}`;
    buffers.set(key, { candles: [], maxSize: config.trading.candle_lookback });
    regimes.set(symbol, 'unknown');
    activeStrategies.set(symbol, config.strategies.enabled[0]);
  }

  state = {
    balance: initialBalance,
    initialBalance,
    peakBalance: initialBalance,
    dailyStartBalance: initialBalance,
    tier: 'normal',
    candleBuffers: buffers,
    regimes,
    paused: false,
    pausedUntil: null,
    initialized: true,
    apiResults: [],
    aiSpendToday: 0,
    aiSpendDate: new Date().toISOString().slice(0, 10),
    activeStrategies,
  };
}

export function getState(): AppState {
  if (!state) throw new Error('State not initialized. Call initState() first.');
  return state;
}

// ─── Balance ─────────────────────────────────────────────────────────────────

export function updateBalance(newBalance: number): void {
  const s = getState();
  s.balance = newBalance;
  if (newBalance > s.peakBalance) s.peakBalance = newBalance;
}

export function getBalance(): number {
  return getState().balance;
}

export function getDailyPnLPct(): number {
  const s = getState();
  if (s.dailyStartBalance === 0) return 0;
  return (s.balance - s.dailyStartBalance) / s.dailyStartBalance;
}

export function getDrawdownFromPeak(): number {
  const s = getState();
  if (s.peakBalance === 0) return 0;
  return (s.balance - s.peakBalance) / s.peakBalance;
}

export function resetDailyBalance(): void {
  getState().dailyStartBalance = getState().balance;
}

// ─── Tier ────────────────────────────────────────────────────────────────────

export function getTier(): SurvivalTier {
  return getState().tier;
}

export function setTier(tier: SurvivalTier): void {
  getState().tier = tier;
}

// ─── Candle buffers ──────────────────────────────────────────────────────────

export function appendCandle(symbol: string, timeframe: string, candle: OHLCV): void {
  const key = `${symbol}:${timeframe}`;
  const s = getState();
  let buf = s.candleBuffers.get(key);
  if (!buf) {
    buf = { candles: [], maxSize: 200 };
    s.candleBuffers.set(key, buf);
  }

  // Avoid duplicates by timestamp
  if (buf.candles.length > 0 && buf.candles[buf.candles.length - 1].timestamp === candle.timestamp) {
    buf.candles[buf.candles.length - 1] = candle; // Replace last (in-progress candle)
    return;
  }

  buf.candles.push(candle);
  if (buf.candles.length > buf.maxSize) buf.candles.shift();
}

export function getCandles(symbol: string, timeframe: string): OHLCV[] {
  const key = `${symbol}:${timeframe}`;
  return getState().candleBuffers.get(key)?.candles ?? [];
}

export function seedCandles(symbol: string, timeframe: string, candles: OHLCV[]): void {
  const key = `${symbol}:${timeframe}`;
  const s = getState();
  const maxSize = s.candleBuffers.get(key)?.maxSize ?? 200;
  s.candleBuffers.set(key, {
    candles: candles.slice(-maxSize),
    maxSize,
  });
}

// ─── Market regime ────────────────────────────────────────────────────────────

export function setRegime(symbol: string, regime: MarketRegime): void {
  getState().regimes.set(symbol, regime);
}

export function getRegime(symbol: string): MarketRegime {
  return getState().regimes.get(symbol) ?? 'unknown';
}

// ─── Pause ───────────────────────────────────────────────────────────────────

export function setPaused(until: Date | null): void {
  const s = getState();
  s.paused = until !== null;
  s.pausedUntil = until;
}

export function isPaused(): boolean {
  const s = getState();
  if (!s.paused) return false;
  if (s.pausedUntil && new Date() >= s.pausedUntil) {
    s.paused = false;
    s.pausedUntil = null;
    return false;
  }
  return true;
}

// ─── API error tracking ───────────────────────────────────────────────────────

export function recordApiResult(success: boolean): void {
  const s = getState();
  s.apiResults.push(success);
  if (s.apiResults.length > 20) s.apiResults.shift();
}

export function getApiErrorRate(): number {
  const s = getState();
  if (s.apiResults.length === 0) return 0;
  const errors = s.apiResults.filter(r => !r).length;
  return errors / s.apiResults.length;
}

// ─── AI spend tracking ────────────────────────────────────────────────────────

export function recordAiSpend(costUsd: number): void {
  const s = getState();
  const today = new Date().toISOString().slice(0, 10);
  if (today !== s.aiSpendDate) {
    s.aiSpendToday = 0;
    s.aiSpendDate = today;
  }
  s.aiSpendToday += costUsd;
}

export function getAiSpendToday(): number {
  const s = getState();
  const today = new Date().toISOString().slice(0, 10);
  if (today !== s.aiSpendDate) return 0;
  return s.aiSpendToday;
}

// ─── Active strategy ─────────────────────────────────────────────────────────

export function setActiveStrategy(symbol: string, strategy: string): void {
  getState().activeStrategies.set(symbol, strategy);
}

export function getActiveStrategy(symbol: string): string {
  return getState().activeStrategies.get(symbol) ?? 'momentum';
}
