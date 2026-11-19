"""RSI zone-exit reversal - buy the recovery out of oversold, exit on the overbought turn.

Run `python3 rsi_zone_reversal.py --help` for the CLI contract.
"""
"""Runtime helpers shared by this skill package.

DESIGN NOTE - read this before editing.

This module intentionally contains **no calibrated thresholds and no position
sizing**. Every numeric decision boundary must be supplied by the caller at
run time. The public package ships the decision *structure*; the production
calibration of the reference implementation is not part of it.

That is why every `need()` call raises `ParamError` instead of falling back to
a default: a silent default would let a caller believe they are running a
calibrated system when they are actually running somebody else's numbers.
"""

import argparse
import json
import sys
import urllib.parse
import urllib.request


class ParamError(ValueError):
    """A required threshold was not supplied by the caller."""


def need(params, key, cast=float):
    """Fetch a mandatory parameter, or raise a loud, actionable error."""
    if key not in params or params[key] is None or params[key] == "":
        raise ParamError("missing required parameter: " + key)
    value = params[key]
    try:
        return cast(value)
    except (TypeError, ValueError):
        raise ParamError(
            "parameter %r is not a valid %s: %r" % (key, cast.__name__, value)
        )


def precheck(params, keys):
    """Fail on missing keys before any network call, so a transport error can
    never mask the real problem: an uncalibrated parameter file."""
    missing = [
        k for k in keys if k not in params or params[k] is None or params[k] == ""
    ]
    if missing:
        raise ParamError("missing required parameter(s): " + ", ".join(missing))


def http_json(url, host_header=None):
    """GET a JSON document. The empty ProxyHandler keeps RPC/API calls direct."""
    req = urllib.request.Request(url, headers={"User-Agent": "finch-skill/1.0"})
    if host_header:
        req.add_header("Host", host_header)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=25) as resp:
        return json.loads(resp.read().decode())


def fetch_klines(base_url, symbol, interval, limit=300, host_header=None):
    """Fetch OHLCV as [[ts_ms, open, high, low, close, volume], ...] (oldest first)."""
    query = urllib.parse.urlencode(
        {"symbol": symbol.replace("/", ""), "interval": interval, "limit": limit}
    )
    url = base_url.rstrip("/") + "/api/v3/klines?" + query
    raw = http_json(url, host_header)
    return [
        [int(k[0]), float(k[1]), float(k[2]), float(k[3]), float(k[4]), float(k[5])]
        for k in raw
    ]


def closes_of(frames):
    return [f[4] for f in frames]


def sma(values, period):
    if len(values) < period:
        return None
    return sum(values[-period:]) / float(period)


def ema_series(values, period):
    if len(values) < period:
        return []
    k = 2.0 / (period + 1.0)
    acc = sum(values[:period]) / float(period)
    out = [acc]
    for v in values[period:]:
        acc = v * k + acc * (1.0 - k)
        out.append(acc)
    return out


def rsi_series(values, period):
    """Wilder-smoothed RSI, aligned to the tail of `values`."""
    if len(values) < period + 1:
        return []
    gains, losses = [], []
    for i in range(1, period + 1):
        ch = values[i] - values[i - 1]
        gains.append(max(ch, 0.0))
        losses.append(max(-ch, 0.0))
    avg_gain = sum(gains) / float(period)
    avg_loss = sum(losses) / float(period)

    def value(ag, al):
        if al == 0:
            return 100.0
        return 100.0 - 100.0 / (1.0 + ag / al)

    out = [value(avg_gain, avg_loss)]
    for i in range(period + 1, len(values)):
        ch = values[i] - values[i - 1]
        avg_gain = (avg_gain * (period - 1) + max(ch, 0.0)) / period
        avg_loss = (avg_loss * (period - 1) + max(-ch, 0.0)) / period
        out.append(value(avg_gain, avg_loss))
    return out


def stdev(values, period):
    if len(values) < period:
        return None
    window = values[-period:]
    mid = sum(window) / float(period)
    var = sum((v - mid) ** 2 for v in window) / float(period)
    return var ** 0.5


REQUIRED = ("rsi_period", "oversold", "overbought")


def evaluate(data, params):
    """Return one RSI zone-transition decision on the last closed bar."""
    period = need(params, "rsi_period", int)
    oversold = need(params, "oversold")
    overbought = need(params, "overbought")

    if period < 2:
        raise ParamError("rsi_period must be >= 2")
    if not 0 < oversold < overbought < 100:
        raise ParamError("need 0 < oversold < overbought < 100")
    if overbought - oversold > 60:
        raise ParamError("zones are too wide to ever produce a transition")

    closed = closes_of(data.get("frames") or [])[:-1]
    series = rsi_series(closed, period)
    if len(series) < 2:
        return {"action": "flat", "price": closed[-1] if closed else 0.0,
                "reason": "need at least %d closed bars for RSI(%d), got %d"
                          % (period + 2, period, len(closed))}

    now, prev = series[-1], series[-2]
    price = closed[-1]

    if prev < oversold <= now:
        return {"action": "long", "price": price, "rsi_now": now, "rsi_prev": prev,
                "oversold": oversold, "overbought": overbought,
                "reason": "RSI recovered out of oversold (%.1f -> %.1f)" % (prev, now)}

    if prev > overbought >= now:
        return {"action": "exit", "price": price, "rsi_now": now, "rsi_prev": prev,
                "oversold": oversold, "overbought": overbought,
                "reason": "RSI turned down out of overbought (%.1f -> %.1f)" % (prev, now)}

    return {"action": "flat", "price": price, "rsi_now": now, "rsi_prev": prev,
            "oversold": oversold, "overbought": overbought,
            "reason": "no zone transition (%.1f -> %.1f, zones %.0f/%.0f)"
                      % (prev, now, oversold, overbought)}

def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Evaluate one decision from your own calibrated thresholds."
    )
    ap.add_argument(
        "--params",
        required=True,
        help="path to a JSON file holding YOUR calibrated thresholds "
        "(see references/params-template.json)",
    )
    ap.add_argument("--base-url", default="https://data-api.binance.vision")
    ap.add_argument("--host-header", default=None, help="Host override for a mirror")
    ap.add_argument("--symbol", default="BTC/USDT")
    ap.add_argument("--interval", default="4h")
    ap.add_argument("--limit", type=int, default=400)
    ap.add_argument(
        "--state",
        default="{}",
        help="JSON object with your current position state, e.g. "
        '\'{"avg_entry": 0, "layers": 0}\'',
    )
    ap.add_argument("--state-file", default=None)
    ap.add_argument("--json", action="store_true", help="compact single-line output")
    args = ap.parse_args(argv)

    with open(args.params, encoding="utf-8") as fh:
        params = json.load(fh)

    state = json.loads(args.state)
    if args.state_file:
        with open(args.state_file, encoding="utf-8") as fh:
            state = json.load(fh)

    try:
        precheck(params, REQUIRED)
        frames = fetch_klines(
            args.base_url, args.symbol, args.interval, args.limit, args.host_header
        )
        result = evaluate(
            {"frames": frames, "state": state, "symbol": args.symbol}, params
        )
    except ParamError as exc:
        print(
            json.dumps(
                {
                    "error": "PARAM_INCOMPLETE",
                    "detail": str(exc),
                    "fix": "fill the required key in your params file - this "
                    "package ships no default thresholds on purpose",
                },
                ensure_ascii=False,
            )
        )
        return 2
    except Exception as exc:  # network / upstream shape problems
        print(
            json.dumps(
                {"error": type(exc).__name__, "detail": str(exc)}, ensure_ascii=False
            )
        )
        return 1

    print(
        json.dumps(result, ensure_ascii=False, indent=None if args.json else 2)
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
