// SignalFloor desk app. All numbers computed in-browser from window.SF_BARS
// through window.SF_ENGINE. Browser-local persistence only; no server state.
"use strict";
(() => {
const DATA = window.SF_BARS, E = window.SF_ENGINE;
const LS_INPUTS = "sf.inputs.v1", LS_BOOK = "sf.book.v1", LS_BARS = "sf.bars.v2", LS_SEEN = "sf.seen.v1";
const $ = id => document.getElementById(id);
const START_CASH = 1000000;

const DEFAULTS = {
  symbols: ["TCS.NS", "RELIANCE.NS", "INFY.NS", "INDIGO.NS"],
  rsiPeriod: 14, oversold: 30, overbought: 70, smaFast: 10, smaSlow: 30,
  trendFilter: false, budgetPct: 25, feePct: 0.1, testSymbol: "TCS.NS",
};

function loadJSON(k, fb) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? fb : v; } catch { return fb; } }
function saveJSON(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
const inr = n => "₹" + Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 });
const inr0 = n => "₹" + Number(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });
const pct = n => (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const istOf = iso => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }) + " IST";

let toastT = null;
function toast(msg, ms) {
  const t = $("toast"); t.textContent = msg; t.classList.add("on");
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("on"), ms || 4200);
}

// ---------- merged bar store (build baseline + browser-cached refreshes) ----------
function mergeRows(base, extra, baseAsOf, extraAsOf) {
  const byDate = new Map();
  for (const r of (base || [])) byDate.set(r[0], { row: r, asof: baseAsOf || "" });
  for (const r of (extra || [])) {
    const row = [r.date, r.open, r.high, r.low, r.close, r.volume || 0];
    const cur = byDate.get(row[0]);
    if (!cur || (extraAsOf || "") >= cur.asof) byDate.set(row[0], { row, asof: extraAsOf || "" });
  }
  return [...byDate.values()].map(v => v.row).sort((a, b) => a[0] < b[0] ? -1 : 1).slice(-160);
}

let lsBars = loadJSON(LS_BARS, { symbols: {}, status: {} });
if (!lsBars || typeof lsBars !== "object") lsBars = { symbols: {}, status: {} };
lsBars.symbols = lsBars.symbols || {}; lsBars.status = lsBars.status || {};

const BARS = {};
function rebuildBars() {
  for (const k of Object.keys(BARS)) delete BARS[k];
  const syms = new Set([...Object.keys(DATA.symbols), ...Object.keys(lsBars.symbols)]);
  for (const s of syms) BARS[s] = mergeRows(DATA.symbols[s], lsBars.symbols[s], DATA.meta.fetched_at_utc, (lsBars.status[s] || {}).asof);
}
rebuildBars();
const allSyms = () => Object.keys(BARS).sort();
const latestBar = sym => { const r = BARS[sym]; return r && r[r.length - 1]; };
const dataThrough = () => {
  let d = "";
  for (const s of Object.keys(BARS)) { const b = latestBar(s); if (b && b[0] > d) d = b[0]; }
  return d || "no bars";
};
const pretty = s => s.replace(".NS", "");

// ---------- state ----------
let inputs = Object.assign({}, DEFAULTS, loadJSON(LS_INPUTS, {}));
inputs.symbols = (inputs.symbols || []).filter(s => BARS[s]);
if (!inputs.symbols.length) inputs.symbols = DEFAULTS.symbols.filter(s => BARS[s]);
if (!BARS[inputs.testSymbol]) inputs.testSymbol = inputs.symbols[0];

let book = loadJSON(LS_BOOK, null);
if (!book || book.v !== 1) book = { v: 1, cash: START_CASH, positions: {}, orders: [], done: [] };
for (const o of book.orders) { o.mode = o.mode || "rule"; o._id = o._id || (Date.now() + Math.random()); o.placedAt = o.placedAt || (o.decided + "T15:30:00+05:30"); }
for (const o of book.done) { o.mode = o.mode || "rule"; o.placedAt = o.placedAt || (o.decided + "T15:30:00+05:30"); }

const ui = { sheet: null, refreshing: false };
let ticket = { side: "BUY" };
const rp = { active: false, sym: null, i: 0, playing: false, timer: null, res: null };

const params = () => ({ rsiPeriod: +inputs.rsiPeriod, oversold: +inputs.oversold, overbought: +inputs.overbought, smaFast: +inputs.smaFast, smaSlow: +inputs.smaSlow, budgetPct: +inputs.budgetPct });
const opts = () => ({ trendFilter: !!inputs.trendFilter });

// ---------- IST session helpers (UTC+5:30, no DST) ----------
function istParts(iso) {
  const t = new Date(new Date(iso).getTime() + 19800e3);
  return { day: t.toISOString().slice(0, 10), mins: t.getUTCHours() * 60 + t.getUTCMinutes() };
}
function fillableDay(placedAt) {
  const p = istParts(placedAt);
  if (p.mins < 555) return p.day; // placed before 09:15 IST: that day's open is attainable
  return new Date(new Date(p.day + "T00:00:00Z").getTime() + 86400e3).toISOString().slice(0, 10);
}

// ---------- paper book fills ----------
// A pending order fills at the first loaded session whose open was not already
// in the past at actual placement time. Fills later than the earliest eligible
// weekday are labeled first-OBSERVED (unobserved sessions in between).
function tryFillOrders() {
  let changed = false;
  for (const o of book.orders) {
    if (o.status !== "pending") continue;
    const rows = BARS[o.sym];
    if (!rows) continue;
    const minDay = fillableDay(o.placedAt);
    const next = rows.find(r => r[0] > o.decided && r[0] >= minDay);
    if (!next) continue;
    const [odate, open] = next;
    let e = new Date(minDay + "T00:00:00Z");
    while (e.getUTCDay() === 0 || e.getUTCDay() === 6) e = new Date(e.getTime() + 86400e3);
    const firstEligibleWeekday = e.toISOString().slice(0, 10);
    if (odate > firstEligibleWeekday) o.delayedObservation = true; else delete o.delayedObservation;
    if (o.side === "BUY") {
      let qty;
      if (o.mode === "shares") qty = o.qty;
      else {
        const budget = START_CASH * inputs.budgetPct / 100;
        qty = Math.floor(budget / open);
        if (qty < 1 && book.cash >= open) qty = 1;
      }
      const cost = qty * open, fee = cost * inputs.feePct / 100;
      if (qty >= 1 && book.cash >= cost + fee) {
        book.cash -= cost + fee;
        const pos = book.positions[o.sym] || { qty: 0, avg: 0 };
        pos.avg = pos.qty === 0 ? open : (pos.avg * pos.qty + open * qty) / (pos.qty + qty);
        pos.qty += qty; book.positions[o.sym] = pos;
        o.status = "filled"; o.filled = odate; o.open = open; o.qty = qty; o.fee = +fee.toFixed(2); delete o.note;
      } else { o.status = "rejected"; o.note = "insufficient paper cash at the fill bar"; delete o.delayedObservation; }
    } else {
      const pos = book.positions[o.sym];
      const held = pos ? pos.qty : 0;
      const qty = o.mode === "shares" ? Math.min(o.qty, held) : held;
      if (qty > 0) {
        const proceeds = qty * open, fee = proceeds * feePct / 100;
        book.cash += proceeds - fee;
        pos.qty -= qty; if (pos.qty <= 0) delete book.positions[o.sym];
        o.status = "filled"; o.filled = odate; o.open = open; o.qty = qty; o.fee = +fee.toFixed(2); delete o.note;
      } else { o.status = "rejected"; o.note = "no open paper position (no shorting)"; delete o.delayedObservation; }
    }
    book.done.push(Object.assign({}, o));
    o._arch = true; changed = true;
  }
  if (changed) book.orders = book.orders.filter(o => !o._arch);
  saveJSON(LS_BOOK, book);
  return changed;
}

function queueOrder(sym, side, mode, qty) {
  const bar = latestBar(sym);
  book.orders.push({ _id: Date.now() + Math.random(), sym, side, mode, qty: mode === "shares" ? qty : undefined,
    decided: bar[0], decidedClose: bar[4], status: "pending", placedAt: new Date().toISOString(),
    note: (mode === "rule" ? "rule-sized (" + inputs.budgetPct + "% of start cash); " : "") +
      "placed " + istParts(new Date().toISOString()).day + " IST - fills at the first session open that is not already in the past, once its bar arrives via Refresh data" });
  saveJSON(LS_BOOK, book);
}
const hasPending = (sym, side) => book.orders.some(o => o.sym === sym && o.status === "pending" && (!side || o.side === side));
function cancelOrder(id) {
  const i = book.orders.findIndex(o => String(o._id) === String(id));
  if (i >= 0) { book.orders.splice(i, 1); saveJSON(LS_BOOK, book); renderAll(); }
}
function bookTotals() {
  let invested = 0;
  for (const [s, p] of Object.entries(book.positions)) { const b = latestBar(s); if (b) invested += p.qty * b[4]; }
  const total = book.cash + invested;
  return { invested, total, pl: total - START_CASH };
}

// ---------- chart ----------
const NS_SVG = "http://www.w3.org/2000/svg";
const C_UP = "#22d483", C_DOWN = "#f6465d", C_FAST = "#4c8dff", C_SLOW = "#f7b955", C_GRID = "#1b212a", C_AXIS = "#5d6875";

function smaSeries(closes, n) {
  const out = new Array(closes.length).fill(null);
  let s = 0;
  for (let i = 0; i < closes.length; i++) {
    s += closes[i];
    if (i >= n) s -= closes[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}
const monthShort = d => { const m = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]; return m[+d.slice(5,7)-1] + " " + d.slice(8,10); };

let chartGeom = null; // geometry of last draw, for crosshair mapping

function drawChart() {
  const svg = $("chart"), wrap = $("chartwrap");
  const W = Math.max(320, wrap.clientWidth - 2), H = Math.max(260, wrap.clientHeight - 2);
  svg.setAttribute("viewBox", "0 0 " + W + " " + H);
  const sym = rp.active ? rp.sym : inputs.testSymbol;
  const allRows = BARS[sym];
  if (!allRows || !allRows.length) { svg.innerHTML = ""; chartGeom = null; return; }

  const res = E.replay(allRows, params(), opts(), START_CASH, +inputs.feePct);
  const n0 = allRows.length;
  const upto = rp.active ? Math.max(2, rp.i + 1) : n0; // bars visible
  const rows = allRows.slice(0, upto);

  const AXR = 62, AXB = 18, PADL = 6, PADT = 8;
  const priceH = Math.round((H - AXB - PADT) * 0.74), rsiH = H - AXB - PADT - priceH - 8;
  const plotW = W - AXR - PADL;
  const n = rows.length;
  const cw = plotW / n, bw = Math.max(1.6, cw * 0.62);

  const closes = rows.map(r => r[4]);
  let lo = Infinity, hi = -Infinity;
  for (const r of rows) { if (r[3] < lo) lo = r[3]; if (r[2] > hi) hi = r[2]; }
  const smaF = smaSeries(closes, +inputs.smaFast), smaS = smaSeries(closes, +inputs.smaSlow);
  for (let i = 0; i < n; i++) { if (smaF[i] != null) { lo = Math.min(lo, smaF[i]); hi = Math.max(hi, smaF[i]); } if (smaS[i] != null) { lo = Math.min(lo, smaS[i]); hi = Math.max(hi, smaS[i]); } }
  const pad = (hi - lo) * 0.06 || 1; hi += pad; lo -= pad;
  const X = i => PADL + i * cw + cw / 2;
  const Y = v => PADT + (1 - (v - lo) / (hi - lo)) * priceH;

  let g = "";
  // gridlines + price labels
  for (let k = 0; k <= 4; k++) {
    const v = lo + (hi - lo) * k / 4, y = Y(v);
    g += `<line x1="${PADL}" y1="${y.toFixed(1)}" x2="${(W - AXR).toFixed(1)}" y2="${y.toFixed(1)}" stroke="${C_GRID}" stroke-width="1"/>`;
    g += `<text x="${W - AXR + 6}" y="${(y + 3.5).toFixed(1)}" font-size="10" fill="${C_AXIS}">${inr0(v)}</text>`;
  }
  // date ticks
  const step = Math.max(1, Math.round(n / 6));
  for (let i = 0; i < n; i += step) {
    const anchor = i === 0 ? "start" : (i + step >= n ? "end" : "middle");
    const tx = i === 0 ? PADL : (i + step >= n ? W - AXR : X(i));
    g += `<text x="${tx.toFixed(1)}" y="${H - 5}" font-size="9.5" fill="${C_AXIS}" text-anchor="${anchor}">${monthShort(rows[i][0])}</text>`;
  }
  // candles
  for (let i = 0; i < n; i++) {
    const [d, o, h2, l, c] = rows[i];
    const up = c >= o, col = up ? C_UP : C_DOWN;
    const x = X(i);
    g += `<line x1="${x.toFixed(1)}" y1="${Y(h2).toFixed(1)}" x2="${x.toFixed(1)}" y2="${Y(l).toFixed(1)}" stroke="${col}" stroke-width="1.1"/>`;
    const y1 = Y(Math.max(o, c)), y2 = Y(Math.min(o, c));
    g += `<rect x="${(x - bw / 2).toFixed(1)}" y="${y1.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, y2 - y1).toFixed(1)}" rx="1" fill="${col}"/>`;
  }
  // SMA overlays
  const sline = (arr, col) => {
    let d2 = "";
    for (let i = 0; i < n; i++) if (arr[i] != null) d2 += (d2 ? "L" : "M") + X(i).toFixed(1) + "," + Y(arr[i]).toFixed(1);
    return d2 ? `<path d="${d2}" fill="none" stroke="${col}" stroke-width="1.4" opacity=".9"/>` : "";
  };
  g += sline(smaF, C_FAST) + sline(smaS, C_SLOW);
  // fill markers (real replay events on visible bars)
  const idxByDate = {}; allRows.forEach((r, i) => { idxByDate[r[0]] = i; });
  for (const ev of res.events) {
    if (ev.outcome !== "filled") continue;
    const fi = idxByDate[ev.filled];
    if (fi == null || fi >= upto) continue;
    const x = X(fi);
    if (ev.side === "BUY") { const y = Y(rows[fi][3]) + 12; g += `<path d="M${x.toFixed(1)},${y.toFixed(1)} l-5.5,-9 h11 z" fill="${C_UP}" stroke="#04160d" stroke-width=".6"><title>BUY filled ${ev.filled} at ${inr(ev.open)} - ${esc(ev.reason)}</title></path>`; }
    else { const y = Y(rows[fi][2]) - 12; g += `<path d="M${x.toFixed(1)},${y.toFixed(1)} l-5.5,9 h11 z" fill="${C_DOWN}" stroke="#21060a" stroke-width=".6"><title>SELL filled ${ev.filled} at ${inr(ev.open)} - ${esc(ev.reason)}</title></path>`; }
  }
  // last price line + tag
  const lastC = closes[n - 1], prevC = n > 1 ? closes[n - 2] : lastC;
  const lcol = lastC >= prevC ? C_UP : C_DOWN;
  const ly = Y(lastC);
  g += `<line x1="${PADL}" y1="${ly.toFixed(1)}" x2="${(W - AXR).toFixed(1)}" y2="${ly.toFixed(1)}" stroke="${lcol}" stroke-width="1" stroke-dasharray="4 4" opacity=".8"/>`;
  g += `<rect x="${W - AXR + 2}" y="${(ly - 9).toFixed(1)}" width="${AXR - 4}" height="18" rx="5" fill="${lcol}"/>`;
  g += `<text x="${W - AXR + 8}" y="${(ly + 3.5).toFixed(1)}" font-size="10" font-weight="700" fill="#04160d">${inr0(lastC)}</text>`;

  // RSI pane
  const rsi = E.rsiSeries(allRows.map(r => r[4]), +inputs.rsiPeriod).slice(0, upto);
  const ry0 = PADT + priceH + 8, RY = v => ry0 + (1 - v / 100) * rsiH;
  g += `<rect x="${PADL}" y="${RY(70).toFixed(1)}" width="${plotW.toFixed(1)}" height="${(RY(30) - RY(70)).toFixed(1)}" fill="rgba(76,141,255,.05)"/>`;
  g += `<line x1="${PADL}" y1="${RY(70).toFixed(1)}" x2="${(W - AXR).toFixed(1)}" y2="${RY(70).toFixed(1)}" stroke="${C_GRID}" stroke-dasharray="3 4"/>`;
  g += `<line x1="${PADL}" y1="${RY(30).toFixed(1)}" x2="${(W - AXR).toFixed(1)}" y2="${RY(30).toFixed(1)}" stroke="${C_GRID}" stroke-dasharray="3 4"/>`;
  g += `<text x="${W - AXR + 6}" y="${(RY(70) + 3).toFixed(1)}" font-size="9" fill="${C_AXIS}">70</text>`;
  g += `<text x="${W - AXR + 6}" y="${(RY(30) + 3).toFixed(1)}" font-size="9" fill="${C_AXIS}">30</text>`;
  g += `<text x="${PADL + 2}" y="${(ry0 + 10).toFixed(1)}" font-size="9" fill="${C_AXIS}">RSI ${inputs.rsiPeriod}</text>`;
  let rd = "";
  for (let i = 0; i < n; i++) if (rsi[i] != null) rd += (rd ? "L" : "M") + X(i).toFixed(1) + "," + RY(rsi[i]).toFixed(1);
  if (rd) g += `<path d="${rd}" fill="none" stroke="${C_FAST}" stroke-width="1.3"/>`;
  const lastR = rsi[n - 1];
  if (lastR != null) {
    g += `<rect x="${W - AXR + 2}" y="${(RY(lastR) - 8).toFixed(1)}" width="${AXR - 4}" height="16" rx="5" fill="${C_FAST}"/>`;
    g += `<text x="${W - AXR + 8}" y="${(RY(lastR) + 3.5).toFixed(1)}" font-size="9.5" font-weight="700" fill="#04122b">${lastR.toFixed(1)}</text>`;
  }
  // crosshair layer
  g += `<g id="ch" style="display:none"><line id="ch-v" y1="${PADT}" y2="${(PADT + priceH + 8 + rsiH).toFixed(1)}" stroke="#3a4552" stroke-width="1"/><circle id="ch-c" r="3" fill="#fff"/></g>`;
  svg.innerHTML = g;
  chartGeom = { W, H, PADL, AXR, cw, n, rows, X, rsiFull: rsi };
  bindCrosshair();
}

function bindCrosshair() {
  const svg = $("chart");
  svg.onmousemove = ev => {
    const gm = chartGeom; if (!gm) return;
    const rect = svg.getBoundingClientRect();
    const px = (ev.clientX - rect.left) * (gm.W / rect.width);
    let i = Math.round((px - gm.PADL - gm.cw / 2) / gm.cw);
    i = Math.max(0, Math.min(gm.n - 1, i));
    const r = gm.rows[i]; if (!r) return;
    const chv = svg.querySelector("#ch-v"), chc = svg.querySelector("#ch-c"), chg = svg.querySelector("#ch");
    chg.style.display = "";
    chv.setAttribute("x1", gm.X(i)); chv.setAttribute("x2", gm.X(i));
    const priceH = gm.H - 18 - 8;
    const closes = gm.rows.map(x => x[4]);
    let lo = Infinity, hi = -Infinity; for (const x of gm.rows) { lo = Math.min(lo, x[3]); hi = Math.max(hi, x[2]); }
    const pad = (hi - lo) * 0.06 || 1; hi += pad; lo -= pad;
    const y = 8 + (1 - (r[4] - lo) / (hi - lo)) * (priceH * 0.74);
    chc.setAttribute("cx", gm.X(i)); chc.setAttribute("cy", y);
    const rv = gm.rsiFull[i];
    $("ohlc").hidden = false;
    $("ohlc").innerHTML = `<b>${r[0]}</b> &nbsp;O <b>${inr(r[1])}</b> H <b>${inr(r[2])}</b> L <b>${inr(r[3])}</b> C <b style="color:${r[4] >= r[1] ? C_UP : C_DOWN}">${inr(r[4])}</b>` + (rv != null ? ` &nbsp;RSI <b>${rv.toFixed(1)}</b>` : "");
  };
  svg.onmouseleave = () => {
    const chg = svg.querySelector("#ch"); if (chg) chg.style.display = "none";
    $("ohlc").hidden = true;
  };
}

// ---------- rendering: top / symbar / signal / ticket / book ----------
function renderTop() {
  $("data-through").textContent = dataThrough();
  const t = bookTotals();
  $("bal-cash").textContent = inr0(book.cash);
  $("bal-total").textContent = inr0(t.total);
  const pl = $("bal-pl");
  pl.textContent = (t.pl >= 0 ? "+" : "") + inr0(t.pl) + " (" + pct(t.pl / START_CASH * 100) + ")";
  pl.className = "num " + (t.pl >= 0 ? "up" : "down");
  const pend = book.orders.some(o => o.status === "pending");
  $("dot-book").hidden = !pend; $("dot-book-m").hidden = !pend;
  // Header balances are the live paper book, never a replayed frame: demote
  // them while replay runs so they cannot read as replay state.
  document.querySelector(".bals").classList.toggle("rp-dim", rp.active);
}

function renderSymbar() {
  const bar = $("symbar");
  // During replay, chip values are as of the replay bar's date, matching the
  // chart - a future price must never sit beside a past frame.
  const asOf = rp.active ? BARS[rp.sym][rp.i][0] : null;
  bar.innerHTML = inputs.symbols.filter(s => BARS[s]).map(s => {
    const rows = BARS[s];
    let idx = rows.length - 1;
    if (asOf) { while (idx > 0 && rows[idx][0] > asOf) idx--; if (rows[idx][0] > asOf) idx = -1; }
    if (idx < 0) return `<button class="symchip ${s === inputs.testSymbol ? "on" : ""}" data-sym="${s}" role="tab" aria-selected="${s === inputs.testSymbol}">
      <b>${pretty(s)}</b><span class="c">no bar by ${asOf}</span></button>`;
    const c = rows[idx][4], p = idx > 0 ? rows[idx - 1][4] : c;
    const ch = p ? (c / p - 1) * 100 : 0;
    return `<button class="symchip ${s === inputs.testSymbol ? "on" : ""}" data-sym="${s}" role="tab" aria-selected="${s === inputs.testSymbol}">
      <b>${pretty(s)}</b><span class="c num ${ch >= 0 ? "up" : "down"}">${inr0(c)} · ${pct(ch)}</span></button>`;
  }).join("") + `<button class="addchip" id="chip-add" title="Add an NSE symbol" type="button">+</button>`;
}

function scanRow(sym) {
  const sub = {};
  // During replay, scan only the bars visible at the replay position so the
  // analyst call is contemporaneous with the chart - never the future.
  sub[sym] = rp.active && rp.sym === sym ? BARS[sym].slice(0, Math.max(2, rp.i + 1)) : BARS[sym];
  return E.scan(sub, params(), opts())[0];
}

function renderSignal() {
  const sym = inputs.testSymbol, r = scanRow(sym);
  const v = r.verdict === "NO SIGNAL" ? "HOLD" : r.verdict;
  const glow = v === "BUY" ? "rgba(34,212,131,.14)" : v === "SELL" ? "rgba(246,70,93,.14)" : "rgba(76,141,255,.07)";
  const dup = hasPending(sym);
  const canQ = v !== "HOLD" && !dup && !rp.active;
  const asOf = rp.active && rp.sym === sym;
  $("sigcard").style.setProperty("--sig-glow", glow);
  $("sigcard").innerHTML = `
    <h3>Analyst call · ${pretty(sym)}</h3>
    <div class="sub">${asOf ? `As of replay bar ${r.date} · bar ${rp.i + 1} of ${BARS[sym].length} · historical, simulated` : `Latest loaded bar ${r.date} · ${r.bars} bars`}</div>
    <div class="sigverdict"><span class="sigword ${v}">${v}</span><span class="sigbadge ${v}">${v === "HOLD" ? "no signal" : "signal"}</span></div>
    <div class="sigreason">${esc(r.reason)}</div>
    <div class="siggrid">
      <div class="sigcell"><span>Close</span><b class="num">${inr(r.close)}</b></div>
      <div class="sigcell"><span>SMA ${inputs.smaFast}</span><b class="num">${r.smaFast != null ? inr(r.smaFast) : "–"}</b></div>
      <div class="sigcell"><span>SMA ${inputs.smaSlow}</span><b class="num">${r.smaSlow != null ? inr(r.smaSlow) : "–"}</b></div>
    </div>
    <div class="sigcell" style="margin-top:8px"><span>RSI ${inputs.rsiPeriod}</span><b class="num">${r.rsi ?? "–"}</b>
      ${r.rsi != null ? `<div class="gauge"><i style="left:${Math.max(1, Math.min(99, r.rsi))}%"></i></div>` : ""}</div>
    ${v !== "HOLD" && !rp.active ? `<button id="sig-queue" style="width:100%;margin-top:12px;padding:12px;font-weight:800;border-radius:12px;${v === "BUY" ? "background:var(--buy-dim);border-color:rgba(34,212,131,.4);color:var(--buy)" : "background:var(--sell-dim);border-color:rgba(246,70,93,.4);color:var(--sell)"}" ${canQ ? "" : "disabled"}>${dup ? "Order already pending" : "Queue this " + v + " (rule-sized)"}</button>` : ""}
    ${rp.active ? `<div class="fillnote" style="margin-top:10px">This call is computed at the replay bar. Orders queue against the latest loaded bar - exit replay to place one.</div>` : ""}`;
  const q = $("sig-queue");
  if (q && canQ) q.onclick = () => {
    queueOrder(sym, v, "rule");
    toast(`${v} ${pretty(sym)} queued - fills at a future session open once its bar arrives.`);
    renderAll();
  };
}

function ticketEst(sym, qraw) {
  const b = latestBar(sym);
  if (!b || !qraw || isNaN(+qraw) || +qraw <= 0) return "";
  const qty = Math.floor(+qraw);
  if (ticket.side === "BUY") {
    const cost = qty * b[4], fee = cost * inputs.feePct / 100;
    return `Est. at latest close (${b[0]}): ${inr(cost)} + fee ${inr(fee)} = ${inr(cost + fee)} · paper cash ${inr0(book.cash)}`;
  }
  const held = (book.positions[sym] || { qty: 0 }).qty;
  const proceeds = qty * b[4], fee = proceeds * inputs.feePct / 100;
  return `Est. at latest close (${b[0]}): ${inr(proceeds)} − fee ${inr(fee)} = ${inr(proceeds - fee)} · you hold ${held} sh`;
}

function renderTicket() {
  const sym = inputs.testSymbol;
  const el = $("ticket");
  if (rp.active) {
    el.innerHTML = `
      <h3>Paper order</h3>
      <div class="sub">${pretty(sym)}</div>
      <div class="fillnote" style="margin-top:4px">Replay is running. Paper orders always queue against the <b>latest loaded bar</b> at the real placement time - never against a replayed historical bar - so the ticket is paused while replay is active.</div>
      <button id="t-exit-rp" type="button" style="width:100%;margin-top:10px;padding:12px;font-weight:750;border-radius:12px">Exit replay to trade</button>`;
    el.querySelector("#t-exit-rp").onclick = exitReplay;
    return;
  }
  const prevQty = el.querySelector("#t-qty") ? el.querySelector("#t-qty").value : "";
  el.innerHTML = `
    <h3>Paper order</h3>
    <div class="sub">${pretty(sym)} · executor books it when a newer session bar arrives</div>
    <div class="seg">
      <button type="button" id="side-buy" class="${ticket.side === "BUY" ? "on-buy" : ""}">▲ Buy</button>
      <button type="button" id="side-sell" class="${ticket.side === "SELL" ? "on-sell" : ""}">▼ Sell</button>
    </div>
    <div class="qtyrow">
      <button type="button" id="q-minus" aria-label="Decrease quantity">−</button>
      <input id="t-qty" type="number" min="1" step="1" inputmode="numeric" placeholder="Qty" value="${esc(prevQty)}">
      <button type="button" id="q-plus" aria-label="Increase quantity">+</button>
    </div>
    <div class="qtychips">${[10, 25, 50, 100].map(q => `<button type="button" data-q="${q}">${q} sh</button>`).join("")}</div>
    <div id="t-est" class="num"></div>
    <button id="t-submit" type="button" class="${ticket.side === "BUY" ? "buy" : "sell"}">Queue ${ticket.side === "BUY" ? "Buy" : "Sell"} order</button>
    <div id="t-err"></div><div id="t-ok"></div>
    <div class="fillnote">Fills at the first session open that is not already in the past when the order is placed, once that bar arrives via Refresh data. Mechanical paper accounting: no spread, slippage or impact. This browser only.</div>`;
  const qEl = el.querySelector("#t-qty");
  const est = () => { el.querySelector("#t-est").textContent = ticketEst(sym, qEl.value.trim()); };
  el.querySelector("#side-buy").onclick = () => { ticket.side = "BUY"; renderTicket(); };
  el.querySelector("#side-sell").onclick = () => { ticket.side = "SELL"; renderTicket(); };
  el.querySelector("#q-minus").onclick = () => { qEl.value = Math.max(1, (Math.floor(+qEl.value) || 1) - 1); est(); };
  el.querySelector("#q-plus").onclick = () => { qEl.value = (Math.floor(+qEl.value) || 0) + 1; est(); };
  el.querySelectorAll("[data-q]").forEach(b => b.onclick = () => { qEl.value = b.dataset.q; est(); });
  qEl.oninput = () => { el.querySelector("#t-err").textContent = ""; est(); };
  el.querySelector("#t-submit").onclick = () => submitTicket(sym, qEl, el);
  est();
}

function submitTicket(sym, qEl, el) {
  const err = m => { el.querySelector("#t-err").textContent = m; el.querySelector("#t-ok").textContent = ""; };
  el.querySelector("#t-err").textContent = "";
  const qraw = qEl.value.trim();
  if (!qraw) return err("Enter a quantity.");
  const q = +qraw;
  if (isNaN(q) || q <= 0) return err("Quantity must be a positive number.");
  if (!Number.isInteger(q)) return err("Whole shares only - NSE equities trade in whole shares here.");
  const b = latestBar(sym);
  if (!b) return err("No bars loaded for " + sym + " - fetch it first.");
  if (hasPending(sym, ticket.side)) return err(`A pending ${ticket.side} for ${pretty(sym)} already exists. Cancel it in the book first, or wait for it to fill.`);
  if (ticket.side === "BUY") {
    const cost = q * b[4], fee = cost * inputs.feePct / 100;
    if (cost + fee > book.cash) return err(`Estimated cost ${inr(cost + fee)} exceeds paper cash ${inr0(book.cash)}. Try fewer shares.`);
  } else {
    const held = (book.positions[sym] || { qty: 0 }).qty;
    if (held <= 0) return err(`You hold no ${pretty(sym)} shares in the paper book (no shorting).`);
    if (q > held) return err(`You hold ${held} share${held === 1 ? "" : "s"} - cannot sell ${q}.`);
  }
  queueOrder(sym, ticket.side, "shares", q);
  el.querySelector("#t-ok").textContent = `${ticket.side} ${q} ${pretty(sym)} queued - pending until newer bars arrive.`;
  qEl.value = ""; el.querySelector("#t-est").textContent = "";
  toast(`${ticket.side} ${q} ${pretty(sym)} queued. Track it in the book.`);
  renderAll();
}

function posLine(s, p) {
  const b = latestBar(s);
  const pl = b ? (b[4] - p.avg) * p.qty : null;
  return `<div class="mini-line"><div><b>${pretty(s)}</b> <span class="num">${p.qty} sh @ ${inr(p.avg)}</span>
    <div class="meta">latest close ${b ? inr(b[4]) + " (" + b[0] + ")" : "no bars"}</div></div>
    ${pl != null ? `<span class="pos-pl num ${pl >= 0 ? "up" : "down"}">${pl >= 0 ? "+" : ""}${inr0(pl)}</span>` : ""}</div>`;
}
function pendLine(o) {
  return `<div class="mini-line"><div><span class="st pending">pending</span> <b>${o.side}</b> ${pretty(o.sym)}${o.mode === "shares" ? " × " + o.qty : ""}
    <div class="meta">decided ${o.decided} @ ${inr(o.decidedClose)} · fills at a future session open</div></div>
    <button class="linklike" data-cancel="${o._id}" type="button">cancel</button></div>`;
}

function renderSideBook() {
  const pos = Object.entries(book.positions).map(([s, p]) => posLine(s, p)).join("");
  const pend = book.orders.map(pendLine).join("");
  $("sidebook").innerHTML = pos + pend ||
    `<div class="empty">No positions or orders yet.<br>Queue one from the analyst call or place a paper order.</div>`;
  $("sidebook").querySelectorAll("[data-cancel]").forEach(b => b.onclick = () => cancelOrder(b.dataset.cancel));
}

// ---------- sheets ----------
const SHEET_TITLES = { book: "Paper book", lab: "Rule lab", info: "Data & about" };
function openSheet(name) {
  ui.sheet = name;
  $("sheet-title").textContent = SHEET_TITLES[name] || "";
  renderSheetBody();
  $("sheet").classList.add("on"); $("sheetback").classList.add("on");
  document.querySelectorAll(".railbtn[data-sheet]").forEach(b => b.classList.toggle("on", b.dataset.sheet === name));
}
function closeSheet() {
  ui.sheet = null;
  $("sheet").classList.remove("on"); $("sheetback").classList.remove("on");
  document.querySelectorAll(".railbtn[data-sheet]").forEach(b => b.classList.remove("on"));
  $("rail-desk").classList.add("on");
}
function renderSheetBody() {
  if (ui.sheet === "book") renderBookSheet();
  else if (ui.sheet === "lab") renderLabSheet();
  else if (ui.sheet === "info") renderInfoSheet();
}

function renderBookSheet() {
  const t = bookTotals();
  const pos = Object.entries(book.positions).map(([s, p]) => `<div class="bline"><span class="st holding">holding</span> ${posLine(s, p).replace('class="mini-line"', 'style="border:none;padding:4px 0;display:flex;justify-content:space-between;gap:8px"')}</div>`).join("");
  const pend = book.orders.map(o => `<div class="bline"><span class="st pending">pending</span> <b>${o.side}</b> ${pretty(o.sym)}${o.mode === "shares" ? " × " + o.qty : " (rule-sized)"}
    <div class="meta">${esc(o.note || "")}</div>
    <button class="linklike" data-cancel="${o._id}" type="button">cancel order</button></div>`).join("");
  const done = book.done.slice().reverse().map(o => `<div class="bline"><span class="st ${o.status}">${o.status}</span> <b>${o.side}</b> ${pretty(o.sym)}${o.qty ? " " + o.qty + " @ " + inr(o.open) : ""}
    <div class="meta">${o.filled ? "filled " + o.filled + " (session open)" : ""}${o.fee ? " · fee " + inr(o.fee) : ""}${o.note ? esc(o.note) : ""}</div>
    ${o.delayedObservation ? `<div class="meta warn">First OBSERVED eligible session: bars for sessions between placement and this fill were never loaded, so this may not be the actual first eligible session's open.</div>` : ""}</div>`).join("");
  $("sheet-body").innerHTML = `
    <div class="teststats" style="grid-template-columns:repeat(2,1fr)">
      <div class="stat"><div class="k">Paper cash</div><div class="v num">${inr(book.cash)}</div></div>
      <div class="stat"><div class="k">Invested (latest close)</div><div class="v num">${inr(t.invested)}</div></div>
      <div class="stat"><div class="k">Total</div><div class="v num">${inr(t.total)}</div></div>
      <div class="stat"><div class="k">P&amp;L vs ${inr0(START_CASH)}</div><div class="v num ${t.pl >= 0 ? "up" : "down"}" style="color:${t.pl >= 0 ? "var(--buy)" : "var(--sell)"}">${t.pl >= 0 ? "+" : ""}${inr(t.pl)} (${pct(t.pl / START_CASH * 100)})</div></div>
    </div>
    <div class="booksec"><h4>Positions</h4>${pos || '<div class="empty">No open paper positions.</div>'}</div>
    <div class="booksec"><h4>Pending orders</h4>${pend || '<div class="empty">Nothing pending.</div>'}</div>
    <div class="booksec"><h4>History</h4>${done || '<div class="empty">No fills or rejections yet.</div>'}</div>
    <button id="btn-reset-book" type="button" style="margin-top:6px">Reset paper book</button>
    <div class="disclaimer">Saved in this browser's local storage only. Clearing site data erases it; no server-side account state exists.</div>`;
  $("sheet-body").querySelectorAll("[data-cancel]").forEach(b => b.onclick = () => cancelOrder(b.dataset.cancel));
  $("btn-reset-book").onclick = () => {
    if (!confirm("Reset the paper book saved in this browser? This cannot be undone.")) return;
    book = { v: 1, cash: START_CASH, positions: {}, orders: [], done: [] };
    saveJSON(LS_BOOK, book); renderAll();
  };
}

const LAB_ROWS = [
  ["rsiPeriod", "RSI period", 2, 30, 1, "Bars per RSI reading."],
  ["oversold", "Oversold below", 10, 45, 1, "BUY arms when RSI crosses back up out of this zone."],
  ["overbought", "Overbought above", 55, 90, 1, "SELL arms when RSI crosses back down out of this zone."],
  ["smaFast", "SMA fast", 2, 50, 1, "Fast trend line on the chart."],
  ["smaSlow", "SMA slow", 5, 200, 1, "Slow trend line on the chart."],
  ["budgetPct", "Order budget (% of start cash)", 1, 100, 1, "Size of each rule-based paper buy."],
  ["feePct", "Fee per side (%)", 0, 2, 0.05, "Charged on every simulated fill, both sides."],
];
function labResultsHTML() {
  const sym = inputs.testSymbol, rows = BARS[sym];
  const res = E.replay(rows, params(), opts(), START_CASH, +inputs.feePct);
  const bh = (rows[rows.length - 1][4] / rows[0][4] - 1) * 100;
  const endV = res.equity[res.equity.length - 1].v;
  const ret = (endV / START_CASH - 1) * 100;
  const fills = res.events.filter(e => e.outcome === "filled").length;
  return `
    <div class="labrow"><div class="lhead"><label>Replay result on loaded history - ${pretty(sym)} (${rows[0][0]} → ${rows[rows.length - 1][0]})</label></div></div>
    <div class="teststats">
      <div class="stat"><div class="k">Signals</div><div class="v num">${res.events.length}</div></div>
      <div class="stat"><div class="k">Fills</div><div class="v num">${fills}</div></div>
      <div class="stat"><div class="k">End (paper)</div><div class="v num">${inr0(endV)}</div></div>
      <div class="stat"><div class="k">Open pos.</div><div class="v num">${res.end.pos} sh</div></div>
      <div class="stat"><div class="k">Strategy</div><div class="v num" style="color:${ret >= 0 ? "var(--buy)" : "var(--sell)"}">${pct(ret)}</div></div>
      <div class="stat"><div class="k">Buy &amp; hold</div><div class="v num" style="color:${bh >= 0 ? "var(--buy)" : "var(--sell)"}">${pct(bh)}</div></div>
    </div>
    <div id="test-events">${res.events.map(e => `
      <div class="ev"><b style="color:${e.side === "BUY" ? "var(--buy)" : "var(--sell)"}">${e.side}</b> decided ${e.decided} (close ${inr(e.decidedClose)})
      ${e.outcome === "filled" ? ` · <span style="color:var(--buy)">filled ${e.filled} @ ${inr(e.open)} · qty ${e.qty}, fee ${inr(e.fee)}</span>` : ` · attempted ${e.attempted} · <span style="color:var(--sell)">${esc(e.outcome)}</span>`}
      <div class="why">${esc(e.reason)}</div></div>`).join("") || '<div class="ev">No signals under these rules on the loaded bars.</div>'}</div>
    <div class="disclaimer">Historical replay on real delayed bars - simulated. Paper fills use the next bar's open after each decision bar. Past simulated results are not evidence of real-world performance.</div>`;
}

function renderLabSheet() {
  $("sheet-body").innerHTML = `
    <p style="margin:0 0 14px;font-size:.8rem;color:var(--muted)">Tune the strategy - the desk chart, markers and these results redraw from the actual computation on every change.</p>
    ${LAB_ROWS.map(([k, label, min, max, st, hint]) => `
      <div class="labrow"><div class="lhead"><label for="in-${k}">${label}</label><span class="val num" id="val-${k}">${inputs[k]}</span></div>
      <input type="range" id="in-${k}" min="${min}" max="${max}" step="${st}" value="${inputs[k]}">
      <div class="labhint">${hint}</div></div>`).join("")}
    <label class="checkline"><input id="in-trendFilter" type="checkbox" ${inputs.trendFilter ? "checked" : ""}> Trend filter - no buys below the SMA cross, no sells above</label>
    <div class="labrow" style="margin-top:14px"><div class="lhead"><label>Watchlist</label></div>
      <div class="watchwrap" id="symlist">${allSyms().map(s => `<label class="${inputs.symbols.includes(s) ? "on" : ""}"><input type="checkbox" data-sym="${s}" ${inputs.symbols.includes(s) ? "checked" : ""}>${pretty(s)}</label>`).join("")}</div>
      <div class="addsym"><input id="in-addsym" type="text" placeholder="Add NSE symbol, e.g. HDFCBANK" maxlength="18"><button id="btn-addsym" type="button">Fetch &amp; add</button></div>
      <div id="addsym-err"></div><div id="addsym-warn"></div></div>
    <div id="lab-results">${labResultsHTML()}</div>`;
  for (const [k] of LAB_ROWS) {
    $("in-" + k).oninput = ev => {
      inputs[k] = +ev.target.value;
      if (k === "smaFast" && inputs.smaFast >= inputs.smaSlow) inputs.smaSlow = Math.min(200, inputs.smaFast + 1);
      if (k === "smaSlow" && inputs.smaSlow <= inputs.smaFast) inputs.smaFast = Math.max(2, inputs.smaSlow - 1);
      if (k === "oversold" && inputs.oversold >= inputs.overbought) inputs.overbought = Math.min(90, inputs.oversold + 1);
      if (k === "overbought" && inputs.overbought <= inputs.oversold) inputs.oversold = Math.max(10, inputs.overbought - 1);
      saveJSON(LS_INPUTS, inputs);
      for (const [k2] of LAB_ROWS) { $("val-" + k2).textContent = inputs[k2]; if (k2 !== k) $("in-" + k2).value = inputs[k2]; }
      $("lab-results").innerHTML = labResultsHTML();
      chartWithFade(); renderSignal(); renderSymbar();
    };
  }
  $("in-trendFilter").onchange = ev => { inputs.trendFilter = ev.target.checked; saveJSON(LS_INPUTS, inputs); $("lab-results").innerHTML = labResultsHTML(); chartWithFade(); renderSignal(); };
  $("sheet-body").querySelectorAll("#symlist input").forEach(cb => cb.onchange = () => {
    inputs.symbols = cb.checked ? [...inputs.symbols, cb.dataset.sym] : inputs.symbols.filter(s => s !== cb.dataset.sym);
    if (!inputs.symbols.length) inputs.symbols = [cb.dataset.sym];
    if (!inputs.symbols.includes(inputs.testSymbol)) inputs.testSymbol = inputs.symbols[0];
    saveJSON(LS_INPUTS, inputs); renderAll();
  });
  $("btn-addsym").onclick = addSymbol;
  $("in-addsym").onkeydown = ev => { if (ev.key === "Enter") addSymbol(); };
}

function renderInfoSheet() {
  const errs = Object.entries(DATA.meta.errors || {});
  const st = lsBars.status || {};
  const ranges = allSyms().map(s => `${pretty(s)}: ${BARS[s][0][0]} → ${latestBar(s)[0]} (${BARS[s].length} bars)`);
  const fetched = Object.entries(st).filter(([, v]) => v && v.upstream).map(([s, v]) => `${s} via ${v.upstream} at ${istOf(v.asof)}`);
  const lastErrs = Object.entries(st).filter(([, v]) => v && v.error).map(([s, v]) => `${s}: ${esc(v.error)}`);
  $("sheet-body").innerHTML = `
    <div class="prov"><ul>
      <li><b>Baseline source:</b> ${esc(DATA.meta.source)}; fetched ${esc(DATA.meta.fetched_at_utc)}; raw prices, no dividend adjustment.</li>
      <li><b>In-app refresh:</b> the Refresh button pulls delayed daily bars through the same-origin proxy (/api/bars: Yahoo Finance chart API, then Groww latest-bar fallback, then Stooq) at the moment you press it. Refreshes are cached in this browser's storage only - the server stores nothing about you.${fetched.length ? "<br>This browser: " + esc(fetched.join("; ")) + "." : ""}</li>
      <li>The Groww fallback returns only the latest daily bar, so long-unrefreshed symbols can have gaps; the latest bar fetched during market hours may be a still-forming session.</li>
      <li><b>Coverage:</b> ${ranges.join("; ")}.</li>
      ${errs.length ? `<li class="errline">Baseline failed fetches: ${errs.map(([s, e]) => `${s} (${esc(e)})`).join("; ")}. Failed symbols are excluded, never guessed.</li>` : ""}
      ${lastErrs.length ? `<li class="errline">Latest refresh errors: ${lastErrs.join("; ")}. Previously loaded bars are kept.</li>` : ""}
      <li>Every number on this desk is recomputed in your browser from the loaded bars when an input changes - the same rule family as the BAND-room analyst and executor agents. This desk is not connected to the live BAND room; live agent-to-agent messaging happens only in the separate Python agents and is not shown here.</li>
      <li>Fills use the first session whose open was not already in the past when the order was actually placed (pre-open placements: that day's open; later placements: a later session), at its open, once that bar is loaded - an order never books an already-past price. A fill that landed later than the earliest eligible session is labeled "first observed eligible session". Mechanical paper accounting: no spread, slippage or impact; not a matched-risk control.</li>
      <li>Real-time/intraday feed: unavailable in this build (delayed daily bars only). Brokerage connection: not present by design.</li>
    </ul></div>
    <div class="about-links">
      <a href="https://www.mr-nagabhushanaraju-s.engineer/" target="_blank" rel="noopener"><span>Built by Nagabhushana Raju S</span><span>portfolio ↗</span></a>
      <a href="archive/docs-2026-11-22-frozen/" target="_blank" rel="noopener"><span>Archived build</span><span>2026-11-22 ↗</span></a>
      <a href="#" id="btn-how" ><span>How the desk works</span><span>replay intro</span></a>
    </div>
    <div class="disclaimer">SignalFloor - Diwali Festiverse agent-to-agent hackathon (India Edition), team 0dev.<br><br>
    Paper accounting only - not investment advice; simulated results are not evidence of real-world performance. No brokerage, no real orders, no real money.</div>`;
  $("btn-how").onclick = ev => { ev.preventDefault(); closeSheet(); showOnboard(); };
}

// ---------- replay mode ----------
function startReplay() {
  const sym = inputs.testSymbol;
  if (!BARS[sym] || BARS[sym].length < 5) { toast("Not enough bars loaded to replay " + pretty(sym) + "."); return; }
  rp.active = true; rp.sym = sym;
  rp.i = Math.min(Math.max(+inputs.smaSlow, 25), BARS[sym].length - 1); rp.playing = false;
  $("replaybar").classList.add("show"); $("replaymark").hidden = false;
  $("rp-range").max = BARS[sym].length - 1;
  document.querySelectorAll(".railbtn").forEach(b => b.classList.remove("on"));
  document.querySelector('[data-replay]').classList.add("on");
  closeSheetOnly();
  renderSignal(); renderTicket();
  updateReplay();
}
function closeSheetOnly() { ui.sheet = null; $("sheet").classList.remove("on"); $("sheetback").classList.remove("on"); }
function exitReplay() {
  rp.active = false; rp.playing = false; clearInterval(rp.timer);
  $("replaybar").classList.remove("show"); $("replaymark").hidden = true;
  document.querySelectorAll(".railbtn").forEach(b => b.classList.remove("on"));
  $("rail-desk").classList.add("on");
  renderSignal(); renderTicket(); renderTop(); renderSymbar();
  chartWithFade();
}
function updateReplay() {
  // Recompute from the live bar store each step so a mid-replay refresh never
  // leaves stale results on screen.
  rp.res = E.replay(BARS[rp.sym], params(), opts(), START_CASH, +inputs.feePct);
  const n = BARS[rp.sym].length;
  rp.i = Math.max(0, Math.min(n - 1, rp.i));
  renderTop(); renderSymbar();
  $("rp-range").value = rp.i;
  const eq = rp.res.equity[rp.i];
  const ret = (eq.v / START_CASH - 1) * 100;
  const evs = rp.res.events.filter(e => e.outcome === "filled" && e.filled <= BARS[rp.sym][rp.i][0]).length;
  $("rp-stats").innerHTML = `<span class="rp-lbl">${BARS[rp.sym][rp.i][0]}</span>
    <span>Paper equity <b class="num">${inr0(eq.v)}</b></span>
    <span class="${ret >= 0 ? "up" : "down"} num">${pct(ret)}</span>
    <span>${evs} fill${evs === 1 ? "" : "s"} so far</span>`;
  drawChart();
}
function rpStep(d) { rp.i += d; updateReplay(); renderSignal(); }
function rpPlayPause() {
  rp.playing = !rp.playing;
  $("rp-play").textContent = rp.playing ? "❚❚" : "▶";
  clearInterval(rp.timer);
  if (rp.playing) rp.timer = setInterval(() => {
    if (rp.i >= BARS[rp.sym].length - 1) { rpPlayPause(); return; }
    rpStep(1);
  }, 240);
}

// ---------- refresh ----------
async function refreshData() {
  if (ui.refreshing) return;
  ui.refreshing = true;
  const btn = $("btn-refresh");
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Refreshing';
  const targets = [...new Set([...inputs.symbols, ...Object.keys(book.positions), ...book.orders.map(o => o.sym)])].sort();
  const lines = [];
  for (const sym of targets) {
    try {
      const r = await fetch("/api/bars?symbol=" + encodeURIComponent(sym));
      const j = await r.json();
      if (r.ok && j.bars && j.bars.length) {
        const before = latestBar(sym) ? latestBar(sym)[0] : null;
        lsBars.symbols[sym] = j.bars;
        lsBars.status[sym] = { asof: j.asof, upstream: j.upstream, source: j.source, last: j.bars[j.bars.length - 1].date };
        rebuildBars();
        const after = latestBar(sym)[0];
        lines.push(`${pretty(sym)}: ${j.bars.length} bar(s) from ${j.upstream}, latest ${after}` + (before && after > before ? ` (new since ${before})` : " (no newer bar)"));
      } else {
        lsBars.status[sym] = { asof: new Date().toISOString(), error: (j && j.error) || "no bars returned" };
        lines.push(`${pretty(sym)}: refresh failed - ${(j && j.error) || "no bars returned"}. Kept previously loaded bars.`);
      }
    } catch (e) {
      lsBars.status[sym] = { asof: new Date().toISOString(), error: String(e).slice(0, 120) };
      lines.push(`${pretty(sym)}: refresh failed - network error. Kept previously loaded bars.`);
    }
  }
  saveJSON(LS_BARS, lsBars);
  const filled = tryFillOrders();
  toast(lines.join("\n") + (filled ? "\nPending order state updated from the new bars." : ""), 6500);
  btn.disabled = false; btn.textContent = "Refresh data";
  ui.refreshing = false;
  renderAll();
}

async function addSymbol() {
  $("addsym-err").textContent = ""; $("addsym-warn").textContent = "";
  let s = $("in-addsym").value.trim().toUpperCase();
  if (!s) { $("addsym-err").textContent = "Enter a symbol first."; return; }
  if (!/^[A-Z0-9&-]{1,15}(\.NS)?$/.test(s)) { $("addsym-err").textContent = "Letters, digits, & or - only (e.g. HDFCBANK or M&M)."; return; }
  if (!s.endsWith(".NS")) s += ".NS";
  if (BARS[s]) {
    if (!inputs.symbols.includes(s)) { inputs.symbols.push(s); saveJSON(LS_INPUTS, inputs); }
    $("in-addsym").value = ""; renderAll(); return;
  }
  const btn = $("btn-addsym"); btn.disabled = true; btn.textContent = "Fetching…";
  try {
    const r = await fetch("/api/bars?symbol=" + encodeURIComponent(s));
    const j = await r.json();
    if (r.ok && j.bars && j.bars.length) {
      lsBars.symbols[s] = j.bars;
      lsBars.status[s] = { asof: j.asof, upstream: j.upstream, source: j.source, last: j.bars[j.bars.length - 1].date };
      saveJSON(LS_BARS, lsBars); rebuildBars();
      if (!inputs.symbols.includes(s)) inputs.symbols.push(s);
      inputs.testSymbol = s;
      saveJSON(LS_INPUTS, inputs);
      $("in-addsym").value = "";
      if (j.bars.length < 31) $("addsym-warn").textContent = `Added with ${j.bars.length} bar(s) only - indicators need more history than the live fallback returns. They appear as more bars accumulate via Refresh.`;
      renderAll();
    } else {
      $("addsym-err").textContent = `Could not fetch ${pretty(s)}: ${(j && j.error) || "no bars returned"}. Symbol not added.`;
    }
  } catch (e) { $("addsym-err").textContent = `Could not fetch ${pretty(s)}: network error. Symbol not added.`; }
  btn.disabled = false; btn.textContent = "Fetch & add";
}

// ---------- onboarding ----------
function showOnboard() { $("onboard").hidden = false; }
function hideOnboard(save) { if (save) localStorage.setItem(LS_SEEN, "1"); $("onboard").hidden = true; }

// ---------- responsive side placement ----------
const mq = window.matchMedia("(max-width:1023px)");
function placeSide() {
  const cards = [$("sigcard"), $("ticket"), $("sidebook").closest(".card")];
  if (mq.matches) { const mt = $("mobticket"); for (const c of cards) mt.appendChild(c); }
  else { const sd = $("side"); for (const c of cards) sd.appendChild(c); }
}

// ---------- render all / wiring ----------
function chartWithFade() {
  const f = $("chart-fade"); f.classList.add("on");
  setTimeout(() => { drawChart(); f.classList.remove("on"); }, 120);
}
function renderAll() {
  renderTop(); renderSymbar(); renderSignal(); renderTicket(); renderSideBook();
  drawChart();
  if (rp.active) updateReplay();
  if (ui.sheet) renderSheetBody();
}

$("symbar").addEventListener("click", ev => {
  const chip = ev.target.closest(".symchip");
  if (chip) {
    if (chip.dataset.sym !== inputs.testSymbol) {
      if (rp.active) exitReplay();
      inputs.testSymbol = chip.dataset.sym;
      saveJSON(LS_INPUTS, inputs);
      renderSymbar(); renderSignal(); renderTicket(); chartWithFade();
      if (ui.sheet === "lab") { renderLabSheet(); }
    }
    return;
  }
  if (ev.target.closest("#chip-add")) openSheet("lab");
});
document.querySelectorAll(".railbtn[data-sheet]").forEach(b => b.addEventListener("click", () => {
  if (ui.sheet === b.dataset.sheet) closeSheet(); else openSheet(b.dataset.sheet);
}));
document.querySelector(".railbtn[data-replay]").addEventListener("click", () => { if (rp.active) exitReplay(); else startReplay(); });
$("sheet-x").addEventListener("click", closeSheet);
$("sheetback").addEventListener("click", closeSheet);
$("btn-refresh").addEventListener("click", refreshData);
$("rp-exit").addEventListener("click", exitReplay);
$("rp-back").addEventListener("click", () => rpStep(-1));
$("rp-fwd").addEventListener("click", () => rpStep(1));
$("rp-play").addEventListener("click", rpPlayPause);
$("rp-range").addEventListener("input", ev => { rp.i = +ev.target.value; updateReplay(); renderSignal(); });
$("ob-go").addEventListener("click", () => hideOnboard(true));
$("ob-skip").addEventListener("click", () => hideOnboard(true));
document.addEventListener("keydown", ev => {
  if (ev.key === "Escape") { if (ui.sheet) closeSheet(); else if (rp.active) exitReplay(); else if (!$("onboard").hidden) hideOnboard(true); }
  if (rp.active && ev.key === "ArrowRight") rpStep(1);
  if (rp.active && ev.key === "ArrowLeft") rpStep(-1);
  if (rp.active && ev.key === " ") { ev.preventDefault(); rpPlayPause(); }
});
document.querySelectorAll(".mbtn").forEach(b => b.addEventListener("click", () => {
  document.querySelectorAll(".mbtn").forEach(x => x.classList.remove("on"));
  b.classList.add("on");
  const t = b.dataset.mtab;
  if (t === "desk") { closeSheet(); $("desk").scrollTo({ top: 0, behavior: "smooth" }); }
  else if (t === "trade") { closeSheet(); const tk = $("ticket"); if (tk) tk.scrollIntoView({ behavior: "smooth", block: "start" }); }
  else if (t === "book") openSheet("book");
  else if (t === "lab") openSheet("lab");
  else if (t === "info") openSheet("info");
}));
let rszT = null;
window.addEventListener("resize", () => { clearTimeout(rszT); rszT = setTimeout(() => { placeSide(); drawChart(); }, 160); });
if (mq.addEventListener) mq.addEventListener("change", placeSide);

// ---------- init ----------
placeSide();
if (tryFillOrders()) { /* fills landed from cached bars */ }
renderAll();
const hash = location.hash;
const sheetM = hash.match(/sheet=(book|lab|info)/);
if (sheetM) openSheet(sheetM[1]);
if (/replay=1/.test(hash)) startReplay();
if (!/skip-intro/.test(hash) && !localStorage.getItem(LS_SEEN)) showOnboard();
})();
