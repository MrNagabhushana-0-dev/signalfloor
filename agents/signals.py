"""Market data + signal computation for SignalFloor (SIMULATION ONLY)."""
import math

def _rsi(closes, period=14):
    if len(closes) < period + 1:
        return None
    gains, losses = [], []
    for i in range(1, len(closes)):
        d = closes[i] - closes[i-1]
        gains.append(max(d, 0.0)); losses.append(max(-d, 0.0))
    avg_gain = sum(gains[-period:]) / period
    avg_loss = sum(losses[-period:]) / period
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100.0 - 100.0 / (1.0 + rs)

def _sma(values, n):
    if len(values) < n:
        return None
    return sum(values[-n:]) / n

def fetch_snapshots(symbols):
    """Return {symbol: {price, sma10, sma30, rsi14, change_pct}} using yfinance daily data."""
    import yfinance as yf
    out = {}
    for sym in symbols:
        try:
            hist = yf.Ticker(sym).history(period="3mo", interval="1d")
            if hist is None or hist.empty:
                continue
            closes = [float(c) for c in hist["Close"].tolist()]
            price = closes[-1]
            prev = closes[-2] if len(closes) > 1 else price
            try:
                asof = str(hist.index[-1].date())
            except Exception:
                asof = "unknown"
            out[sym] = {
                "price": round(price, 2),
                "asof": asof,
                "sma10": round(_sma(closes, 10), 2) if _sma(closes, 10) else None,
                "sma30": round(_sma(closes, 30), 2) if _sma(closes, 30) else None,
                "rsi14": round(_rsi(closes), 1) if _rsi(closes) is not None else None,
                "change_pct": round((price - prev) / prev * 100, 2) if prev else 0.0,
            }
        except Exception as e:
            out[sym] = {"error": str(e)[:120]}
    return out

def pick_signal(snapshots, demo=False):
    """Choose at most one signal. demo=True always emits one (momentum sign) so the A2A loop is demonstrable."""
    best = None
    for sym, s in snapshots.items():
        if "error" in s or s.get("sma10") is None or s.get("sma30") is None or s.get("rsi14") is None:
            continue
        side = None
        reason = []
        if s["sma10"] > s["sma30"] and s["rsi14"] < 70:
            side, reason = "BUY", ["sma10>sma30 uptrend", f"rsi {s['rsi14']} < 70"]
        elif s["sma10"] < s["sma30"] and s["rsi14"] > 30:
            side, reason = "SELL", ["sma10<sma30 downtrend", f"rsi {s['rsi14']} > 30"]
        if s["rsi14"] <= 30:
            side, reason = "BUY", [f"rsi {s['rsi14']} oversold"]
        elif s["rsi14"] >= 70:
            side, reason = "SELL", [f"rsi {s['rsi14']} overbought"]
        if side:
            score = abs(s["sma10"] - s["sma30"]) / s["sma30"] + abs(s["rsi14"] - 50) / 100.0
            if best is None or score > best[0]:
                best = (score, sym, side, s, "; ".join(reason))
    if best is None and demo:
        cands = [(abs(s.get("change_pct", 0)), sym, s) for sym, s in snapshots.items() if "error" not in s]
        if cands:
            cands.sort(reverse=True)
            _, sym, s = cands[0]
            side = "BUY" if s.get("change_pct", 0) >= 0 else "SELL"
            return sym, side, s, f"demo momentum pick, 1d change {s.get('change_pct')}%"
        return None
    if best is None:
        return None
    _, sym, side, s, reason = best
    return sym, side, s, reason
