import * as https from 'https';
import { log } from '../logger';

const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ENABLED = Boolean(TOKEN && CHAT_ID);

export function telegramEnabled(): boolean {
  return ENABLED;
}

/**
 * Send a message to your Telegram chat.
 * Silent no-op if TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not set.
 * Never throws — alerts are best-effort and must never crash the bot.
 *
 * Supports basic HTML: <b>bold</b>  <i>italic</i>  <code>monospace</code>
 */
export async function sendAlert(message: string): Promise<void> {
  if (!ENABLED) return;

  const body = JSON.stringify({
    chat_id: CHAT_ID,
    text: message,
    parse_mode: 'HTML',
  });

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${TOKEN}/sendMessage`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume(); // discard response body
        resolve();
      }
    );

    req.on('error', (err) => {
      log.debug('Telegram send failed', { error: err.message });
      resolve(); // never reject
    });

    req.setTimeout(5000, () => {
      req.destroy();
      resolve();
    });

    req.write(body);
    req.end();
  });
}

/** Pre-built alert formatters */
export const alerts = {
  tradeOpened: (symbol: string, strategy: string, side: string, price: number, size: number, stopLoss?: number, takeProfit?: number, sentiment?: { label: string; score: number }): string =>
    [
      `🟢 <b>TRADE OPENED</b>`,
      `<b>${symbol}</b> · ${strategy.toUpperCase()} · ${side.toUpperCase()}`,
      `Entry: <code>$${price.toFixed(2)}</code>  Size: <code>${size.toFixed(6)}</code>`,
      stopLoss   ? `Stop:  <code>$${stopLoss.toFixed(2)}</code>` : '',
      takeProfit ? `TP:    <code>$${takeProfit.toFixed(2)}</code>` : '',
      sentiment  ? `📰 Sentiment: ${sentiment.label.charAt(0).toUpperCase() + sentiment.label.slice(1)} (${sentiment.score > 0 ? '+' : ''}${sentiment.score})` : '',
    ].filter(Boolean).join('\n'),

  tradeClosed: (symbol: string, strategy: string, action: string, price: number, pnl: number): string => {
    const emoji = pnl >= 0 ? '✅' : '❌';
    const pnlStr = `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`;
    return [
      `${emoji} <b>TRADE CLOSED</b>`,
      `<b>${symbol}</b> · ${strategy.toUpperCase()} · ${action.toUpperCase()}`,
      `Exit: <code>$${price.toFixed(2)}</code>  PnL: <code>${pnlStr}</code>`,
    ].join('\n');
  },

  partialClose: (symbol: string, price: number, pnl: number): string =>
    `🎯 <b>TP1 HIT</b> — <b>${symbol}</b>\nClosed 50% at <code>$${price.toFixed(2)}</code>  PnL: <code>+$${pnl.toFixed(2)}</code>\nStop moved to breakeven.`,

  circuitBreaker: (event: string): string =>
    `⚠️ <b>CIRCUIT BREAKER</b>: ${event.replace(/_/g, ' ').toUpperCase()}`,

  tierChange: (from: string, to: string, balance: number): string =>
    `🔴 <b>TIER CHANGE</b>: ${from.toUpperCase()} → ${to.toUpperCase()}\nBalance: <code>$${balance.toFixed(2)}</code>`,

  fearGreed: (value: number, label: string): string =>
    `📊 <b>Fear &amp; Greed</b>: ${value} (${label})`,
};
