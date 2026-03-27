export interface OHLCV {
  timestamp: number; // Unix ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Ticker {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  timestamp: number;
}

export interface Balance {
  free: number;   // Available USDT
  used: number;   // Locked in orders
  total: number;  // free + used
}

export interface OrderResult {
  exchangeOrderId: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit' | 'stop' | 'oco';
  price: number;
  size: number;
  status: 'open' | 'closed' | 'cancelled';
  fee?: number;
  timestamp: number;
}

export interface SymbolFilters {
  minQty: number;
  maxQty: number;
  stepSize: number;
  minNotional: number;
  tickSize: number;
}

export interface OpenOrder {
  exchangeOrderId: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: string;
  price: number;
  size: number;
  filled: number;
  status: string;
  timestamp: number;
}

export interface IExchange {
  /** Fetch current ticker for a symbol */
  getTicker(symbol: string): Promise<Ticker>;

  /** Fetch OHLCV candles — returns newest-first, length = limit */
  getOHLCV(symbol: string, timeframe: string, limit: number): Promise<OHLCV[]>;

  /** Get USDT balance */
  getBalance(): Promise<Balance>;

  /** Get all open orders */
  getOpenOrders(symbol?: string): Promise<OpenOrder[]>;

  /** Place a market or limit order */
  placeOrder(params: {
    symbol: string;
    side: 'buy' | 'sell';
    type: 'market' | 'limit';
    size: number;
    price?: number;
  }): Promise<OrderResult>;

  /** Place an OCO (stop-loss + take-profit) order */
  placeOCO(params: {
    symbol: string;
    side: 'sell';
    size: number;
    price: number;       // Take profit limit price
    stopPrice: number;   // Stop trigger price
    stopLimitPrice: number; // Stop limit price (slightly below stopPrice)
  }): Promise<OrderResult>;

  /** Cancel an order by exchange order ID */
  cancelOrder(symbol: string, orderId: string): Promise<void>;

  /** Get symbol trading filters (lot size, min notional) */
  getSymbolFilters(symbol: string): Promise<SymbolFilters>;

  /** Check if API key has withdrawal permission (should be false) */
  hasWithdrawalPermission(): Promise<boolean>;

  /** Whether this is a paper (simulated) exchange */
  isPaper: boolean;
}
