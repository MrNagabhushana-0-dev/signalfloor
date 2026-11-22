/* SignalFloor interactive workbench. Client-side port of the agents' own logic:
   indicators (agents/signals.py), Finch RSI zone-reversal skill (vendor/, Apache-2.0),
   pick_signal() scoring, and PaperPortfolio.try_fill() risk checks.
   Runs entirely in the browser on the recorded dataset in data.js. No network calls.
   SIMULATION ONLY: no brokerage, no real orders, no live data. */
(function () {
  "use strict";

  var DATA = window.SF_DATA;
  var SYMBOLS = Object.keys(DATA);
  var PARAMS = { rsiPeriod: 14, oversold: 30.0, overbought: 70.0 }; // SignalFloor's Finch calibration (signals.py FINCH_PARAMS)
  var PORTFOLIO0 = { cash: 502838.8, starting_cash: 1000000.0, positions: { "TCS.NS": { qty: 212, avg: 2345.1 } } };
  var MAX_POSITION_PCT = 0.25, MAX_OPEN = 5;

  /* ---------- indicator math (ports of agents/signals.py) ---------- */
  function sma(values, n) {
    if (values.length < n) return null;
    var s = 0;
    for (var i = values.length - n; i < values.length; i++) s += values[i];
    return s / n;
  }
  // Simple RSI exactly as agents/signals.py _rsi(): averages over ALL bars, last `period` values
  function rsiSimple(closes, period) {
    if (closes.length < period + 1) return null;
    var gains = [], losses = [];
    for (var i = 1; i < closes.length; i++) {
      var d = closes[i] - closes[i - 1];
      gains.push(Math.max(d, 0)); losses.push(Math.max(-d, 0));
    }
    var ag = 0, al = 0;
    for (var j = gains.length - period; j < gains.length; j++) { ag += gains[j]; al += losses[j]; }
    ag /= period; al /= period;
    if (al === 0) return 100;
    return 100 - 100 / (1 + ag / al);
  }
  // Wilder RSI series (port of vendor finch rsi_zone_reversal.py rsi_series)
  function rsiSeriesWilder(values, period) {
    if (values.length < period + 1) return [];
    var ag = 0, al = 0, i;
    for (i = 1; i <= period; i++) {
      var ch = values[i] - values[i - 1];
      ag += Math.max(ch, 0); al += Math.max(-ch, 0);
    }
    ag /= period; al /= period;
    var val = function (g, l) { return l === 0 ? 100 : 100 - 100 / (1 + g / l); };
    var out = [val(ag, al)];
    for (i = period + 1; i < values.length; i++) {
      var c = values[i] - values[i - 1];
      ag = (ag * (period - 1) + Math.max(c, 0)) / period;
      al = (al * (period - 1) + Math.max(-c, 0)) / period;
      out.push(val(ag, al));
    }
    return out;
  }
  // Port of finch evaluate(): zone-transition decision on the last CLOSED bar (frames[:-1], as agents do live)
  function finchEvaluate(barsUpto) {
    var closes = barsUpto.map(function (b) { return b[4]; });
    var closed = closes.slice(0, -1);
    var series = rsiSeriesWilder(closed, PARAMS.rsiPeriod);
    if (series.length < 2) {
      return { action: "flat", price: closed[closed.length - 1] || 0, reason: "not enough closed bars for RSI(" + PARAMS.rsiPeriod + ")" };
    }
    var now = series[series.length - 1], prev = series[series.length - 2], price = closed[closed.length - 1];
    if (prev < PARAMS.oversold && now >= PARAMS.oversold) {
      return { action: "long", price: price, rsiNow: now, rsiPrev: prev,
        reason: "RSI recovered out of oversold (" + prev.toFixed(1) + " -> " + now.toFixed(1) + ")" };
    }
    if (prev > PARAMS.overbought && now <= PARAMS.overbought) {
      return { action: "exit", price: price, rsiNow: now, rsiPrev: prev,
        reason: "RSI turned down out of overbought (" + prev.toFixed(1) + " -> " + now.toFixed(1) + ")" };
    }
    return { action: "flat", price: price, rsiNow: now, rsiPrev: prev,
      reason: "no zone transition (" + prev.toFixed(1) + " -> " + now.toFixed(1) + ", zones 30/70)" };
  }

  // Port of pick_signal() for one symbol. Returns {side, reason, score} or {side:null, reason}
  function evaluateSymbol(sym, asofIdx) {
    var bars = DATA[sym].slice(0, asofIdx + 1);
    var closes = bars.map(function (b) { return b[4]; });
    var price = closes[closes.length - 1];
    var prev = closes[closes.length - 2] != null ? closes[closes.length - 2] : price;
    var s10 = sma(closes, 10), s30 = sma(closes, 30), rsi = rsiSimple(closes, PARAMS.rsiPeriod);
    var finch = finchEvaluate(bars);
    var snap = {
      symbol: sym, price: price, asof: bars[bars.length - 1][0],
      sma10: s10 != null ? round2(s10) : null, sma30: s30 != null ? round2(s30) : null,
      rsi14: rsi != null ? round1(rsi) : null,
      changePct: prev ? round2((price - prev) / prev * 100) : 0,
      finch: finch, bars: bars, closes: closes
    };
    var side = null, reason = [];
    if (s10 != null && s30 != null && rsi != null) {
      if (s10 > s30 && rsi < 70) { side = "BUY"; reason = ["sma10>sma30 uptrend", "rsi " + snap.rsi14 + " < 70"]; }
      else if (s10 < s30 && rsi > 30) { side = "SELL"; reason = ["sma10<sma30 downtrend", "rsi " + snap.rsi14 + " > 30"]; }
    }
    if (finch.action === "long") { side = "BUY"; reason = ["finch rsi-zone-reversal skill: " + finch.reason]; }
    else if (finch.action === "exit") { side = "SELL"; reason = ["finch rsi-zone-reversal skill: " + finch.reason]; }
    else if (finch.action === "flat") { side = null; reason = ["finch: " + finch.reason]; }
    snap.side = side;
    snap.reasonText = reason.join("; ");
    if (side) {
      snap.score = Math.abs(s10 - s30) / s30 + Math.abs(rsi - 50) / 100;
    }
    return snap;
  }
  function round2(x) { return Math.round(x * 100) / 100; }
  function round1(x) { return Math.round(x * 10) / 10; }

  // Analyst room-post formats (market_analyst.py format_signal / no-trade status)
  function formatSignal(s) {
    return "SIGNAL " + s.symbol + " " + s.side + " price=" + s.price + " asof=" + s.asof +
      " sma10=" + s.sma10 + " sma30=" + s.sma30 + " rsi14=" + s.rsi14 +
      " change1d=" + s.changePct + "% reason=\"" + s.reasonText + "\"";
  }
  function formatNoTrade(notes) {
    return "STATUS NO-TRADE cycle (strategy v2, Finch RSI zone-transition, delayed public data): " + notes;
  }

  // Port of PaperPortfolio.try_fill() against the recorded paper portfolio (copy; nothing persists)
  function tryFill(state, symbol, side, price) {
    var pos = state.positions;
    if (side === "BUY") {
      if (!(symbol in pos) && Object.keys(pos).length >= MAX_OPEN) {
        return { ok: false, msg: "risk check failed: max " + MAX_OPEN + " open positions" };
      }
      var budget = Math.min(state.cash, state.starting_cash * MAX_POSITION_PCT);
      var qty = Math.max(1, Math.floor(budget / price));
      var cost = round2(qty * price);
      if (cost > state.cash) {
        return { ok: false, msg: "risk check failed: insufficient paper cash (" + state.cash.toFixed(2) + " < " + cost.toFixed(2) + ")" };
      }
      var p = pos[symbol] || { qty: 0, avg: 0 };
      var nq = p.qty + qty;
      p.avg = round2((p.avg * p.qty + cost) / nq); p.qty = nq;
      pos[symbol] = p;
      state.cash = round2(state.cash - cost);
      return { ok: true, msg: "SIM BUY " + qty + " " + symbol + " @ " + price + " (avg " + p.avg + ")", qty: qty };
    }
    var pp = pos[symbol];
    if (!pp || pp.qty <= 0) {
      return { ok: false, msg: "risk check failed: no open " + symbol + " position to sell (no shorting)" };
    }
    var proceeds = round2(pp.qty * price);
    var pnl = round2((price - pp.avg) * pp.qty);
    state.cash = round2(state.cash + proceeds);
    delete pos[symbol];
    return { ok: true, msg: "SIM SELL " + pp.qty + " " + symbol + " @ " + price + " (trade P&L " + (pnl >= 0 ? "+" : "") + pnl + ")" };
  }

  /* ---------- state ---------- */
  var cur = { sym: SYMBOLS[0], idx: DATA[SYMBOLS[0]].length - 1 };
  var portfolio = JSON.parse(JSON.stringify(PORTFOLIO0));

  /* ---------- rendering ---------- */
  var $ = function (id) { return document.getElementById(id); };

  function renderChart(snap) {
    var bars = snap.bars, closes = snap.closes;
    var W = 720, H = 240, PL = 44, PR = 10, PT = 12, PB = 22;
    var lo = Math.min.apply(null, closes), hi = Math.max.apply(null, closes);
    var pad = (hi - lo) * 0.06 || 1; lo -= pad; hi += pad;
    var x = function (i) { return PL + (W - PL - PR) * (i / (closes.length - 1)); };
    var y = function (v) { return PT + (H - PT - PB) * (1 - (v - lo) / (hi - lo)); };
    var smaSeries = function (n) {
      var out = [];
      for (var i = 0; i < closes.length; i++) {
        if (i < n - 1) { out.push(null); continue; }
        var s = 0; for (var j = i - n + 1; j <= i; j++) s += closes[j];
        out.push(s / n);
      }
      return out;
    };
    var path = function (vals) {
      var d = "", started = false;
      for (var i = 0; i < vals.length; i++) {
        if (vals[i] == null) continue;
        d += (started ? "L" : "M") + x(i).toFixed(1) + " " + y(vals[i]).toFixed(1);
        started = true;
      }
      return d;
    };
    var last = closes.length - 1;
    var lastPrice = closes[last];
    var html = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Price chart for ' + snap.symbol + ' up to ' + snap.asof + '" preserveAspectRatio="none">';
    html += '<defs><linearGradient id="areagrad" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#8b7bd8" stop-opacity="0.28"/>' +
      '<stop offset="1" stop-color="#8b7bd8" stop-opacity="0"/></linearGradient></defs>';
    // area under the close line
    var area = 'M' + x(0).toFixed(1) + ' ' + y(closes[0]).toFixed(1);
    for (var ai = 1; ai < closes.length; ai++) area += 'L' + x(ai).toFixed(1) + ' ' + y(closes[ai]).toFixed(1);
    area += 'L' + x(closes.length - 1).toFixed(1) + ' ' + (H - PB) + 'L' + x(0).toFixed(1) + ' ' + (H - PB) + 'Z';
    html += '<path d="' + area + '" class="area"/>';
    // grid
    for (var g = 0; g <= 4; g++) {
      var gy = PT + (H - PT - PB) * (g / 4);
      var gv = hi - (hi - lo) * (g / 4);
      html += '<line x1="' + PL + '" y1="' + gy + '" x2="' + (W - PR) + '" y2="' + gy + '" class="grid"/>';
      html += '<text x="' + (PL - 6) + '" y="' + (gy + 3) + '" class="gtext">' + Math.round(gv).toLocaleString("en-IN") + "</text>";
    }
    html += '<path d="' + path(closes) + '" class="line-price"/>';
    html += '<path d="' + path(smaSeries(10)) + '" class="line-s10"/>';
    html += '<path d="' + path(smaSeries(30)) + '" class="line-s30"/>';
    html += '<circle cx="' + x(last) + '" cy="' + y(lastPrice) + '" r="4" class="dot"/>';
    html += '<text x="' + Math.max(PL + 2, Math.min(W - PR - 150, x(last) - 60)) + '" y="' + (y(lastPrice) - 10) + '" class="ptext">' + snap.asof + "  " + lastPrice.toLocaleString("en-IN") + "</text>";
    html += "</svg>";
    return html;
  }

  function ruleRow(ok, label) {
    var cls = ok === null ? "rule na" : ok ? "rule pass" : "rule fail";
    var mark = ok === null ? "n/a" : ok ? "pass" : "no";
    return '<li class="' + cls + '"><span class="rule-mark">' + mark + "</span> " + label + "</li>";
  }

  function render() {
    var snap = evaluateSymbol(cur.sym, cur.idx);
    $("chart").innerHTML = renderChart(snap);
    $("asof-label").innerHTML = snap.asof + " <small>(bar " + (cur.idx + 1) + " of " + DATA[cur.sym].length + ")</small>";
    $("slider").max = DATA[cur.sym].length - 1;
    $("slider").value = cur.idx;

    var m = $("metrics");
    m.innerHTML = "";
    [["Close", snap.price.toLocaleString("en-IN") + " (" + (snap.changePct >= 0 ? "+" : "") + snap.changePct + "% 1d)"],
     ["SMA 10", snap.sma10 != null ? snap.sma10.toLocaleString("en-IN") : "n/a"],
     ["SMA 30", snap.sma30 != null ? snap.sma30.toLocaleString("en-IN") : "n/a"],
     ["RSI 14 (agent)", snap.rsi14 != null ? snap.rsi14 : "n/a"],
     ["RSI 14 (Finch/Wilder)", snap.finch.rsiNow != null ? round1(snap.finch.rsiNow) : "n/a"],
    ].forEach(function (kv) {
      m.innerHTML += '<div class="metric"><span class="m-k">' + kv[0] + '</span><span class="m-v">' + kv[1] + "</span></div>";
    });

    var f = snap.finch;
    var rules = $("rules");
    rules.innerHTML =
      ruleRow(snap.sma10 != null && snap.sma30 != null ? snap.sma10 > snap.sma30 : null, "SMA10 above SMA30 (uptrend)") +
      ruleRow(snap.sma10 != null && snap.sma30 != null ? snap.sma10 < snap.sma30 : null, "SMA10 below SMA30 (downtrend)") +
      ruleRow(snap.rsi14 != null ? snap.rsi14 < 70 : null, "RSI below 70 (long guard)") +
      ruleRow(snap.rsi14 != null ? snap.rsi14 > 30 : null, "RSI above 30 (short guard)") +
      ruleRow(f.action === "long", "Finch zone: RSI recovery out of oversold (long override)") +
      ruleRow(f.action === "exit", "Finch zone: RSI turn down out of overbought (exit override)") +
      ruleRow(f.action === "flat", "Finch zone: no transition (vetoes trend signal)");

    var out = $("signal-out");
    if (snap.side) {
      out.innerHTML = '<div class="sig ' + (snap.side === "BUY" ? "sig-buy" : "sig-sell") + '">' +
        '<span class="sig-side">' + snap.side + " " + snap.symbol + "</span>" +
        '<details class="payload"><summary>Room message payload</summary><code>' + escapeHtml(formatSignal(snap)) + "</code></details></div>";
      $("executor-box").hidden = false;
    } else {
      out.innerHTML = '<div class="sig sig-flat"><span class="sig-side">NO TRADE</span>' +
        '<details class="payload"><summary>Room message payload</summary><code>' + escapeHtml(formatNoTrade(snap.symbol + ": " + f.reason)) + "</code></details></div>";
      $("executor-box").hidden = true;
    }
    $("fill-result").textContent = "";
    $("fill-btn").dataset.side = snap.side || "";
    $("fill-btn").textContent = snap.side ? "Simulate executor risk check + paper fill" : "";
    renderPortfolio();
  }

  function renderPortfolio() {
    var p = portfolio;
    var inv = 0, parts = [];
    Object.keys(p.positions).forEach(function (s) {
      var pos = p.positions[s];
      inv += pos.avg * pos.qty;
      parts.push(s + ": " + pos.qty + " @ avg " + pos.avg);
    });
    var total = p.cash + inv, pnl = total - p.starting_cash;
    $("portfolio-line").textContent =
      "PAPER PORTFOLIO cash " + p.cash.toFixed(2) + " | invested " + inv.toFixed(2) +
      " | total " + total.toFixed(2) + " | P&L " + (pnl >= 0 ? "+" : "") + pnl.toFixed(2) +
      " (" + (pnl / p.starting_cash * 100).toFixed(2) + "%) | " + (parts.join("; ") || "no open positions");
  }

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* ---------- deep-link state (?sym=TCS.NS&idx=93) ---------- */
  function applyParams() {
    var q = new URLSearchParams(location.search);
    var s = q.get("sym");
    if (s && DATA[s]) cur.sym = s;
    var i = parseInt(q.get("idx"), 10);
    if (!isNaN(i)) cur.idx = Math.max(44, Math.min(DATA[cur.sym].length - 1, i));
  }

  /* ---------- events ---------- */
  function init() {
    applyParams();
    var picker = $("sym-picker");
    SYMBOLS.forEach(function (s) {
      var b = document.createElement("button");
      b.type = "button"; b.className = "chip" + (s === cur.sym ? " on" : "");
      b.textContent = s.replace(".NS", "");
      b.setAttribute("aria-pressed", s === cur.sym ? "true" : "false");
      if (s === cur.sym) { /* keep param-selected state */ }
      b.addEventListener("click", function () {
        cur.sym = s; cur.idx = DATA[s].length - 1;
        Array.prototype.forEach.call(picker.children, function (c) {
          c.classList.toggle("on", c.textContent === s.replace(".NS", ""));
          c.setAttribute("aria-pressed", c.classList.contains("on") ? "true" : "false");
        });
        render();
      });
      picker.appendChild(b);
    });
    var slider = $("slider");
    slider.min = 44; // need >= 45 bars for SMA30 + RSI history, same as agents
    slider.addEventListener("input", function () { cur.idx = parseInt(slider.value, 10); render(); });
    $("fill-btn").addEventListener("click", function () {
      var snap = evaluateSymbol(cur.sym, cur.idx);
      if (!snap.side) return;
      var r = tryFill(portfolio, snap.symbol, snap.side, snap.price);
      var el = $("fill-result");
      el.textContent = (r.ok ? "" : "") + r.msg + "  (simulated against the recorded paper portfolio; resets on reload)";
      el.className = r.ok ? "fill-ok" : "fill-fail";
      renderPortfolio();
    });
    $("reset-btn").addEventListener("click", function () {
      portfolio = JSON.parse(JSON.stringify(PORTFOLIO0));
      $("fill-result").textContent = "";
      renderPortfolio();
    });
    $("scan-btn").addEventListener("click", function () {
      var best = null, rows = [];
      SYMBOLS.forEach(function (s) {
        var snap = evaluateSymbol(s, Math.min(cur.idx, DATA[s].length - 1));
        rows.push(snap);
        if (snap.side && (best === null || snap.score > best.score)) best = snap;
      });
      var box = $("scan-result");
      var html = '<table class="scan-table"><thead><tr><th>Symbol</th><th>Close</th><th>SMA10</th><th>SMA30</th><th>RSI14</th><th>Finch</th><th>Verdict</th></tr></thead><tbody>';
      rows.forEach(function (r) {
        html += "<tr" + (best && r.symbol === best.symbol ? ' class="picked"' : "") + "><td>" + r.symbol + "</td><td>" +
          r.price.toLocaleString("en-IN") + "</td><td>" + (r.sma10 != null ? r.sma10 : "-") + "</td><td>" +
          (r.sma30 != null ? r.sma30 : "-") + "</td><td>" + (r.rsi14 != null ? r.rsi14 : "-") + "</td><td>" +
          r.finch.action + "</td><td>" + (r.side ? r.side + " (score " + r.score.toFixed(4) + ")" : "flat") + "</td></tr>";
      });
      html += "</tbody></table>";
      html += best
        ? '<p class="scan-verdict">Analyst pick (highest score): <strong>' + best.side + " " + best.symbol + '</strong> &mdash; <code>' + escapeHtml(formatSignal(best)) + "</code></p>"
        : '<p class="scan-verdict">Analyst pick: <strong>NO TRADE</strong> &mdash; <code>' + escapeHtml(formatNoTrade(rows.map(function (r) { return r.symbol + ": " + r.finch.reason; }).join(" | "))) + "</code></p>";
      box.innerHTML = html;
    });

    // replay
    Array.prototype.forEach.call(document.querySelectorAll(".replay-step-btn"), function (b) {
      b.addEventListener("click", function () {
        var steps = document.querySelectorAll(".replay-step");
        var visible = document.querySelectorAll(".replay-step:not([hidden])").length;
        if (b.dataset.dir === "next" && visible < steps.length) steps[visible].hidden = false;
        if (b.dataset.dir === "prev" && visible > 1) steps[visible - 1].hidden = true;
        if (b.dataset.dir === "all") Array.prototype.forEach.call(steps, function (s) { s.hidden = false; });
      });
    });

    render();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
