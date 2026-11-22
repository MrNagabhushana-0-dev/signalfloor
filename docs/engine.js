// SignalFloor rule engine. Pure functions over loaded delayed bars.
// Every output is computed at call time from window.SF_BARS plus the caller's
// parameters. Nothing in this file is precomputed per-scenario.
"use strict";
window.SF_ENGINE = (() => {

  function sma(vals, n, end) {
    if (end < n - 1) return null;
    let s = 0;
    for (let i = end - n + 1; i <= end; i++) s += vals[i];
    return s / n;
  }

  // Wilder's RSI series over closes; returns array with nulls until period.
  function rsiSeries(closes, period) {
    const out = new Array(closes.length).fill(null);
    if (closes.length < period + 1) return out;
    let g = 0, l = 0;
    for (let i = 1; i <= period; i++) {
      const d = closes[i] - closes[i - 1];
      if (d >= 0) g += d; else l -= d;
    }
    let ag = g / period, al = l / period;
    out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    for (let i = period + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      ag = (ag * (period - 1) + Math.max(d, 0)) / period;
      al = (al * (period - 1) + Math.max(-d, 0)) / period;
      out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    }
    return out;
  }

  // Zone-transition rule (same family as the agents' Finch RSI zone-reversal):
  // BUY when RSI crosses up out of the oversold zone; SELL when RSI crosses
  // down out of the overbought zone. Optional SMA trend filter.
  // Returns {side, reason} or null for bar index i.
  function ruleAt(closes, rsi, p, i, opts) {
    if (i < 1 || rsi[i] == null || rsi[i - 1] == null) return null;
    const wasOS = rsi[i - 1] <= p.oversold, nowOS = rsi[i] <= p.oversold;
    const wasOB = rsi[i - 1] >= p.overbought, nowOB = rsi[i] >= p.overbought;
    let side = null, why = null;
    if (wasOS && !nowOS) { side = "BUY"; why = `RSI ${p.rsiPeriod} crossed up out of oversold (${rsi[i-1].toFixed(1)} -> ${rsi[i].toFixed(1)})`; }
    else if (wasOB && !nowOB) { side = "SELL"; why = `RSI ${p.rsiPeriod} crossed down out of overbought (${rsi[i-1].toFixed(1)} -> ${rsi[i].toFixed(1)})`; }
    if (!side) return null;
    if (opts.trendFilter) {
      const f = sma(closes, p.smaFast, i), s = sma(closes, p.smaSlow, i);
      if (f == null || s == null) return null;
      if (side === "BUY" && f < s) return null;   // no buys against downtrend
      if (side === "SELL" && f > s) return null;  // no sells against uptrend
      why += `; SMA${p.smaFast} ${f > s ? ">" : "<"} SMA${p.smaSlow} trend filter passed`;
    }
    return { side, reason: why };
  }

  // Current verdict per symbol at the latest loaded bar.
  function scan(bars, p, opts) {
    const out = [];
    for (const [sym, rows] of Object.entries(bars)) {
      const closes = rows.map(r => r[4]);
      const rsi = rsiSeries(closes, p.rsiPeriod);
      const i = closes.length - 1;
      const f = sma(closes, p.smaFast, i), s = sma(closes, p.smaSlow, i);
      const sig = ruleAt(closes, rsi, { rsiPeriod: p.rsiPeriod, oversold: p.oversold, overbought: p.overbought, smaFast: p.smaFast, smaSlow: p.smaSlow }, i, opts);
      out.push({
        sym, date: rows[i][0], close: closes[i],
        rsi: rsi[i] == null ? null : +rsi[i].toFixed(1),
        smaFast: f == null ? null : +f.toFixed(2), smaSlow: s == null ? null : +s.toFixed(2),
        bars: closes.length,
        verdict: sig ? sig.side : "NO SIGNAL",
        reason: sig ? sig.reason : "no zone transition on the latest loaded bar",
      });
    }
    return out;
  }

  // Replay the caller's exact rules across the loaded history of one symbol.
  // Paper fills at the NEXT bar's open after each decision bar. Fee per side.
  // Returns {events, equity} where equity is marked on closes, cash+holdings.
  function replay(rows, p, opts, startCash, feePct) {
    const closes = rows.map(r => r[4]);
    const rsi = rsiSeries(closes, p.rsiPeriod);
    let cash = startCash, pos = 0, avg = 0;
    const events = [], equity = [];
    for (let i = 0; i < closes.length; i++) {
      const sig = ruleAt(closes, rsi, { rsiPeriod: p.rsiPeriod, oversold: p.oversold, overbought: p.overbought, smaFast: p.smaFast, smaSlow: p.smaSlow }, i, opts);
      if (sig && i + 1 < closes.length) {
        const open = rows[i + 1][1], odate = rows[i + 1][0];
        if (sig.side === "BUY") {
          const budget = startCash * p.budgetPct / 100;
          let qty = Math.floor(budget / open);
          if (qty < 1 && cash >= open) qty = 1; // preserved legacy minimum-one-share edge
          const cost = qty * open, fee = cost * feePct / 100;
          if (qty >= 1 && cash >= cost + fee) {
            cash -= cost + fee;
            avg = pos === 0 ? open : (avg * pos + open * qty) / (pos + qty);
            pos += qty;
            events.push({ side: "BUY", decided: rows[i][0], decidedClose: closes[i], filled: odate, open, qty, fee: +fee.toFixed(2), reason: sig.reason, outcome: "filled" });
          } else {
            events.push({ side: "BUY", decided: rows[i][0], decidedClose: closes[i], attempted: odate, open, reason: sig.reason, outcome: "rejected: insufficient cash" });
          }
        } else if (sig.side === "SELL") {
          if (pos > 0) {
            const proceeds = pos * open, fee = proceeds * feePct / 100;
            cash += proceeds - fee;
            events.push({ side: "SELL", decided: rows[i][0], decidedClose: closes[i], filled: odate, open, qty: pos, fee: +fee.toFixed(2), reason: sig.reason, outcome: "filled" });
            pos = 0; avg = 0;
          } else {
            events.push({ side: "SELL", decided: rows[i][0], decidedClose: closes[i], attempted: odate, open, reason: sig.reason, outcome: "rejected: no open position (no shorting)" });
          }
        }
      }
      equity.push({ date: rows[i][0], v: cash + pos * closes[i] });
    }
    return { events, equity, end: { cash: +cash.toFixed(2), pos, avg: +avg.toFixed(2) } };
  }

  return { sma, rsiSeries, scan, replay };
})();
