// 추세 추종 전용 청산 스윕 — 신호는 buildTrendResult 그대로, 청산 방식만 바꾼다.
//
// 왜 별도 파일인가: sweep-exits.mjs 는 early 신호에 대해 **고정 목표 R** 만 스윕한다.
// 추세 추종의 전제는 "이긴 것을 끝까지 끌고 간다" 인데 고정 목표는 정확히 그걸 막는다.
// 그래서 트레일링·부분익절+트레일을 같은 잣대로 비교해야 답이 나온다.
//
// 반대 근거도 이미 있다 — earlyPlan 주석: 급등 141건에서 고점 이후 중앙 82% 를 반납했고
// 31% 는 전량 반납했다. 이 시장의 상승은 매끄러운 추세가 아니라 뾰족한 스파이크라
// 트레일링이 이론만큼 안 먹힐 수 있다. 어느 쪽인지는 재야 안다.
//
// 사용: node trend-exits.mjs [all|SYM,SYM,...]  /  node trend-exits.mjs --selftest
//       LIMIT=20 node trend-exits.mjs        (소량 확인)
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.window = globalThis;

const B = "../js/";
const { CONFIG } = await import(B + "config.js");
const { buildEarlyMetrics, earlyPlan } = await import(B + "core/early-detect.js");
const { buildTrendResult } = await import(B + "core/strategies.js");
const { gradeFor, topSignals } = await import(B + "core/scoring.js");
const { atr } = await import(B + "core/indicators.js");

const FEE = 0.0005, SLIP = 0.0005, COST = (FEE + SLIP) * 2;
const EVAL_EVERY = 6;
const NOW = Date.now();
const MIN_SCORE = +(process.env.TREND_MIN_SCORE || 40);

const grid = (env, dflt) => (process.env[env] ? process.env[env].split(",").map(Number) : dflt);
const STOPS = grid("STOPS", [2, 3, 4]);          // 초기 손절 = ATR × 이 배수
const TARGETS = grid("TARGETS", [2, 4, 6]);      // 고정 목표 R
const TRAILS = grid("TRAILS", [2, 3, 4]);        // 트레일 폭 = ATR × 이 배수
const TIMES = grid("TIMES", [60, 90]);

// ── 청산 방식 3종. 셋 다 같은 초기 손절·시간청산을 쓴다 — 그래야 차이가 청산 방식에서만 온다.

// A. 고정 목표 (현재 방식). sweep-exits.mjs 와 동일한 규칙.
function simFixed(c, i, fill, risk, { targetR, timeBars }) {
  const stop = fill - risk, target = fill + risk * targetR;
  for (let k = i + 1; k < Math.min(c.length, i + 1 + timeBars); k++) {
    // 한 봉에서 둘 다 닿으면 손절 우선 — 봉 내부 순서를 모른다(보수적).
    if (c[k].low <= stop) return { exitBar: k, exitPx: stop, why: "stop" };
    if (c[k].high >= target) return { exitBar: k, exitPx: target, why: "target" };
  }
  const exitBar = Math.min(c.length - 1, i + timeBars);
  return { exitBar, exitPx: c[exitBar].close, why: "time" };
}

// B. 트레일링 — 목표 없음. 고점에서 ATR×trailAtr 내려오면 청산.
// 손절선은 올라가기만 한다(내려가면 손절이 아니다).
function simTrail(c, i, fill, risk, { trailAtr, atrVal, timeBars }) {
  let stop = fill - risk, peak = fill;
  for (let k = i + 1; k < Math.min(c.length, i + 1 + timeBars); k++) {
    // 이번 봉의 저가부터 본다 — 지난 봉까지로 정해진 손절선이 이 봉에 닿았는지가 먼저다.
    // 같은 봉의 고가로 손절을 올린 뒤 저가를 보면 미래를 쓰는 것이다(룩어헤드).
    if (c[k].low <= stop) return { exitBar: k, exitPx: stop, why: stop > fill ? "trail" : "stop" };
    if (c[k].high > peak) {
      peak = c[k].high;
      stop = Math.max(stop, peak - atrVal * trailAtr);
    }
  }
  const exitBar = Math.min(c.length - 1, i + timeBars);
  return { exitBar, exitPx: c[exitBar].close, why: "time" };
}

// C. 부분 익절 + 트레일 — 1R 에서 절반 빼고 손절을 본전으로, 나머지는 트레일.
// 반환 r 은 두 조각의 가중 합이다.
function simPartialTrail(c, i, fill, risk, { trailAtr, atrVal, timeBars, frac = 0.5, partialAtR = 1 }) {
  const partialPx = fill + risk * partialAtR;
  let stop = fill - risk, peak = fill, taken = false;
  for (let k = i + 1; k < Math.min(c.length, i + 1 + timeBars); k++) {
    if (c[k].low <= stop) {
      return { exitBar: k, exitPx: stop, why: taken ? "trail-rest" : "stop", partialPx: taken ? partialPx : null, frac };
    }
    if (!taken && c[k].high >= partialPx) {
      taken = true;
      stop = Math.max(stop, fill);      // 본전으로
    }
    if (c[k].high > peak) {
      peak = c[k].high;
      if (taken) stop = Math.max(stop, peak - atrVal * trailAtr);
    }
  }
  const exitBar = Math.min(c.length - 1, i + timeBars);
  return { exitBar, exitPx: c[exitBar].close, why: "time", partialPx: taken ? partialPx : null, frac };
}

function rMultOf(fill, exitPx, risk) {
  return ((exitPx - fill) / fill - COST) / (risk / fill);
}
// 부분 익절은 두 조각을 각각 비용 처리한다.
function rOfExit(fill, risk, ex) {
  if (ex.partialPx == null) return rMultOf(fill, ex.exitPx, risk);
  return ex.frac * rMultOf(fill, ex.partialPx, risk) + (1 - ex.frac) * rMultOf(fill, ex.exitPx, risk);
}

// ---- self-check ----
if (process.argv[2] === "--selftest") {
  const { strict: A } = await import("node:assert");
  const bar = (o, h, l, cl) => ({ open: o, high: h, low: l, close: cl });

  // 고정: 곧장 목표(2R)
  const up = [bar(100, 100, 100, 100), bar(100, 105, 99, 104), bar(104, 125, 103, 124)];
  A.equal(simFixed(up, 0, 100, 10, { targetR: 2, timeBars: 60 }).why, "target");
  // 같은 봉에서 둘 다 → 손절 우선
  const both = [bar(100, 100, 100, 100), bar(100, 130, 85, 128)];
  A.equal(simFixed(both, 0, 100, 10, { targetR: 2, timeBars: 60 }).why, "stop");

  // 트레일: 130 까지 올랐다가 되돌림. ATR 10 × 2 = 20 트레일 → 손절선 110.
  const tr = [bar(100, 100, 100, 100), bar(100, 130, 99, 128), bar(128, 129, 105, 108)];
  const t1 = simTrail(tr, 0, 100, 10, { trailAtr: 2, atrVal: 10, timeBars: 60 });
  A.equal(t1.why, "trail"); A.equal(t1.exitPx, 110); A.equal(t1.exitBar, 2);
  // 트레일이 아직 진입 아래면 그냥 손절이다.
  const tr2 = [bar(100, 100, 100, 100), bar(100, 102, 88, 89)];
  A.equal(simTrail(tr2, 0, 100, 10, { trailAtr: 2, atrVal: 10, timeBars: 60 }).why, "stop");
  // 룩어헤드 방지: 같은 봉에서 고가로 손절을 올린 뒤 저가를 보면 안 된다.
  // 고가 130(트레일 110)·저가 95 인 한 봉 → 저가를 먼저 보므로 원래 손절 90 에 안 닿아 계속 간다.
  const la = [bar(100, 100, 100, 100), bar(100, 130, 95, 120), bar(120, 121, 100, 101)];
  const t3 = simTrail(la, 0, 100, 10, { trailAtr: 2, atrVal: 10, timeBars: 60 });
  A.equal(t3.exitBar, 2); A.equal(t3.exitPx, 110);

  // 부분익절: 1R(110) 찍고 본전으로 → 되돌아 100 에 나머지 청산
  const pt = [bar(100, 100, 100, 100), bar(100, 112, 99, 111), bar(111, 112, 98, 99)];
  const p1 = simPartialTrail(pt, 0, 100, 10, { trailAtr: 2, atrVal: 10, timeBars: 60 });
  A.equal(p1.why, "trail-rest"); A.equal(p1.exitPx, 100); A.equal(p1.partialPx, 110);
  const r = rOfExit(100, 10, p1);
  A.ok(r > 0.4 && r < 0.5, `절반 +1R · 절반 본전 → 약 0.5R 에서 비용 차감 (${r})`);
  console.log("selftest 통과");
  process.exit(0);
}

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

const mode = process.argv[2] || "all";
const info = await j("https://fapi.binance.com/fapi/v1/exchangeInfo");
const meta = new Map(info.symbols.map((s) => [s.symbol, s]));
let symbols = mode === "all"
  ? info.symbols.filter((s) => s.contractType === "PERPETUAL" && s.quoteAsset === "USDT" && s.status === "TRADING").map((s) => s.symbol)
  : mode.split(",");
if (+(process.env.LIMIT || 0) > 0) symbols = symbols.slice(0, +process.env.LIMIT);

// 조합. 방식마다 스윕 축이 달라 따로 만든다.
const combos = [];
for (const s of STOPS) {
  for (const tb of TIMES) {
    for (const t of TARGETS) combos.push({ kind: "고정", stopAtr: s, targetR: t, timeBars: tb, trades: [], cooldown: -1 });
    for (const tr of TRAILS) combos.push({ kind: "트레일", stopAtr: s, trailAtr: tr, timeBars: tb, trades: [], cooldown: -1 });
    for (const tr of TRAILS) combos.push({ kind: "절반+트레일", stopAtr: s, trailAtr: tr, timeBars: tb, trades: [], cooldown: -1 });
  }
}
console.log(`symbols=${symbols.length}  조합=${combos.length}  점수하한=${MIN_SCORE}`);

const deps = { buildEarlyMetrics, earlyPlan, gradeFor, topSignals };
let done = 0, signals = 0;
for (const sym of symbols) {
  if (++done % 50 === 0) console.error(`  ${done}/${symbols.length}`);
  const raw = await j(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=4h&limit=1000`);
  if (!raw || raw.length < 300) continue;
  const c = raw.map((k) => ({ time: +k[0], openTime: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4],
                              volume: +k[5], quoteVolume: +k[7] }));
  const atrArr = atr(c, CONFIG.indicators.atrPeriod);
  const onboard = +(meta.get(sym)?.onboardDate || 0);
  for (const cb of combos) cb.cooldown = -1;

  for (let i = 240; i < c.length - 2; i += EVAL_EVERY) {
    const bar = c[i];
    const prev = c[Math.max(0, i - 6)];
    const item = {
      symbol: sym, baseAsset: sym.replace(/USDT$/, ""),
      quoteVolume: c.slice(Math.max(0, i - 5), i + 1).reduce((s, x) => s + x.quoteVolume, 0),
      change24h: ((bar.close - prev.close) / prev.close) * 100,
      newListing: false,
      onboardDate: onboard ? onboard + (NOW - bar.time) : 0,
    };
    const r = buildTrendResult(item, c.slice(0, i + 1), null, CONFIG, deps);
    if (!r || r.score < MIN_SCORE) continue;
    signals++;

    const fill = c[i + 1].open;
    const a = atrArr[i];
    if (!(a > 0)) continue;
    for (const cb of combos) {
      if (i <= cb.cooldown) continue;
      const risk = a * cb.stopAtr;
      if (!(risk > 0) || risk >= fill) continue;
      const opt = { targetR: cb.targetR, trailAtr: cb.trailAtr, atrVal: a, timeBars: cb.timeBars };
      const ex = cb.kind === "고정" ? simFixed(c, i, fill, risk, opt)
        : cb.kind === "트레일" ? simTrail(c, i, fill, risk, opt)
        : simPartialTrail(c, i, fill, risk, opt);
      cb.trades.push({ r: rOfExit(fill, risk, ex), why: ex.why, score: r.score });
      cb.cooldown = ex.exitBar;
    }
  }
}

function summarize(list) {
  const n = list.length;
  if (!n) return null;
  const wins = list.filter((t) => t.r > 0);
  const total = list.reduce((s, t) => s + t.r, 0);
  const gp = wins.reduce((s, t) => s + t.r, 0);
  const gl = -list.filter((t) => t.r <= 0).reduce((s, t) => s + t.r, 0);
  let peak = 0, dd = 0, cum = 0;
  for (const t of list) { cum += t.r; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); }
  return { n, win: wins.length / n * 100, avg: total / n, total, pf: gl > 0 ? gp / gl : Infinity, dd };
}

console.log(`\n신호 ${signals}건 · 왕복비용 ${(COST * 100).toFixed(2)}%\n`);
console.log("방식          손절    목표/트레일  시간    n     승률   평균R    합계R    PF     MDD");
const rows = combos.map((cb) => ({ cb, s: summarize(cb.trades) })).filter((x) => x.s && x.s.n >= 30);
rows.sort((a, b) => b.s.avg - a.s.avg);
for (const { cb, s } of rows) {
  const mid = cb.kind === "고정" ? `${cb.targetR}R` : `ATR×${cb.trailAtr}`;
  console.log(
    `${cb.kind.padEnd(12)} ATR×${String(cb.stopAtr).padEnd(4)} ${mid.padEnd(11)} ${String(cb.timeBars + "봉").padEnd(6)} ` +
    `${String(s.n).padStart(5)} ${s.win.toFixed(0).padStart(4)}% ${s.avg >= 0 ? " " : ""}${s.avg.toFixed(3)}R ` +
    `${s.total.toFixed(1).padStart(8)}R ${s.pf.toFixed(2).padStart(5)} ${s.dd.toFixed(1).padStart(7)}R`);
}

// 방식별 최고를 나란히 — 격자 안에서 어느 방식이 이겼는지가 결론이다.
console.log("\n방식별 최고:");
for (const kind of ["고정", "트레일", "절반+트레일"]) {
  const best = rows.filter((x) => x.cb.kind === kind)[0];
  if (!best) { console.log(`  ${kind}: 표본 부족`); continue; }
  const mid = kind === "고정" ? `${best.cb.targetR}R` : `ATR×${best.cb.trailAtr}`;
  console.log(`  ${kind.padEnd(12)} ATR×${best.cb.stopAtr} · ${mid} · ${best.cb.timeBars}봉 → 평균 ${best.s.avg.toFixed(3)}R · PF ${best.s.pf.toFixed(2)} · 승률 ${best.s.win.toFixed(0)}% (n=${best.s.n})`);
}

const best = rows[0];
if (best) {
  console.log(`\n최고 조합 점수 구간별:`);
  for (const [lo, hi] of [[40, 55], [55, 70], [70, 101]]) {
    const s = summarize(best.cb.trades.filter((t) => t.score >= lo && t.score < hi));
    if (s) console.log(`  ${lo}-${hi - 1}  n=${String(s.n).padStart(5)}  승률=${s.win.toFixed(0)}%  평균=${s.avg.toFixed(3)}R  PF=${s.pf.toFixed(2)}`);
  }
}
