// SignalFloor app wiring v2: inputs -> engine -> outputs, browser-local persistence,
// in-app data refresh through the same-origin /api/bars proxy.
"use strict";
(() => {
const DATA = window.SF_BARS, E = window.SF_ENGINE;
const LS_INPUTS = "sf.inputs.v1", LS_BOOK = "sf.book.v1", LS_BARS = "sf.bars.v2";
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
const istNow = () => new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }) + " IST";

// ---------- merged bar store: build-time baseline + fetched bars ----------
function mergeRows(base, extra) {
  const byDate = new Map();
  for (const r of (base || [])) byDate.set(r[0], r);
  for (const r of (extra || [])) byDate.set(r[0], [r.date, r.open, r.high, r.low, r.close, r.volume || 0]);
  const rows = [...byDate.values()].sort((a, b) => a[0] < b[0] ? -1 : 1);
  return rows.slice(-160);
}

let lsBars = loadJSON(LS_BARS, { symbols: {}, status: {} });
if (!lsBars || typeof lsBars !== "object") lsBars = { symbols: {}, status: {} };
lsBars.symbols = lsBars.symbols || {}; lsBars.status = lsBars.status || {};

const BARS = {}; // sym -> rows
function rebuildBars() {
  for (const k of Object.keys(BARS)) delete BARS[k];
  const syms = new Set([...Object.keys(DATA.symbols), ...Object.keys(lsBars.symbols)]);
  for (const s of syms) BARS[s] = mergeRows(DATA.symbols[s], lsBars.symbols[s]);
}
rebuildBars();
const allSyms = () => Object.keys(BARS).sort();
const latestBar = sym => { const r = BARS[sym]; return r && r[r.length - 1]; };
const dataThrough = () => {
  let d = "";
  for (const s of Object.keys(BARS)) { const b = latestBar(s); if (b && b[0] > d) d = b[0]; }
  return d || "no bars";
};

// ---------- state ----------
let inputs = Object.assign({}, DEFAULTS, loadJSON(LS_INPUTS, {}));
inputs.symbols = (inputs.symbols || []).filter(s => BARS[s]);
if (!inputs.symbols.length) inputs.symbols = DEFAULTS.symbols.filter(s => BARS[s]);
if (!inputs.symbols.includes(inputs.testSymbol)) inputs.testSymbol = inputs.symbols[0];

let book = loadJSON(LS_BOOK, null);
if (!book || book.v !== 1) book = { v: 1, cash: START_CASH, positions: {}, orders: [], done: [] };
for (const o of book.orders) { o.mode = o.mode || "rule"; o._id = o._id || (Date.now() + Math.random()); o.placedAt = o.placedAt || (o.decided + "T15:30:00+05:30"); }
for (const o of book.done) { o.mode = o.mode || "rule"; o.placedAt = o.placedAt || (o.decided + "T15:30:00+05:30"); }

// IST helpers (UTC+5:30, no DST). An order may only fill at a session whose bar
// was not already in the past when the order was actually placed: pre-open
// placements may fill at that day's open; placements during/after market hours
// fill at a later session's open. Never book an already-past open as attainable.
function istParts(iso) {
  const t = new Date(new Date(iso).getTime() + 19800e3);
  return { day: t.toISOString().slice(0, 10), mins: t.getUTCHours() * 60 + t.getUTCMinutes() };
}
function fillableDay(placedAt) {
  const p = istParts(placedAt);
  if (p.mins < 555) return p.day; // placed before 09:15 IST: same day's open is attainable
  return new Date(new Date(p.day + "T00:00:00Z").getTime() + 86400e3).toISOString().slice(0, 10);
}

let ticket = { side: "BUY" };
let refreshing = false;

const params = () => ({ rsiPeriod: +inputs.rsiPeriod, oversold: +inputs.oversold, overbought: +inputs.overbought, smaFast: +inputs.smaFast, smaSlow: +inputs.smaSlow, budgetPct: +inputs.budgetPct });

// ---------- header / refresh ----------
function renderHeader() {
  $("data-through").textContent = dataThrough();
  const st = lsBars.status || {};
  const oks = Object.values(st).filter(s => s && s.asof).map(s => s.asof).sort();
  $("refresh-state").textContent = oks.length ? "last refreshed " + istOf(oks[oks.length - 1]) : "not refreshed in this browser yet";
}
const istOf = iso => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }) + " IST";

async function refreshData() {
  if (refreshing) return;
  refreshing = true;
  const btn = $("btn-refresh"); btn.disabled = true; btn.textContent = "Refreshing...";
  const targets = [...new Set([...inputs.symbols, ...Object.keys(book.positions), ...book.orders.map(o => o.sym)])].sort();
  const status = $("refresh-status");
  const lines = [];
  for (const sym of targets) {
    status.innerHTML = lines.concat([`fetching ${sym}...`]).join("<br>");
    try {
      const r = await fetch("/api/bars?symbol=" + encodeURIComponent(sym));
      const j = await r.json();
      if (r.ok && j.bars && j.bars.length) {
        const before = latestBar(sym) ? latestBar(sym)[0] : null;
        lsBars.symbols[sym] = j.bars;
        lsBars.status[sym] = { asof: j.asof, upstream: j.upstream, source: j.source, last: j.bars[j.bars.length - 1].date };
        rebuildBars();
        const after = latestBar(sym)[0];
        lines.push(`${sym}: ${j.bars.length} bar(s) from ${j.upstream}, latest ${after}` + (before && after > before ? ` (new since ${before})` : " (no newer bar)"));
      } else {
        lsBars.status[sym] = { asof: new Date().toISOString(), error: (j && j.error) || "no bars returned" };
        lines.push(`<span class="errline">${sym}: refresh failed - ${(j && j.error) || "no bars returned"}${j && j.attempts ? " (" + j.attempts.join(", ") + ")" : ""}. Keeping previously loaded bars.</span>`);
      }
    } catch (e) {
      lsBars.status[sym] = { asof: new Date().toISOString(), error: String(e).slice(0, 120) };
      lines.push(`<span class="errline">${sym}: refresh failed - network error. Keeping previously loaded bars.</span>`);
    }
  }
  saveJSON(LS_BARS, lsBars);
  tryFillOrders();
  status.innerHTML = lines.join("<br>");
  btn.disabled = false; btn.textContent = "Refresh data";
  refreshing = false;
  renderAll();
}
$("btn-refresh").addEventListener("click", refreshData);

// ---------- paper book ----------
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
      } else { o.status = "rejected"; o.note = "insufficient paper cash at the fill bar"; }
    } else {
      const pos = book.positions[o.sym];
      const held = pos ? pos.qty : 0;
      const qty = o.mode === "shares" ? Math.min(o.qty, held) : held;
      if (qty > 0) {
        const proceeds = qty * open, fee = proceeds * inputs.feePct / 100;
        book.cash += proceeds - fee;
        pos.qty -= qty; if (pos.qty <= 0) delete book.positions[o.sym];
        o.status = "filled"; o.filled = odate; o.open = open; o.qty = qty; o.fee = +fee.toFixed(2); delete o.note;
      } else { o.status = "rejected"; o.note = "no open paper position (no shorting)"; }
    }
    book.done.push(Object.assign({}, o));
    o._arch = true; changed = true;
  }
  if (changed) book.orders = book.orders.filter(o => !o._arch);
  saveJSON(LS_BOOK, book);
}

function renderBook() {
  let invested = 0;
  for (const [s, p] of Object.entries(book.positions)) { const b = latestBar(s); if (b) invested += p.qty * b[4]; }
  const total = book.cash + invested, pl = total - START_CASH;
  $("bookline").innerHTML =
    `<div class="stat"><div class="k">Paper cash</div><div class="v num">${inr(book.cash)}</div></div>
     <div class="stat"><div class="k">Invested (latest close)</div><div class="v num">${inr(invested)}</div></div>
     <div class="stat"><div class="k">Total</div><div class="v num">${inr(total)}</div></div>
     <div class="stat"><div class="k">P&amp;L vs ${inr(START_CASH)}</div><div class="v num ${pl >= 0 ? "up" : "down"}">${pl >= 0 ? "+" : ""}${inr(pl)} (${((total / START_CASH - 1) * 100).toFixed(2)}%)</div></div>`;

  const pos = Object.entries(book.positions).map(([s, p]) => {
    const b = latestBar(s);
    return `<div class="order"><span class="st holding">holding</span><b>${s.replace(".NS", "")}</b> ${p.qty} sh @ avg ${inr(p.avg)}
      <div class="meta">latest close ${b ? inr(b[4]) + " (" + b[0] + ")" : "no bars loaded"}</div></div>`;
  }).join("");
  const pend = book.orders.map(o =>
    `<div class="order"><span class="st pending">pending</span><b>${o.side}</b> ${o.sym.replace(".NS", "")}${o.mode === "shares" ? " x " + o.qty : ""}
      <div class="meta">decided on bar ${o.decided} (close ${inr(o.decidedClose)}) - ${o.note || "fills at the first attainable session open"}</div>
      <button class="linklike" data-cancel="${o._id}">cancel order</button></div>`).join("");
  const done = book.done.slice(-8).reverse().map(o =>
    `<div class="order"><span class="st ${o.status}">${o.status}</span><b>${o.side}</b> ${o.sym.replace(".NS", "")}${o.qty ? " " + o.qty + " @ " + inr(o.open) : ""}
      <div class="meta">${o.filled ? "filled " + o.filled + " (open)" : ""}${o.fee ? " · fee " + inr(o.fee) : ""}${o.note ? o.note : ""}</div></div>`).join("");
  $("orders").innerHTML = pos + pend + done || '<div class="empty">No positions or orders yet. Queue one from a signal, or place one manually with the order ticket.</div>';
}

$("orders").addEventListener("click", e => {
  const b = e.target.closest("[data-cancel]");
  if (!b) return;
  const i = book.orders.findIndex(o => String(o._id) === b.dataset.cancel);
  if (i >= 0) { book.orders.splice(i, 1); saveJSON(LS_BOOK, book); renderAll(); }
});

$("btn-reset-book").addEventListener("click", () => {
  if (!confirm("Reset the paper book saved in this browser? This cannot be undone.")) return;
  book = { v: 1, cash: START_CASH, positions: {}, orders: [], done: [] };
  saveJSON(LS_BOOK, book);
  renderAll();
});

// ---------- signals ----------
function renderScan() {
  const p = params(), opts = { trendFilter: inputs.trendFilter };
  const sub = {};
  for (const s of inputs.symbols) if (BARS[s]) sub[s] = BARS[s];
  const rows = E.scan(sub, p, opts);
  $("scan").innerHTML = rows.map(r => {
    const pill = r.verdict === "BUY" ? "BUY" : r.verdict === "SELL" ? "SELL" : "HOLD";
    const dup = book.orders.some(o => o.sym === r.sym && o.status === "pending");
    const can = r.verdict !== "NO SIGNAL" && !dup;
    return `<tr>
      <td><div class="sym">${r.sym.replace(".NS", "")}</div><div class="px num">${inr(r.close)} · ${r.date}</div>
          <div class="inds num">RSI ${r.rsi ?? "-"} · SMA${p.smaFast} ${r.smaFast ?? "-"} · SMA${p.smaSlow} ${r.smaSlow ?? "-"}</div></td>
      <td><span class="pill ${pill}">${r.verdict === "NO SIGNAL" ? "HOLD" : r.verdict}</span></td>
      <td class="why"><div class="reason">${r.reason}</div></td>
      <td>${can ? `<button class="small" type="button" data-queue="${r.sym}" data-side="${r.verdict}">Queue</button>` : (dup ? '<span class="reason">order pending</span>' : "")}</td>
    </tr>`;
  }).join("");
}

$("scan").addEventListener("click", e => {
  const b = e.target.closest("button[data-queue]");
  if (!b) return;
  const sym = b.dataset.queue, side = b.dataset.side, bar = latestBar(sym);
  book.orders.push({ _id: Date.now() + Math.random(), sym, side, mode: "rule", decided: bar[0], decidedClose: bar[4], status: "pending", placedAt: new Date().toISOString(),
    note: "rule-sized (" + inputs.budgetPct + "% of start cash); placed " + istParts(new Date().toISOString()).day + " IST - fills at the first session open that is not already in the past, once its bar arrives via Refresh data" });
  saveJSON(LS_BOOK, book);
  renderAll();
});

// ---------- order ticket ----------
function renderTicketSymbols() {
  const cur = $("t-symbol").value;
  $("t-symbol").innerHTML = allSyms().map(s => `<option value="${s}">${s.replace(".NS", "")}</option>`).join("");
  if (cur && BARS[cur]) $("t-symbol").value = cur;
}

function ticketEstimate() {
  const sym = $("t-symbol").value, qraw = $("t-qty").value.trim();
  const b = latestBar(sym);
  if (!b || !qraw || isNaN(+qraw) || +qraw <= 0) { $("t-est").textContent = ""; return; }
  const qty = Math.floor(+qraw);
  if (ticket.side === "BUY") {
    const cost = qty * b[4], fee = cost * inputs.feePct / 100;
    $("t-est").textContent = `Est. at latest close (${b[0]}): ${inr(cost)} + fee ${inr(fee)} = ${inr(cost + fee)} · paper cash ${inr(book.cash)}`;
  } else {
    const held = (book.positions[sym] || { qty: 0 }).qty;
    const proceeds = qty * b[4], fee = proceeds * inputs.feePct / 100;
    $("t-est").textContent = `Est. at latest close (${b[0]}): ${inr(proceeds)} - fee ${inr(fee)} = ${inr(proceeds - fee)} · you hold ${held} sh`;
  }
}

function setSide(side) {
  ticket.side = side;
  $("side-buy").className = side === "BUY" ? "on-buy" : "";
  $("side-sell").className = side === "SELL" ? "on-sell" : "";
  $("side-buy").textContent = "Buy"; $("side-sell").textContent = "Sell";
  $("t-err").textContent = ""; $("t-ok").textContent = "";
  ticketEstimate();
}
$("side-buy").addEventListener("click", () => setSide("BUY"));
$("side-sell").addEventListener("click", () => setSide("SELL"));
$("t-qty").addEventListener("input", () => { $("t-err").textContent = ""; ticketEstimate(); });
$("t-symbol").addEventListener("change", () => { $("t-err").textContent = ""; ticketEstimate(); });

$("t-submit").addEventListener("click", () => {
  const sym = $("t-symbol").value, qraw = $("t-qty").value.trim();
  $("t-err").textContent = ""; $("t-ok").textContent = "";
  const fail = m => { $("t-err").textContent = m; };
  if (!qraw) return fail("Enter a quantity.");
  const q = +qraw;
  if (isNaN(q) || q <= 0) return fail("Quantity must be a positive number.");
  if (!Number.isInteger(q)) return fail("Quantity must be whole shares - NSE equities trade in whole shares here.");
  const b = latestBar(sym);
  if (!b) return fail("No bars loaded for " + sym + " - fetch it first.");
  const dup = book.orders.find(o => o.sym === sym && o.side === ticket.side && o.status === "pending");
  if (dup) return fail(`A pending ${ticket.side} for ${sym.replace(".NS", "")} already exists (decided ${dup.decided}). Cancel it in the paper book first, or wait for it to fill.`);
  if (ticket.side === "BUY") {
    const cost = q * b[4], fee = cost * inputs.feePct / 100;
    if (cost + fee > book.cash) return fail(`Estimated cost ${inr(cost + fee)} exceeds paper cash ${inr(book.cash)}. Try fewer shares.`);
  } else {
    const held = (book.positions[sym] || { qty: 0 }).qty;
    if (held <= 0) return fail(`You hold no ${sym.replace(".NS", "")} shares in the paper book (no shorting).`);
    if (q > held) return fail(`You hold ${held} share${held === 1 ? "" : "s"} - cannot sell ${q}.`);
  }
  book.orders.push({ _id: Date.now() + Math.random(), sym, side: ticket.side, mode: "shares", qty: q,
    decided: b[0], decidedClose: b[4], status: "pending", placedAt: new Date().toISOString(),
    note: "placed " + istParts(new Date().toISOString()).day + " IST - fills at the first session open that is not already in the past, once its bar arrives via Refresh data" });
  saveJSON(LS_BOOK, book);
  $("t-qty").value = ""; $("t-est").textContent = "";
  $("t-ok").textContent = `${ticket.side} ${q} ${sym.replace(".NS", "")} queued - pending until newer bars arrive.`;
  renderAll();
});

// ---------- rule lab ----------
function renderLab() {
  $("symlist").innerHTML = allSyms().map(s =>
    `<label class="${inputs.symbols.includes(s) ? "on" : ""}"><input type="checkbox" data-sym="${s}" ${inputs.symbols.includes(s) ? "checked" : ""}> ${s.replace(".NS", "")}</label>`).join("");
  for (const k of ["rsiPeriod", "smaFast", "oversold", "overbought", "smaSlow", "budgetPct", "feePct"]) $("in-" + k).value = inputs[k];
  $("in-trendFilter").checked = !!inputs.trendFilter;
  $("in-testSymbol").innerHTML = allSyms().map(s => `<option ${s === inputs.testSymbol ? "selected" : ""}>${s.replace(".NS", "")}</option>`).join("");
}

$("lab").addEventListener("input", e => {
  const t = e.target;
  if (t.dataset.sym) {
    inputs.symbols = t.checked ? [...inputs.symbols, t.dataset.sym] : inputs.symbols.filter(s => s !== t.dataset.sym);
    if (!inputs.symbols.includes(inputs.testSymbol)) inputs.testSymbol = inputs.symbols[0];
  } else if (t.id === "in-trendFilter") inputs.trendFilter = t.checked;
  else if (t.id && t.id.startsWith("in-") && t.id !== "in-testSymbol" && t.id !== "in-addsym") inputs[t.id.slice(3)] = +t.value;
  saveJSON(LS_INPUTS, inputs);
  renderAll();
});
$("in-testSymbol").addEventListener("change", e => {
  const v = e.target.value;
  inputs.testSymbol = allSyms().find(s => s.replace(".NS", "") === v || s === v) || v;
  saveJSON(LS_INPUTS, inputs); renderAll();
});

$("btn-addsym").addEventListener("click", async () => {
  $("addsym-err").textContent = "";
  let s = $("in-addsym").value.trim().toUpperCase();
  if (!s) { $("addsym-err").textContent = "Enter a symbol first."; return; }
  if (!/^[A-Z0-9&-]{1,15}(\.NS)?$/.test(s)) { $("addsym-err").textContent = "Symbols use letters, digits, & or - only (e.g. HDFCBANK or M&M)."; return; }
  if (!s.endsWith(".NS")) s += ".NS";
  if (BARS[s]) {
    if (!inputs.symbols.includes(s)) { inputs.symbols.push(s); saveJSON(LS_INPUTS, inputs); renderAll(); }
    $("in-addsym").value = ""; return;
  }
  const btn = $("btn-addsym"); btn.disabled = true; btn.textContent = "Fetching...";
  try {
    const r = await fetch("/api/bars?symbol=" + encodeURIComponent(s));
    const j = await r.json();
    if (r.ok && j.bars && j.bars.length) {
      lsBars.symbols[s] = j.bars;
      lsBars.status[s] = { asof: j.asof, upstream: j.upstream, source: j.source, last: j.bars[j.bars.length - 1].date };
      saveJSON(LS_BARS, lsBars);
      rebuildBars();
      if (!inputs.symbols.includes(s)) inputs.symbols.push(s);
      saveJSON(LS_INPUTS, inputs);
      $("in-addsym").value = "";
      if (j.bars.length < 31) $("addsym-err").textContent = `Added with ${j.bars.length} bar(s) only - indicators need more history than the live fallback returns. Indicators will show as more bars accumulate via Refresh data.`;
      renderAll();
    } else {
      $("addsym-err").textContent = `Could not fetch ${s}: ${(j && j.error) || "no bars returned"}. Symbol not added.`;
    }
  } catch (e) { $("addsym-err").textContent = `Could not fetch ${s}: network error. Symbol not added.`; }
  btn.disabled = false; btn.textContent = "Fetch & add";
});

// ---------- rule test ----------
function renderTest() {
  const sym = inputs.testSymbol;
  if (!sym || !BARS[sym]) { $("test-stats").innerHTML = ""; $("test-events").innerHTML = ""; return; }
  const rows = BARS[sym];
  const r = E.replay(rows, params(), { trendFilter: inputs.trendFilter }, START_CASH, +inputs.feePct);
  const bh = (rows[rows.length - 1][4] / rows[0][4] - 1) * 100;
  const endV = r.equity[r.equity.length - 1].v;
  const ret = (endV / START_CASH - 1) * 100;
  const fills = r.events.filter(e => e.outcome === "filled").length;
  $("test-stats").innerHTML =
    `<div class="stat"><div class="k">Bars</div><div class="v num">${rows.length}</div></div>
     <div class="stat"><div class="k">Window</div><div class="v num" style="font-size:.8rem">${rows[0][0]} -> ${rows[rows.length - 1][0]}</div></div>
     <div class="stat"><div class="k">Signals</div><div class="v num">${r.events.length}</div></div>
     <div class="stat"><div class="k">Fills</div><div class="v num">${fills}</div></div>
     <div class="stat"><div class="k">End (paper)</div><div class="v num">${inr(endV)}</div></div>
     <div class="stat"><div class="k">Price return</div><div class="v num ${ret >= 0 ? "up" : "down"}">${ret.toFixed(2)}%</div></div>
     <div class="stat"><div class="k">Buy-and-hold</div><div class="v num ${bh >= 0 ? "up" : "down"}">${bh.toFixed(2)}%</div></div>
     <div class="stat"><div class="k">Open position</div><div class="v num">${r.end.pos} sh</div></div>`;
  $("test-events").innerHTML = r.events.map(e =>
    `<div class="ev"><b>${e.side}</b> decided ${e.decided} (close ${inr(e.decidedClose)})` +
    (e.outcome === "filled"
      ? ` · <span style="color:var(--buy)">filled ${e.filled} (open ${inr(e.open)}) - qty ${e.qty}, fee ${inr(e.fee)}</span>`
      : ` · attempted ${e.attempted} · <span style="color:var(--sell)">${e.outcome}</span>`) +
    `<div class="why">${e.reason}</div></div>`).join("") ||
    `<div class="ev">No signals under these rules on the loaded bars.</div>`;
}

// ---------- provenance ----------
function renderProv() {
  const errs = Object.entries(DATA.meta.errors || {});
  const st = lsBars.status || {};
  const ranges = allSyms().map(s => `${s}: ${BARS[s][0][0]} -> ${latestBar(s)[0]} (${BARS[s].length} bars)`);
  const fetched = Object.entries(st).filter(([, v]) => v && v.upstream).map(([s, v]) => `${s} via ${v.upstream} at ${istOf(v.asof)}`);
  $("provenance").innerHTML = `<ul>
    <li>Baseline source: ${DATA.meta.source}; fetched ${DATA.meta.fetched_at_utc}; auto_adjust=false (raw prices, no dividend adjustment).</li>
    <li>In-app refresh: same-origin proxy at /api/bars pulls delayed daily bars (Yahoo Finance chart API, then Groww latest-bar fallback, then Stooq) at the moment you press Refresh data. Refreshes are cached in this browser's storage only - the server stores nothing about you.${fetched.length ? " This browser: " + fetched.join("; ") + "." : ""}</li>
    <li>The Groww fallback returns only the latest daily bar, so long-unrefreshed symbols can have gaps; the latest bar fetched during market hours may be a still-forming session.</li>
    <li>Per-symbol coverage: ${ranges.join("; ")}.</li>
    ${errs.length ? `<li class="errline">Baseline failed fetches: ${errs.map(([s, e]) => `${s} (${e})`).join("; ")}. Failed symbols are excluded, never guessed.</li>` : ""}
    <li>Rules are the ones set in the rule lab; every number on this page is recomputed in your browser from the loaded bars when an input changes. No precomputed scenarios.</li>
    <li>Fills use the first session whose open was not already in the past when the order was actually placed (pre-open placements: that day's open; later placements: a later session), at its open, once that bar is loaded - an order never books an already-past price. Mechanical paper accounting: no spread/slippage/impact, not a matched-risk control.</li>
    <li>Real-time/intraday feed: unavailable in this build (delayed daily bars only). Brokerage connection: not present by design.</li>
    <li>Inputs, cached bars and paper book persist in this browser's local storage only; clearing site data erases them. No server-side account state exists.</li>
  </ul>`;
}

function renderAll() { renderHeader(); renderBook(); renderScan(); renderTicketSymbols(); renderLab(); renderTest(); renderProv(); }
setSide("BUY");
tryFillOrders();
renderAll();
})();
