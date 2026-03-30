"""
Fetch OHLCV candles for a stock symbol via yfinance.
Usage: python fetch_stock_candles.py <SYMBOL> <INTERVAL> <LIMIT>
Interval: 1m | 5m | 15m | 1h | 4h | 1d
Outputs a single JSON line to stdout.
"""
import sys
import json
import math

def main():
    symbol   = sys.argv[1].upper() if len(sys.argv) > 1 else "SPY"
    interval = sys.argv[2]         if len(sys.argv) > 2 else "1d"
    limit    = int(sys.argv[3])    if len(sys.argv) > 3 else 300

    try:
        import yfinance as yf
    except ImportError:
        print(json.dumps({"error": "yfinance not installed", "candles": [], "volume": []}))
        sys.exit(0)

    # Map our interval names to yfinance params
    yf_map = {
        "1m":  ("7d",  "1m"),
        "5m":  ("60d", "5m"),
        "15m": ("60d", "15m"),
        "1h":  ("730d","1h"),
        "4h":  ("730d","1h"),   # resample from 1h
        "1d":  ("5y",  "1d"),
    }
    period, yf_interval = yf_map.get(interval, ("1y", "1d"))

    try:
        ticker = yf.Ticker(symbol)
        df = ticker.history(period=period, interval=yf_interval)

        if df.empty:
            print(json.dumps({"error": f"No data for {symbol}", "candles": [], "volume": []}))
            sys.exit(0)

        # Resample 1h → 4h if needed
        if interval == "4h":
            df = df.resample("4h").agg({
                "Open": "first", "High": "max",
                "Low":  "min",   "Close": "last",
                "Volume": "sum",
            }).dropna()

        candles = []
        volumes = []
        for idx, row in df.iterrows():
            ts = int(idx.timestamp())
            o = float(row["Open"])
            h = float(row["High"])
            l = float(row["Low"])
            c = float(row["Close"])
            v = float(row["Volume"])
            # Skip rows with NaN or zero values
            if any(math.isnan(x) for x in [o, h, l, c]):
                continue
            candles.append({"time": ts, "open": round(o, 4), "high": round(h, 4),
                            "low":  round(l, 4), "close": round(c, 4)})
            volumes.append({"time": ts, "value": v})

        # Apply limit
        candles = candles[-limit:]
        volumes = volumes[-limit:]

        # SMA 200 (full history, then trim to last `limit` points)
        closes_full = [float(row["Close"]) for _, row in df.iterrows()
                       if not math.isnan(float(row["Close"]))]
        times_full  = [int(idx.timestamp()) for idx, row in df.iterrows()
                       if not math.isnan(float(row["Close"]))]

        def sma(closes, period):
            result = []
            for i in range(period - 1, len(closes)):
                result.append(sum(closes[i - period + 1:i + 1]) / period)
            return result

        sma200_vals = sma(closes_full, 200)
        sma200_times = times_full[199:]
        sma200 = [{"time": t, "value": round(v, 4)}
                  for t, v in zip(sma200_times, sma200_vals)][-limit:]

        print(json.dumps({
            "symbol":  symbol,
            "candles": candles,
            "volume":  volumes,
            "sma200":  sma200,
        }))

    except Exception as e:
        print(json.dumps({"error": str(e), "candles": [], "volume": []}))


if __name__ == "__main__":
    main()
