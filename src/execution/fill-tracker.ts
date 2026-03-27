import { log } from '../logger';
import { getOpenPositions, getTradesForPosition, insertTrade, closePosition } from '../data/db';
import type { IExchange } from '../exchange/index';

/**
 * On startup: reconcile our internal position records against live exchange orders.
 * Inserts any fills we missed (e.g., stop-loss triggered while bot was offline).
 * Prevents duplicate stop-loss orders on restart.
 */
export async function reconcileOnStartup(exchange: IExchange): Promise<void> {
  if (exchange.isPaper) {
    log.info('Paper mode — skipping fill reconciliation');
    return;
  }

  log.info('Reconciling open positions against exchange (periodic + startup)...');

  const openPositions = getOpenPositions();
  if (openPositions.length === 0) {
    log.info('No open positions to reconcile');
    return;
  }

  let reconciled = 0;
  let closed = 0;

  for (const position of openPositions) {
    try {
      // Get all our recorded trade order IDs for this position
      const knownTrades = getTradesForPosition(position.id);
      const knownOrderIds = new Set(knownTrades.map(t => t.exchange_order_id).filter(Boolean));

      // Check if OCO stop was triggered while we were offline
      if (position.exchange_stop_order_id) {
        const openOrders = await exchange.getOpenOrders(position.symbol);
        const stopOrderStillOpen = openOrders.some(
          o => o.exchangeOrderId === position.exchange_stop_order_id
        );

        if (!stopOrderStillOpen) {
          // OCO was triggered — position likely closed
          log.info('Stop order no longer open — position may have been closed offline', {
            positionId: position.id,
            symbol: position.symbol,
            stopOrderId: position.exchange_stop_order_id,
          });

          // Get current price as approximate exit price
          const ticker = await exchange.getTicker(position.symbol);
          const exitPrice = ticker.last;
          const entryTrade = knownTrades[0];
          const entryPrice = entryTrade?.price ?? position.entry_price;
          const pnl = (exitPrice - entryPrice) * position.size;

          if (!knownOrderIds.has(position.exchange_stop_order_id)) {
            insertTrade({
              position_id: position.id,
              exchange_order_id: position.exchange_stop_order_id,
              action: 'stop_loss',
              price: exitPrice,
              size: position.size,
              fee: 0,
              pnl,
              reasoning: 'Stop order triggered while bot was not monitoring — auto-reconciled',
              ai_model: null,
              ai_cost: null,
            });
          }

          closePosition(position.id);
          closed++;
          reconciled++;
        }
      }
    } catch (e) {
      log.warn('Failed to reconcile position', {
        positionId: position.id,
        error: (e as Error).message,
      });
    }
  }

  log.info('Reconciliation complete', {
    checked: openPositions.length,
    reconciled,
    closedOffline: closed,
  });
}
