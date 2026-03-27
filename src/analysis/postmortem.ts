import { getPositionById, getTradesForPosition } from '../data/db';
import { log } from '../logger';

/**
 * Trade classification tags for the postmortem.
 *
 *   TRUE_POSITIVE    — Setup triggered and the trade was profitable
 *   FALSE_POSITIVE   — Setup triggered but the trade stopped out for a loss
 *   REGIME_MISMATCH  — Stopped out in < 2h (very premature, likely a timing issue)
 *   EARLY_EXIT       — Hit take-profit before the full move played out
 *   BREAKEVEN        — Result within ±0.5% of entry (no meaningful outcome)
 */
export type PostmortemTag =
  | 'TRUE_POSITIVE'
  | 'FALSE_POSITIVE'
  | 'REGIME_MISMATCH'
  | 'EARLY_EXIT'
  | 'BREAKEVEN';

export interface PostmortemResult {
  positionId: number;
  symbol: string;
  strategy: string;
  openedAt: string;    // ISO timestamp — used to look up entry indicators
  tag: PostmortemTag;
  entryPrice: number;
  exitPrice: number;
  holdDurationMs: number;
  holdDurationHuman: string;
  pnl: number;
  pnlPct: number;
  entryReasoning: string;
  exitReasoning: string;
  lesson: string;
}

function humanDuration(ms: number): string {
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const LESSONS: Record<PostmortemTag, string> = {
  TRUE_POSITIVE:
    'Setup worked as expected. Reinforce the entry conditions that triggered this.',
  FALSE_POSITIVE:
    'Price reversed after entry. Check whether volume confirmed the signal and verify higher-timeframe trend alignment.',
  REGIME_MISMATCH:
    'Stopped out in under 2 hours — entry was likely premature or market regime shifted instantly. ' +
    'Consider requiring a second confirmation candle before entering.',
  EARLY_EXIT:
    'Hit take-profit target early. Check if price continued higher — if so, consider a wider TP or switching to a trailing stop after TP1.',
  BREAKEVEN:
    'Near-zero result. The pattern may have been valid but lacked conviction. ' +
    'Consider waiting for stronger volume confirmation before entering.',
};

const EMOJI: Record<PostmortemTag, string> = {
  TRUE_POSITIVE:   '✅',
  FALSE_POSITIVE:  '❌',
  REGIME_MISMATCH: '⚠️',
  EARLY_EXIT:      '🎯',
  BREAKEVEN:       '➖',
};

/**
 * Classify a recently closed position and log a structured postmortem.
 *
 * @param positionId  ID of the position to analyse (must already be closed in DB)
 * @returns           PostmortemResult, or null if not enough data
 */
export function runPostmortem(positionId: number): PostmortemResult | null {
  try {
    const pos = getPositionById(positionId);
    if (!pos || pos.status !== 'closed') return null;

    const trades = getTradesForPosition(positionId);
    if (trades.length < 2) return null;

    // Find entry and exit trades
    const buyTrade = trades.find(t => t.action === 'buy');
    const closeTrade = trades
      .slice()
      .reverse()
      .find(t =>
        t.action === 'sell' ||
        t.action === 'stop_loss' ||
        t.action === 'take_profit' ||
        t.action === 'emergency_liquidation'
      );

    if (!buyTrade || !closeTrade) return null;

    const entryPrice = buyTrade.price;
    const exitPrice  = closeTrade.price;
    const totalPnl   = trades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
    const pnlPct     = ((exitPrice - entryPrice) / entryPrice) * 100;

    const entryTime = new Date(buyTrade.timestamp).getTime();
    const exitTime  = new Date(closeTrade.timestamp).getTime();
    const holdMs    = Math.max(0, exitTime - entryTime);

    // ── Classification ────────────────────────────────────────────────────────
    let tag: PostmortemTag;

    if (holdMs < 2 * 3_600_000 && totalPnl < 0) {
      // Stopped out in under 2 hours — bad timing / regime mismatch
      tag = 'REGIME_MISMATCH';
    } else if (closeTrade.action === 'take_profit') {
      tag = 'EARLY_EXIT';
    } else if (Math.abs(pnlPct) < 0.5) {
      tag = 'BREAKEVEN';
    } else if (totalPnl > 0) {
      tag = 'TRUE_POSITIVE';
    } else {
      tag = 'FALSE_POSITIVE';
    }

    const result: PostmortemResult = {
      positionId,
      symbol:              pos.symbol,
      strategy:            pos.strategy,
      openedAt:            pos.opened_at,
      tag,
      entryPrice,
      exitPrice,
      holdDurationMs:      holdMs,
      holdDurationHuman:   humanDuration(holdMs),
      pnl:                 totalPnl,
      pnlPct,
      entryReasoning:      buyTrade.reasoning   ?? '',
      exitReasoning:       closeTrade.reasoning ?? '',
      lesson:              LESSONS[tag],
    };

    // ── Structured log ────────────────────────────────────────────────────────
    const emoji  = EMOJI[tag];
    const pnlStr = `${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}`;
    const pctStr = `${pnlPct  >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`;

    log.info(
      `${emoji} POSTMORTEM [${pos.strategy.toUpperCase()}] ${pos.symbol} — ${tag}`,
      {
        pnl:    pnlStr,
        pct:    pctStr,
        held:   result.holdDurationHuman,
        entry:  `$${entryPrice.toFixed(2)}`,
        exit:   `$${exitPrice.toFixed(2)}`,
      }
    );
    log.info(`   → ${LESSONS[tag]}`);

    return result;
  } catch (e) {
    // Never crash the bot over a postmortem
    log.debug('Postmortem error', { positionId, error: (e as Error).message });
    return null;
  }
}
