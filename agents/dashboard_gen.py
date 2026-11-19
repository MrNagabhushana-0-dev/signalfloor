"""Generate a static snapshot dashboard for SignalFloor.

Honesty contract: this page is a SNAPSHOT of recorded simulation runs and
freshly pulled delayed daily-bar data at generation time. It is not a live
backend. All trades are simulated paper fills. Not investment advice.
"""
import json, datetime, pathlib, html

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "repo" / "docs" / "index.html"

def load_portfolio():
    p = ROOT / "data" / "paper_portfolio.json"
    return json.loads(p.read_text()) if p.exists() else None

WATCHLIST = "RELIANCE.NS,TCS.NS,INFY.NS,HDFCBANK.NS,ITC.NS".split(",")

def latest_indicators():
    import sys
    sys.path.insert(0, str(ROOT / "agents"))
    import signals
    snaps = signals.fetch_snapshots(WATCHLIST)
    pick = signals.pick_signal(snaps, demo=False)
    picked_sym = pick[0] if pick else None
    picked_side = pick[1] if pick else None
    rows = []
    for sym in WATCHLIST:
        s = snaps.get(sym) or {"error": "no data"}
        if "error" in s:
            rows.append({"symbol": sym, "error": s["error"]})
            continue
        fz = s.get("finch") or {}
        def _r1(x):
            return round(x, 1) if isinstance(x, (int, float)) else "?"
        finch_txt = (str(fz.get("action", "?")) + " " + str(_r1(fz.get("rsi_prev"))) + "->" + str(_r1(fz.get("rsi_now")))) if fz else "n/a"
        rows.append({"symbol": sym, "close": s["price"], "sma10": s["sma10"],
                     "sma30": s["sma30"], "rsi14": s["rsi14"], "finch": finch_txt,
                     "signal": (picked_side + " (v2 pick)" if sym == picked_sym else "none"),
                     "asof": s["asof"]})
    return rows

def inr(n):
    """Indian digit grouping: 502838.8 -> 5,02,839."""
    n = int(round(n))
    s = str(abs(n))
    if len(s) <= 3:
        out = s
    else:
        out = s[-3:]
        s = s[:-3]
        while s:
            out = s[-2:] + "," + out
            s = s[:-2]
    return ("-" if n < 0 else "") + out

def main():
    gen_at = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    pf = load_portfolio()
    inds = latest_indicators()
    pos_rows = ""
    trade_rows = ""
    cash = "n/a"
    if pf:
        cash = f"INR {inr(pf['cash'])} (simulated)"
        for sym, pos in (pf.get("positions") or {}).items():
            pos_rows += f"<tr><td>{html.escape(sym)}</td><td>{pos.get('qty')}</td><td>{pos.get('avg_price', pos.get('avg'))}</td></tr>"
        for t in (pf.get("trades") or [])[-20:]:
            trade_rows += ("<tr><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>".format(
                html.escape(str(t.get("ts",""))), html.escape(str(t.get("symbol",""))),
                html.escape(str(t.get("side",""))), html.escape(str(t.get("price","")))))
    ind_rows = ""
    for r in inds:
        if "error" in r:
            ind_rows += f"<tr><td>{html.escape(r['symbol'])}</td><td colspan=6>data unavailable at generation time</td></tr>"
        else:
            ind_rows += ("<tr><td>{symbol}</td><td>{close}</td><td>{sma10}</td><td>{sma30}</td>"
                         "<td>{rsi14}</td><td>{finch}</td><td><b>{signal}</b></td><td>{asof}</td></tr>").format(**{k: html.escape(str(v)) for k, v in r.items()})
    page = TEMPLATE.format(gen_at=gen_at, ind_rows=ind_rows, cash=cash, starting_cash=inr(pf["starting_cash"]) if pf else "n/a",
                           pos_rows=pos_rows or '<tr><td colspan=3>No open simulated positions</td></tr>',
                           trade_rows=trade_rows or '<tr><td colspan=4>No simulated fills recorded yet</td></tr>')
    OUT.write_text(page)
    print("wrote", OUT)

TEMPLATE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SignalFloor - simulation snapshot</title>
<style>
body{{font-family:system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem;color:#1a1a1a}}
table{{border-collapse:collapse;width:100%;margin:1rem 0}}td,th{{border:1px solid #ccc;padding:.4rem .6rem;text-align:left;font-size:.9rem}}
.banner{{background:#fff3cd;border:1px solid #e0a800;padding:.8rem 1rem;border-radius:6px}}
.meta{{color:#555;font-size:.85rem}}h1{{margin-bottom:.2rem}}
</style></head><body>
<h1>SignalFloor</h1>
<p class="meta">Agent-to-agent market analysis + simulated paper trading on BAND rooms - team 0dev, Diwali Festiverse A2A Hackathon (India).</p>
<div class="banner"><b>Simulation snapshot, not a live service.</b> Generated {gen_at} from recorded
simulation runs and delayed public daily-bar data (yfinance). All trades are paper fills in a local
simulated portfolio. No brokerage connection, no real orders, no investment advice. Simulated results
are not evidence of real-world performance.</div>
<h2>Latest indicator snapshot</h2>
<table><tr><th>Symbol</th><th>Close</th><th>SMA10</th><th>SMA30</th><th>RSI14 (simple)</th><th>Finch RSI zone-transition (Wilder, prev-&gt;now)</th><th>Signal</th><th>Data as of (bar date)</th></tr>
{ind_rows}</table>
<h2>Simulated paper portfolio</h2>
<p>Cash: {cash} &middot; Starting cash: INR {starting_cash} (simulated)</p>
<h3>Open positions</h3>
<table><tr><th>Symbol</th><th>Qty</th><th>Avg price</th></tr>{pos_rows}</table>
<h3>Recent simulated fills</h3>
<table><tr><th>Time</th><th>Symbol</th><th>Side</th><th>Price</th></tr>{trade_rows}</table>
<h2>How it works</h2>
<p>A Market Analyst agent computes SMA/RSI signals from delayed daily bars and posts them to a BAND room.
A Trade Executor agent listening in the same room risk-checks each signal (no shorting, position and cash
caps) and books simulated fills on this paper portfolio. Agents communicate only through the BAND room.
Source: <a href="https://github.com/MrNagabhushana-0-dev/signalfloor">github.com/MrNagabhushana-0-dev/signalfloor</a></p>
</body></html>"""

if __name__ == "__main__":
    main()
