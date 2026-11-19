"""Market data + signal computation for SignalFloor (SIMULATION ONLY)."""
import math
import os

# SignalFloor's OWN calibration for the vendored Finch "RSI Zone Reversal" skill.
# The skill ships no default thresholds by design (raises PARAM_INCOMPLETE);
# these are our values, matching the rules the analyst used before integration.
FINCH_PARAMS = {"rsi_period": 14, "oversold": 30.0, "overbought": 70.0}
_FINCH_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "vendor",
                             "finch-rsi-zone-reversal", "rsi-divergence_finchip",
                             "scripts", "rsi_zone_reversal.py")

def _finch_decision(hist):
    """Run the vendored Finch RSI Zone Reversal skill (Apache-2.0) on our own
    yfinance daily bars. No network: we pass frames directly to evaluate()."""
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location("finch_rsi_zone_reversal", _FINCH_SCRIPT)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        frames = [[int(t.timestamp() * 1000), float(r.Open), float(r.High),
                   float(r.Low), float(r.Close), float(r.Volume)] for t, r in hist.iterrows()]
        return mod.evaluate({"frames": frames, "state": {}, "symbol": ""}, FINCH_PARAMS)
    except Exception as e:
        return {"action": "error", "reason": str(e)[:120]}

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
                "finch": _finch_decision(hist),
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
        fz = s.get("finch") or {}
        if fz.get("action") == "long":
            side, reason = "BUY", [f"finch rsi-zone-reversal skill: {fz.get('reason')}"]
        elif fz.get("action") == "exit":
            side, reason = "SELL", [f"finch rsi-zone-reversal skill: {fz.get('reason')}"]
        elif fz.get("action") == "flat":
            # Finch zone-transition replaces the old naked RSI state rule:
            # an extreme READING alone no longer triggers an entry (avoids
            # repeated entries while RSI stays pinned, per the skill's design).
            side, reason = None, [f"finch: {fz.get('reason')}"]
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
