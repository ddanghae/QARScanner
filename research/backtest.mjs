// Walk-forward backtest of the shipped QARScanner early mode.
// Reuses js/core/early-detect.js + js/config.js verbatim — tests the shipped rule, not a copy.
//
// No lookahead: at bar i only candles[0..i] are passed, entry fills at bar i+1 open,
// exits check bar i+1..n highs/lows. ageDays is shifted so it reads the age AT bar time
// (buildEarlyMetrics uses Date.now(), so onboardDate is offset to compensate).
//
// Known gaps, both conservative (understate the strategy):
//   - OI history is 30d only -> oiSeries empty -> oiBuildUp always 0 (up to 10 pts lost)
//   - funding uses the last settled rate at bar time (live scanner uses lastFundingRate too)
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.window = globalThis;

const B = "../js/";
const { CONFIG } = await import(B + "config.js");
const { buildEarlyResult } = await import(B + "core/early-detect.js");

const FEE = 0.0005;          // taker per side
const SLIP = 0.0005;         // assumed slippage per side (low-cap perps)
const EVAL_EVERY = 6;        // evaluate once per day (4h bars)
const TIME_STOP_BARS = 60;   // 10 days
const NOW = Date.now();

const args = process.argv.slice(2);
const mode = args[0] || "pumpers";

const PUMPERS = ["BANKUSDT","AKEUSDT","USUSDT","ESPORTSUSDT","KAITOUSDT","TLMUSDT","EULUSDT","BULLAUSDT",
                 "ZAMAUSDT","ONUSDT","PROMUSDT","AVAAIUSDT","MUSDT","UBUSDT","EPICUSDT","CHILLGUYUSDT"];

async function j(url) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url);
      if (r.status === 429 || r.status >= 500) { await new Promise((s) => setTimeout(s, 1500 * (i + 1))); continue; }
      if (!r.ok) return null;
      return await r.json();
    } catch { await new Promise((s) => setTimeout(s, 800 * (i + 1))); }
  }
  return null;
}

const info = await j("https://fapi.binance.com/fapi/v1/exchangeInfo");
const meta = new Map(info.symbols.map((s) => [s.symbol, s]));
const symbols = mode === "all"
  ? info.symbols.filter((s) => s.contractType === "PERPETUAL" && s.quoteAsset === "USDT" && s.status === "TRADING").map((s) => s.symbol)
  : PUMPERS;

console.log(`mode=${mode} symbols=${symbols.length}`);

const trades = [];
let evaluated = 0, signals = 0, done = 0;

for (const sym of symbols) {
  done++;
  if (done % 50 === 0) console.error(`  ${done}/${symbols.length}`);
  const raw = await j(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=4h&limit=1000`);
  if (!raw || raw.length < 300) continue;
  const c = raw.map((k) => ({ time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5], quoteVolume: +k[7] }));

  const fr = await j(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${sym}&limit=1000`);
  const fund = (fr || []).map((f) => ({ t: +f.fundingTime, r: +f.fundingRate })).sort((a, b) => a.t - b.t);
  let fi = 0;
  const fundingAt = (ts) => {
    while (fi + 1 < fund.length && fund[fi + 1].t <= ts) fi++;
    if (!fund.length || fund[fi].t > ts) return null;
    return fund[fi].r;
  };

  const onboard = +(meta.get(sym)?.onboardDate || 0);
  const start = 240;
  let cooldownUntil = -1;

  for (let i = start; i < c.length - 2; i += EVAL_EVERY) {
    if (i <= cooldownUntil) continue;
    evaluated++;
    const hist = c.slice(0, i + 1);          // bar i closed
    const bar = c[i];
    const win24 = c.slice(Math.max(0, i - 5), i + 1);
    const item = {
      symbol: sym, baseAsset: sym.replace(/USDT$/, ""),
      quoteVolume: win24.reduce((s, x) => s + x.quoteVolume, 0),
      change24h: ((bar.close - c[Math.max(0, i - 6)].close) / c[Math.max(0, i - 6)].close) * 100,
      newListing: false,
      // shift so (Date.now() - onboardDate) == (barTime - realOnboard)
      onboardDate: onboard ? onboard + (NOW - bar.time) : 0,
    };
    fi = 0;
    const r = buildEarlyResult(item, hist, [], fundingAt(bar.time), CONFIG);
    if (!r || r.score < CONFIG.earlyMinScore) continue;
    signals++;

    // fill at next bar open
    const fill = c[i + 1].open;
    const risk = fill - (r.plan.stop / r.plan.entry) * fill;   // scale plan to the fill price
    if (!(risk > 0)) continue;
    const stop = fill - risk;
    const target = fill + risk * 2;

    let exitBar = -1, exitPx = null, why = "time";
    for (let k = i + 1; k < Math.min(c.length, i + 1 + TIME_STOP_BARS); k++) {
      if (c[k].low <= stop) { exitBar = k; exitPx = stop; why = "stop"; break; }   // stop first if both
      if (c[k].high >= target) { exitBar = k; exitPx = target; why = "target"; break; }
    }
    if (exitBar < 0) {
      exitBar = Math.min(c.length - 1, i + TIME_STOP_BARS);
      exitPx = c[exitBar].close;
    }
    const gross = (exitPx - fill) / fill;
    const cost = (FEE + SLIP) * 2;
    const rMult = (gross - cost) / (risk / fill);
    trades.push({ sym, score: r.score, stage: r.stage.stage, why, rMult,
      bars: exitBar - i, entryTime: new Date(c[i + 1].time).toISOString().slice(0, 10) });
    cooldownUntil = exitBar;
  }
}

// ---- report ----
function stats(list, label) {
  if (!list.length) { console.log(`${label}: 거래 없음`); return; }
  const n = list.length;
  const wins = list.filter((t) => t.rMult > 0);
  const totalR = list.reduce((s, t) => s + t.rMult, 0);
  const gp = wins.reduce((s, t) => s + t.rMult, 0);
  const gl = -list.filter((t) => t.rMult <= 0).reduce((s, t) => s + t.rMult, 0);
  const byWhy = (w) => list.filter((t) => t.why === w).length;
  let peak = 0, dd = 0, cum = 0;
  for (const t of list) { cum += t.rMult; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); }
  console.log(
    `${label.padEnd(18)} n=${String(n).padStart(4)}  승률=${(wins.length / n * 100).toFixed(0).padStart(3)}%  ` +
    `평균=${totalR / n >= 0 ? " " : ""}${(totalR / n).toFixed(3)}R  합계=${totalR.toFixed(1).padStart(7)}R  ` +
    `PF=${gl > 0 ? (gp / gl).toFixed(2) : "inf"}  MDD=${dd.toFixed(1)}R  ` +
    `[목표 ${byWhy("target")} / 손절 ${byWhy("stop")} / 시간 ${byWhy("time")}]`
  );
}

console.log(`\n평가 시점 ${evaluated}회 → 신호 ${signals}건 → 거래 ${trades.length}건`);
console.log(`비용: 왕복 ${((FEE + SLIP) * 2 * 100).toFixed(2)}%  |  손절 ATR×${CONFIG.earlyDetect.stopMaxAtr}  |  목표 2R  |  시간청산 ${TIME_STOP_BARS}봉\n`);
stats(trades, "전체");
trades.sort((a, b) => a.score - b.score);
for (const [lo, hi] of [[25, 40], [40, 55], [55, 70], [70, 101]]) {
  stats(trades.filter((t) => t.score >= lo && t.score < hi), `점수 ${lo}-${hi - 1}`);
}
for (const s of [1, 2, 3]) stats(trades.filter((t) => t.stage === s), `${s}단계`);

if (mode !== "all") {
  console.log("\n종목별:");
  const bySym = {};
  for (const t of trades) (bySym[t.sym] ||= []).push(t);
  for (const [s, list] of Object.entries(bySym).sort((a, b) =>
    b[1].reduce((x, t) => x + t.rMult, 0) - a[1].reduce((x, t) => x + t.rMult, 0))) {
    stats(list, "  " + s);
  }
}
