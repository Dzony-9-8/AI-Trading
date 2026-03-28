/**
 * External signal queue — receives signals from webhooks (TradingView, etc.)
 * and hands them off to the market scanner loop each tick.
 */

export interface ExternalSignal {
  symbol: string;
  action: 'enter_long' | 'exit';
  strategy: string;
  confidence: number;
  price?: number;
  source: string;
  receivedAt: number;
}

const queue: ExternalSignal[] = [];

export function pushExternalSignal(signal: ExternalSignal): void {
  queue.push(signal);
}

/** Drain and return all queued signals (clears the queue). */
export function drainExternalSignals(): ExternalSignal[] {
  return queue.splice(0);
}
