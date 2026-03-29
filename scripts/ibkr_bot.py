"""
IBKR Automated Trading Bot
===========================
Runs continuously during US market hours (Mon–Fri).
  • 10:00 AM ET  — runs options scanner, places top credit spreads
  • Every 5 min  — monitors open positions, applies exit rules
  • 3:45 PM ET   — sends shutdown alert, exits cleanly

Exit rules (any one triggers a close):
  1. Profit target  — position P&L ≥ 50% of initial credit received
  2. DTE stop       — days to expiry ≤ 21
  3. Loss stop      — unrealised loss ≥ 2× initial credit received

Usage:
    python scripts/ibkr_bot.py              # live paper trading
    python scripts/ibkr_bot.py --dry-run    # preview only, no orders placed
    python scripts/ibkr_bot.py --no-scan    # skip today's scan, monitor only
"""

import json
import math
import os
import signal
import subprocess
import sys
import time
import logging
from datetime import date, datetime, time as dtime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import requests
from dotenv import load_dotenv

# ── Bootstrap ─────────────────────────────────────────────────────────────────

BASE_DIR    = Path(__file__).parent.parent          # D:\AI\AI Trading
SCRIPTS_DIR = Path(__file__).parent                 # D:\AI\AI Trading\scripts
OUTPUT_DIR  = SCRIPTS_DIR / "output"
STATE_FILE  = OUTPUT_DIR / "bot_state.json"

load_dotenv(BASE_DIR / ".env")

OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# ── Logging ───────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("ibkr_bot")

# ── Constants ─────────────────────────────────────────────────────────────────

GATEWAY_HOST    = "127.0.0.1"
GATEWAY_PORT    = 4002          # IB Gateway paper port
CLIENT_ID       = 11            # Must differ from ibkr_trader.py (uses 10)

SCAN_HOUR       = 10            # 10:00 AM ET (30 min post-open)
SCAN_MINUTE     = 0
SHUTDOWN_HOUR   = 15            # 3:45 PM ET (15 min before close)
SHUTDOWN_MINUTE = 45
MARKET_OPEN     = dtime(9, 35)  # Ignore pre-open noise
MARKET_CLOSE    = dtime(15, 40)

POLL_SECS       = 300           # Monitor every 5 minutes
PROFIT_TARGET   = 50.0          # Close at 50% profit
DTE_STOP        = 21            # Close ≤ 21 DTE
LOSS_MULTIPLIER = 2.0           # Close at 2× initial credit loss

# Python executable — must match ibkr_trader.py's env
PYTHON = sys.executable

# Telegram credentials from .env
TELEGRAM_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT  = os.getenv("TELEGRAM_CHAT_ID",  "")


# ── Timezone helper ───────────────────────────────────────────────────────────

def _et_offset_hours() -> int:
    """Return -4 (EDT) or -5 (EST) depending on US DST."""
    try:
        from zoneinfo import ZoneInfo
        from datetime import timezone
        et = ZoneInfo("America/New_York")
        return int(datetime.now(et).utcoffset().total_seconds() / 3600)
    except Exception:
        # Approximate: EDT after 2nd Sunday March, EST after 1st Sunday Nov
        now = datetime.utcnow()
        # US DST 2026: Mar 8 (spring forward) → Nov 1 (fall back)
        spring = datetime(now.year, 3, 8)
        fall   = datetime(now.year, 11, 1)
        return -4 if spring <= now < fall else -5


def now_et() -> datetime:
    """Current datetime in US Eastern time."""
    from datetime import timezone, timedelta
    offset = timedelta(hours=_et_offset_hours())
    return datetime.now(timezone(offset)).replace(tzinfo=None)


# ── Telegram ──────────────────────────────────────────────────────────────────

def send_telegram(msg: str) -> None:
    """Send a Telegram message. Silent on error."""
    if not TELEGRAM_TOKEN or not TELEGRAM_CHAT:
        log.debug("Telegram not configured — skipping alert")
        return
    try:
        url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
        requests.post(url, json={"chat_id": TELEGRAM_CHAT, "text": msg}, timeout=10)
        log.debug(f"Telegram sent: {msg[:60]}")
    except Exception as e:
        log.warning(f"Telegram send failed: {e}")


# ── State persistence ─────────────────────────────────────────────────────────

def load_state() -> Dict:
    """Load bot state (open trades, last scan date)."""
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"open_trades": [], "last_scan_date": None}


def save_state(state: Dict) -> None:
    """Persist bot state to disk."""
    try:
        STATE_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")
    except Exception as e:
        log.warning(f"State save failed: {e}")


# ── IBKR helpers ──────────────────────────────────────────────────────────────

def ibkr_connect():
    """Connect to IB Gateway. Returns IB instance or None."""
    try:
        from ib_insync import IB, util
        util.logToConsole(logging.WARNING)   # suppress ib_insync INFO noise
        ib = IB()
        ib.connect(GATEWAY_HOST, GATEWAY_PORT, clientId=CLIENT_ID, timeout=15)
        log.info(f"Connected to IBKR Gateway (client {CLIENT_ID})")
        return ib
    except Exception as e:
        log.warning(f"IBKR Gateway not reachable: {e}")
        return None


def ibkr_portfolio(ib) -> List[Dict]:
    """Fetch current portfolio items from IBKR with P&L."""
    try:
        items = ib.portfolio()
        out = []
        for item in items:
            c = item.contract
            entry = {
                "symbol":      c.symbol,
                "sec_type":    c.secType,
                "strike":      getattr(c, "strike",                        None),
                "right":       getattr(c, "right",                         None),
                "expiry":      getattr(c, "lastTradeDateOrContractMonth",  None),
                "position":    item.position,
                "avg_cost":    item.averageCost,
                "market_value": item.marketValue,
                "unrealized_pnl": item.unrealizedPNL,
                "realized_pnl":   item.realizedPNL,
            }
            # Compute DTE
            if entry["expiry"]:
                try:
                    exp = datetime.strptime(str(entry["expiry"])[:8], "%Y%m%d")
                    entry["dte"] = max((exp - datetime.now()).days, 0)
                except Exception:
                    entry["dte"] = 999
            else:
                entry["dte"] = 999
            out.append(entry)
        return out
    except Exception as e:
        log.warning(f"Portfolio fetch failed: {e}")
        return []


def ibkr_close_position(ib, symbol: str, expiry: str,
                         strike: float, right: str,
                         quantity: float, dry_run: bool = False) -> bool:
    """
    Close an options position by placing a market BUY order (to cover short).
    For short positions, quantity will be negative — we buy it back.
    """
    try:
        from ib_insync import Option, Order

        if dry_run:
            log.info(f"[DRY RUN] Would close: {symbol} {right} {strike} exp {expiry} qty {abs(quantity):.0f}")
            return True

        contract = Option(symbol, expiry[:8], strike, right, "SMART", currency="USD")
        details  = ib.reqContractDetails(contract)
        if not details:
            log.warning(f"Could not find contract for {symbol} {right} {strike} {expiry}")
            return False
        contract = details[0].contract

        # For a short position (qty < 0), we BUY to close
        close_action = "BUY" if quantity < 0 else "SELL"
        close_qty    = abs(quantity)

        order = Order()
        order.action        = close_action
        order.orderType     = "MKT"
        order.totalQuantity = close_qty
        order.tif           = "DAY"

        trade = ib.placeOrder(contract, order)
        ib.sleep(3)

        log.info(f"CLOSE ORDER: {symbol} {right} {strike} exp {expiry} "
                 f"qty {close_qty} status={trade.orderStatus.status}")
        return True
    except Exception as e:
        log.error(f"Close order failed for {symbol}: {e}")
        return False


# ── Scanner integration ────────────────────────────────────────────────────────

def run_scanner(dry_run: bool = False) -> Optional[str]:
    """
    Run options_scanner.py as a subprocess.
    Returns path to the latest results JSON or None on failure.
    """
    scanner = SCRIPTS_DIR / "options_scanner.py"
    if not scanner.exists():
        log.error(f"options_scanner.py not found at {scanner}")
        return None

    cmd = [PYTHON, str(scanner), "--telegram"]
    if dry_run:
        cmd.append("--no-ai")          # skip Claude to save cost on dry runs
        cmd.append("--top-n")
        cmd.append("5")

    log.info(f"Starting options scan: {' '.join(cmd)}")
    send_telegram("🔍 IBKR Bot: starting options scan…")

    # Force UTF-8 and plain-text Rich output so Windows CP1252 terminals
    # don't choke on box-drawing / emoji characters in the scan report
    scan_env = {
        **os.environ,
        "PYTHONUTF8":   "1",    # Python UTF-8 mode (PEP 540)
        "PYTHONIOENCODING": "utf-8",
        "NO_COLOR":     "1",    # tell Rich to skip ANSI / legacy-Windows rendering
    }

    try:
        result = subprocess.run(
            cmd,
            cwd=str(BASE_DIR),
            timeout=900,               # 15 min max
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=scan_env,
        )
        if result.returncode != 0:
            log.error(f"Scanner exited with code {result.returncode}")
            log.error(result.stderr[-500:] if result.stderr else "(no stderr)")
            return None

        # Find the latest results file produced
        files = sorted(OUTPUT_DIR.glob("options_results_*.json"), reverse=True)
        if not files:
            log.warning("Scanner finished but no results file found")
            return None

        latest = str(files[0])
        log.info(f"Scan complete → {files[0].name}")
        return latest

    except subprocess.TimeoutExpired:
        log.error("Scanner timed out after 15 minutes")
        return None
    except Exception as e:
        log.error(f"Scanner subprocess failed: {e}")
        return None


def place_trades(json_path: str, dry_run: bool = False) -> List[Dict]:
    """
    Call ibkr_trader.py --json <path> to place trades from scanner output.
    Returns list of trade dicts from the results, or [] on error.
    """
    trader = SCRIPTS_DIR / "ibkr_trader.py"
    if not trader.exists():
        log.error(f"ibkr_trader.py not found")
        return []

    cmd = [PYTHON, str(trader), "--json", json_path, "--emit-json"]
    if dry_run:
        cmd.append("--dry-run")

    log.info(f"Placing trades: {' '.join(cmd)}")
    try:
        result = subprocess.run(
            cmd,
            cwd=str(BASE_DIR),
            timeout=120,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            log.error(f"Trade placement failed (code {result.returncode}): {result.stderr[:300]}")
            return []
        # ibkr_trader.py --emit-json prints a single JSON line to stdout
        stdout = (result.stdout or "").strip()
        if not stdout:
            log.warning("ibkr_trader.py returned no output")
            return []
        placed = json.loads(stdout)
        log.info(f"Placed {len(placed)} trade(s)")
        return placed
    except json.JSONDecodeError as e:
        log.error(f"Could not parse trade JSON: {e} — raw: {result.stdout[:200]}")
        return []
    except Exception as e:
        log.error(f"Trade placement subprocess failed: {e}")
        return []


# ── Exit rules ────────────────────────────────────────────────────────────────

def check_exit_rule(pos: Dict) -> Optional[Tuple[str, str]]:
    """
    Evaluate exit rules for a position.
    Returns (rule_name, reason_string) if position should be closed, else None.

    pos keys: symbol, strike, right, expiry, position (qty), avg_cost,
              market_value, unrealized_pnl, dte
    """
    symbol   = pos.get("symbol", "?")
    qty      = float(pos.get("position",      0))
    avg_cost = float(pos.get("avg_cost",      0))
    pnl      = float(pos.get("unrealized_pnl", 0))
    dte      = int(  pos.get("dte",           999))

    # Only manage short options positions (qty < 0 = we sold)
    if qty >= 0:
        return None
    if pos.get("sec_type") != "OPT":
        return None

    # Initial credit received (per share × 100 multiplier × abs qty)
    # avg_cost for a sold option is negative (premium received)
    initial_credit = abs(avg_cost) * abs(qty) * 100
    if initial_credit <= 0:
        # No credit data — can't evaluate profit rule, still check DTE
        if dte <= DTE_STOP:
            return ("dte_stop", f"DTE {dte} ≤ {DTE_STOP}")
        return None

    # ── Rule 1: Profit target ──────────────────────────────────────────────
    profit_pct = (pnl / initial_credit) * 100
    if profit_pct >= PROFIT_TARGET:
        return ("profit_target", f"P&L +{profit_pct:.0f}% ≥ {PROFIT_TARGET:.0f}%")

    # ── Rule 2: DTE stop ──────────────────────────────────────────────────
    if dte <= DTE_STOP:
        return ("dte_stop", f"DTE {dte} ≤ {DTE_STOP}")

    # ── Rule 3: Loss stop ─────────────────────────────────────────────────
    if pnl < 0 and abs(pnl) >= LOSS_MULTIPLIER * initial_credit:
        return ("loss_stop",
                f"Loss ${abs(pnl):.0f} ≥ {LOSS_MULTIPLIER:.0f}× credit ${initial_credit:.0f}")

    return None


# ── Schedule helpers ──────────────────────────────────────────────────────────

def is_market_hours(et: datetime) -> bool:
    """True if current ET time is within regular market hours on a weekday."""
    if et.weekday() >= 5:       # Saturday=5, Sunday=6
        return False
    t = et.time()
    return MARKET_OPEN <= t <= MARKET_CLOSE


def is_scan_time(et: datetime) -> bool:
    """True if it's past the daily scan trigger time."""
    return et.hour == SCAN_HOUR and et.minute >= SCAN_MINUTE


def is_shutdown_time(et: datetime) -> bool:
    """True if it's at or past the daily shutdown time."""
    return (et.hour > SHUTDOWN_HOUR or
            (et.hour == SHUTDOWN_HOUR and et.minute >= SHUTDOWN_MINUTE))


# ── Main bot class ────────────────────────────────────────────────────────────

class IBKRBot:
    def __init__(self, dry_run: bool = False, no_scan: bool = False):
        self.dry_run   = dry_run
        self.no_scan   = no_scan
        self.running   = True
        self.state     = load_state()
        self.scan_done_date: Optional[date] = None

        # Restore last scan date from state so we don't re-scan after a restart
        if self.state.get("last_scan_date"):
            try:
                self.scan_done_date = date.fromisoformat(self.state["last_scan_date"])
            except Exception:
                pass

        signal.signal(signal.SIGINT,  self._handle_signal)
        signal.signal(signal.SIGTERM, self._handle_signal)

    # ── Signal handling ────────────────────────────────────────────────────

    def _handle_signal(self, signum, frame):
        log.info(f"Received signal {signum} — shutting down…")
        self.running = False

    # ── Core actions ───────────────────────────────────────────────────────

    def do_scan(self) -> None:
        """Run the options scanner and place trades from the top results."""
        log.info("═══ Daily scan starting ═══")
        today = now_et().date()

        results_path = run_scanner(dry_run=self.dry_run)
        if not results_path:
            msg = "❌ IBKR Bot: scanner failed or returned no results"
            log.warning(msg)
            send_telegram(msg)
            return

        # Parse scan summary for Telegram
        try:
            data       = json.loads(Path(results_path).read_text(encoding="utf-8"))
            total      = data.get("total_scanned", "?")
            passed     = data.get("passed_gates",  "?")
            top_stocks = data.get("top_stocks",    [])[:3]
            top_str    = "  ".join(
                f"{s.get('ticker','?')} ({s.get('score', 0):.0f})"
                for s in top_stocks
            )
            scan_msg = (
                f"🔍 SCAN COMPLETE — {datetime.now().strftime('%H:%M')}\n"
                f"{total} scanned | {passed} passed gates\n"
                f"Top: {top_str}"
            )
        except Exception:
            scan_msg = f"🔍 SCAN COMPLETE — results at {Path(results_path).name}"

        log.info(scan_msg.replace("\n", " | "))
        send_telegram(scan_msg)

        # Place trades
        placed = place_trades(results_path, dry_run=self.dry_run)
        if self.dry_run:
            log.info("[DRY RUN] Trade placement preview complete")

        # Persist scan date and open trades
        self.scan_done_date = today
        self.state["last_scan_date"] = today.isoformat()
        if placed:
            # Merge with existing open trades (avoid duplicates by ticker+expiry)
            existing_keys = {
                (t.get("ticker"), t.get("expiry")) for t in self.state.get("open_trades", [])
            }
            new_trades = [
                t for t in placed
                if (t.get("ticker"), t.get("expiry")) not in existing_keys
            ]
            self.state.setdefault("open_trades", []).extend(new_trades)
            log.info(f"Saved {len(new_trades)} new trade(s) to state")
        save_state(self.state)

    def do_monitor(self) -> None:
        """Connect to IBKR, check all option positions, apply exit rules (spread-aware)."""
        log.info("── Position monitor ──")
        ib = ibkr_connect()
        if ib is None:
            log.warning("Gateway not available — skipping position check")
            return

        try:
            portfolio = ibkr_portfolio(ib)
            options   = [p for p in portfolio if p.get("sec_type") == "OPT"
                         and float(p.get("position", 0)) < 0]

            if not options:
                log.info("No short option positions to monitor")
                return

            log.info(f"Monitoring {len(options)} short option position(s)")

            # Group legs by (symbol, expiry) so we can close whole spreads together
            from collections import defaultdict
            spread_groups: Dict[Tuple, List] = defaultdict(list)
            for pos in options:
                key = (pos.get("symbol", "?"), str(pos.get("expiry", ""))[:8])
                spread_groups[key].append(pos)

            for (symbol, expiry), legs in spread_groups.items():
                total_pnl = sum(float(p.get("unrealized_pnl", 0)) for p in legs)
                dte = min(p.get("dte", 999) for p in legs)

                for leg in legs:
                    avg_cost = float(leg.get("avg_cost", 0))
                    qty      = float(leg.get("position", 0))
                    pnl      = float(leg.get("unrealized_pnl", 0))
                    initial_credit = abs(avg_cost) * abs(qty) * 100
                    log.info(
                        f"  {symbol} {leg.get('right')} {leg.get('strike')} "
                        f"exp {expiry}  DTE={dte}  P&L=${pnl:+.2f}"
                        + (f"  ({pnl / initial_credit * 100:+.0f}% of credit)"
                           if initial_credit > 0 else "")
                    )

                # Check exit rules — use the leg with the most conservative signal
                triggered_rule: Optional[Tuple[str, str]] = None
                for leg in legs:
                    rule = check_exit_rule(leg)
                    if rule:
                        triggered_rule = rule
                        break   # one leg triggers = close the whole spread

                if triggered_rule:
                    rule_name, reason = triggered_rule
                    self._close_spread(ib, symbol, expiry, legs, rule_name, reason, total_pnl)

        finally:
            try:
                ib.disconnect()
            except Exception:
                pass

    def _close_and_alert(self, ib, pos: Dict,
                          rule_name: str, reason: str) -> None:
        """Close a single position and send Telegram alert (legacy — use _close_spread)."""
        symbol = pos.get("symbol", "?")
        strike = pos.get("strike")
        right  = pos.get("right", "?")
        expiry = str(pos.get("expiry", ""))
        qty    = float(pos.get("position", 0))
        pnl    = float(pos.get("unrealized_pnl", 0))

        emoji = {"profit_target": "💰", "dte_stop": "⏰", "loss_stop": "🛑"}.get(rule_name, "❌")
        log.info(f"EXIT [{rule_name}] {symbol} {right} {strike}: {reason}")

        if expiry and strike and right:
            ok = ibkr_close_position(
                ib, symbol, expiry, float(strike), right, qty,
                dry_run=self.dry_run
            )
        else:
            log.warning(f"Incomplete contract data for {symbol} — cannot close")
            ok = False

        label = "DRY RUN — " if self.dry_run else ""
        if ok:
            msg = (
                f"{emoji} {label}{rule_name.upper().replace('_', ' ')}\n"
                f"{symbol} {right} {strike} exp {expiry[:6] if expiry else '?'}\n"
                f"Reason: {reason}  |  P&L: ${pnl:+.2f}"
            )
            send_telegram(msg)

    def _close_spread(self, ib, symbol: str, expiry: str,
                      legs: List[Dict], rule_name: str, reason: str,
                      total_pnl: float) -> None:
        """
        Close all legs of a spread together and send one Telegram alert.
        Ensures both the sell leg and buy leg are closed atomically.
        """
        emoji  = {"profit_target": "💰", "dte_stop": "⏰", "loss_stop": "🛑"}.get(rule_name, "❌")
        label  = "DRY RUN — " if self.dry_run else ""
        closed = []

        for leg in legs:
            strike = leg.get("strike")
            right  = leg.get("right", "?")
            qty    = float(leg.get("position", 0))

            log.info(f"EXIT [{rule_name}] {symbol} {right} {strike} exp {expiry}: {reason}")

            if expiry and strike and right:
                ok = ibkr_close_position(
                    ib, symbol, expiry, float(strike), right, qty,
                    dry_run=self.dry_run
                )
                if ok:
                    closed.append(f"{right}{strike}")
            else:
                log.warning(f"Incomplete leg data for {symbol} — skipping leg {right} {strike}")

        # Remove from open_trades state once spread is fully closed
        if closed and not self.dry_run:
            self.state["open_trades"] = [
                t for t in self.state.get("open_trades", [])
                if not (t.get("ticker") == symbol
                        and str(t.get("expiry", "")).startswith(expiry[:8]))
            ]
            save_state(self.state)

        if closed:
            leg_str = " / ".join(closed)
            msg = (
                f"{emoji} {label}SPREAD CLOSED [{rule_name.upper().replace('_', ' ')}]\n"
                f"{symbol} {leg_str} exp {expiry}\n"
                f"Reason: {reason}  |  Total P&L: ${total_pnl:+.2f}"
            )
            send_telegram(msg)

    # ── Run loop ───────────────────────────────────────────────────────────

    def run(self) -> None:
        mode_str = "[DRY RUN] " if self.dry_run else ""
        startup_msg = (
            f"🤖 {mode_str}IBKR Bot started\n"
            f"Scan: {SCAN_HOUR:02d}:{SCAN_MINUTE:02d} ET  "
            f"Shutdown: {SHUTDOWN_HOUR:02d}:{SHUTDOWN_MINUTE:02d} ET  "
            f"Poll: every {POLL_SECS // 60} min"
        )
        log.info(startup_msg.replace("\n", " | "))
        send_telegram(startup_msg)

        while self.running:
            et = now_et()

            # ── Daily shutdown ─────────────────────────────────────────
            if is_shutdown_time(et) and et.weekday() < 5:
                msg = f"🔴 IBKR Bot: market close — shutting down ({et.strftime('%H:%M')} ET)"
                log.info(msg)
                send_telegram(msg)
                break

            if not is_market_hours(et):
                next_check = POLL_SECS
                log.debug(
                    f"Outside market hours ({et.strftime('%H:%M')} ET) — "
                    f"sleeping {next_check // 60} min"
                )
                self._sleep(next_check)
                continue

            # ── Daily scan ─────────────────────────────────────────────
            if (not self.no_scan
                    and is_scan_time(et)
                    and self.scan_done_date != et.date()):
                try:
                    self.do_scan()
                except Exception as e:
                    log.error(f"Scan failed: {e}", exc_info=True)
                    send_telegram(f"❌ IBKR Bot: scan error — {e}")

            # ── Position monitor ───────────────────────────────────────
            try:
                self.do_monitor()
            except Exception as e:
                log.error(f"Monitor cycle failed: {e}", exc_info=True)

            self._sleep(POLL_SECS)

        log.info("IBKR Bot stopped.")

    def _sleep(self, secs: int) -> None:
        """Sleep in 1-second ticks so Ctrl+C is responsive."""
        for _ in range(secs):
            if not self.running:
                break
            time.sleep(1)


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="IBKR Automated Trading Bot — runs continuously during market hours",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview mode — shows what would happen without placing orders",
    )
    parser.add_argument(
        "--no-scan",
        action="store_true",
        help="Skip today's scan and go straight to position monitoring",
    )
    args = parser.parse_args()

    bot = IBKRBot(dry_run=args.dry_run, no_scan=args.no_scan)
    bot.run()
