import { log } from '../logger';
import type { IExchange, OHLCV, Ticker, Balance, OrderResult, SymbolFilters, OpenOrder } from './index';

interface PaperOrder {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit' | 'stop' | 'oco';
  size: number;
  price: number;
  status: 'open' | 'closed' | 'cancelled';
  timestamp: number;
}

const SLIPPAGE = 0.0005; // 0.05% market impact

/**
 * PaperExchange — simulates fills for paper trading and backtesting.
 * Fills:
 *   - Market orders: at next available price (set via setCurrentPrice)
 *   - Limit buys: when candle low <= limit price
 *   - Stop sells: when candle low <= stop price (fills at stop price)
 */
export class PaperExchange implements IExchange {
  public readonly isPaper = true;
  private balance: Balance;
  private pendingOrders: Map<string, PaperOrder> = new Map();
  private currentPrices: Map<string, number> = new Map();
  private liveExchange: IExchange;

  constructor(liveExchange: IExchange, initialBalanceUSDT: number) {
    this.liveExchange = liveExchange;
    this.balance = {
      free: initialBalanceUSDT,
      used: 0,
      total: initialBalanceUSDT,
    };
  }

  /** Called by the market scanner to update current prices for fill simulation */
  setCurrentPrice(symbol: string, price: number): void {
    this.currentPrices.set(symbol, price);
  }

  /** Simulate candle-level fills (used by backtesting engine) */
  simulateCandle(symbol: string, candle: OHLCV): OrderResult[] {
    const fills: OrderResult[] = [];
    for (const [id, order] of this.pendingOrders) {
      if (order.symbol !== symbol || order.status !== 'open') continue;

      let filled = false;
      let fillPrice = 0;

      if (order.type === 'market') {
        // Buys fill slightly above open, sells slightly below (market impact)
        fillPrice = order.side === 'buy'
          ? candle.open * (1 + SLIPPAGE)
          : candle.open * (1 - SLIPPAGE);
        filled = true;
      } else if (order.type === 'limit' && order.side === 'buy') {
        if (candle.low <= order.price) {
          fillPrice = order.price;
          filled = true;
        }
      } else if (order.type === 'limit' && order.side === 'sell') {
        if (candle.high >= order.price) {
          fillPrice = order.price;
          filled = true;
        }
      } else if (order.type === 'stop' && order.side === 'sell') {
        if (candle.low <= order.price) {
          fillPrice = order.price;
          filled = true;
        }
      }

      if (filled) {
        order.status = 'closed';
        this.pendingOrders.set(id, order);
        this.applyFill(order.side, order.size, fillPrice);

        fills.push({
          exchangeOrderId: id,
          symbol,
          side: order.side,
          type: order.type as OrderResult['type'],
          price: fillPrice,
          size: order.size,
          status: 'closed',
          fee: fillPrice * order.size * 0.001, // 0.1% Binance fee
          timestamp: candle.timestamp,
        });

        log.debug('Paper fill', { symbol, side: order.side, price: fillPrice, size: order.size });
      }
    }
    return fills;
  }

  async getTicker(symbol: string): Promise<Ticker> {
    return this.liveExchange.getTicker(symbol);
  }

  async getOHLCV(symbol: string, timeframe: string, limit: number): Promise<OHLCV[]> {
    return this.liveExchange.getOHLCV(symbol, timeframe, limit);
  }

  async getBalance(): Promise<Balance> {
    return { ...this.balance };
  }

  async getOpenOrders(symbol?: string): Promise<OpenOrder[]> {
    const orders = Array.from(this.pendingOrders.values()).filter(
      o => o.status === 'open' && (!symbol || o.symbol === symbol)
    );
    return orders.map(o => ({
      exchangeOrderId: o.id,
      symbol: o.symbol,
      side: o.side,
      type: o.type,
      price: o.price,
      size: o.size,
      filled: 0,
      status: o.status,
      timestamp: o.timestamp,
    }));
  }

  async placeOrder(params: {
    symbol: string;
    side: 'buy' | 'sell';
    type: 'market' | 'limit';
    size: number;
    price?: number;
  }): Promise<OrderResult> {
    const price = params.price ?? this.currentPrices.get(params.symbol) ?? 0;
    const id = `paper-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    // For market orders, compute the slipped fill price upfront so it can be
    // reused for applyFill, fee calculation, and the returned receipt.
    const fillPrice = params.type === 'market'
      ? (params.side === 'buy' ? price * (1 + SLIPPAGE) : price * (1 - SLIPPAGE))
      : price;

    const order: PaperOrder = {
      id,
      symbol: params.symbol,
      side: params.side,
      type: params.type,
      size: params.size,
      price: fillPrice,
      status: params.type === 'market' ? 'closed' : 'open',
      timestamp: Date.now(),
    };

    if (params.type === 'market') {
      this.applyFill(params.side, params.size, fillPrice);
    } else {
      // Reserve funds for limit buy
      if (params.side === 'buy') {
        const cost = params.size * price;
        this.balance.free -= cost;
        this.balance.used += cost;
      }
      this.pendingOrders.set(id, order);
    }

    log.info('[PAPER] Order placed', {
      symbol: params.symbol,
      side: params.side,
      type: params.type,
      size: params.size,
      price: fillPrice,
      id,
    });

    return {
      exchangeOrderId: id,
      symbol: params.symbol,
      side: params.side,
      type: params.type,
      price: fillPrice,
      size: params.size,
      status: order.status,
      fee: fillPrice * params.size * 0.001,
      timestamp: Date.now(),
    };
  }

  async placeOCO(params: {
    symbol: string;
    side: 'sell';
    size: number;
    price: number;
    stopPrice: number;
    stopLimitPrice: number;
  }): Promise<OrderResult> {
    // Register as a stop order for simulation
    const id = `paper-oco-${Date.now()}`;
    this.pendingOrders.set(id, {
      id,
      symbol: params.symbol,
      side: 'sell',
      type: 'stop',
      size: params.size,
      price: params.stopPrice,
      status: 'open',
      timestamp: Date.now(),
    });

    log.info('[PAPER] OCO placed', { symbol: params.symbol, stopPrice: params.stopPrice });

    return {
      exchangeOrderId: id,
      symbol: params.symbol,
      side: 'sell',
      type: 'oco',
      price: params.stopPrice,
      size: params.size,
      status: 'open',
      timestamp: Date.now(),
    };
  }

  async cancelOrder(_symbol: string, orderId: string): Promise<void> {
    const order = this.pendingOrders.get(orderId);
    if (order) {
      order.status = 'cancelled';
      // Release reserved funds
      if (order.side === 'buy' && order.type === 'limit') {
        const cost = order.size * order.price;
        this.balance.free += cost;
        this.balance.used -= cost;
      }
    }
    log.info('[PAPER] Order cancelled', { orderId });
  }

  async getSymbolFilters(symbol: string): Promise<SymbolFilters> {
    return this.liveExchange.getSymbolFilters(symbol);
  }

  async hasWithdrawalPermission(): Promise<boolean> {
    return false;
  }

  private applyFill(side: 'buy' | 'sell', size: number, price: number): void {
    const cost = size * price;
    const fee = cost * 0.001;

    if (side === 'buy') {
      this.balance.free -= cost + fee;
      this.balance.total -= fee;
    } else {
      this.balance.free += cost - fee;
      this.balance.total -= fee;
    }
  }
}
