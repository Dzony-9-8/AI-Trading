import ccxt from 'ccxt';
import { log } from '../logger';
import type { IExchange, OHLCV, Ticker, Balance, OrderResult, SymbolFilters, OpenOrder } from './index';

export class BinanceExchange implements IExchange {
  public readonly isPaper = false;
  private exchange: ccxt.binance;
  private symbolFiltersCache: Map<string, SymbolFilters> = new Map();

  constructor(apiKey: string, secret: string, sandbox = false) {
    this.exchange = new ccxt.binance({
      apiKey,
      secret,
      enableRateLimit: true,
      options: {
        defaultType: 'spot',
        adjustForTimeDifference: true,
        recvWindow: 60000,  // 60s tolerance — handles Windows clock drift
      },
    });

    if (sandbox) {
      this.exchange.setSandboxMode(true);
    }
  }

  /**
   * Must be called once before any authenticated request.
   * Fetches Binance server time and computes the local clock offset so
   * all signed requests use the correct timestamp regardless of Windows drift.
   */
  async syncTime(): Promise<void> {
    try {
      await this.exchange.loadTimeDifference();
      log.info('Binance time sync complete', {
        offsetMs: (this.exchange as any).options?.timeDifference ?? 0,
      });
    } catch (e) {
      log.warn('Binance time sync failed — proceeding anyway', { error: (e as Error).message });
    }
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const t = await this.exchange.fetchTicker(symbol);
    return {
      symbol: t.symbol,
      bid: t.bid ?? t.last ?? 0,
      ask: t.ask ?? t.last ?? 0,
      last: t.last ?? 0,
      timestamp: t.timestamp ?? Date.now(),
    };
  }

  async getOHLCV(symbol: string, timeframe: string, limit: number): Promise<OHLCV[]> {
    const raw = await this.exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
    return raw.map(([ts, open, high, low, close, volume]) => ({
      timestamp: ts as number,
      open: open as number,
      high: high as number,
      low: low as number,
      close: close as number,
      volume: volume as number,
    }));
  }

  async getBalance(): Promise<Balance> {
    const b = await this.exchange.fetchBalance();
    const usdt = b.USDT ?? { free: 0, used: 0, total: 0 };
    return {
      free: usdt.free ?? 0,
      used: usdt.used ?? 0,
      total: usdt.total ?? 0,
    };
  }

  async getOpenOrders(symbol?: string): Promise<OpenOrder[]> {
    const orders = symbol
      ? await this.exchange.fetchOpenOrders(symbol)
      : await this.exchange.fetchOpenOrders();

    return orders.map(o => ({
      exchangeOrderId: String(o.id),
      symbol: o.symbol,
      side: o.side as 'buy' | 'sell',
      type: o.type,
      price: o.price ?? 0,
      size: o.amount,
      filled: o.filled ?? 0,
      status: o.status ?? 'open',
      timestamp: o.timestamp ?? Date.now(),
    }));
  }

  async placeOrder(params: {
    symbol: string;
    side: 'buy' | 'sell';
    type: 'market' | 'limit';
    size: number;
    price?: number;
  }): Promise<OrderResult> {
    const filters = await this.getSymbolFilters(params.symbol);
    const roundedSize = this.roundToStepSize(params.size, filters.stepSize);

    if (roundedSize < filters.minQty) {
      throw new Error(`Order size ${roundedSize} < minQty ${filters.minQty} for ${params.symbol}`);
    }
    if (params.price && roundedSize * params.price < filters.minNotional) {
      throw new Error(`Order notional < minNotional ${filters.minNotional} for ${params.symbol}`);
    }

    const order = await this.exchange.createOrder(
      params.symbol,
      params.type,
      params.side,
      roundedSize,
      params.type === 'limit' ? params.price : undefined
    );

    log.info('Order placed', {
      symbol: params.symbol,
      side: params.side,
      type: params.type,
      size: roundedSize,
      price: order.price,
      id: order.id,
    });

    return {
      exchangeOrderId: String(order.id),
      symbol: order.symbol,
      side: order.side as 'buy' | 'sell',
      type: order.type as 'market' | 'limit',
      price: order.price ?? 0,
      size: order.amount,
      status: order.status as 'open' | 'closed' | 'cancelled',
      fee: order.fee?.cost,
      timestamp: order.timestamp ?? Date.now(),
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
    const filters = await this.getSymbolFilters(params.symbol);
    const size = this.roundToStepSize(params.size, filters.stepSize);

    // Binance OCO via private API call
    const result = await this.exchange.privatePostOrder({
      symbol: params.symbol.replace('/', ''),
      side: params.side.toUpperCase(),
      quantity: size,
      listClientOrderId: `lt-oco-${Date.now()}`,
      orderType: 'OCO',
      price: this.roundToTickSize(params.price, filters.tickSize),
      stopPrice: this.roundToTickSize(params.stopPrice, filters.tickSize),
      stopLimitPrice: this.roundToTickSize(params.stopLimitPrice, filters.tickSize),
      stopLimitTimeInForce: 'GTC',
    });

    const orderId = String(result.orderListId ?? result.listClientOrderId ?? Date.now());
    log.info('OCO order placed', { symbol: params.symbol, size, ...params });

    return {
      exchangeOrderId: orderId,
      symbol: params.symbol,
      side: 'sell',
      type: 'oco',
      price: params.stopPrice,
      size,
      status: 'open',
      timestamp: Date.now(),
    };
  }

  async cancelOrder(symbol: string, orderId: string): Promise<void> {
    await this.exchange.cancelOrder(orderId, symbol);
    log.info('Order cancelled', { symbol, orderId });
  }

  async getSymbolFilters(symbol: string): Promise<SymbolFilters> {
    if (this.symbolFiltersCache.has(symbol)) {
      return this.symbolFiltersCache.get(symbol)!;
    }

    const markets = await this.exchange.loadMarkets();
    const market = markets[symbol];
    if (!market) throw new Error(`Symbol not found: ${symbol}`);

    const filters: SymbolFilters = {
      minQty: market.limits?.amount?.min ?? 0.0001,
      maxQty: market.limits?.amount?.max ?? 1e9,
      stepSize: market.precision?.amount ? Math.pow(10, -(market.precision.amount as number)) : 0.0001,
      minNotional: (market.limits?.cost?.min as number) ?? 10,
      tickSize: market.precision?.price ? Math.pow(10, -(market.precision.price as number)) : 0.01,
    };

    this.symbolFiltersCache.set(symbol, filters);
    return filters;
  }

  async hasWithdrawalPermission(): Promise<boolean> {
    try {
      // /sapi/v1/account/apiRestrictions returns the actual API key permission flags.
      // canWithdraw on /api/v3/account is account-level KYC status — always true for
      // verified accounts regardless of what the API key is allowed to do.
      const restrictions = await this.exchange.sapiGetAccountApiRestrictions();
      return restrictions.enableWithdrawals === true;
    } catch {
      // If endpoint unavailable, fall back to account endpoint
      try {
        const account = await this.exchange.privateGetAccount();
        // permissions array is present on newer CCXT versions
        if (Array.isArray(account.permissions)) {
          return account.permissions.includes('WITHDRAWALS');
        }
      } catch { /* ignore */ }
      return false;
    }
  }

  private roundToStepSize(value: number, stepSize: number): number {
    const precision = Math.round(-Math.log10(stepSize));
    return parseFloat((Math.floor(value / stepSize) * stepSize).toFixed(precision));
  }

  private roundToTickSize(value: number, tickSize: number): number {
    const precision = Math.round(-Math.log10(tickSize));
    return parseFloat((Math.round(value / tickSize) * tickSize).toFixed(precision));
  }
}
