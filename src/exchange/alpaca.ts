import type {
  IExchange,
  OHLCV,
  Ticker,
  Balance,
  OpenOrder,
  OrderResult,
  SymbolFilters,
} from './index';

// ─── Alpaca API response types ─────────────────────────────────────────────────

interface AlpacaQuoteResponse {
  quote: {
    bp: number;  // bid price
    ap: number;  // ask price
    lp?: number; // last price (may be absent)
    t: string;   // timestamp ISO
  };
}

interface AlpacaTradeResponse {
  trade: {
    p: number; // price
    t: string; // timestamp ISO
  };
}

interface AlpacaBar {
  t: string; // ISO timestamp
  o: number; // open
  h: number; // high
  l: number; // low
  c: number; // close
  v: number; // volume
}

interface AlpacaBarsResponse {
  bars: AlpacaBar[];
  next_page_token?: string | null;
}

interface AlpacaAccount {
  cash: string;
  buying_power: string;
  portfolio_value: string;
}

interface AlpacaOrder {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: string;
  limit_price: string | null;
  stop_price: string | null;
  qty: string;
  filled_qty: string;
  status: string;
  created_at: string;
}

interface AlpacaAsset {
  fractionable: boolean;
  min_order_size?: string | null;
}

interface AlpacaClock {
  is_open: boolean;
}

// ─── Timeframe mapping ─────────────────────────────────────────────────────────

function mapTimeframe(tf: string): string {
  switch (tf) {
    case '1m':  return '1Min';
    case '5m':  return '5Min';
    case '15m': return '15Min';
    case '1h':  return '1Hour';
    case '4h':  return '4Hour';
    case '1d':  return '1Day';
    default:    return '1Hour';
  }
}

// ─── Order status mapping ──────────────────────────────────────────────────────

function mapOrderStatus(status: string): 'open' | 'closed' | 'cancelled' {
  switch (status) {
    case 'filled':           return 'closed';
    case 'canceled':
    case 'cancelled':
    case 'expired':
    case 'replaced':         return 'cancelled';
    default:                 return 'open'; // new, partially_filled, pending_new, etc.
  }
}

// ─── AlpacaExchange ────────────────────────────────────────────────────────────

export class AlpacaExchange implements IExchange {
  readonly isPaper: boolean;
  private baseUrl: string;
  private readonly dataUrl = 'https://data.alpaca.markets';
  private readonly apiKey: string;
  private readonly secretKey: string;

  constructor(apiKey: string, secretKey: string, paper: boolean) {
    this.apiKey    = apiKey;
    this.secretKey = secretKey;
    this.isPaper   = paper;
    this.baseUrl   = paper
      ? 'https://paper-api.alpaca.markets'
      : 'https://api.alpaca.markets';
  }

  // ── Internal HTTP helper ─────────────────────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    useDataUrl = false,
  ): Promise<T> {
    const base = useDataUrl ? this.dataUrl : this.baseUrl;
    const url  = `${base}${path}`;

    const res = await fetch(url, {
      method,
      headers: {
        'APCA-API-KEY-ID':     this.apiKey,
        'APCA-API-SECRET-KEY': this.secretKey,
        'Content-Type':        'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '<no body>');
      throw new Error(`Alpaca API error ${res.status} ${method} ${path}: ${text}`);
    }

    if (res.status === 204) return {} as T;
    return res.json() as Promise<T>;
  }

  // ── IExchange implementation ─────────────────────────────────────────────────

  async getTicker(symbol: string): Promise<Ticker> {
    // Try quotes first for bid/ask
    try {
      const data = await this.request<AlpacaQuoteResponse>(
        'GET',
        `/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest`,
        undefined,
        true,
      );

      const q = data.quote;
      const bid  = q.bp ?? 0;
      const ask  = q.ap ?? 0;

      // lp (last price) may be missing from quotes — fall through to trade if needed
      let last = q.lp ?? 0;

      if (last === 0) {
        // Fetch latest trade for last price
        try {
          const tradeData = await this.request<AlpacaTradeResponse>(
            'GET',
            `/v2/stocks/${encodeURIComponent(symbol)}/trades/latest`,
            undefined,
            true,
          );
          last = tradeData.trade.p;
        } catch {
          // Use mid-price as fallback
          last = bid && ask ? (bid + ask) / 2 : bid || ask;
        }
      }

      return {
        symbol,
        bid,
        ask,
        last,
        timestamp: new Date(q.t).getTime(),
      };
    } catch {
      // Quote endpoint failed — try latest trade directly
      const tradeData = await this.request<AlpacaTradeResponse>(
        'GET',
        `/v2/stocks/${encodeURIComponent(symbol)}/trades/latest`,
        undefined,
        true,
      );
      const p = tradeData.trade.p;
      return {
        symbol,
        bid:       p,
        ask:       p,
        last:      p,
        timestamp: new Date(tradeData.trade.t).getTime(),
      };
    }
  }

  async getOHLCV(symbol: string, timeframe: string, limit: number): Promise<OHLCV[]> {
    const tf   = mapTimeframe(timeframe);
    const path = `/v2/stocks/${encodeURIComponent(symbol)}/bars`
               + `?timeframe=${tf}&limit=${limit}&adjustment=raw&feed=iex`;

    const data = await this.request<AlpacaBarsResponse>('GET', path, undefined, true);

    const bars: AlpacaBar[] = data.bars ?? [];

    // Map and sort oldest → newest (consistent with Binance interface)
    return bars
      .map((b): OHLCV => ({
        timestamp: new Date(b.t).getTime(),
        open:      b.o,
        high:      b.h,
        low:       b.l,
        close:     b.c,
        volume:    b.v,
      }))
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  async getBalance(): Promise<Balance> {
    const account = await this.request<AlpacaAccount>('GET', '/v2/account');

    const cash           = parseFloat(account.cash);
    const portfolioValue = parseFloat(account.portfolio_value);
    const used           = portfolioValue - cash;

    return {
      free:  cash,
      used:  used < 0 ? 0 : used,
      total: portfolioValue,
    };
  }

  async getOpenOrders(symbol?: string): Promise<OpenOrder[]> {
    let path = '/v2/orders?status=open&limit=500';
    if (symbol) {
      path += `&symbols=${encodeURIComponent(symbol)}`;
    }

    const orders = await this.request<AlpacaOrder[]>('GET', path);

    return orders.map((o): OpenOrder => ({
      exchangeOrderId: o.id,
      symbol:          o.symbol,
      side:            o.side,
      type:            o.type,
      price:           o.limit_price ? parseFloat(o.limit_price)
                     : o.stop_price  ? parseFloat(o.stop_price)
                     : 0,
      size:            parseFloat(o.qty),
      filled:          parseFloat(o.filled_qty),
      status:          o.status,
      timestamp:       new Date(o.created_at).getTime(),
    }));
  }

  async placeOrder(params: {
    symbol: string;
    side: 'buy' | 'sell';
    type: 'market' | 'limit';
    size: number;
    price?: number;
  }): Promise<OrderResult> {
    const body: Record<string, unknown> = {
      symbol:        params.symbol,
      qty:           String(params.size),
      side:          params.side,
      type:          params.type,
      time_in_force: 'day',
    };

    if (params.type === 'limit' && params.price !== undefined) {
      body['limit_price'] = String(params.price);
    }

    const order = await this.request<AlpacaOrder>('POST', '/v2/orders', body);

    return {
      exchangeOrderId: order.id,
      symbol:          order.symbol,
      side:            order.side,
      type:            params.type,
      price:           order.limit_price ? parseFloat(order.limit_price) : (params.price ?? 0),
      size:            parseFloat(order.qty),
      status:          mapOrderStatus(order.status),
      timestamp:       new Date(order.created_at).getTime(),
    };
  }

  async placeOCO(params: {
    symbol: string;
    side: 'sell';
    size: number;
    price: number;         // take-profit limit price
    stopPrice: number;     // stop trigger price
    stopLimitPrice: number; // stop limit price
  }): Promise<OrderResult> {
    // Alpaca bracket order: sell limit (take profit) + stop loss on the same leg
    const body = {
      symbol:        params.symbol,
      qty:           String(params.size),
      side:          'sell' as const,
      type:          'limit',
      time_in_force: 'gtc',
      order_class:   'oco',
      limit_price:   String(params.price),
      stop_loss: {
        stop_price:  String(params.stopPrice),
        limit_price: String(params.stopLimitPrice),
      },
    };

    const order = await this.request<AlpacaOrder>('POST', '/v2/orders', body);

    return {
      exchangeOrderId: order.id,
      symbol:          order.symbol,
      side:            'sell',
      type:            'oco',
      price:           params.price,
      size:            params.size,
      status:          mapOrderStatus(order.status),
      timestamp:       new Date(order.created_at).getTime(),
    };
  }

  async cancelOrder(_symbol: string, orderId: string): Promise<void> {
    await this.request<unknown>('DELETE', `/v2/orders/${encodeURIComponent(orderId)}`);
  }

  async getSymbolFilters(symbol: string): Promise<SymbolFilters> {
    try {
      const asset = await this.request<AlpacaAsset>(
        'GET',
        `/v2/assets/${encodeURIComponent(symbol)}`,
      );

      const fractionable = asset.fractionable ?? false;
      const step         = fractionable ? 0.000001 : 1;

      return {
        minQty:      fractionable ? 0.000001 : 1,
        maxQty:      10_000_000,
        stepSize:    step,
        minNotional: 1,
        tickSize:    0.01,
      };
    } catch {
      // Return safe defaults if asset lookup fails
      return {
        minQty:      1,
        maxQty:      10_000_000,
        stepSize:    1,
        minNotional: 1,
        tickSize:    0.01,
      };
    }
  }

  async hasWithdrawalPermission(): Promise<boolean> {
    // Alpaca does not have a withdrawal concept equivalent to crypto exchanges
    return false;
  }

  // ── Alpaca-specific method (not on IExchange) ──────────────────────────────

  /**
   * Check whether the US stock market is currently open.
   * Used by the heartbeat via duck-typing: `'isMarketOpen' in exchange`.
   */
  async isMarketOpen(): Promise<boolean> {
    const clock = await this.request<AlpacaClock>('GET', '/v2/clock');
    return clock.is_open;
  }
}
