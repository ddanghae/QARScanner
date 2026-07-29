// 두 채점 모델 비교 — 같은 봉, 같은 라벨, 각자의 청산 규칙.
//
// 2026-07-26~29 사이 두 갈래가 공통 조상 db01999 에서 독립적으로 early 모드를 다시 만들었다.
//   A(이 저장소)  momentum 45 / change24h 32 / freshness 23,  손절 ATR×4 · 목표 4R
//   B(origin/main) volatilityRange 40 / rangePosition 25 / oiBuildUp 25 / volumeExpansion 10,
//                  손절 min(박스하단, 2ATR, 20%) · 목표 3ATR
// 둘 다 "압축·거래량고갈 전제는 틀렸다" 는 같은 결론에 도달했으나 대체 모델이 다르다.
// 어느 쪽이 나은지는 같은 표본에 둘 다 돌려봐야 안다.
//
// 사용: MAIN_WT=<origin/main 워크트리 경로> node compare-models.mjs [oi|long] [심볼수]
//
//   oi   (기본) OI 히스토리가 있는 최근 구간만. B 의 oiBuildUp 25점이 살아 있어 공정하다.
//                Binance openInterestHist(period=1h) 는 30일만 보존하고 limit 상한이 500 이라
//                실제 평가 가능 구간은 약 11일이다. 표본이 짧다 — 순위 참고용.
//   long        4시간봉 1000개(약 166일) 전 구간. OI 가 없어 B 는 25점을 구조적으로 잃는다.
//                B 에 불리하므로 R 비교의 보조 지표로만 읽을 것.
//
// 라벨은 양쪽 공통: 평가 시점 이후 7일 안에 "24시간 +40% 이상" 이 한 번이라도 나오면 적중.
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.window = globalThis;

import { pathToFileURL } from "node:url";
import path from "node:path";

const WT = process.env.MAIN_WT;
if (!WT) { console.error("MAIN_WT 환경변수에 origin/main 워크트리 경로를 넣으세요."); process.exit(1); }
const wtUrl = (p) => pathToFileURL(path.join(WT, p)).href;

const A = { name: "A 이 저장소", cfg: (await import("../js/config.js")).CONFIG,
            build: (await import("../js/core/early-detect.js")).buildEarlyResult };
const B = { name: "B origin/main", cfg: (await import(wtUrl("js/config.js"))).CONFIG,
            build: (await import(wtUrl("js/core/early-detect.js"))).buildEarlyResult };
const MODELS = [A, B];

const FEE = 0.0005, SLIP = 0.0005, COST = (FEE + SLIP) * 2;
const EVAL_EVERY = 6;          // 하루 1회 평가 (4시간봉)
const LABEL_DAYS = 7;
const PUMP_PCT = 40;           // 라벨: 24시간 +40%
const HOLD_BARS = 90;          // 청산 시뮬 상한 — 양쪽 공통
const NOW = Date.now();
const HOUR = 3600_000;

const mode = process.argv[2] || "oi";
const symLimit = Number(process.argv[3]) || Infinity;

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

// 이후 LABEL_DAYS 안에 "어떤 24시간 창이든 +40% 이상" 이 있었나. 4시간봉 6개 = 24시간.
function labelAt(c, i) {
  const end = Math.min(c.length - 1, i + LABEL_DAYS * 6);
  for (let k = i + 1; k <= end; k++) {
    const base = c[Math.max(0, k - 6)].close;
    if (base > 0 && (c[k].high - base) / base * 100 >= PUMP_PCT) return true;
  }
  return i + LABEL_DAYS * 6 <= c.length - 1 ? false : null;   // 미래가 모자라면 표본에서 뺀다
}

// 봉 i+1 시가 체결. 손절 우선(봉 내부 순서를 알 수 없다). 각 모델의 plan 을 그대로 쓴다.
function simulate(c, i, plan) {
  const fill = c[i + 1].open;
  const risk = fill - (plan.stop / plan.entry) * fill;      // 계획 비율을 체결가로 옮긴다
  const reward = (plan.tp2 / plan.entry) * fill - fill;
  if (!(risk > 0) || !(reward > 0)) return null;
  const stop = fill - risk, target = fill + reward;
  let exitBar = -1, exitPx = null, why = "time";
  for (let k = i + 1; k < Math.min(c.length, i + 1 + HOLD_BARS); k++) {
    if (c[k].low <= stop) { exitBar = k; exitPx = stop; why = "stop"; break; }
    if (c[k].high >= target) { exitBar = k; exitPx = target; why = "target"; break; }
  }
  if (exitBar < 0) {
    exitBar = Math.min(c.length - 1, i + HOLD_BARS);
    if (exitBar <= i + 1) return null;
    exitPx = c[exitBar].close;
  }
  return { r: ((exitPx - fill) / fill - COST) / (risk / fill), why, exitBar };
}

const info = await j("https://fapi.binance.com/fapi/v1/exchangeInfo");
const meta = new Map(info.symbols.map((s) => [s.symbol, s]));
const symbols = info.symbols
  .filter((s) => s.contractType === "PERPETUAL" && s.quoteAsset === "USDT" && s.status === "TRADING")
  .map((s) => s.symbol).slice(0, symLimit);

console.log(`비교 모드=${mode} 심볼=${symbols.length} 라벨="${LABEL_DAYS}일 내 24h +${PUMP_PCT}%"\n`);

const rows = [];        // { day, label, per: { A:{score,...}|null, B:... } }
let evaluated = 0, done = 0;

for (const sym of symbols) {
  if (++done % 50 === 0) console.error(`  ${done}/${symbols.length}`);
  const raw = await j(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=4h&limit=1000`);
  if (!raw || raw.length < 300) continue;
  const c = raw.map((k) => ({ time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5], quoteVolume: +k[7] }));

  // OI 는 1시간 간격 — analyzeOi 가 at(72) 로 "72칸 전 = 72시간 전" 을 집는다.
  let oi = [];
  if (mode === "oi") {
    const rawOi = await j(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${sym}&period=1h&limit=500`);
    oi = (rawOi || []).map((x) => ({ time: +x.timestamp, oi: +x.sumOpenInterest })).sort((a, b) => a.time - b.time);
    if (oi.length < 100) continue;         // OI 없는 종목은 이 모드에서 제외 — B 가 불공정해진다
  }
  const oiStart = oi.length ? oi[0].time + 72 * HOUR : 0;

  const onboard = +(meta.get(sym)?.onboardDate || 0);
  for (let i = 240; i < c.length - 2; i += EVAL_EVERY) {
    const bar = c[i];
    if (mode === "oi" && bar.time < oiStart) continue;
    const label = labelAt(c, i);
    if (label === null) continue;          // 라벨을 매길 미래가 없다
    evaluated++;

    const prev = c[Math.max(0, i - 6)];
    const item = {
      symbol: sym, baseAsset: sym.replace(/USDT$/, ""),
      quoteVolume: c.slice(Math.max(0, i - 5), i + 1).reduce((s, x) => s + x.quoteVolume, 0),
      change24h: ((bar.close - prev.close) / prev.close) * 100,
      newListing: false,
      onboardDate: onboard ? onboard + (NOW - bar.time) : 0,
    };
    const hist = c.slice(0, i + 1);
    const oiSlice = oi.filter((x) => x.time <= bar.time);

    const per = {};
    for (const m of MODELS) {
      const res = m.build(item, hist, oiSlice, null, m.cfg);
      if (!res || res.score < m.cfg.earlyMinScore) { per[m.name] = null; continue; }
      per[m.name] = { score: res.score, trade: simulate(c, i, res.plan) };
    }
    rows.push({ day: Math.floor(bar.time / 86400000), label, per });
  }
}

// ---- 집계 ----
const base = rows.filter((r) => r.label).length / rows.length * 100;
console.log(`\n평가 시점 ${rows.length}건 (표본 외 제외 전 ${evaluated}) · 기준 급등률 ${base.toFixed(2)}%\n`);

function report(m) {
  const hit = rows.filter((r) => r.per[m.name]);
  if (!hit.length) { console.log(`${m.name}: 노출 0건`); return; }
  const pos = hit.filter((r) => r.label).length;
  const rate = pos / hit.length * 100;

  // 상위 N/일 — 하루에 점수 높은 순으로 N 개만 골랐을 때
  const byDay = new Map();
  for (const r of hit) {
    if (!byDay.has(r.day)) byDay.set(r.day, []);
    byDay.get(r.day).push(r);
  }
  const topN = (n) => {
    let t = 0, p = 0;
    for (const list of byDay.values()) {
      const pick = [...list].sort((a, b) => b.per[m.name].score - a.per[m.name].score).slice(0, n);
      t += pick.length; p += pick.filter((x) => x.label).length;
    }
    return t ? [p / t * 100, p / t * 100 / base] : [0, 0];
  };

  const trades = hit.map((r) => r.per[m.name].trade).filter(Boolean);
  const totalR = trades.reduce((s, t) => s + t.r, 0);
  const gp = trades.filter((t) => t.r > 0).reduce((s, t) => s + t.r, 0);
  const gl = -trades.filter((t) => t.r <= 0).reduce((s, t) => s + t.r, 0);
  let peak = 0, dd = 0, cum = 0;
  for (const t of trades) { cum += t.r; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); }

  console.log(`── ${m.name}`);
  console.log(`   노출 ${hit.length}건 (평가의 ${(hit.length / rows.length * 100).toFixed(1)}%) · 적중 ${pos}건`);
  console.log(`   적중률 ${rate.toFixed(2)}%  리프트 ${(rate / base).toFixed(2)}x`);
  for (const n of [1, 3, 5, 10]) {
    const [r2, l2] = topN(n);
    console.log(`   상위 ${String(n).padStart(2)}/일  ${r2.toFixed(1)}%  ${l2.toFixed(2)}x`);
  }
  if (trades.length) {
    console.log(`   백테스트(자기 청산규칙)  n=${trades.length}  평균 ${(totalR / trades.length).toFixed(3)}R  ` +
      `PF ${gl > 0 ? (gp / gl).toFixed(2) : "inf"}  MDD ${dd.toFixed(1)}R  ` +
      `[목표 ${trades.filter((t) => t.why === "target").length} / 손절 ${trades.filter((t) => t.why === "stop").length} / 시간 ${trades.filter((t) => t.why === "time").length}]`);
  }
  console.log("");
}

for (const m of MODELS) report(m);

// 겹침 — 두 모델이 같은 것을 고르는가
const both = rows.filter((r) => r.per[A.name] && r.per[B.name]).length;
const onlyA = rows.filter((r) => r.per[A.name] && !r.per[B.name]).length;
const onlyB = rows.filter((r) => !r.per[A.name] && r.per[B.name]).length;
console.log(`겹침: 둘 다 ${both} · A 만 ${onlyA} · B 만 ${onlyB}`);
const bothHit = rows.filter((r) => r.per[A.name] && r.per[B.name] && r.label).length;
if (both) console.log(`둘 다 고른 것의 적중률 ${(bothHit / both * 100).toFixed(2)}%  리프트 ${(bothHit / both * 100 / base).toFixed(2)}x`);
