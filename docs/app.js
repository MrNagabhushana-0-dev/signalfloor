// SignalFloor app wiring: inputs -> engine -> outputs, with browser-local persistence.
"use strict";
(() => {
const DATA = window.SF_BARS, E = window.SF_ENGINE;
const LS_INPUTS = "sf.inputs.v1", LS_BOOK = "sf.book.v1";
const $ = id => document.getElementById(id);
const ALL_SYMS = Object.keys(DATA.symbols).sort();
const START_CASH = 1000000;

const DEFAULTS = {
  symbols: ["TCS.NS","RELIANCE.NS","INFY.NS","INDIGO.NS"],
  rsiPeriod: 14, oversold: 30, overbought: 70, smaFast: 10, smaSlow: 30,
  trendFilter: false, budgetPct: 25, feePct: 0.1, testSymbol: "TCS.NS",
};

function loadJSON(k, fb) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? fb : v; } catch { return fb; } }
function saveJSON(k, v) { localStorage.setItem(k, JSON.stringify(v)); }

let inputs = Object.assign({}, DEFAULTS, loadJSON(LS_INPUTS, {}));
inputs.symbols = (inputs.symbols || []).filter(s => ALL_SYMS.includes(s));
if (!inputs.symbols.length) inputs.symbols = DEFAULTS.symbols.slice();
if (!ALL_SYMS.includes(inputs.testSymbol)) inputs.testSymbol = inputs.symbols[0];

let book = loadJSON(LS_BOOK, null);
if (!book || book.v !== 1) book = { v: 1, cash: START_CASH, positions: {}, orders: [], done: [] };

const inr = n => "₹" + Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 });
const params = () => ({ rsiPeriod: +inputs.rsiPeriod, oversold: +inputs.oversold, overbought: +inputs.overbought, smaFast: +inputs.smaFast, smaSlow: +inputs.smaSlow, budgetPct: +inputs.budgetPct });

// ---------- inputs panel ----------
function renderInputs() {
  $("symlist").innerHTML = ALL_SYMS.map(s =>
    `<label class="${inputs.symbols.includes(s) ? "on" : ""}"><input type="checkbox" data-sym="${s}" ${inputs.symbols.includes(s) ? "checked" : ""}> ${s.replace(".NS","")}</label>`).join("");
  const errs = DATA.meta.errors || {};
  $("fetch-errors").innerHTML = Object.entries(errs).map(([s, e]) =>
    `<div class="errline">fetch failed: ${s} - ${e}</div>`).join("");
  for (const k of ["rsiPeriod","smaFast","oversold","overbought","smaSlow","budgetPct","feePct"]) $("in-" + k).value = inputs[k];
  $("in-trendFilter").checked = !!inputs.trendFilter;
  $("in-testSymbol").innerHTML = inputs.symbols.map(s => `<option ${s === inputs.testSymbol ? "selected" : ""}>${s}</option>`).join("");
  const f = new Date(DATA.meta.fetched_at_utc);
  $("hdr-fetched").textContent = "bars fetched " + f.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) + " IST";
}

$("inputs-panel").addEventListener("input", e => {
  const t = e.target;
  if (t.dataset.sym) {
    inputs.symbols = t.checked ? [...inputs.symbols, t.dataset.sym] : inputs.symbols.filter(s => s !== t.dataset.sym);
    if (!inputs.symbols.includes(inputs.testSymbol)) inputs.testSymbol = inputs.symbols[0];
  } else if (t.id === "in-trendFilter") inputs.trendFilter = t.checked;
  else if (t.id && t.id.startsWith("in-")) inputs[t.id.slice(3)] = +t.value;
  saveJSON(LS_INPUTS, inputs);
  renderAll();
});
$("in-testSymbol").addEventListener("change", e => { inputs.testSymbol = e.target.value; saveJSON(LS_INPUTS, inputs); renderAll(); });

// ---------- scan ----------
function latestBar(sym) { const r = DATA.symbols[sym]; return r[r.length - 1]; }

function renderScan() {
  const p = params(), opts = { trendFilter: inputs.trendFilter };
  const sub = {};
  for (const s of inputs.symbols) sub[s] = DATA.symbols[s];
  const rows = E.scan(sub, p, opts);
  $("scan").innerHTML = rows.map(r => {
    const vc = r.verdict === "BUY" ? "BUY" : r.verdict === "SELL" ? "SELL" : "NO";
    const can = r.verdict !== "NO SIGNAL" && !book.orders.some(o => o.sym === r.sym && o.status === "pending");
    return `<div class="symrow">
      <div><div class="name">${r.sym}</div><div class="px">${inr(r.close)} · ${r.date}</div>
        <div class="inds">RSI ${r.rsi ?? "-"} · SMA${p.smaFast} ${r.smaFast ?? "-"} · SMA${p.smaSlow} ${r.smaSlow ?? "-"} · ${r.bars} bars</div></div>
      <div class="reason">${r.reason}</div>
      <div class="verdict ${vc}">${r.verdict}</div>
      ${can ? `<div class="rowactions"><button type="button" data-queue="${r.sym}" data-side="${r.verdict}">Queue paper ${r.verdict.toLowerCase()} order</button></div>` : ""}
    </div>`;
  }).join("");
}

$("scan").addEventListener("click", e => {
  const b = e.target.closest("button[data-queue]");
  if (!b) return;
  const sym = b.dataset.queue, side = b.dataset.side, bar = latestBar(sym);
  book.orders.push({ sym, side, decided: bar[0], decidedClose: bar[4], status: "pending",
    note: "fills at the next session's open bar once the data builder runs after that session" });
  saveJSON(LS_BOOK, book);
  renderAll();
});

// ---------- paper book ----------
function tryFillOrders() {
  // Fill any pending order whose decision bar is older than the latest loaded bar.
  for (const o of book.orders) {
    if (o.status !== "pending") continue;
    const rows = DATA.symbols[o.sym];
    const di = rows.findIndex(r => r[0] === o.decided);
    if (di >= 0 && di + 1 < rows.length) {
      const [odate, open] = rows[di + 1];
      if (o.side === "BUY") {
        const budget = START_CASH * inputs.budgetPct / 100;
        let qty = Math.floor(budget / open);
        if (qty < 1 && book.cash >= open) qty = 1;
        const cost = qty * open, fee = cost * inputs.feePct / 100;
        if (qty >= 1 && book.cash >= cost + fee) {
          book.cash -= cost + fee;
          const pos = book.positions[o.sym] || { qty: 0, avg: 0 };
          pos.avg = pos.qty === 0 ? open : (pos.avg * pos.qty + open * qty) / (pos.qty + qty);
          pos.qty += qty; book.positions[o.sym] = pos;
          o.status = "filled"; o.filled = odate; o.open = open; o.qty = qty; o.fee = +fee.toFixed(2); delete o.note;
        } else { o.status = "rejected"; o.note = "insufficient paper cash at next open"; }
      } else {
        const pos = book.positions[o.sym];
        if (pos && pos.qty > 0) {
          const proceeds = pos.qty * open, fee = proceeds * inputs.feePct / 100;
          book.cash += proceeds - fee;
          o.status = "filled"; o.filled = odate; o.open = open; o.qty = pos.qty; o.fee = +fee.toFixed(2); delete o.note;
          delete book.positions[o.sym];
        } else { o.status = "rejected"; o.note = "no open paper position (no shorting)"; }
      }
      book.done.push(Object.assign({}, o));
      o._arch = true;
    }
  }
  book.orders = book.orders.filter(o => !o._arch);
  saveJSON(LS_BOOK, book);
}

function renderBook() {
  let invested = 0;
  for (const [s, p] of Object.entries(book.positions)) invested += p.qty * latestBar(s)[4];
  const total = book.cash + invested;
  $("bookline").innerHTML =
    `<div><b>paper cash</b><span>${inr(book.cash)}</span></div>
     <div><b>invested (latest close)</b><span>${inr(invested)}</span></div>
     <div><b>total</b><span>${inr(total)}</span></div>
     <div><b>P&amp;L vs ${inr(START_CASH)}</b><span>${inr(total - START_CASH)} (${((total / START_CASH - 1) * 100).toFixed(2)}%)</span></div>`;
  const pos = Object.entries(book.positions).map(([s, p]) =>
    `<div class="order">holding ${s}: ${p.qty} @ avg ${inr(p.avg)} (latest close ${inr(latestBar(s)[4])}, ${latestBar(s)[0]})</div>`).join("");
  const pend = book.orders.map(o =>
    `<div class="order"><span class="st-pending">pending</span> ${o.side} ${o.sym} - decided ${o.decided} (close ${inr(o.decidedClose)}) - ${o.note}</div>`).join("");
  const done = book.done.slice(-10).reverse().map(o =>
    `<div class="order"><span class="st-${o.status === "filled" ? "filled" : "pending"}">${o.status}</span> ${o.side} ${o.sym}${o.qty ? " " + o.qty + " @ " + inr(o.open) + " (" + o.filled + ")" + (o.fee ? ", fee " + inr(o.fee) : "") : ""}${o.note ? " - " + o.note : ""}</div>`).join("");
  $("orders").innerHTML = pos + pend + done || '<div class="order">no positions or orders yet - queue one from a scan verdict</div>';
}

$("btn-reset-book").addEventListener("click", () => {
  if (!confirm("Reset the paper book saved in this browser? This cannot be undone.")) return;
  book = { v: 1, cash: START_CASH, positions: {}, orders: [], done: [] };
  saveJSON(LS_BOOK, book);
  renderAll();
});

// ---------- rule test ----------
function renderTest() {
  const sym = inputs.testSymbol;
  if (!sym || !DATA.symbols[sym]) { $("test-stats").innerHTML = ""; $("test-events").innerHTML = ""; return; }
  const rows = DATA.symbols[sym];
  const r = E.replay(rows, params(), { trendFilter: inputs.trendFilter }, START_CASH, +inputs.feePct);
  const bh = (rows[rows.length - 1][4] / rows[0][4] - 1) * 100;
  const endV = r.equity[r.equity.length - 1].v;
  const ret = (endV / START_CASH - 1) * 100;
  const fills = r.events.filter(e => e.outcome === "filled").length;
  $("test-stats").innerHTML =
    `<div><b>bars</b><span>${rows.length}</span></div>
     <div><b>window</b><span style="font-size:.8rem">${rows[0][0]} -> ${rows[rows.length-1][0]}</span></div>
     <div><b>signals</b><span>${r.events.length}</span></div>
     <div><b>fills</b><span>${fills}</span></div>
     <div><b>end (paper)</b><span>${inr(endV)}</span></div>
     <div><b>price return</b><span>${ret.toFixed(2)}%</span></div>
     <div><b>buy-and-hold</b><span>${bh.toFixed(2)}%</span></div>
     <div><b>open position</b><span>${r.end.pos} sh</span></div>`;
  $("test-events").innerHTML = r.events.map(e =>
    `<div class="ev"><span class="${e.side[0]}">${e.side}</span> ${sym} decided ${e.decided} (close ${inr(e.decidedClose)})` +
    (e.outcome === "filled"
      ? ` · <span class="ok">filled ${e.filled} (open ${inr(e.open)}) - qty ${e.qty}, fee ${inr(e.fee)}</span>`
      : ` · attempted ${e.attempted} (open ${inr(e.open)}) · <span class="no">${e.outcome}</span>`) +
    `<br><span class="mono">${e.reason}</span></div>`).join("") ||
    `<div class="ev">no signals under these rules on the loaded bars</div>`;
}

// ---------- provenance ----------
function renderProv() {
  const errs = Object.entries(DATA.meta.errors || {});
  const ranges = Object.entries(DATA.symbols).map(([s, r]) => `${s}: ${r[0][0]} -> ${r[r.length-1][0]} (${r.length} bars)`);
  $("provenance").innerHTML = `<ul>
    <li>Source: ${DATA.meta.source}; fetched ${DATA.meta.fetched_at_utc}; auto_adjust=false (raw prices, no dividend adjustment).</li>
    <li>Per-symbol coverage: ${ranges.join("; ")}.</li>
    ${errs.length ? `<li>Failed fetches: ${errs.map(([s, e]) => `${s} (${e})`).join("; ")}. Failed symbols are excluded, never guessed.</li>` : ""}
    <li>Rules are the ones set in the inputs panel; every number on this page is recomputed in your browser from the loaded bars when an input changes. No precomputed scenarios.</li>
    <li>Rule test fills at the next loaded bar's open - mechanical paper accounting, no spread/slippage/impact, not a matched-risk control.</li>
    <li>Real-time/intraday feed: unavailable in this build (delayed daily bars only). Brokerage connection: not present by design.</li>
    <li>Inputs and paper book persist in this browser's local storage only; clearing site data erases them. No server-side account state exists.</li>
  </ul>`;
}

function renderAll() { renderInputs(); renderScan(); renderBook(); renderTest(); renderProv(); }
tryFillOrders();
renderAll();
})();
