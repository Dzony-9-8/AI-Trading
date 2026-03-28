"""
IBKR Paper Trader
Connects to IB Gateway (port 4002) via ib_insync and places paper trades
based on options scanner top candidates.

Usage (standalone):
  python scripts/ibkr_trader.py --json scripts/output/options_results_latest.json
  python scripts/ibkr_trader.py --status
"""

import json
import math
import time
import argparse
import logging
from pathlib import Path
from datetime import datetime
from typing import Optional, Dict, List

log = logging.getLogger("ibkr_trader")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

GATEWAY_HOST = "127.0.0.1"
GATEWAY_PORT = 4002          # Paper trading port
CLIENT_ID    = 10            # Unique client ID (avoid conflicts with other apps)
MAX_TRADES   = 3             # Max new trades per scan
MAX_RISK_PCT = 0.02          # Max 2% of account per trade


# ── Connection ────────────────────────────────────────────────────────────────

def connect_ibkr():
    """Connect to IB Gateway. Returns IB instance or None on failure."""
    try:
        from ib_insync import IB
        ib = IB()
        ib.connect(GATEWAY_HOST, GATEWAY_PORT, clientId=CLIENT_ID, timeout=10)
        log.info(f"Connected to IBKR Gateway — account: {ib.wrapper.accounts}")
        return ib
    except Exception as e:
        log.error(f"Cannot connect to IB Gateway: {e}")
        log.error("Make sure IB Gateway is running and API is enabled on port 4002")
        return None


def get_account_value(ib) -> float:
    """Get net liquidation value (paper account equity)."""
    try:
        vals = ib.accountValues()
        for v in vals:
            if v.tag == "NetLiquidation" and v.currency == "USD":
                return float(v.value)
    except Exception as e:
        log.warning(f"Could not get account value: {e}")
    return 100_000.0  # fallback


# ── Option Contract Helpers ───────────────────────────────────────────────────

def find_option_contract(ib, ticker: str, expiry: str, strike: float,
                          right: str) -> Optional[object]:
    """
    Look up a specific option contract on IBKR.
    right: 'C' for call, 'P' for put
    expiry: 'YYYYMMDD' format
    """
    try:
        from ib_insync import Option
        contract = Option(ticker, expiry, strike, right, "SMART", currency="USD")
        details  = ib.reqContractDetails(contract)
        if details:
            return details[0].contract
        return None
    except Exception as e:
        log.warning(f"Contract lookup failed {ticker} {expiry} {strike} {right}: {e}")
        return None


def get_live_quote(ib, contract) -> Dict:
    """Get bid/ask for a contract. Falls back to delayed data if live not subscribed."""
    for market_data_type in (1, 3):  # 1=live, 3=delayed frozen
        try:
            ib.reqMarketDataType(market_data_type)
            ticker = ib.reqMktData(contract, "", False, False)
            ib.sleep(2)
            bid = float(ticker.bid) if ticker.bid and ticker.bid > 0 else 0.0
            ask = float(ticker.ask) if ticker.ask and ticker.ask > 0 else 0.0
            mid = (bid + ask) / 2 if bid and ask else 0.0
            ib.cancelMktData(contract)
            if mid > 0:
                log.info(f"Quote (type={market_data_type}): bid={bid:.2f} ask={ask:.2f} mid={mid:.2f}")
                return {"bid": bid, "ask": ask, "mid": mid}
        except Exception as e:
            log.warning(f"Quote error (type={market_data_type}): {e}")
    return {"bid": 0, "ask": 0, "mid": 0}


# ── Order Placement ───────────────────────────────────────────────────────────

def place_credit_spread(ib, ticker: str, expiry: str,
                         sell_strike: float, buy_strike: float,
                         right: str, credit: float,
                         quantity: int = 1) -> Optional[Dict]:
    """
    Place a vertical credit spread as a combo order.
    right: 'P' = bull put spread, 'C' = bear call spread
    credit: expected net credit per share (positive)
    Returns trade details dict or None on failure.
    """
    try:
        from ib_insync import ComboLeg, Contract, Order, TagValue

        # Look up both legs
        sell_con = find_option_contract(ib, ticker, expiry, sell_strike, right)
        buy_con  = find_option_contract(ib, ticker, expiry, buy_strike,  right)

        if not sell_con or not buy_con:
            log.warning(f"{ticker}: Could not find option contracts")
            return None

        # Build combo contract (BAG)
        combo = Contract()
        combo.symbol   = ticker
        combo.secType  = "BAG"
        combo.currency = "USD"
        combo.exchange = "SMART"

        leg_sell       = ComboLeg()
        leg_sell.conId = sell_con.conId
        leg_sell.ratio = 1
        leg_sell.action = "SELL"
        leg_sell.exchange = "SMART"

        leg_buy        = ComboLeg()
        leg_buy.conId  = buy_con.conId
        leg_buy.ratio  = 1
        leg_buy.action = "BUY"
        leg_buy.exchange = "SMART"

        combo.comboLegs = [leg_sell, leg_buy]

        trade = _try_combo_order(ib, combo, credit, quantity)

        if trade is None:
            # Fallback: place legs individually (paper trading workaround)
            log.info(f"{ticker}: Combo rejected, falling back to individual legs")
            return _place_legs_individually(
                ib, ticker, sell_con, buy_con, right,
                sell_strike, buy_strike, expiry, credit, quantity
            )

        log.info(
            f"ORDER PLACED: {ticker} {right} spread "
            f"sell {sell_strike} / buy {buy_strike} "
            f"exp {expiry} credit ${credit:.2f} qty {quantity}  status={trade.orderStatus.status}"
        )

        return {
            "ticker":       ticker,
            "type":         "Bull Put Spread" if right == "P" else "Bear Call Spread",
            "expiry":       expiry,
            "sell_strike":  sell_strike,
            "buy_strike":   buy_strike,
            "credit":       credit,
            "quantity":     quantity,
            "max_profit":   credit * 100 * quantity,
            "max_loss":     (abs(sell_strike - buy_strike) - credit) * 100 * quantity,
            "order_id":     trade.order.orderId,
            "status":       trade.orderStatus.status,
            "placed_at":    datetime.now().isoformat(),
        }

    except Exception as e:
        log.error(f"Order placement failed for {ticker}: {e}")
        return None


def _try_combo_order(ib, combo, credit: float, quantity: int):
    """Attempt a combo (BAG) order with COMBOPAYOUT override. Returns trade or None."""
    from ib_insync import Order, TagValue

    order = Order()
    order.action         = "SELL"
    order.orderType      = "LMT"
    order.totalQuantity  = quantity
    order.lmtPrice       = round(credit, 2)
    order.tif            = "GTC"
    order.smartComboRoutingParams = [TagValue("NonGuaranteed", "1")]
    # FIX tag 8229=COMBOPAYOUT — bypasses the "riskless combination" check
    order.orderMiscOptions = [TagValue("8229", "COMBOPAYOUT")]

    trade = ib.placeOrder(combo, order)
    ib.sleep(3)

    if trade.orderStatus.status == "Cancelled":
        log.warning("Combo order cancelled by IBKR")
        return None
    return trade


def _place_legs_individually(ib, ticker: str, sell_con, buy_con,
                              right: str, sell_strike: float, buy_strike: float,
                              expiry: str, credit: float, quantity: int) -> Optional[Dict]:
    """
    Fallback: submit sell leg then buy leg as separate limit orders.
    Uses mid-price estimates for each leg.
    """
    from ib_insync import Order

    try:
        # Get live quotes for each leg
        sell_q = get_live_quote(ib, sell_con)
        buy_q  = get_live_quote(ib, buy_con)

        sell_lmt = round(sell_q["mid"], 2) if sell_q["mid"] > 0 else round(credit * 0.7, 2)
        buy_lmt  = round(buy_q["mid"],  2) if buy_q["mid"]  > 0 else round(credit * 0.3, 2)

        def _limit_order(action: str, lmt: float) -> Order:
            o = Order()
            o.action        = action
            o.orderType     = "LMT"
            o.totalQuantity = quantity
            o.lmtPrice      = max(lmt, 0.01)
            o.tif           = "GTC"
            return o

        t_sell = ib.placeOrder(sell_con, _limit_order("SELL", sell_lmt))
        ib.sleep(1)
        t_buy  = ib.placeOrder(buy_con,  _limit_order("BUY",  buy_lmt))
        ib.sleep(2)

        log.info(
            f"LEGS PLACED: {ticker} sell {sell_strike}@{sell_lmt:.2f} "
            f"/ buy {buy_strike}@{buy_lmt:.2f}  exp {expiry}"
        )

        return {
            "ticker":      ticker,
            "type":        "Bull Put Spread" if right == "P" else "Bear Call Spread",
            "expiry":      expiry,
            "sell_strike": sell_strike,
            "buy_strike":  buy_strike,
            "credit":      sell_lmt - buy_lmt,
            "quantity":    quantity,
            "max_profit":  (sell_lmt - buy_lmt) * 100 * quantity,
            "max_loss":    (abs(sell_strike - buy_strike) - (sell_lmt - buy_lmt)) * 100 * quantity,
            "order_id":    t_sell.order.orderId,
            "status":      "LegsSubmitted",
            "placed_at":   datetime.now().isoformat(),
        }
    except Exception as e:
        log.error(f"Individual leg placement failed for {ticker}: {e}")
        return None


# ── Main: Process Scanner JSON ────────────────────────────────────────────────

def trade_from_scan(json_path: str, dry_run: bool = False) -> List[Dict]:
    """
    Read options scanner JSON, connect to IBKR, place trades for top candidates.
    Returns list of placed trade dicts.
    """
    path = Path(json_path)
    if not path.exists():
        log.error(f"JSON not found: {json_path}")
        return []

    data       = json.loads(path.read_text())
    top_stocks = data.get("top_stocks", [])

    if not top_stocks:
        log.warning("No top_stocks in scan output")
        return []

    log.info(f"Loaded {len(top_stocks)} candidates from {path.name}")

    ib = connect_ibkr()
    if ib is None:
        return []

    try:
        account_value = get_account_value(ib)
        max_risk_usd  = account_value * MAX_RISK_PCT
        log.info(f"Account: ${account_value:,.0f}  Max risk/trade: ${max_risk_usd:,.0f}")

        placed = []
        count  = 0

        for stock in top_stocks[:MAX_TRADES * 2]:  # look at 2× candidates
            if count >= MAX_TRADES:
                break

            ticker    = stock.get("ticker", "")
            metrics   = stock.get("metrics", {})
            strategies = stock.get("strategies", {})

            # Pick best valid strategy (highest POP)
            valid = [(k, v) for k, v in strategies.items() if v.get("valid", True)]
            if not valid:
                continue
            valid.sort(key=lambda x: x[1].get("prob_of_profit", 0), reverse=True)
            strat_key, strat = valid[0]

            # Only trade bull put spreads and bear call spreads (defined risk)
            if strat_key not in ("bull_put_spread", "bear_call_spread"):
                # Try to find one of these
                preferred = [("bull_put_spread", strategies.get("bull_put_spread")),
                             ("bear_call_spread", strategies.get("bear_call_spread"))]
                preferred = [(k, v) for k, v in preferred
                             if v and v.get("valid", True)]
                if preferred:
                    strat_key, strat = preferred[0]
                else:
                    continue

            # Risk check
            max_loss = strat.get("max_loss", 0)
            if max_loss > max_risk_usd:
                log.info(f"{ticker}: max_loss ${max_loss:.0f} > limit ${max_risk_usd:.0f}, skipping")
                continue

            # Derive strike prices from strategy name and spot price
            expiry   = metrics.get("expiration", "")
            spot     = metrics.get("spot_price", 0)
            credit   = strat.get("net_credit", 0)

            if not expiry or spot <= 0 or credit <= 0:
                log.warning(f"{ticker}: missing expiry/spot/credit data")
                continue

            # Convert expiry to IBKR format YYYYMMDD
            try:
                exp_dt = datetime.strptime(expiry, "%Y-%m-%d")
                exp_str = exp_dt.strftime("%Y%m%d")
            except Exception:
                log.warning(f"{ticker}: bad expiry format {expiry}")
                continue

            # Estimate strikes from spot + strategy
            if strat_key == "bull_put_spread":
                sell_strike = round(spot * 0.95 / 5) * 5   # ~5% OTM put, rounded to $5
                buy_strike  = round(spot * 0.90 / 5) * 5   # 10% OTM put
                right       = "P"
            else:  # bear_call_spread
                sell_strike = round(spot * 1.05 / 5) * 5   # ~5% OTM call
                buy_strike  = round(spot * 1.10 / 5) * 5   # 10% OTM call
                right       = "C"

            if dry_run:
                log.info(
                    f"[DRY RUN] Would place: {ticker} {strat_key} "
                    f"sell {sell_strike} / buy {buy_strike} "
                    f"exp {exp_str} credit ${credit:.2f}"
                )
                placed.append({
                    "ticker": ticker, "type": strat_key, "dry_run": True,
                    "sell_strike": sell_strike, "buy_strike": buy_strike,
                    "expiry": exp_str, "credit": credit,
                })
                count += 1
                continue

            # Place the order
            result = place_credit_spread(
                ib, ticker, exp_str, sell_strike, buy_strike, right, credit
            )

            if result:
                placed.append(result)
                count += 1
                log.info(f"Placed trade {count}/{MAX_TRADES}: {ticker}")
                time.sleep(1)

        return placed

    finally:
        ib.disconnect()
        log.info("Disconnected from IBKR Gateway")


def get_positions() -> Dict:
    """Fetch open positions and pending orders from IBKR."""
    ib = connect_ibkr()
    if ib is None:
        return {"positions": [], "orders": []}
    try:
        positions = ib.positions()
        filled = []
        for p in positions:
            c = p.contract
            filled.append({
                "symbol":   c.symbol,
                "sec_type": c.secType,
                "strike":   getattr(c, "strike", None),
                "right":    getattr(c, "right", None),
                "expiry":   getattr(c, "lastTradeDateOrContractMonth", None),
                "quantity": p.position,
                "avg_cost": p.avgCost,
            })

        orders = ib.openOrders()
        pending = []
        for o in orders:
            pending.append({
                "order_id": o.orderId,
                "action":   o.action,
                "qty":      o.totalQuantity,
                "lmt":      o.lmtPrice,
                "tif":      o.tif,
            })

        trades = ib.openTrades()
        pending_trades = []
        for t in trades:
            c = t.contract
            pending_trades.append({
                "symbol":   c.symbol,
                "sec_type": c.secType,
                "strike":   getattr(c, "strike", None),
                "right":    getattr(c, "right", None),
                "expiry":   getattr(c, "lastTradeDateOrContractMonth", None),
                "action":   t.order.action,
                "qty":      t.order.totalQuantity,
                "lmt":      t.order.lmtPrice,
                "status":   t.orderStatus.status,
            })

        return {"positions": filled, "orders": pending_trades}
    finally:
        ib.disconnect()


def compute_bs_greeks(spot: float, strike: float, right: str, expiry_str: str,
                      iv: float = 0.30, r: float = 0.05) -> Dict:
    """Compute Black-Scholes delta/theta/vega. Returns zeros on any failure."""
    try:
        from scipy.stats import norm
        exp_dt = datetime.strptime(str(expiry_str)[:8], "%Y%m%d")
        dte = max((exp_dt - datetime.now()).days, 0)
        T = dte / 365.0
        if T <= 0 or spot <= 0 or strike <= 0 or iv <= 0:
            return {"delta": 0.0, "theta": 0.0, "vega": 0.0, "dte": dte}
        d1 = (math.log(spot / strike) + (r + 0.5 * iv**2) * T) / (iv * math.sqrt(T))
        d2 = d1 - iv * math.sqrt(T)
        is_call = right.upper() == "C"
        delta = norm.cdf(d1) if is_call else norm.cdf(d1) - 1.0
        theta = (
            -spot * norm.pdf(d1) * iv / (2 * math.sqrt(T))
            - r * strike * math.exp(-r * T) * (norm.cdf(d2) if is_call else norm.cdf(-d2))
        ) / 365.0
        vega = spot * norm.pdf(d1) * math.sqrt(T) / 100.0
        return {"delta": round(delta, 4), "theta": round(theta, 4),
                "vega": round(vega, 4), "dte": dte}
    except Exception as ex:
        log.debug(f"Greeks computation failed: {ex}")
        return {"delta": 0.0, "theta": 0.0, "vega": 0.0, "dte": 0}


def get_positions_json() -> Dict:
    """Fetch positions + compute Black-Scholes portfolio Greeks. Returns JSON-safe dict."""
    try:
        data = get_positions()
        connected = True
    except Exception as e:
        return {"connected": False, "error": str(e), "positions": [],
                "orders": [], "portfolio_greeks": {}, "has_options": False}

    positions = data.get("positions", [])
    orders    = data.get("orders", [])

    # Fetch spot prices for option underlyings via yfinance (best-effort)
    spot_prices: Dict[str, float] = {}
    opt_tickers = list({p["symbol"] for p in positions if p.get("sec_type") == "OPT"})
    if opt_tickers:
        try:
            import yfinance as yf
            for tk in opt_tickers:
                try:
                    info = yf.Ticker(tk).fast_info
                    spot_prices[tk] = float(getattr(info, "last_price", 0) or 0)
                except Exception:
                    spot_prices[tk] = 0.0
        except ImportError:
            pass

    net_delta = 0.0
    net_theta = 0.0
    net_vega  = 0.0
    min_dte   = 9999
    enhanced  = []

    for p in positions:
        entry = dict(p)
        if (p.get("sec_type") == "OPT"
                and p.get("strike") and p.get("right") and p.get("expiry")):
            spot = spot_prices.get(p["symbol"], 0.0)
            if spot > 0:
                g = compute_bs_greeks(spot, float(p["strike"]), p["right"], str(p["expiry"]))
                qty = float(p.get("quantity", 0))
                entry.update({"greeks": g, "spot": spot})
                net_delta += g["delta"] * qty * 100
                net_theta += g["theta"] * qty * 100
                net_vega  += g["vega"]  * qty * 100
                if 0 < g["dte"] < min_dte:
                    min_dte = g["dte"]
        enhanced.append(entry)

    return {
        "connected":  connected,
        "positions":  enhanced,
        "orders":     orders,
        "has_options": any(p.get("sec_type") == "OPT" for p in positions),
        "portfolio_greeks": {
            "net_delta": round(net_delta, 2),
            "net_theta": round(net_theta, 2),
            "net_vega":  round(net_vega, 2),
            "days_to_next_expiry": min_dte if min_dte < 9999 else None,
        },
    }


# ── CLI ───────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="IBKR Paper Trader")
    parser.add_argument("--json",       help="Path to scanner JSON output")
    parser.add_argument("--dry-run",    action="store_true", help="Show orders but don't submit")
    parser.add_argument("--status",     action="store_true", help="Show open positions and pending orders")
    parser.add_argument("--cancel-all", action="store_true", help="Cancel all pending paper orders")
    parser.add_argument("--status-json", action="store_true", help="Output status as JSON to stdout")
    args = parser.parse_args()

    if args.status_json:
        import json as _json
        print(_json.dumps(get_positions_json()))
        raise SystemExit(0)

    if args.status:
        data = get_positions()
        filled  = data.get("positions", [])
        pending = data.get("orders", [])

        if filled:
            print(f"\n── Filled Positions ({len(filled)}) ──")
            for p in filled:
                print(f"  {p['symbol']:6s}  {p['sec_type']:4s}  "
                      f"strike={p['strike']}  {p['right']}  "
                      f"exp={p['expiry']}  qty={p['quantity']}  avg=${p['avg_cost']:.2f}")
        else:
            print("\n── No filled positions ──")

        if pending:
            print(f"\n── Pending Orders ({len(pending)}) ──")
            for o in pending:
                print(f"  {o['symbol']:6s}  {o['sec_type']:4s}  "
                      f"strike={o['strike']}  {o['right']}  "
                      f"exp={o['expiry']}  {o['action']}  "
                      f"qty={o['qty']}  lmt=${o['lmt']:.2f}  [{o['status']}]")
        else:
            print("── No pending orders ──")

    elif args.cancel_all:
        ib = connect_ibkr()
        if ib:
            try:
                trades = ib.openTrades()
                if not trades:
                    print("No pending orders to cancel.")
                for t in trades:
                    ib.cancelOrder(t.order)
                    c = t.contract
                    print(f"Cancelled: {c.symbol} {getattr(c,'right','')} "
                          f"strike={getattr(c,'strike','')} "
                          f"exp={getattr(c,'lastTradeDateOrContractMonth','')} "
                          f"orderId={t.order.orderId}")
                ib.sleep(1)
            finally:
                ib.disconnect()

    elif args.json:
        trades = trade_from_scan(args.json, dry_run=args.dry_run)
        print(f"\n{'[DRY RUN] ' if args.dry_run else ''}Placed {len(trades)} trades:")
        for t in trades:
            print(f"  {t['ticker']:6s}  {t['type']}  "
                  f"sell {t['sell_strike']} / buy {t['buy_strike']}  "
                  f"exp {t['expiry']}  credit ${t['credit']:.2f}")
    else:
        # Auto-find latest scan output
        output_dir = Path(__file__).parent / "output"
        files = sorted(output_dir.glob("options_results_*.json"), reverse=True)
        if not files:
            print("No scan output found. Run options_scanner.py first.")
        else:
            print(f"Using latest scan: {files[0].name}")
            trades = trade_from_scan(str(files[0]), dry_run=args.dry_run)
            print(f"\nPlaced {len(trades)} trades.")
