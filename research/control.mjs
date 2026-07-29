// Control arm: identical exit rules, NO signal. Enter every evaluation bar.
// Without this the strategy's +R is indistinguishable from "alt season, anything long worked".
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.window = globalThis;

const B = "../js/";
const { CONFIG } = await import(B + "config.js");
const { boxRange, earlyPlan } = await import(B + "core/early-detect.js");
const { atr } = await import(B + "core/indicators.js");

const FEE = 0.0005, SLIP = 0.0005, EVAL_EVERY = 6, TIME_STOP_BARS = 60;
const mode = process.argv[2] || "all";
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
const symbols = mode === "all"
  ? info.symbols.filter((s) => s.contractType === "PERPETUAL" && s.quoteAsset === "USDT" && s.status === "TRADING").map((s) => s.symbol)
  : mode.includes("USDT") ? mode.split(",") : PUMPERS;   // ponytail: comma list as the mode arg, no flag parser
console.log(`control mode=${mode} symbols=${symbols.length}`);

const trades = [];
let done = 0;
for (const sym of symbols) {
  done++;
  if (done % 100 === 0) console.error(`  ${done}/${symbols.length}`);
  const raw = await j(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=4h&limit=1000`);
  if (!raw || raw.length < 300) continue;
  const c = raw.map((k) => ({ time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
  const atrArr = atr(c, CONFIG.indicators.atrPeriod);
  let cooldownUntil = -1;

  for (let i = 240; i < c.length - 2; i += EVAL_EVERY) {
    if (i <= cooldownUntil) continue;
    const box = boxRange(c.slice(0, i + 1), CONFIG.earlyDetect.boxLookback);
    if (!box) continue;
    const plan = earlyPlan(box, atrArr[i], c[i].close, CONFIG);
    const fill = c[i + 1].open;
    const risk = fill - (plan.stop / plan.entry) * fill;
    if (!(risk > 0)) continue;
    const stop = fill - risk, target = fill + risk * 2;

    let exitBar = -1, exitPx = null;
    for (let k = i + 1; k < Math.min(c.length, i + 1 + TIME_STOP_BARS); k++) {
      if (c[k].low <= stop) { exitBar = k; exitPx = stop; break; }
      if (c[k].high >= target) { exitBar = k; exitPx = target; break; }
    }
    if (exitBar < 0) { exitBar = Math.min(c.length - 1, i + TIME_STOP_BARS); exitPx = c[exitBar].close; }
    const rMult = ((exitPx - fill) / fill - (FEE + SLIP) * 2) / (risk / fill);
    trades.push(rMult);
    cooldownUntil = exitBar;
  }
}

const n = trades.length;
const wins = trades.filter((r) => r > 0).length;
const total = trades.reduce((s, r) => s + r, 0);
const gp = trades.filter((r) => r > 0).reduce((s, r) => s + r, 0);
const gl = -trades.filter((r) => r <= 0).reduce((s, r) => s + r, 0);
console.log(`\n대조군(무조건 진입)  n=${n}  승률=${(wins / n * 100).toFixed(0)}%  평균=${(total / n).toFixed(3)}R  합계=${total.toFixed(1)}R  PF=${(gp / gl).toFixed(2)}`);
