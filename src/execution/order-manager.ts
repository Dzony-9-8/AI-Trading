import { getConfig } from '../config';
import { log } from '../logger';
import { insertPosition, insertTrade, closePosition, updatePositionStopOrder, getOpenPositions, getTradesForPosition, updatePositionSize, updatePositionMeta, updatePositionStop } from '../data/db';
import { validateTrade, getStopLossDeadline } from '../risk/engine';
import { getTier } from '../core/state';
import { recordApiResult } from '../core/state';
import type { IExchange } from '../exchange/index';

export interface PlaceOrderParams {
  symbol: string;
  side: 'buy' | 'sell';
  size: number;
  type: 'market' | 'limit';
  price?: number;
  stopLoss?: number;
  takeProfit?: number;
  strategy: string;
  reasoning: string;
  aiModel?: string;
  aiCost?: number;
}

export interface ClosePositionParams {
  positionId: number;
  symbol: string;
  size: number;
  currentPrice: number;
  action: 'sell' | 'stop_loss' | 'take_profit' | 'emergency_liquidation';
  reasoning: string;
}

/**
 * Central order execution layer. All exchange order calls go through here.
 * Validates against risk engine, persists to DB, tracks fills.
 */
export class OrderManager {
  private exchange: IExchange;

  constructor(exchange: IExchange) {
    this.exchange = exchange;
  }

  /**
   * Open a new position. Runs risk validation before placing order.
   */
  async openPosition(params: PlaceOrderParams): Promise<number | null> {
    const config = getConfig();
    const tier = getTier();

    // No new entries in critical or stopped tiers
    if (tier === 'critical' || tier === 'stopped') {
      log.warn('Order blocked — survival tier prevents new entries', { tier, symbol: params.symbol });
      return null;
    }

    // Adjust size for cautious tier
    let size = params.size;
    if (tier === 'cautious') {
      size *= 0.70;
      log.debug('Position size reduced for cautious tier', { original: params.size, adjusted: size });
    }

    // Validate through risk engine
    const ticker = await this.exchange.getTicker(params.symbol);
    const price = params.price ?? ticker.ask;

    const validation = await validateTrade({
      symbol: params.symbol,
      side: params.side,
      suggestedSize: size,
      price,
      exchange: this.exchange,
    });

    if (!validation.approved) {
      log.warn('Trade rejected by risk engine', { symbol: params.symbol, reason: validation.reason });
      return null;
    }

    const finalSize = validation.adjustedSize ?? size;

    try {
      // Place the entry order
      const order = await this.exchange.placeOrder({
        symbol: params.symbol,
        side: params.side,
        type: params.type,
        size: finalSize,
        price: params.type === 'limit' ? price : undefined,
      });
      recordApiResult(true);

      // Persist position to DB
      const stopLossDeadline = config.risk.always_use_stop_loss ? getStopLossDeadline() : null;
      const positionId = insertPosition({
        symbol: params.symbol,
        side: 'long', // Spot market — always long
        strategy: params.strategy,
        entry_price: order.price || price,
        current_price: order.price || price,
        size: finalSize,
        stop_loss: params.stopLoss ?? null,
        take_profit: params.takeProfit ?? null,
        exchange_stop_order_id: null,
        stop_loss_deadline: stopLossDeadline,
        status: 'open',
        metadata: null,
      });

      // Persist trade record
      insertTrade({
        position_id: positionId,
        exchange_order_id: order.exchangeOrderId,
        action: 'buy',
        price: order.price || price,
        size: finalSize,
        fee: order.fee ?? 0,
        pnl: null,
        reasoning: params.reasoning,
        ai_model: params.aiModel ?? null,
        ai_cost: params.aiCost ?? null,
      });

      // Set up partial take-profit metadata (TP1 = 1R, TP2 = full take-profit)
      if (params.stopLoss && params.takeProfit) {
        const entryPrice = order.price || price;
        const riskPerUnit = entryPrice - params.stopLoss;
        const tp1Price = entryPrice + riskPerUnit; // 1R — close 50% here, move stop to breakeven
        updatePositionMeta(positionId, JSON.stringify({
          tp1_price: tp1Price,
          tp1_hit: false,
          original_size: finalSize,
        }));
      }

      // Place OCO stop-loss on exchange if configured
      if (params.stopLoss && config.risk.use_exchange_native_stops) {
        await this.placeStopOrder(positionId, params.symbol, finalSize, params.stopLoss, params.takeProfit);
      }

      log.info('Position opened', {
        id: positionId,
        symbol: params.symbol,
        size: finalSize,
        price: order.price || price,
        strategy: params.strategy,
        paper: this.exchange.isPaper,
      });

      return positionId;
    } catch (e) {
      recordApiResult(false);
      log.error('Failed to open position', { symbol: params.symbol, error: (e as Error).message });
      return null;
    }
  }

  /**
   * Close an existing position (sell).
   */
  async closePosition(params: ClosePositionParams): Promise<boolean> {
    const config = getConfig();

    try {
      // For emergency liquidation — try limit first, then market
      if (params.action === 'emergency_liquidation' && config.survival.emergency_liquidation.method === 'limit_then_market') {
        return await this.emergencyClose(params);
      }

      const order = await this.exchange.placeOrder({
        symbol: params.symbol,
        side: 'sell',
        type: 'market',
        size: params.size,
      });
      recordApiResult(true);

      const entryTrade = getTradesForPosition(params.positionId)[0];
      const entryPrice = entryTrade?.price ?? params.currentPrice;
      const pnl = (params.currentPrice - entryPrice) * params.size - (order.fee ?? 0);

      insertTrade({
        position_id: params.positionId,
        exchange_order_id: order.exchangeOrderId,
        action: params.action,
        price: params.currentPrice,
        size: params.size,
        fee: order.fee ?? 0,
        pnl,
        reasoning: params.reasoning,
        ai_model: null,
        ai_cost: null,
      });

      closePosition(params.positionId);

      log.info('Position closed', {
        id: params.positionId,
        symbol: params.symbol,
        action: params.action,
        pnl: pnl.toFixed(2),
        paper: this.exchange.isPaper,
      });

      return true;
    } catch (e) {
      recordApiResult(false);
      log.error('Failed to close position', {
        positionId: params.positionId,
        symbol: params.symbol,
        error: (e as Error).message,
      });
      return false;
    }
  }

  /**
   * Close a fraction of an open position (partial take-profit).
   * Updates position size in DB. Does NOT close the position record.
   */
  async closePartialPosition(params: {
    positionId: number;
    symbol: string;
    closeSize: number;
    remainingSize: number;
    currentPrice: number;
    reasoning: string;
  }): Promise<boolean> {
    try {
      const order = await this.exchange.placeOrder({
        symbol: params.symbol,
        side: 'sell',
        type: 'market',
        size: params.closeSize,
      });
      recordApiResult(true);

      const entryTrade = getTradesForPosition(params.positionId)[0];
      const entryPrice = entryTrade?.price ?? params.currentPrice;
      const pnl = (params.currentPrice - entryPrice) * params.closeSize - (order.fee ?? 0);

      insertTrade({
        position_id: params.positionId,
        exchange_order_id: `${order.exchangeOrderId}-tp1`,
        action: 'take_profit',
        price: params.currentPrice,
        size: params.closeSize,
        fee: order.fee ?? 0,
        pnl,
        reasoning: params.reasoning,
        ai_model: null,
        ai_cost: null,
      });

      // Update position to reflect remaining size
      updatePositionSize(params.positionId, params.remainingSize);

      log.info('Partial close — TP1 hit', {
        id: params.positionId,
        symbol: params.symbol,
        closed: params.closeSize,
        remaining: params.remainingSize,
        pnl: pnl.toFixed(2),
        paper: this.exchange.isPaper,
      });

      return true;
    } catch (e) {
      recordApiResult(false);
      log.error('Failed to close partial position', {
        positionId: params.positionId,
        error: (e as Error).message,
      });
      return false;
    }
  }

  /**
   * Cancel all pending entry orders (not OCO stops).
   */
  async cancelPendingEntries(symbol?: string): Promise<void> {
    try {
      const openOrders = await this.exchange.getOpenOrders(symbol);
      recordApiResult(true);
      for (const order of openOrders) {
        if (order.side === 'buy') {
          await this.exchange.cancelOrder(order.symbol, order.exchangeOrderId);
          log.info('Pending entry cancelled', { symbol: order.symbol, orderId: order.exchangeOrderId });
        }
      }
    } catch (e) {
      recordApiResult(false);
      log.error('Failed to cancel pending entries', { error: (e as Error).message });
    }
  }

  /**
   * Emergency liquidation: limit sell → fallback to market after timeout.
   */
  private async emergencyClose(params: ClosePositionParams): Promise<boolean> {
    const config = getConfig();
    const timeoutMs = config.survival.emergency_liquidation.limit_timeout_minutes * 60 * 1000;

    log.warn('Emergency liquidation starting', { positionId: params.positionId, symbol: params.symbol });

    try {
      // Try limit order at bid price
      const ticker = await this.exchange.getTicker(params.symbol);
      const limitOrder = await this.exchange.placeOrder({
        symbol: params.symbol,
        side: 'sell',
        type: 'limit',
        size: params.size,
        price: ticker.bid,
      });

      // Wait for fill
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await sleep(10000); // Check every 10s
        const openOrders = await this.exchange.getOpenOrders(params.symbol);
        const stillOpen = openOrders.find(o => o.exchangeOrderId === limitOrder.exchangeOrderId);
        if (!stillOpen) {
          // Filled
          break;
        }
      }

      // Cancel limit and place market as fallback
      await this.exchange.cancelOrder(params.symbol, limitOrder.exchangeOrderId);
    } catch {
      // Continue to market order regardless
    }

    // Market fallback
    return this.closePosition({ ...params, action: 'emergency_liquidation' });
  }

  private async placeStopOrder(
    positionId: number,
    symbol: string,
    size: number,
    stopLoss: number,
    takeProfit?: number
  ): Promise<void> {
    try {
      if (takeProfit) {
        const ocoOrder = await this.exchange.placeOCO({
          symbol,
          side: 'sell',
          size,
          price: takeProfit,
          stopPrice: stopLoss,
          stopLimitPrice: stopLoss * 0.999, // 0.1% below stop
        });
        updatePositionStopOrder(positionId, ocoOrder.exchangeOrderId);
        log.info('OCO stop order placed on exchange', { positionId, stopLoss, takeProfit });
      } else {
        // Plain stop-limit order
        const stopOrder = await this.exchange.placeOrder({
          symbol,
          side: 'sell',
          type: 'limit',
          size,
          price: stopLoss * 0.999,
        });
        updatePositionStopOrder(positionId, stopOrder.exchangeOrderId);
        log.info('Stop order placed on exchange', { positionId, stopLoss });
      }
    } catch (e) {
      log.warn('Failed to place exchange stop order — will monitor locally', {
        positionId,
        error: (e as Error).message,
      });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
