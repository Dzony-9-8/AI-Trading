#!/usr/bin/env python3
"""
S&P 500 Options Scanner
Scans all S&P 500 stocks for credit spread opportunities.
Scores, builds strategies, and runs AI analysis via Claude.

Usage:
  python scripts/options_scanner.py
  python scripts/options_scanner.py --no-ai --tickers AAPL MSFT NVDA
  python scripts/options_scanner.py --telegram --verbose
"""

import os
import sys
import json
import time
import math
import logging
import argparse
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path
from dataclasses import dataclass, field, asdict
from typing import Optional, List, Dict, Tuple, Any

import requests
import pandas as pd
import numpy as np
from scipy.stats import norm
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from tqdm import tqdm
from rich.console import Console
from rich.table import Table
from rich.panel import Panel
from rich.text import Text
import diskcache
import yfinance as yf
import plotly.graph_objects as go
from plotly.subplots import make_subplots
import plotly.io as pio

# ── Constants ──────────────────────────────────────────────────────────────────
BID_ASK_MAX_PCT    = 0.25    # Max bid-ask spread as fraction of mid
IV_RANK_MIN        = 10      # Min IV rank 0-100
EARNINGS_HIGH_DAYS = 7       # High risk earnings threshold
EARNINGS_WARN_DAYS = 14      # Warning earnings threshold
OPEN_INT_MIN       = 200     # Min open interest
IV_MIN             = 0.12    # Min implied volatility (12%)
TARGET_DTE         = 35      # Target days to expiration
DTE_MIN            = 21      # Min DTE
DTE_MAX            = 60      # Max DTE
TOP_N_DEFAULT      = 20      # Stocks to show and send to Claude
RATE_LIMIT_DELAY   = 0.4     # Seconds between yfinance calls
CACHE_TTL          = 3600    # 1-hour cache TTL
RISK_FREE_RATE     = 0.05    # Risk-free rate for Black-Scholes

_RELAXED_MODE = False  # Set True via --relaxed flag (loosens all gate thresholds by 50%)
_DIAGNOSE     = False  # Set True via --diagnose flag (prints gate failure for every stock)


# ── Section 1: DataClasses ─────────────────────────────────────────────────────

@dataclass
class GreekSet:
    delta: float = 0.0
    gamma: float = 0.0
    theta: float = 0.0
    vega:  float = 0.0


@dataclass
class LiquidityMetrics:
    bid_ask_pct:    float = 0.0
    open_interest:  int   = 0
    volume:         int   = 0
    liquidity_score: float = 0.0


@dataclass
class StrategyResult:
    name: str
    max_profit:       float = 0.0   # $ per contract (×100 shares)
    max_loss:         float = 0.0
    net_credit:       float = 0.0   # positive = received credit
    breakeven_lower:  float = 0.0
    breakeven_upper:  float = 0.0
    prob_of_profit:   float = 0.0   # 0.0 to 1.0
    delta:            float = 0.0
    theta:            float = 0.0
    vega:             float = 0.0
    sell_strike:      float = 0.0   # actual strike prices for order placement
    buy_strike:       float = 0.0
    pnl_prices: List[float] = field(default_factory=list)
    pnl_values: List[float] = field(default_factory=list)
    valid: bool             = True
    error: str              = ""


@dataclass
class AnalystRating:
    consensus:      str   = "N/A"
    buy_count:      int   = 0
    hold_count:     int   = 0
    sell_count:     int   = 0
    total_analysts: int   = 0
    price_target:   float = 0.0


@dataclass
class StockData:
    ticker: str
    company:         str   = ""
    sector:          str   = ""
    spot_price:      float = 0.0
    hv20:            float = 0.0
    hv30:            float = 0.0
    atm_iv:          float = 0.0
    iv_rank:         float = 0.0
    iv_percentile:   float = 0.0
    days_to_earnings: Optional[int] = None
    expiration:      str   = ""
    dte:             int   = 0
    liquidity:       LiquidityMetrics = field(default_factory=LiquidityMetrics)
    atm_greeks:      GreekSet         = field(default_factory=GreekSet)
    flags:           List[str]        = field(default_factory=list)
    score:           float = 0.0
    score_breakdown: Dict[str, float] = field(default_factory=dict)
    strategies:      Dict[str, "StrategyResult"] = field(default_factory=dict)
    headlines:       List[str]        = field(default_factory=list)
    analyst:         AnalystRating    = field(default_factory=AnalystRating)
    gate_failure:    str              = ""


# ── Section 2: DataCache ───────────────────────────────────────────────────────

class DataCache:
    def __init__(self, cache_dir: Path, ttl: int = CACHE_TTL):
        cache_dir.mkdir(parents=True, exist_ok=True)
        self.cache = diskcache.Cache(str(cache_dir))
        self.ttl = ttl

    def get(self, key: str) -> Optional[Any]:
        return self.cache.get(key)

    def set(self, key: str, value: Any, ttl: Optional[int] = None) -> None:
        self.cache.set(key, value, expire=ttl or self.ttl)

    def clear(self) -> None:
        self.cache.clear()

    def key(self, *parts: str) -> str:
        return ":".join(str(p) for p in parts)


# ── Section 3: SP500Fetcher ────────────────────────────────────────────────────

class SP500Fetcher:
    WIKI_URL = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"

    def __init__(self, cache: DataCache):
        self.cache = cache

    def get_tickers(self) -> List[Dict[str, str]]:
        cached = self.cache.get("sp500:tickers")
        if cached:
            return cached
        try:
            result = self._scrape_wikipedia()
            if result:
                self.cache.set("sp500:tickers", result, ttl=86400)  # 24h cache
                return result
        except Exception as e:
            logging.warning(f"Wikipedia scrape failed: {e}")
        return self._hardcoded_fallback()

    def _scrape_wikipedia(self) -> List[Dict[str, str]]:
        resp = requests.get(self.WIKI_URL, timeout=10,
                            headers={"User-Agent": "Mozilla/5.0"})
        soup = BeautifulSoup(resp.text, "lxml")
        table = soup.find("table", {"id": "constituents"})
        if not table:
            raise ValueError("Table not found")
        rows = []
        for tr in table.find_all("tr")[1:]:
            cols = tr.find_all("td")
            if len(cols) >= 4:
                ticker  = cols[0].text.strip().replace(".", "-")
                company = cols[1].text.strip()
                sector  = cols[3].text.strip()
                rows.append({"ticker": ticker, "company": company, "sector": sector})
        return rows

    def _hardcoded_fallback(self) -> List[Dict[str, str]]:
        # Top 50 S&P 500 by market cap as fallback
        tickers = [
            ("AAPL",  "Apple Inc.",             "Technology"),
            ("MSFT",  "Microsoft",              "Technology"),
            ("NVDA",  "NVIDIA",                 "Technology"),
            ("AMZN",  "Amazon",                 "Consumer Discretionary"),
            ("GOOGL", "Alphabet",               "Communication"),
            ("META",  "Meta",                   "Communication"),
            ("BRK-B", "Berkshire Hathaway",     "Financials"),
            ("TSLA",  "Tesla",                  "Consumer Discretionary"),
            ("UNH",   "UnitedHealth",           "Health Care"),
            ("XOM",   "Exxon Mobil",            "Energy"),
            ("JPM",   "JPMorgan Chase",         "Financials"),
            ("JNJ",   "Johnson & Johnson",      "Health Care"),
            ("V",     "Visa",                   "Financials"),
            ("PG",    "Procter & Gamble",       "Consumer Staples"),
            ("MA",    "Mastercard",             "Financials"),
            ("HD",    "Home Depot",             "Consumer Discretionary"),
            ("CVX",   "Chevron",                "Energy"),
            ("MRK",   "Merck",                  "Health Care"),
            ("ABBV",  "AbbVie",                 "Health Care"),
            ("KO",    "Coca-Cola",              "Consumer Staples"),
            ("LLY",   "Eli Lilly",              "Health Care"),
            ("AVGO",  "Broadcom",               "Technology"),
            ("PEP",   "PepsiCo",               "Consumer Staples"),
            ("COST",  "Costco",                 "Consumer Staples"),
            ("WMT",   "Walmart",                "Consumer Staples"),
            ("TMO",   "Thermo Fisher",          "Health Care"),
            ("MCD",   "McDonald's",             "Consumer Discretionary"),
            ("ABT",   "Abbott",                 "Health Care"),
            ("ACN",   "Accenture",              "Technology"),
            ("CSCO",  "Cisco",                  "Technology"),
            ("LIN",   "Linde",                  "Materials"),
            ("DHR",   "Danaher",                "Health Care"),
            ("WFC",   "Wells Fargo",            "Financials"),
            ("VZ",    "Verizon",                "Communication"),
            ("ADBE",  "Adobe",                  "Technology"),
            ("CRM",   "Salesforce",             "Technology"),
            ("NKE",   "Nike",                   "Consumer Discretionary"),
            ("ORCL",  "Oracle",                 "Technology"),
            ("TXN",   "Texas Instruments",      "Technology"),
            ("INTC",  "Intel",                  "Technology"),
            ("AMD",   "Advanced Micro Devices", "Technology"),
            ("QCOM",  "Qualcomm",               "Technology"),
            ("HON",   "Honeywell",              "Industrials"),
            ("UPS",   "UPS",                    "Industrials"),
            ("BA",    "Boeing",                 "Industrials"),
            ("CAT",   "Caterpillar",            "Industrials"),
            ("GE",    "GE Aerospace",           "Industrials"),
            ("MMM",   "3M",                     "Industrials"),
            ("RTX",   "RTX",                    "Industrials"),
            ("IBM",   "IBM",                    "Technology"),
        ]
        return [{"ticker": t, "company": c, "sector": s} for t, c, s in tickers]


# ── Section 4: VolatilityEngine ────────────────────────────────────────────────

class VolatilityEngine:
    def __init__(self, cache: DataCache):
        self.cache = cache

    def get_price_history(self, ticker: str) -> Optional[pd.DataFrame]:
        key = self.cache.key("prices", ticker)
        cached = self.cache.get(key)
        if cached is not None:
            return cached
        try:
            df = yf.download(ticker, period="1y", interval="1d",
                             progress=False, auto_adjust=True)
            if df.empty or len(df) < 30:
                return None
            # Flatten MultiIndex columns produced by newer yfinance versions
            if isinstance(df.columns, pd.MultiIndex):
                df.columns = [col[0] if col[1] == ticker else col[0]
                              for col in df.columns]
            self.cache.set(key, df)
            return df
        except Exception:
            return None

    def compute_hv(self, df: pd.DataFrame, window: int) -> float:
        if df is None or len(df) < window + 1:
            return 0.0
        closes = df["Close"].values
        # Squeeze in case it's still 2-D after MultiIndex flatten
        if hasattr(closes, "ndim") and closes.ndim > 1:
            closes = closes.squeeze()
        log_returns = np.log(closes[1:] / closes[:-1])
        if len(log_returns) < window:
            return 0.0
        return float(np.std(log_returns[-window:]) * np.sqrt(252) * 100)

    def compute_iv_rank(self, hv20_history: np.ndarray, current_hv: float) -> float:
        """IV Rank using HV as proxy (yfinance has no historical IV)"""
        if len(hv20_history) < 2:
            return 50.0
        low  = float(np.min(hv20_history))
        high = float(np.max(hv20_history))
        if high == low:
            return 50.0
        return min(100.0, max(0.0, (current_hv - low) / (high - low) * 100))

    def compute_iv_percentile(self, hv20_history: np.ndarray, current_hv: float) -> float:
        if len(hv20_history) < 2:
            return 50.0
        return float(np.mean(hv20_history < current_hv) * 100)

    def get_hv_history(self, df: pd.DataFrame, window: int = 20) -> np.ndarray:
        """Rolling HV over the past year for IV rank computation"""
        if df is None or len(df) < window + 20:
            return np.array([])
        closes = df["Close"].values
        if hasattr(closes, "ndim") and closes.ndim > 1:
            closes = closes.squeeze()
        log_returns = np.log(closes[1:] / closes[:-1])
        result = []
        for i in range(window, len(log_returns)):
            hv = np.std(log_returns[i - window:i]) * np.sqrt(252) * 100
            result.append(hv)
        return np.array(result)

    def get_earnings_date(self, ticker: str) -> Optional[datetime]:
        key = self.cache.key("earnings", ticker)
        cached = self.cache.get(key)
        if cached is not None:
            return cached if cached != "none" else None
        try:
            t = yf.Ticker(ticker)
            cal = t.calendar
            if cal is None:
                self.cache.set(key, "none", ttl=3600)
                return None
            # calendar can be dict or DataFrame
            if isinstance(cal, dict) and "Earnings Date" in cal:
                dates = cal["Earnings Date"]
                if dates:
                    d0 = dates[0]
                    dt = (d0.to_pydatetime()
                          if hasattr(d0, "to_pydatetime")
                          else datetime.fromisoformat(str(d0)))
                    self.cache.set(key, dt, ttl=3600)
                    return dt
            self.cache.set(key, "none", ttl=3600)
            return None
        except Exception:
            return None

    def days_to_earnings(self, ticker: str) -> Optional[int]:
        ed = self.get_earnings_date(ticker)
        if ed is None:
            return None
        delta = (ed.replace(tzinfo=None) - datetime.now()).days
        return delta if delta >= 0 else None


# ── Section 5: OptionsChainFetcher ────────────────────────────────────────────

class OptionsChainFetcher:
    def __init__(self, cache: DataCache):
        self.cache = cache

    def get_chain(self, ticker: str) -> Optional[Dict]:
        key = self.cache.key("chain", ticker)
        cached = self.cache.get(key)
        if cached is not None:
            return cached if cached != "none" else None
        try:
            t = yf.Ticker(ticker)
            spot = self._get_spot(t, ticker)
            if spot is None or spot <= 0:
                self.cache.set(key, "none")
                return None
            expirations = t.options
            if not expirations:
                self.cache.set(key, "none")
                return None
            exp = self._select_expiration(expirations)
            if exp is None:
                self.cache.set(key, "none")
                return None
            dte   = (datetime.strptime(exp, "%Y-%m-%d") - datetime.now()).days
            chain = t.option_chain(exp)
            result = {
                "ticker":     ticker,
                "spot":       spot,
                "expiration": exp,
                "dte":        dte,
                "calls":      chain.calls,
                "puts":       chain.puts,
            }
            self.cache.set(key, result)
            return result
        except Exception:
            self.cache.set(key, "none")
            return None

    def _get_spot(self, t, ticker: str) -> Optional[float]:
        try:
            info  = t.fast_info
            price = (getattr(info, "last_price", None)
                     or getattr(info, "regularMarketPrice", None))
            if price and price > 0:
                return float(price)
        except Exception:
            pass
        try:
            hist = t.history(period="1d")
            if not hist.empty:
                return float(hist["Close"].iloc[-1])
        except Exception:
            pass
        return None

    def _select_expiration(self, expirations: tuple) -> Optional[str]:
        today    = datetime.now()
        best     = None
        best_diff = float("inf")
        for exp in expirations:
            try:
                exp_date = datetime.strptime(exp, "%Y-%m-%d")
                dte      = (exp_date - today).days
                if DTE_MIN <= dte <= DTE_MAX:
                    diff = abs(dte - TARGET_DTE)
                    if diff < best_diff:
                        best_diff = diff
                        best = exp
            except Exception:
                continue
        return best

    def get_atm_iv(self, chain: Dict) -> float:
        spot  = chain["spot"]
        calls = chain["calls"]
        if calls.empty:
            return 0.0
        calls = calls.copy()
        calls["dist"] = abs(calls["strike"] - spot)
        atm_row = calls.loc[calls["dist"].idxmin()]
        iv = float(atm_row.get("impliedVolatility", 0))
        return iv if iv > 0 else 0.0

    def get_liquidity(self, chain: Dict) -> LiquidityMetrics:
        calls = chain["calls"]
        spot  = chain["spot"]
        if calls.empty:
            return LiquidityMetrics()
        calls = calls.copy()
        calls["dist"] = abs(calls["strike"] - spot)
        atm = calls.loc[calls["dist"].idxmin()]
        bid = float(atm.get("bid", 0) or 0)
        ask = float(atm.get("ask", 0) or 0)
        mid = (bid + ask) / 2 if bid + ask > 0 else 0
        oi  = int(atm.get("openInterest", 0) or 0)
        vol = int(atm.get("volume", 0) or 0)

        # Pre-market / after-hours: bid+ask=0 is normal (market closed)
        # Use last traded price to estimate spread instead of penalising 100%
        if mid == 0:
            last = float(atm.get("lastPrice", 0) or 0)
            if last > 0:
                # Estimate spread as 5% of last price (conservative pre-market assumption)
                spread_pct = 0.05
            else:
                # Truly no data — mark as unknown, don't fail the spread gate
                spread_pct = 0.0
        else:
            spread_pct = (ask - bid) / mid

        # Composite liquidity score 0-100
        oi_score  = min(10.0, oi  / 1000 * 10)
        vol_score = min(8.0,  vol / 500  * 8)
        spd_score = max(0.0, (0.10 - spread_pct) / 0.10 * 7)
        liq_score = oi_score + vol_score + spd_score
        return LiquidityMetrics(
            bid_ask_pct=spread_pct * 100,
            open_interest=oi,
            volume=vol,
            liquidity_score=liq_score,
        )

    def bs_greeks(self, S: float, K: float, T: float, sigma: float,
                  r: float = RISK_FREE_RATE, option_type: str = "call") -> GreekSet:
        if T <= 0 or sigma <= 0 or S <= 0 or K <= 0:
            return GreekSet()
        try:
            d1 = (math.log(S / K) + (r + 0.5 * sigma ** 2) * T) / (sigma * math.sqrt(T))
            d2 = d1 - sigma * math.sqrt(T)
            if option_type == "call":
                delta = norm.cdf(d1)
            else:
                delta = norm.cdf(d1) - 1.0
            gamma = norm.pdf(d1) / (S * sigma * math.sqrt(T))
            if option_type == "call":
                theta = (-(S * norm.pdf(d1) * sigma) / (2 * math.sqrt(T))
                         - r * K * math.exp(-r * T) * norm.cdf(d2)) / 365
            else:
                theta = (-(S * norm.pdf(d1) * sigma) / (2 * math.sqrt(T))
                         + r * K * math.exp(-r * T) * norm.cdf(-d2)) / 365
            vega = S * norm.pdf(d1) * math.sqrt(T) / 100
            return GreekSet(
                delta=round(delta, 4),
                gamma=round(gamma, 6),
                theta=round(theta, 4),
                vega=round(vega, 4),
            )
        except Exception:
            return GreekSet()

    def get_atm_greeks(self, chain: Dict) -> GreekSet:
        spot  = chain["spot"]
        dte   = chain["dte"]
        calls = chain["calls"].copy()
        if calls.empty:
            return GreekSet()
        calls["dist"] = abs(calls["strike"] - spot)
        atm = calls.loc[calls["dist"].idxmin()]
        iv  = float(atm.get("impliedVolatility", 0.3) or 0.3)
        T   = dte / 365
        return self.bs_greeks(spot, float(atm["strike"]), T, iv, option_type="call")


# ── Section 6: ScoringEngine ───────────────────────────────────────────────────

class ScoringEngine:
    def apply_gates(self, stock: StockData) -> bool:
        """Returns True if stock passes all hard gates."""
        factor = 2.0 if _RELAXED_MODE else 1.0
        if stock.liquidity.bid_ask_pct > BID_ASK_MAX_PCT * 100 * factor:
            stock.gate_failure = (
                f"Bid-ask {stock.liquidity.bid_ask_pct:.1f}% > {BID_ASK_MAX_PCT*100*factor:.0f}%"
            )
            if _DIAGNOSE:
                print(f"[GATE] {stock.ticker}: {stock.gate_failure}")
            return False
        if stock.iv_rank < IV_RANK_MIN / factor:
            stock.gate_failure = f"IV Rank {stock.iv_rank:.0f} < {IV_RANK_MIN/factor:.0f}"
            if _DIAGNOSE:
                print(f"[GATE] {stock.ticker}: {stock.gate_failure}")
            return False
        if stock.liquidity.open_interest < OPEN_INT_MIN / factor:
            stock.gate_failure = f"OI {stock.liquidity.open_interest} < {int(OPEN_INT_MIN/factor)}"
            if _DIAGNOSE:
                print(f"[GATE] {stock.ticker}: {stock.gate_failure}")
            return False
        if stock.atm_iv < IV_MIN / factor:
            stock.gate_failure = f"IV {stock.atm_iv*100:.1f}% < {IV_MIN/factor*100:.0f}%"
            if _DIAGNOSE:
                print(f"[GATE] {stock.ticker}: {stock.gate_failure}")
            return False
        # Flags (warning, not elimination)
        dte = stock.days_to_earnings
        if dte is not None and dte < EARNINGS_HIGH_DAYS:
            stock.flags.append("HIGH_RISK_EARNINGS")
        elif dte is not None and dte < EARNINGS_WARN_DAYS:
            stock.flags.append("EARNINGS_WARNING")
        return True

    def score(self, stock: StockData, sector_counts: Dict[str, int]) -> float:
        vol   = self._vol_score(stock.iv_rank)
        liq   = self._liq_score(stock.liquidity)
        earn  = self._earn_score(stock.days_to_earnings)
        sect  = self._sector_score(stock.sector, sector_counts)
        tech  = self._tech_score(stock)
        total = vol + liq + earn + sect + tech
        stock.score_breakdown = {
            "volatility_edge": round(vol,  1),
            "liquidity":       round(liq,  1),
            "earnings_safety": round(earn, 1),
            "sector_balance":  round(sect, 1),
            "technical_setup": round(tech, 1),
        }
        return round(total, 1)

    def _vol_score(self, iv_rank: float) -> float:
        return max(0.0, min(30.0,
                            (iv_rank - IV_RANK_MIN) / (100 - IV_RANK_MIN) * 30))

    def _liq_score(self, liq: LiquidityMetrics) -> float:
        oi_score  = min(10.0, liq.open_interest / 10000 * 10)
        vol_score = min(8.0,  liq.volume / 1000 * 8)
        spd_score = max(0.0,
                        (BID_ASK_MAX_PCT * 100 - liq.bid_ask_pct)
                        / (BID_ASK_MAX_PCT * 100) * 7)
        return oi_score + vol_score + spd_score

    def _earn_score(self, days: Optional[int]) -> float:
        if days is None:  return 20.0
        if days > 60:     return 20.0
        if days > 30:     return 15.0
        if days > 14:     return 10.0
        if days > 7:      return 5.0
        return 0.0

    def _sector_score(self, sector: str, counts: Dict[str, int]) -> float:
        n = counts.get(sector, 0)
        if n >= 5: return 0.0
        if n >= 4: return 5.0
        if n >= 2: return 8.0
        return 10.0

    def _tech_score(self, stock: StockData) -> float:
        pts = 0.0
        # HV declining (HV20 < HV30)
        if stock.hv20 > 0 and stock.hv30 > 0 and stock.hv20 < stock.hv30:
            pts += 3.0
        # IV moderate (not extreme)
        if 0.2 <= stock.atm_iv <= 0.7:
            pts += 5.0
        # IV rank in sweet spot (40-80)
        if 40 <= stock.iv_rank <= 80:
            pts += 4.0
        # Some structure exists
        if stock.dte >= 21:
            pts += 3.0
        return min(15.0, pts)


# ── Section 7: StrategyBuilder ─────────────────────────────────────────────────

class StrategyBuilder:
    def __init__(self, chain_fetcher: OptionsChainFetcher):
        self.cf = chain_fetcher

    def build_all(self, stock: StockData, chain: Dict) -> Dict[str, StrategyResult]:
        return {
            "bull_put_spread":  self._bull_put(stock, chain),
            "bear_call_spread": self._bear_call(stock, chain),
            "iron_condor":      self._iron_condor(stock, chain),
            "straddle":         self._straddle(stock, chain),
            "strangle":         self._strangle(stock, chain),
        }

    def _find_by_delta(self, df: pd.DataFrame, target_delta: float,
                       opt_type: str, spot: float, dte: int,
                       iv: float) -> Optional[pd.Series]:
        if df.empty:
            return None
        df = df.copy()
        T  = dte / 365
        strikes = df["strike"].values
        deltas  = []
        for k in strikes:
            g = self.cf.bs_greeks(spot, float(k), T, iv, option_type=opt_type)
            deltas.append(abs(g.delta))
        df["calc_delta"] = deltas
        df["delta_dist"] = abs(df["calc_delta"] - abs(target_delta))
        idx = df["delta_dist"].idxmin()
        return df.loc[idx]

    def _pop(self, spot: float, lower: float, upper: float,
             iv: float, dte: int) -> float:
        T   = max(dte / 365, 0.01)
        sig = iv * math.sqrt(T)
        if sig <= 0:
            return 0.5
        if upper > 0 and lower > 0:
            z_u = math.log(upper / spot) / sig
            z_l = math.log(lower / spot) / sig
            return float(norm.cdf(z_u) - norm.cdf(z_l))
        elif upper > 0:
            z_u = math.log(upper / spot) / sig
            return float(norm.cdf(z_u))
        else:
            return 0.5

    def _pnl_chart(self, spot: float,
                   strategy_fn) -> Tuple[List[float], List[float]]:
        prices = [round(spot * (0.75 + i * 0.005), 2) for i in range(101)]
        pnls   = [strategy_fn(p) for p in prices]
        return prices, pnls

    # ── Bull Put Spread ────────────────────────────────────────────────────────
    def _bull_put(self, stock: StockData, chain: Dict) -> StrategyResult:
        try:
            spot = stock.spot_price
            puts = chain["puts"]
            iv   = stock.atm_iv or 0.3
            sell = self._find_by_delta(puts, -0.30, "put", spot, stock.dte, iv)
            buy  = self._find_by_delta(puts, -0.15, "put", spot, stock.dte, iv)
            if sell is None or buy is None:
                return StrategyResult("Bull Put Spread", valid=False, error="No strikes")
            sell_k = float(sell["strike"])
            buy_k  = float(buy["strike"])
            if buy_k >= sell_k:
                all_puts = puts[puts["strike"] < sell_k]
                if all_puts.empty:
                    return StrategyResult("Bull Put Spread", valid=False,
                                         error="No lower strikes")
                buy_row  = all_puts.iloc[-1]
                buy_k    = float(buy_row["strike"])
                sell_bid = float(sell.get("bid", 0) or 0)
                buy_ask  = float(buy_row.get("ask", 0) or 0)
            else:
                sell_bid = float(sell.get("bid", 0) or 0)
                buy_ask  = float(buy.get("ask", 0) or 0)
            net = sell_bid - buy_ask
            if net <= 0:
                net = (sell_k - buy_k) * 0.15   # estimate
            max_p = net * 100
            max_l = (sell_k - buy_k - net) * 100
            be    = sell_k - net
            pop   = self._pop(spot, be, spot * 2, iv, stock.dte)
            T     = stock.dte / 365
            g_sell = self.cf.bs_greeks(spot, sell_k, T, iv, "put")
            g_buy  = self.cf.bs_greeks(spot, buy_k,  T, iv, "put")

            def _pnl(p, _net=net, _sell_k=sell_k, _buy_k=buy_k):
                if p >= _sell_k:
                    return _net * 100
                elif p <= _buy_k:
                    return (_net - (_sell_k - _buy_k)) * 100
                else:
                    return (_net - (_sell_k - p)) * 100

            prices, pnls = self._pnl_chart(spot, _pnl)
            return StrategyResult(
                "Bull Put Spread",
                max_profit=max_p, max_loss=abs(max_l),
                net_credit=net, breakeven_lower=be,
                prob_of_profit=pop,
                delta=g_sell.delta - g_buy.delta,
                theta=g_sell.theta - g_buy.theta,
                vega=g_sell.vega  - g_buy.vega,
                sell_strike=sell_k, buy_strike=buy_k,
                pnl_prices=prices, pnl_values=pnls,
            )
        except Exception as e:
            return StrategyResult("Bull Put Spread", valid=False, error=str(e))

    # ── Bear Call Spread ───────────────────────────────────────────────────────
    def _bear_call(self, stock: StockData, chain: Dict) -> StrategyResult:
        try:
            spot  = stock.spot_price
            calls = chain["calls"]
            iv    = stock.atm_iv or 0.3
            sell  = self._find_by_delta(calls, 0.30, "call", spot, stock.dte, iv)
            buy   = self._find_by_delta(calls, 0.15, "call", spot, stock.dte, iv)
            if sell is None or buy is None:
                return StrategyResult("Bear Call Spread", valid=False, error="No strikes")
            sell_k = float(sell["strike"])
            buy_k  = float(buy["strike"])
            if buy_k <= sell_k:
                higher = calls[calls["strike"] > sell_k]
                if higher.empty:
                    return StrategyResult("Bear Call Spread", valid=False,
                                         error="No higher strikes")
                buy_row = higher.iloc[0]
                buy_k   = float(buy_row["strike"])
                buy_ask = float(buy_row.get("ask", 0) or 0)
            else:
                buy_ask = float(buy.get("ask", 0) or 0)
            sell_bid = float(sell.get("bid", 0) or 0)
            net  = sell_bid - buy_ask
            if net <= 0:
                net = (buy_k - sell_k) * 0.15
            max_p = net * 100
            max_l = (buy_k - sell_k - net) * 100
            be    = sell_k + net
            pop   = 1.0 - self._pop(spot, 0.01, be, iv, stock.dte)
            T     = stock.dte / 365
            g_sell = self.cf.bs_greeks(spot, sell_k, T, iv, "call")
            g_buy  = self.cf.bs_greeks(spot, buy_k,  T, iv, "call")

            def _pnl(p, _net=net, _sell_k=sell_k, _buy_k=buy_k):
                if p <= _sell_k:
                    return _net * 100
                elif p >= _buy_k:
                    return (_net - (_buy_k - _sell_k)) * 100
                else:
                    return (_net - (p - _sell_k)) * 100

            prices, pnls = self._pnl_chart(spot, _pnl)
            return StrategyResult(
                "Bear Call Spread",
                max_profit=max_p, max_loss=abs(max_l),
                net_credit=net, breakeven_upper=be,
                prob_of_profit=pop,
                delta=g_sell.delta - g_buy.delta,
                theta=g_sell.theta - g_buy.theta,
                vega=g_sell.vega  - g_buy.vega,
                sell_strike=sell_k, buy_strike=buy_k,
                pnl_prices=prices, pnl_values=pnls,
            )
        except Exception as e:
            return StrategyResult("Bear Call Spread", valid=False, error=str(e))

    # ── Iron Condor ────────────────────────────────────────────────────────────
    def _iron_condor(self, stock: StockData, chain: Dict) -> StrategyResult:
        try:
            bp = self._bull_put(stock, chain)
            bc = self._bear_call(stock, chain)
            if not bp.valid or not bc.valid:
                return StrategyResult("Iron Condor", valid=False, error="Legs invalid")
            net   = bp.net_credit + bc.net_credit
            max_p = net * 100
            max_l = max(bp.max_loss, bc.max_loss) - net * 100
            be_l  = bp.breakeven_lower
            be_u  = bc.breakeven_upper
            spot  = stock.spot_price
            iv    = stock.atm_iv or 0.3
            pop   = self._pop(spot, be_l, be_u, iv, stock.dte)

            def _pnl(p, _net=net, _be_l=be_l, _be_u=be_u):
                if _be_l <= p <= _be_u:
                    return _net * 100
                return (_net
                        - max(0.0, _be_l - p)
                        - max(0.0, p - _be_u)) * 100

            prices, pnls = self._pnl_chart(spot, _pnl)
            return StrategyResult(
                "Iron Condor",
                max_profit=max_p, max_loss=abs(max_l),
                net_credit=net, breakeven_lower=be_l, breakeven_upper=be_u,
                prob_of_profit=pop,
                delta=bp.delta + bc.delta,
                theta=bp.theta + bc.theta,
                vega=bp.vega  + bc.vega,
                pnl_prices=prices, pnl_values=pnls,
            )
        except Exception as e:
            return StrategyResult("Iron Condor", valid=False, error=str(e))

    # ── Straddle ───────────────────────────────────────────────────────────────
    def _straddle(self, stock: StockData, chain: Dict) -> StrategyResult:
        try:
            spot  = stock.spot_price
            calls = chain["calls"].copy()
            puts  = chain["puts"].copy()
            iv    = stock.atm_iv or 0.3
            calls["dist"] = abs(calls["strike"] - spot)
            puts["dist"]  = abs(puts["strike"]  - spot)
            atm_call = calls.loc[calls["dist"].idxmin()]
            atm_put  = puts.loc[puts["dist"].idxmin()]
            call_ask = float(atm_call.get("ask", 0) or 0)
            put_ask  = float(atm_put.get("ask",  0) or 0)
            cost = call_ask + put_ask
            if cost <= 0:
                cost = spot * iv * math.sqrt(stock.dte / 365) * 1.25
            max_l = cost * 100
            k     = float(atm_call["strike"])
            be_l  = k - cost
            be_u  = k + cost
            pop   = 1.0 - self._pop(spot, be_l, be_u, iv, stock.dte)
            T     = stock.dte / 365
            g_c   = self.cf.bs_greeks(spot, k, T, iv, "call")
            g_p   = self.cf.bs_greeks(spot, k, T, iv, "put")

            def _pnl(p, _k=k, _cost=cost):
                return (abs(p - _k) - _cost) * 100

            prices, pnls = self._pnl_chart(spot, _pnl)
            return StrategyResult(
                "Straddle",
                max_profit=99999, max_loss=max_l,
                net_credit=-cost, breakeven_lower=be_l, breakeven_upper=be_u,
                prob_of_profit=pop,
                delta=g_c.delta + g_p.delta,
                theta=g_c.theta + g_p.theta,
                vega=g_c.vega  + g_p.vega,
                pnl_prices=prices, pnl_values=pnls,
            )
        except Exception as e:
            return StrategyResult("Straddle", valid=False, error=str(e))

    # ── Strangle ───────────────────────────────────────────────────────────────
    def _strangle(self, stock: StockData, chain: Dict) -> StrategyResult:
        try:
            spot     = stock.spot_price
            iv       = stock.atm_iv or 0.3
            calls    = chain["calls"]
            puts     = chain["puts"]
            otm_call = self._find_by_delta(calls, 0.25,  "call", spot, stock.dte, iv)
            otm_put  = self._find_by_delta(puts,  -0.25, "put",  spot, stock.dte, iv)
            if otm_call is None or otm_put is None:
                return StrategyResult("Strangle", valid=False, error="No strikes")
            call_k   = float(otm_call["strike"])
            put_k    = float(otm_put["strike"])
            call_ask = float(otm_call.get("ask", 0) or 0)
            put_ask  = float(otm_put.get("ask",  0) or 0)
            cost = call_ask + put_ask
            if cost <= 0:
                cost = spot * iv * math.sqrt(stock.dte / 365) * 0.9
            max_l = cost * 100
            be_l  = put_k  - cost
            be_u  = call_k + cost
            pop   = 1.0 - self._pop(spot, be_l, be_u, iv, stock.dte)
            T     = stock.dte / 365
            g_c   = self.cf.bs_greeks(spot, call_k, T, iv, "call")
            g_p   = self.cf.bs_greeks(spot, put_k,  T, iv, "put")

            def _pnl(p, _put_k=put_k, _call_k=call_k, _cost=cost):
                return (max(0.0, _put_k - p) + max(0.0, p - _call_k) - _cost) * 100

            prices, pnls = self._pnl_chart(spot, _pnl)
            return StrategyResult(
                "Strangle",
                max_profit=99999, max_loss=max_l,
                net_credit=-cost, breakeven_lower=be_l, breakeven_upper=be_u,
                prob_of_profit=pop,
                delta=g_c.delta + g_p.delta,
                theta=g_c.theta + g_p.theta,
                vega=g_c.vega  + g_p.vega,
                pnl_prices=prices, pnl_values=pnls,
            )
        except Exception as e:
            return StrategyResult("Strangle", valid=False, error=str(e))


# ── Section 8: NewsAndRatings ──────────────────────────────────────────────────

class NewsAndRatings:
    def __init__(self, cache: DataCache):
        self.cache = cache

    def get_headlines(self, ticker: str) -> List[str]:
        key    = self.cache.key("news", ticker)
        cached = self.cache.get(key)
        if cached is not None:
            return cached
        try:
            t = yf.Ticker(ticker)
            news = t.news or []
            headlines = [item.get("title", "") for item in news[:3]
                         if item.get("title")]
            self.cache.set(key, headlines, ttl=1800)
            return headlines
        except Exception:
            return []

    def get_analyst_rating(self, ticker: str) -> AnalystRating:
        key    = self.cache.key("analyst", ticker)
        cached = self.cache.get(key)
        if cached is not None:
            return cached
        try:
            t    = yf.Ticker(ticker)
            recs = t.recommendations
            if recs is None or recs.empty:
                return AnalystRating()
            # Recent 90 days
            cutoff    = datetime.now() - timedelta(days=90)
            recs.index = pd.to_datetime(recs.index)
            recent    = recs[recs.index >= cutoff]
            if recent.empty:
                recent = recs.tail(10)
            buys = holds = sells = 0
            for _, row in recent.iterrows():
                grade = str(row.get("To Grade",
                                    row.get("Action", ""))).lower()
                if any(w in grade for w in
                       ["buy", "outperform", "overweight", "strong buy"]):
                    buys += 1
                elif any(w in grade for w in
                         ["hold", "neutral", "market perform", "equal"]):
                    holds += 1
                elif any(w in grade for w in
                         ["sell", "underperform", "underweight"]):
                    sells += 1
            total = buys + holds + sells
            if total == 0:
                return AnalystRating()
            if buys / total >= 0.6:
                cons = "Strong Buy" if buys / total >= 0.75 else "Buy"
            elif sells / total >= 0.4:
                cons = "Sell"
            else:
                cons = "Hold"
            # Price target
            try:
                pt = float(t.info.get("targetMeanPrice", 0) or 0)
            except Exception:
                pt = 0.0
            rating = AnalystRating(
                consensus=cons, buy_count=buys, hold_count=holds,
                sell_count=sells, total_analysts=total, price_target=pt,
            )
            self.cache.set(key, rating, ttl=3600)
            return rating
        except Exception:
            return AnalystRating()


# ── Section 9: ClaudeAnalyzer ──────────────────────────────────────────────────

class ClaudeAnalyzer:
    def __init__(self, api_key: str):
        import anthropic
        self.client = anthropic.Anthropic(api_key=api_key)
        self.model  = "claude-sonnet-4-6"

    def analyze(self, stocks: List[StockData], total_scanned: int,
                total_passed: int) -> Dict:
        if not stocks:
            return {"raw": "No stocks to analyze.", "tokens": 0, "cost": 0}
        table_rows = []
        for i, s in enumerate(stocks[:20], 1):
            valid_strats = {k: v for k, v in s.strategies.items() if v.valid}
            best = (max(valid_strats.values(),
                        key=lambda x: x.prob_of_profit)
                    if valid_strats else None)
            best_name = best.name[:12]              if best else "N/A"
            best_pop  = f"{best.prob_of_profit*100:.0f}%" if best else "N/A"
            dte_earn  = (str(s.days_to_earnings) + "d"
                         if s.days_to_earnings else ">60d")
            table_rows.append(
                f"{i:2}. {s.ticker:<6} {s.score:5.1f}  {s.atm_iv*100:5.1f}%  "
                f"{s.iv_rank:5.1f}  {s.hv20:5.1f}%  {dte_earn:>6}  "
                f"{s.sector[:15]:<15}  {best_name:<14}  {best_pop:<6}  "
                f"{s.analyst.consensus}"
            )
        table_str = "\n".join(table_rows)
        prompt = f"""You are a professional options trading analyst. Analyze these top S&P 500 stocks from today's options scanner.

SCAN METADATA:
- Date: {datetime.now().strftime('%Y-%m-%d')}
- Total scanned: {total_scanned}
- Passed hard gates: {total_passed}

TOP {len(stocks[:20])} STOCKS (ranked by score):
 #   Ticker  Score   IV%  IVRnk  HV20%  EarnDTE  Sector            Best Strategy  POP     Rating
{table_str}

Provide analysis in EXACTLY these sections (use the headers as shown):

PATTERN SUMMARY:
- [3-5 bullet points of macro patterns you see in this data]

TOP 3 OPPORTUNITIES:
1. [TICKER] - [strategy] - [2-3 sentence reasoning with specific numbers]
2. [TICKER] - [strategy] - [2-3 sentence reasoning]
3. [TICKER] - [strategy] - [2-3 sentence reasoning]

CONCENTRATION RISKS:
- [sector/correlation warnings]

ANOMALIES:
- [anything unusual: extreme IV, suspicious data, outliers]

MARKET REGIME NOTE:
[One sentence about current implied volatility environment]

Be specific. Reference actual tickers and numbers. Keep under 600 words total."""

        try:
            resp = self.client.messages.create(
                model=self.model, max_tokens=1200,
                system="You are a professional options trading analyst. Be concise and data-driven.",
                messages=[{"role": "user", "content": prompt}],
            )
            text          = resp.content[0].text
            input_tokens  = resp.usage.input_tokens
            output_tokens = resp.usage.output_tokens
            # Sonnet pricing: $3/M input, $15/M output
            cost = (input_tokens * 3 + output_tokens * 15) / 1_000_000
            return {"raw": text, "tokens": input_tokens + output_tokens, "cost": cost}
        except Exception as e:
            return {"raw": f"Claude analysis failed: {e}", "tokens": 0, "cost": 0}


# ── Section 10: ReportGenerator ───────────────────────────────────────────────

class ReportGenerator:
    def __init__(self, output_dir: Path):
        self.output_dir = output_dir
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.console = Console(legacy_windows=False)

    def print_terminal(self, stocks: List[StockData], total: int, passed: int,
                       eliminated: List[StockData], claude: Dict,
                       args: argparse.Namespace) -> None:
        ts = datetime.now().strftime("%Y-%m-%d %H:%M")
        self.console.print(Panel(
            f"[bold cyan]OPTIONS SCANNER — {ts}[/bold cyan]\n"
            f"Scanned: [white]{total}[/white]  |  "
            f"Passed gates: [green]{passed}[/green]  |  "
            f"Showing top: [yellow]{len(stocks)}[/yellow]",
            border_style="cyan",
        ))

        table = Table(show_header=True, header_style="bold magenta",
                      border_style="dim", box=None)
        table.add_column("#",            width=3)
        table.add_column("Ticker",       width=6)
        table.add_column("Score",        width=6)
        table.add_column("IV%",          width=5)
        table.add_column("IVRnk",        width=6)
        table.add_column("HV20%",        width=6)
        table.add_column("DTE",          width=4)
        table.add_column("Earn",         width=6)
        table.add_column("Sector",       width=18)
        table.add_column("Best Strategy",width=15)
        table.add_column("POP",          width=5)
        table.add_column("Rating",       width=10)
        table.add_column("Flags",        width=10)

        for i, s in enumerate(stocks, 1):
            score_col = (
                "[green]" if s.score >= 70 else
                "[yellow]" if s.score >= 50 else
                "[red]"
            )
            valid_strats = {k: v for k, v in s.strategies.items() if v.valid}
            best = (max(valid_strats.values(), key=lambda x: x.prob_of_profit)
                    if valid_strats else None)
            best_name = best.name           if best else "N/A"
            best_pop  = f"{best.prob_of_profit*100:.0f}%" if best else "N/A"
            earn_str  = f"{s.days_to_earnings}d" if s.days_to_earnings else ">60d"
            earn_col  = (
                "[red]"    if s.days_to_earnings and s.days_to_earnings < 7  else
                "[yellow]" if s.days_to_earnings and s.days_to_earnings < 14 else
                "[white]"
            )
            flags_str = ",".join(f[:8] for f in s.flags) if s.flags else ""
            table.add_row(
                str(i),
                f"[bold]{s.ticker}[/bold]",
                f"{score_col}{s.score:.1f}[/]",
                f"{s.atm_iv*100:.1f}%",
                f"{s.iv_rank:.0f}",
                f"{s.hv20:.1f}%",
                str(s.dte),
                f"{earn_col}{earn_str}[/]",
                s.sector[:18],
                best_name[:15],
                best_pop,
                s.analyst.consensus,
                f"[yellow]{flags_str}[/yellow]" if flags_str else "",
            )
        self.console.print(table)

        # Claude analysis block
        if claude.get("raw") and "failed" not in claude["raw"].lower():
            self.console.print(Panel(
                claude["raw"],
                title="[bold yellow]Claude AI Analysis[/bold yellow]",
                border_style="yellow",
            ))
            self.console.print(
                f"[dim]Tokens: {claude.get('tokens', 0):,}  |  "
                f"Cost: ${claude.get('cost', 0):.4f}[/dim]"
            )

        # Always show gate failure breakdown so we know why stocks were eliminated
        if eliminated:
            # Count reasons
            reason_counts: Dict[str, int] = {}
            for s in eliminated:
                # Bucket the reason (take first word/phrase before the number)
                key = s.gate_failure.split(" ")[0] + " " + s.gate_failure.split(" ")[1] if len(s.gate_failure.split(" ")) > 1 else s.gate_failure
                reason_counts[key] = reason_counts.get(key, 0) + 1
            self.console.print(f"\n[dim]── Gate failures ({len(eliminated)} eliminated) ──[/dim]")
            for reason, count in sorted(reason_counts.items(), key=lambda x: -x[1])[:8]:
                self.console.print(f"  [dim]{count:>4}x  {reason}[/dim]")
            if args.verbose:
                self.console.print(f"\n[dim]First 20 eliminations:[/dim]")
                for s in eliminated[:20]:
                    self.console.print(f"  [dim]{s.ticker:<6} — {s.gate_failure}[/dim]")

    def save_json(self, stocks: List[StockData], eliminated: List[StockData],
                  claude: Dict, total: int) -> Path:
        ts   = datetime.now().strftime("%Y%m%d_%H%M%S")
        path = self.output_dir / f"options_results_{ts}.json"

        def strat_dict(s: StrategyResult) -> Dict:
            return {
                "name":             s.name,
                "max_profit":       round(s.max_profit,  2),
                "max_loss":         round(s.max_loss,    2),
                "net_credit":       round(s.net_credit,  4),
                "breakeven_lower":  round(s.breakeven_lower, 2),
                "breakeven_upper":  round(s.breakeven_upper, 2),
                "prob_of_profit":   round(s.prob_of_profit,  3),
                "delta":            round(s.delta, 4),
                "theta":            round(s.theta, 4),
                "vega":             round(s.vega,  4),
                "sell_strike":      round(s.sell_strike, 2),
                "buy_strike":       round(s.buy_strike,  2),
                "valid":            s.valid,
            }

        output = {
            "scan_metadata": {
                "timestamp":     datetime.now().isoformat(),
                "total_scanned": total,
                "passed_gates":  len(stocks) + len(eliminated),
                "top_n":         len(stocks),
            },
            "top_stocks": [
                {
                    "ticker":  s.ticker,
                    "company": s.company,
                    "sector":  s.sector,
                    "score":   s.score,
                    "score_breakdown": s.score_breakdown,
                    "metrics": {
                        "spot_price":       s.spot_price,
                        "atm_iv":           round(s.atm_iv,          4),
                        "iv_rank":          round(s.iv_rank,          1),
                        "iv_percentile":    round(s.iv_percentile,    1),
                        "hv20":             round(s.hv20,             2),
                        "hv30":             round(s.hv30,             2),
                        "dte":              s.dte,
                        "expiration":       s.expiration,
                        "days_to_earnings": s.days_to_earnings,
                        "open_interest":    s.liquidity.open_interest,
                        "bid_ask_pct":      round(s.liquidity.bid_ask_pct, 2),
                    },
                    "greeks":     asdict(s.atm_greeks),
                    "flags":      s.flags,
                    "strategies": {k: strat_dict(v) for k, v in s.strategies.items()},
                    "news":       s.headlines,
                    "analyst":    asdict(s.analyst),
                }
                for s in stocks
            ],
            "claude_analysis":   claude,
            "eliminated_count":  len(eliminated),
            "eliminated_sample": [
                {"ticker": s.ticker, "reason": s.gate_failure}
                for s in eliminated[:50]
            ],
        }
        path.write_text(json.dumps(output, indent=2, default=str))
        return path

    def save_html(self, stocks: List[StockData], claude: Dict,
                  total: int, passed: int) -> Path:
        ts_str  = datetime.now().strftime("%Y-%m-%d %H:%M")
        ts_file = datetime.now().strftime("%Y%m%d_%H%M%S")
        path    = self.output_dir / f"options_report_{ts_file}.html"

        stock_cards = ""
        for i, s in enumerate(stocks, 1):
            valid_strats = {k: v for k, v in s.strategies.items() if v.valid}
            best = (max(valid_strats.values(), key=lambda x: x.prob_of_profit)
                    if valid_strats else None)

            # P&L chart (iron condor or best strategy)
            chart_html  = ""
            chart_strat = s.strategies.get("iron_condor") or best
            if (chart_strat and chart_strat.valid
                    and chart_strat.pnl_prices):
                colors = ["green" if v >= 0 else "red"
                          for v in chart_strat.pnl_values]
                fig = go.Figure()
                fig.add_trace(go.Bar(
                    x=chart_strat.pnl_prices,
                    y=chart_strat.pnl_values,
                    marker_color=colors,
                    name="P&L",
                ))
                fig.update_layout(
                    height=200,
                    margin=dict(l=10, r=10, t=10, b=10),
                    paper_bgcolor="#0d1117",
                    plot_bgcolor="#0d1117",
                    font_color="#c9d1d9",
                    showlegend=False,
                    xaxis=dict(gridcolor="#21262d"),
                    yaxis=dict(gridcolor="#21262d", tickprefix="$"),
                )
                chart_html = pio.to_html(fig, full_html=False,
                                         include_plotlyjs=False)

            # Strategy table rows
            strat_rows = ""
            for sname, sr in s.strategies.items():
                if sr.valid:
                    strat_rows += (
                        f"<tr>"
                        f"<td>{sr.name}</td>"
                        f'<td style="color:#3fb950">${sr.max_profit:.0f}</td>'
                        f'<td style="color:#f85149">${sr.max_loss:.0f}</td>'
                        f"<td>${sr.net_credit:.2f}</td>"
                        f"<td>{sr.prob_of_profit*100:.0f}%</td>"
                        f"<td>{sr.delta:.3f}</td>"
                        f"<td>{sr.theta:.3f}</td>"
                        f"<td>{sr.vega:.3f}</td>"
                        f"</tr>"
                    )

            flags_html = " ".join(
                f'<span class="flag">{f}</span>' for f in s.flags
            )
            news_html  = "".join(f"<li>{h}</li>" for h in s.headlines)
            score_color = (
                "#3fb950" if s.score >= 70 else
                "#d29922" if s.score >= 50 else
                "#f85149"
            )
            earn_display = (str(s.days_to_earnings) + "d"
                            if s.days_to_earnings else ">60d")

            stock_cards += f"""
            <div class="stock-card">
              <div class="card-header">
                <span class="rank">#{i}</span>
                <span class="ticker">{s.ticker}</span>
                <span class="company">{s.company}</span>
                <span class="score" style="color:{score_color}">{s.score:.1f}</span>
                <span class="sector-badge">{s.sector}</span>
                {flags_html}
              </div>
              <div class="card-body">
                <div class="metrics-grid">
                  <div class="metric"><label>IV</label><value>{s.atm_iv*100:.1f}%</value></div>
                  <div class="metric"><label>IV Rank</label><value>{s.iv_rank:.0f}</value></div>
                  <div class="metric"><label>HV20</label><value>{s.hv20:.1f}%</value></div>
                  <div class="metric"><label>HV30</label><value>{s.hv30:.1f}%</value></div>
                  <div class="metric"><label>DTE</label><value>{s.dte}d</value></div>
                  <div class="metric"><label>Earnings</label><value>{earn_display}</value></div>
                  <div class="metric"><label>Spot</label><value>${s.spot_price:.2f}</value></div>
                  <div class="metric"><label>Analyst</label><value>{s.analyst.consensus}</value></div>
                </div>
                <div class="pnl-chart">{chart_html}</div>
                <table class="strat-table">
                  <thead><tr>
                    <th>Strategy</th><th>Max Profit</th><th>Max Loss</th>
                    <th>Credit</th><th>POP</th><th>Delta</th><th>Theta</th><th>Vega</th>
                  </tr></thead>
                  <tbody>{strat_rows}</tbody>
                </table>
                <div class="news"><strong>Recent News:</strong><ul>{news_html}</ul></div>
              </div>
            </div>"""

        claude_html = ""
        if claude.get("raw"):
            claude_html = f"""
        <div class="claude-section">
          <h2>Claude AI Analysis</h2>
          <pre>{claude.get('raw', 'No AI analysis available.')}</pre>
          <p class="cost-note">Tokens: {claude.get('tokens', 0):,} | Cost: ${claude.get('cost', 0):.4f}</p>
        </div>"""

        html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Options Scanner &mdash; {ts_str}</title>
<script src="https://cdn.plot.ly/plotly-2.26.0.min.js"></script>
<style>
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{ background: #0d1117; color: #c9d1d9; font-family: -apple-system, monospace; padding: 20px; }}
  h1 {{ color: #58a6ff; margin-bottom: 20px; }}
  .summary {{ background: #161b22; border: 1px solid #30363d; border-radius: 8px;
              padding: 16px; margin-bottom: 24px; display: flex; gap: 32px; }}
  .summary span {{ font-size: 14px; }}
  .summary strong {{ color: #58a6ff; }}
  .stock-card {{ background: #161b22; border: 1px solid #30363d; border-radius: 8px;
                 margin-bottom: 20px; overflow: hidden; }}
  .card-header {{ background: #21262d; padding: 12px 16px; display: flex; align-items: center; gap: 12px; }}
  .rank {{ color: #8b949e; font-size: 12px; }}
  .ticker {{ font-size: 20px; font-weight: bold; color: #e6edf3; }}
  .company {{ color: #8b949e; font-size: 13px; flex: 1; }}
  .score {{ font-size: 24px; font-weight: bold; }}
  .sector-badge {{ background: #1f6feb33; color: #58a6ff; padding: 2px 8px;
                   border-radius: 12px; font-size: 11px; }}
  .flag {{ background: #f8514922; color: #f85149; padding: 2px 6px;
           border-radius: 4px; font-size: 11px; }}
  .card-body {{ padding: 16px; }}
  .metrics-grid {{ display: grid; grid-template-columns: repeat(8, 1fr); gap: 8px; margin-bottom: 16px; }}
  .metric {{ background: #0d1117; border-radius: 4px; padding: 8px; text-align: center; }}
  .metric label {{ display: block; font-size: 10px; color: #8b949e; margin-bottom: 4px; }}
  .metric value {{ font-size: 14px; font-weight: bold; }}
  .pnl-chart {{ margin: 12px 0; }}
  .strat-table {{ width: 100%; border-collapse: collapse; font-size: 12px; margin: 12px 0; }}
  .strat-table th {{ background: #21262d; padding: 6px 10px; text-align: left;
                     color: #8b949e; font-weight: normal; }}
  .strat-table td {{ padding: 5px 10px; border-bottom: 1px solid #21262d; }}
  .news {{ font-size: 12px; color: #8b949e; margin-top: 12px; }}
  .news ul {{ padding-left: 16px; }}
  .news li {{ margin: 3px 0; }}
  .claude-section {{ background: #161b22; border: 1px solid #d29922; border-radius: 8px;
                     padding: 20px; margin: 24px 0; }}
  .claude-section h2 {{ color: #d29922; margin-bottom: 16px; }}
  .claude-section pre {{ white-space: pre-wrap; line-height: 1.6; font-size: 13px; }}
  .cost-note {{ color: #8b949e; font-size: 11px; margin-top: 8px; }}
</style>
</head>
<body>
<h1>S&amp;P 500 Options Scanner</h1>
<div class="summary">
  <span>Time: <strong>{ts_str}</strong></span>
  <span>Scanned: <strong>{total}</strong></span>
  <span>Passed gates: <strong>{passed}</strong></span>
  <span>Showing: <strong>{len(stocks)}</strong></span>
</div>
{claude_html}
{stock_cards}
</body>
</html>"""
        path.write_text(html, encoding="utf-8")
        return path


# ── Section 11: Orchestrator and entry point ───────────────────────────────────

def send_telegram(token: str, chat_id: str, message: str) -> None:
    try:
        url = f"https://api.telegram.org/bot{token}/sendMessage"
        requests.post(
            url,
            json={"chat_id": chat_id, "text": message, "parse_mode": "HTML"},
            timeout=10,
        )
    except Exception:
        pass


class OptionScanner:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        # Load .env from project root (one directory above scripts/)
        env_path = Path(__file__).parent.parent / ".env"
        load_dotenv(env_path)
        self.claude_key = os.getenv("CLAUDE_API_KEY", "")
        self.tg_token   = os.getenv("TELEGRAM_BOT_TOKEN", "")
        self.tg_chat    = os.getenv("TELEGRAM_CHAT_ID", "")

        # Allow output-dir override
        if args.output_dir:
            output_dir = Path(args.output_dir)
        else:
            output_dir = Path(__file__).parent / "output"

        cache_dir     = output_dir / ".cache"
        self.cache    = DataCache(cache_dir)
        self.sp500    = SP500Fetcher(self.cache)
        self.vol_eng  = VolatilityEngine(self.cache)
        self.chain_f  = OptionsChainFetcher(self.cache)
        self.scorer   = ScoringEngine()
        self.builder  = StrategyBuilder(self.chain_f)
        self.news     = NewsAndRatings(self.cache)
        self.reporter = ReportGenerator(output_dir)
        self.console  = Console(legacy_windows=False)

    # ──────────────────────────────────────────────────────────────────────────
    def run(self) -> None:
        if self.args.clear_cache:
            self.cache.clear()
            self.console.print("[yellow]Cache cleared.[/yellow]")

        # Resolve ticker list
        if self.args.tickers:
            tickers_raw = [
                {"ticker": t, "company": t, "sector": "Unknown"}
                for t in self.args.tickers
            ]
        else:
            self.console.print("[cyan]Fetching S&P 500 list...[/cyan]")
            tickers_raw = self.sp500.get_tickers()
            if self.args.sectors:
                tickers_raw = [
                    t for t in tickers_raw
                    if any(s.lower() in t["sector"].lower()
                           for s in self.args.sectors)
                ]

        total = len(tickers_raw)
        self.console.print(f"[cyan]Scanning {total} stocks...[/cyan]")

        passed:     List[StockData] = []
        eliminated: List[StockData] = []
        sector_counts: Dict[str, int] = {}

        with tqdm(
            total=total, desc="Scanning", unit="stock",
            bar_format="{l_bar}{bar}| {n_fmt}/{total_fmt} [{elapsed}<{remaining}]",
        ) as pbar:
            for info in tickers_raw:
                ticker = info["ticker"]
                pbar.set_postfix({"ticker": ticker})
                stock = self._analyze_ticker(info, sector_counts)
                if stock:
                    if stock.gate_failure:
                        eliminated.append(stock)
                    else:
                        sector_counts[stock.sector] = (
                            sector_counts.get(stock.sector, 0) + 1
                        )
                        passed.append(stock)
                pbar.update(1)
                time.sleep(RATE_LIMIT_DELAY)

        # Apply min-score filter then sort
        if self.args.min_score > 0:
            passed = [s for s in passed if s.score >= self.args.min_score]
        passed.sort(key=lambda s: s.score, reverse=True)
        top_n     = self.args.top_n
        top_stocks = passed[:top_n]

        # Claude analysis
        claude_result: Dict = {"raw": "", "tokens": 0, "cost": 0.0}
        if not self.args.no_ai and self.claude_key:
            self.console.print("[yellow]Running Claude analysis...[/yellow]")
            analyzer = ClaudeAnalyzer(self.claude_key)
            claude_result = analyzer.analyze(top_stocks, total, len(passed))
        elif not self.claude_key:
            self.console.print(
                "[dim]No CLAUDE_API_KEY — skipping AI analysis[/dim]"
            )

        # Terminal output
        self.reporter.print_terminal(
            top_stocks, total, len(passed), eliminated, claude_result, self.args
        )

        # JSON
        json_path = self.reporter.save_json(
            top_stocks, eliminated, claude_result, total
        )
        self.console.print(f"[green]JSON saved: {json_path}[/green]")

        # HTML
        if not self.args.no_html:
            html_path = self.reporter.save_html(
                top_stocks, claude_result, total, len(passed)
            )
            self.console.print(f"[green]HTML report: {html_path}[/green]")

        # Telegram
        if self.args.telegram and self.tg_token and self.tg_chat:
            lines = []
            for i, s in enumerate(top_stocks[:3], 1):
                valid_strats = {k: v for k, v in s.strategies.items() if v.valid}
                best = (max(valid_strats.values(),
                            key=lambda x: x.prob_of_profit)
                        if valid_strats else None)
                bname = best.name                        if best else "N/A"
                bpop  = f"{best.prob_of_profit*100:.0f}%" if best else "N/A"
                lines.append(
                    f"{i}. <b>{s.ticker}</b>  Score:{s.score:.0f}  "
                    f"{bname}  POP:{bpop}"
                )
            ai_note = (claude_result["raw"].split("\n")[0]
                       if claude_result.get("raw") else "")
            msg = (
                f"<b>OPTIONS SCAN COMPLETE</b> — "
                f"{datetime.now().strftime('%Y-%m-%d %H:%M')}\n\n"
                f"{total} scanned | {len(passed)} passed gates\n\n"
                f"<b>TOP 3:</b>\n" + "\n".join(lines) +
                (f"\n\n{ai_note}" if ai_note else "")
            )
            send_telegram(self.tg_token, self.tg_chat, msg)
            self.console.print("[green]Telegram sent.[/green]")

        # IBKR paper trading
        if (self.args.ibkr or self.args.ibkr_dry_run) and top_stocks:
            try:
                from ibkr_trader import trade_from_scan
                dry = self.args.ibkr_dry_run
                label = "[DRY RUN] " if dry else ""
                self.console.print(
                    f"[cyan]{label}Submitting trades to IBKR Gateway...[/cyan]"
                )
                trades = trade_from_scan(str(json_path), dry_run=dry)
                if trades:
                    self.console.print(
                        f"[green]{label}Placed {len(trades)} trade(s):[/green]"
                    )
                    for t in trades:
                        self.console.print(
                            f"  [white]{t['ticker']:6s}[/white]  {t['type']}  "
                            f"sell {t.get('sell_strike','?')} / buy {t.get('buy_strike','?')}  "
                            f"exp {t.get('expiry','?')}  credit ${t.get('credit',0):.2f}"
                        )
                else:
                    self.console.print("[yellow]No trades placed (check Gateway connection)[/yellow]")
            except ImportError:
                self.console.print("[red]ibkr_trader.py not found in scripts/[/red]")
            except Exception as e:
                self.console.print(f"[red]IBKR error: {e}[/red]")

    # ──────────────────────────────────────────────────────────────────────────
    def _analyze_ticker(self, info: Dict,
                        sector_counts: Dict[str, int]) -> Optional[StockData]:
        ticker  = info["ticker"]
        company = info.get("company", ticker)
        sector  = info.get("sector", "Unknown")
        try:
            # Price history
            price_df = self.vol_eng.get_price_history(ticker)
            if price_df is None or len(price_df) < 30:
                return None

            hv20       = self.vol_eng.compute_hv(price_df, 20)
            hv30       = self.vol_eng.compute_hv(price_df, 30)
            hv_history = self.vol_eng.get_hv_history(price_df, 20)
            iv_rank    = self.vol_eng.compute_iv_rank(hv_history, hv20)
            iv_pct     = self.vol_eng.compute_iv_percentile(hv_history, hv20)
            dte_earn   = self.vol_eng.days_to_earnings(ticker)

            # Options chain
            chain = self.chain_f.get_chain(ticker)
            if chain is None:
                return None

            spot       = chain["spot"]
            atm_iv     = self.chain_f.get_atm_iv(chain)
            liquidity  = self.chain_f.get_liquidity(chain)
            atm_greeks = self.chain_f.get_atm_greeks(chain)

            stock = StockData(
                ticker=ticker, company=company, sector=sector,
                spot_price=spot, hv20=hv20, hv30=hv30,
                atm_iv=atm_iv, iv_rank=iv_rank, iv_percentile=iv_pct,
                days_to_earnings=dte_earn,
                expiration=chain["expiration"],
                dte=chain["dte"],
                liquidity=liquidity,
                atm_greeks=atm_greeks,
            )

            # Hard gates
            if not self.scorer.apply_gates(stock):
                return stock  # Returned with gate_failure set

            # Score (pass live sector_counts for diversity scoring)
            stock.score = self.scorer.score(stock, sector_counts)

            # Strategies
            stock.strategies = self.builder.build_all(stock, chain)

            # News + analyst ratings
            stock.headlines = self.news.get_headlines(ticker)
            stock.analyst   = self.news.get_analyst_rating(ticker)

            return stock

        except KeyboardInterrupt:
            raise
        except Exception as e:
            logging.debug(f"[{ticker}] Error: {e}")
            return None


# ── CLI ────────────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="S&P 500 Options Scanner",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument(
        "--top-n", type=int, default=TOP_N_DEFAULT,
        help=f"Number of top stocks to show (default: {TOP_N_DEFAULT})",
    )
    p.add_argument(
        "--min-score", type=float, default=0,
        help="Minimum score to include in results",
    )
    p.add_argument(
        "--no-ai", action="store_true",
        help="Skip Claude AI analysis",
    )
    p.add_argument(
        "--no-html", action="store_true",
        help="Skip HTML report generation",
    )
    p.add_argument(
        "--use-cache", action="store_true",
        help="Use cached data (skip re-fetching)",
    )
    p.add_argument(
        "--clear-cache", action="store_true",
        help="Clear cache before scanning",
    )
    p.add_argument(
        "--tickers", nargs="+", metavar="TICKER",
        help="Scan specific tickers only",
    )
    p.add_argument(
        "--sectors", nargs="+", metavar="SECTOR",
        help="Filter to specific sectors",
    )
    p.add_argument(
        "--telegram", action="store_true",
        help="Send Telegram summary after scan",
    )
    p.add_argument(
        "--verbose", action="store_true",
        help="Show eliminated stocks and reasons",
    )
    p.add_argument(
        "--diagnose", action="store_true",
        help="Print gate failure reason for every eliminated stock",
    )
    p.add_argument(
        "--relaxed", action="store_true",
        help="Loosen all gate thresholds by 50%% for testing",
    )
    p.add_argument(
        "--output-dir", type=str,
        help="Override output directory",
    )
    p.add_argument(
        "--ibkr", action="store_true",
        help="Auto-place paper trades via IBKR Gateway after scan",
    )
    p.add_argument(
        "--ibkr-dry-run", action="store_true",
        help="Show IBKR trades that would be placed but don't submit",
    )
    return p.parse_args()


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.WARNING,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    args = parse_args()
    if getattr(args, 'relaxed', False):
        import options_scanner as _self
        _self._RELAXED_MODE = True
    if getattr(args, 'diagnose', False):
        import options_scanner as _self
        _self._DIAGNOSE = True
    scanner = OptionScanner(args)
    scanner.run()
