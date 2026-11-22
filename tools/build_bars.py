"""SignalFloor data builder: fetches delayed public daily bars for a configurable
symbol universe and emits docs/bars.js. Real fetch, real timestamps, real errors.
SIMULATION ONLY - delayed public data, not a live feed, not investment advice."""
import json, sys, datetime, pathlib
import yfinance as yf

ROOT = pathlib.Path(__file__).resolve().parent.parent
UNIVERSE = [s.strip() for s in (sys.argv[1].split(",") if len(sys.argv) > 1 else
    ["TCS.NS","RELIANCE.NS","INFY.NS","INDIGO.NS","HDFCBANK.NS","ITC.NS","SBIN.NS",
     "BHARTIARTL.NS","HINDUNILVR.NS","KOTAKBANK.NS","LT.NS","MARUTI.NS","SUNPHARMA.NS",
     "WIPRO.NS","TATAMOTORS.NS"])]

fetched_at = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
symbols, errors = {}, {}
for sym in UNIVERSE:
    try:
        hist = yf.Ticker(sym).history(period="6mo", interval="1d", auto_adjust=False)
        if hist is None or hist.empty:
            errors[sym] = "provider returned no daily bars"
            continue
        rows = []
        for t, r in hist.iterrows():
            rows.append([str(t.date()), round(float(r.Open),2), round(float(r.High),2),
                         round(float(r.Low),2), round(float(r.Close),2), int(r.Volume)])
        symbols[sym] = rows
    except Exception as e:
        errors[sym] = str(e)[:200]

payload = {
    "meta": {
        "fetched_at_utc": fetched_at,
        "source": "Yahoo Finance public daily bars via yfinance (delayed, not live)",
        "auto_adjust": False,
        "note": "Last bar per symbol is the last completed NSE session. SIMULATION ONLY.",
        "errors": errors,
    },
    "symbols": symbols,
}
out = ROOT / "docs" / "bars.js"
out.write_text("window.SF_BARS=" + json.dumps(payload, separators=(",", ":")) + ";\n")
print(f"symbols ok: {len(symbols)}  errors: {errors}  -> {out}")
