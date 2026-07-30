// One data pass -> CSV of (score, factors, forward outcome) for every symbol x day.
// Scores EVERY evaluation point, gate-passing or not, so the gate itself can be measured.
// Entry/exit is deliberately absent: this measures prediction, nothing else.
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.window = globalThis;

import { writeFileSync } from "node:fs";
const B = "../js/";
const { CONFIG } = await import(B + "config.js");
const { buildEarlyMetrics, scoreEarly, buildEarlyResult } = await import(B + "core/early-detect.js");
const { cvdDivergence, volumeSpikes } = await import(B + "core/volume-analysis.js");

const EVAL_EVERY = 6;    // daily
const FWD_7 = 42;        // 7d in 4h bars
const FWD_14 = 84;
const NOW = Date.now();

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
const symbols = info.symbols
  .filter((s) => s.contractType === "PERPETUAL" && s.quoteAsset === "USDT" && s.status === "TRADING")
  .map((s) => s.symbol);
// LIMIT=3 로 소량 검증 후 전체를 돌린다 — 500종목 스크레이프가 마지막에 터지면 시간만 버린다.
if (+(process.env.LIMIT || 0) > 0) symbols.length = Math.min(symbols.length, +process.env.LIMIT);
const OUT = process.env.OUT || "predict.csv";
console.error(`symbols=${symbols.length} out=${OUT}`);

const rows = [["sym","ts","gate","stage","score","crowdAbs","mom14","volExpand","ageDays","oi72","chg24","qv",
               "cvdBull","cvdBear","spRel","spBuy","spPos","spAgo","spAbove","spVerdict",
               "fwdMax24h","fwdPeak7","fwdPeak14","fwdTrough7"].join(",")];
let done = 0;

for (const sym of symbols) {
  done++;
  if (done % 50 === 0) console.error(`  ${done}/${symbols.length}`);
  const raw = await j(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=4h&limit=1000`);
  if (!raw || raw.length < 300 + FWD_14) continue;
  // takerBuyBase (인덱스 9) 가 없으면 CVD·매수비율을 못 만든다. openTime 도 같이 둔다
  // — findPivots 가 pivot.time 에 쓴다(계산에는 안 쓰이지만 undefined 를 남기지 않는다).
  const c = raw.map((k) => {
    const volume = +k[5], takerBuyBase = +k[9];
    return { time: +k[0], openTime: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4],
             volume, quoteVolume: +k[7], takerBuyBase, takerSellBase: volume - takerBuyBase };
  });

  const fr = await j(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${sym}&limit=1000`);
  const fund = (fr || []).map((f) => ({ t: +f.fundingTime, r: +f.fundingRate })).sort((a, b) => a.t - b.t);
  const fundingAt = (ts) => {
    let lo = 0, hi = fund.length - 1, best = null;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (fund[m].t <= ts) { best = fund[m].r; lo = m + 1; } else hi = m - 1; }
    return best;
  };

  const onboard = +(meta.get(sym)?.onboardDate || 0);
  const n = c.length;

  for (let i = 240; i < n - FWD_14 - 1; i += EVAL_EVERY) {
    const hist = c.slice(0, i + 1);
    const bar = c[i];
    const win24 = c.slice(Math.max(0, i - 5), i + 1);
    const item = {
      symbol: sym, baseAsset: sym.replace(/USDT$/, ""),
      quoteVolume: win24.reduce((s, x) => s + x.quoteVolume, 0),
      change24h: ((bar.close - c[i - 6].close) / c[i - 6].close) * 100,
      newListing: false,
      onboardDate: onboard ? onboard + (NOW - bar.time) : 0,
    };
    const f = fundingAt(bar.time);
    const m = buildEarlyMetrics(hist, [], f, item, CONFIG);
    if (!m) continue;
    const sc = scoreEarly(m, CONFIG);
    const gated = buildEarlyResult(item, hist, [], f, CONFIG);

    // forward outcomes, strictly after bar i
    let best24 = -999;
    for (let k = i + 1; k + 6 <= Math.min(n - 1, i + FWD_7); k++) {
      const r = (c[k + 6].close / c[k].close - 1) * 100;
      if (r > best24) best24 = r;
    }
    let pk7 = -999, pk14 = -999, tr7 = 999;
    for (let k = i + 1; k <= Math.min(n - 1, i + FWD_14); k++) {
      const up = (c[k].high / bar.close - 1) * 100;
      if (k <= i + FWD_7) { if (up > pk7) pk7 = up;
        const dn = (c[k].low / bar.close - 1) * 100; if (dn < tr7) tr7 = dn; }
      if (up > pk14) pk14 = up;
    }

    // 선행지표 후보. hist 는 bar i 까지만이라 룩어헤드 없음.
    // 80봉 꼬리만 넘긴다 — 다이버전스는 최근 40봉 피봇만 보고, CVD 는 두 피봇의 차만 쓰므로
    // 누적 시작점이 상쇄된다. 전체 히스토리를 매 평가점마다 훑으면 O(n^2) 가 된다.
    const tail = hist.slice(-80);
    const dv = cvdDivergence(tail, 3, 40);
    const sp = volumeSpikes(tail, { period: 20, minRel: 3, lookback: 30 })[0] || null;

    const f4 = (x) => (x == null ? "" : (+x).toFixed(4));
    rows.push([sym, bar.time, gated ? 1 : 0, gated ? gated.stage.stage : "", sc.score,
      f4(m.crowdAbs), f4(m.mom14), f4(m.volExpand), m.ageDays == null ? "" : Math.round(m.ageDays),
      f4(m.oi.change72h), f4(m.change24h), Math.round(item.quoteVolume),
      dv.bullish ? 1 : 0, dv.bearish ? 1 : 0,
      sp ? f4(sp.relVol) : "", sp ? f4(sp.buyRatio) : "", sp ? f4(sp.closePos) : "",
      sp ? sp.barsAgo : "", sp && sp.pctAbove != null ? f4(sp.pctAbove) : "", sp ? sp.verdict : "",
      f4(best24), f4(pk7), f4(pk14), f4(tr7)].join(","));
  }
}

writeFileSync(OUT, rows.join("\n"), "utf8");
console.error(`done rows=${rows.length - 1}`);
