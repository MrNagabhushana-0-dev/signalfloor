// SignalFloor data proxy: same-origin server-side fetch of delayed daily bars.
// Upstreams: Yahoo Finance chart API (primary), Groww charting service (latest candle), Stooq CSV (fallback).
// No keys, no user data, public market data only. Raw bars (not adjusted).
export const config = { regions: ['bom1'] };
const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36' };

function fromYahoo(j) {
  const ch = j && j.chart;
  if (!ch) return null;
  if (ch.error) return { error: ch.error.description || 'upstream error' };
  const r0 = ch.result && ch.result[0];
  if (!r0 || !r0.timestamp) return null;
  const q = r0.indicators.quote[0];
  const bars = [];
  for (let i = 0; i < r0.timestamp.length; i++) {
    if (q.open[i] == null || q.close[i] == null) continue;
    bars.push({
      date: istDate(r0.timestamp[i]),
      open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i],
      volume: q.volume[i] || 0,
    });
  }
  return bars.length ? { bars } : null;
}

function fromStooq(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2 || !/^date/i.test(lines[0]) && lines[0].indexOf('Date') !== 0) return null;
  const bars = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(',');
    if (p.length < 6) continue;
    const o = parseFloat(p[1]), h = parseFloat(p[2]), l = parseFloat(p[3]), c = parseFloat(p[4]);
    if (!isFinite(o) || !isFinite(c)) continue;
    bars.push({ date: p[0], open: o, high: h, low: l, close: c, volume: parseFloat(p[5]) || 0 });
  }
  return bars.length ? { bars } : null;
}

export default async function handler(req, res) {
  const symbol = ((req.query && req.query.symbol) || '').toString().trim().toUpperCase().slice(0, 20);
  if (!/^[A-Z0-9][A-Z0-9.&-]{0,19}$/.test(symbol)) {
    res.status(400).json({ error: 'invalid symbol format' });
    return;
  }
  const tries = [];
  // Primary: Yahoo Finance chart API
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=6mo&interval=1d`, { headers: UA });
    tries.push(`yahoo HTTP ${r.status}`);
    if (r.ok) {
      const out = fromYahoo(await r.json());
      if (out && out.bars) {
        res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
        res.status(200).json({ symbol, upstream: 'yahoo', source: 'Yahoo Finance chart API - delayed daily bars, raw (not adjusted)', asof: new Date().toISOString(), bars: out.bars });
        return;
      }
      if (out && out.error) tries.push(`yahoo: ${out.error}`);
      else tries.push('yahoo: no daily bars');
    }
  } catch (e) { tries.push(`yahoo fetch failed: ${String(e).slice(0, 120)}`); }
  // Fallback 1: Groww charting service (latest daily candle only)
  try {
    const gSym = symbol.replace(/\.NS$/, '');
    const r = await fetch(`https://groww.in/v1/api/charting_service/v2/chart/exchange/NSE/segment/CASH/${encodeURIComponent(gSym)}/daily?intervalInMinutes=1440&minimal=false`, { headers: UA });
    tries.push(`groww HTTP ${r.status}`);
    if (r.ok) {
      const j = await r.json();
      const c = j && j.candles && j.candles[0];
      if (c && c.length >= 6 && c[4] != null) {
        const bar = { date: new Date(c[0] * 1000).toISOString().slice(0, 10), open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] || 0 };
        res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
        res.status(200).json({ symbol, upstream: 'groww', source: 'Groww charting service - latest daily bar only, raw (not adjusted)', asof: new Date().toISOString(), bars: [bar] });
        return;
      }
      tries.push('groww: no candle');
    }
  } catch (e) { tries.push(`groww fetch failed: ${String(e).slice(0, 120)}`); }
  // Fallback 2: Stooq CSV (symbols like TCS.NS -> TCS.IN)
  try {
    const stooqSym = symbol.replace(/\.NS$/, '.IN').toLowerCase();
    const r = await fetch(`https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSym)}&i=d`, { headers: UA });
    tries.push(`stooq HTTP ${r.status}`);
    if (r.ok) {
      const out = fromStooq(await r.text());
      if (out && out.bars) {
        res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
        res.status(200).json({ symbol, upstream: 'stooq', source: 'Stooq - delayed daily bars, raw (not adjusted)', asof: new Date().toISOString(), bars: out.bars.slice(-130) });
        return;
      }
      tries.push('stooq: no daily bars');
    }
  } catch (e) { tries.push(`stooq fetch failed: ${String(e).slice(0, 120)}`); }
  res.status(502).json({ symbol, error: 'no upstream returned daily bars', attempts: tries });
}
