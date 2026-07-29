// 청산 규칙 격자 탐색 — 신호는 배포 스캐너 그대로, 손절 배수 × 목표 R × 시간청산만 바꾼다.
//
// 왜: 2026-07-29 전체 유니버스 백테스트에서 평균 +0.017R / PF 1.03 (대조군 -0.164R).
// 점수는 단조(40-54 -0.016R < 55-69 +0.045R < 70+ +0.062R)라 채점은 순위를 제대로 매긴다.
// 남은 손실은 청산 쪽이다 — 손절 1018 vs 목표 563 으로 손절이 1.8배였다.
//
// 심볼당 1회만 페치하고 조합 전부를 같은 패스에서 평가한다(조합마다 다시 받으면 32배 낭비).
// 펀딩은 재적합 후 채점에 안 쓰인다(crowdAbs 를 읽는 곳이 없다) — 페치 생략.
// 손절은 plan.stop(박스 기반) 이 아니라 순수 ATR 배수다. 배수를 스윕하려면 기준이 하나여야 한다.
//
// 사용: node sweep-exits.mjs [all|SYM,SYM,...]   /   node sweep-exits.mjs --selftest
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.window = globalThis;

const B = "../js/";
const { CONFIG } = await import(B + "config.js");
const { buildEarlyResult } = await import(B + "core/early-detect.js");
const { atr } = await import(B + "core/indicators.js");

const FEE = 0.0005, SLIP = 0.0005, COST = (FEE + SLIP) * 2;
const EVAL_EVERY = 6;
const NOW = Date.now();

// 1차 스윕에서 최고점이 격자 끝단(목표 3R · 60봉)에 걸려 밖을 다시 본다. 환경변수로 덮어쓴다.
const grid = (env, dflt) => (process.env[env] ? process.env[env].split(",").map(Number) : dflt);
const STOPS = grid("SWEEP_STOPS", [1.5, 2, 3, 4]);
const TARGETS = grid("SWEEP_TARGETS", [1, 1.5, 2, 3]);
const TIMES = grid("SWEEP_TIMES", [30, 60]);

// 봉 i+1 시가에 체결됐다고 보고 청산 지점을 찾는다.
// 한 봉 안에서 손절·목표가 같이 닿으면 손절을 먼저 본다(보수적 — 봉 내부 순서를 알 수 없다).
function simulate(c, i, fill, risk, targetR, timeBars) {
  const stop = fill - risk, target = fill + risk * targetR;
  for (let k = i + 1; k < Math.min(c.length, i + 1 + timeBars); k++) {
    if (c[k].low <= stop) return { exitBar: k, exitPx: stop, why: "stop" };
    if (c[k].high >= target) return { exitBar: k, exitPx: target, why: "target" };
  }
  const exitBar = Math.min(c.length - 1, i + timeBars);
  return { exitBar, exitPx: c[exitBar].close, why: "time" };
}

function rMultOf(fill, exitPx, risk) {
  return ((exitPx - fill) / fill - COST) / (risk / fill);
}

// ---- self-check ----
if (process.argv[2] === "--selftest") {
  const { strict: A } = await import("node:assert");
  const bar = (o, h, l, cl) => ({ open: o, high: h, low: l, close: cl });
  // 진입 100, risk 10. 곧장 목표(120 = 2R)까지 오르는 경우.
  const up = [bar(100, 100, 100, 100), bar(100, 105, 99, 104), bar(104, 125, 103, 124)];
  const win = simulate(up, 0, 100, 10, 2, 60);
  A.equal(win.why, "target"); A.equal(win.exitBar, 2); A.equal(win.exitPx, 120);
  A.ok(Math.abs(rMultOf(100, 120, 10) - (2 - COST * 10)) < 1e-9);
  // 곧장 손절(90)로 빠지는 경우.
  const dn = [bar(100, 100, 100, 100), bar(100, 101, 88, 89)];
  const lose = simulate(dn, 0, 100, 10, 2, 60);
  A.equal(lose.why, "stop"); A.equal(lose.exitPx, 90);
  A.ok(rMultOf(100, 90, 10) < -1);
  // 같은 봉에서 둘 다 닿으면 손절 우선.
  const both = [bar(100, 100, 100, 100), bar(100, 130, 85, 128)];
  A.equal(simulate(both, 0, 100, 10, 2, 60).why, "stop");
  // 아무것도 안 닿으면 시간청산 — timeBars 만큼 뒤 종가.
  const flat = [bar(100, 100, 100, 100), bar(100, 101, 99, 100), bar(100, 101, 99, 101)];
  const t = simulate(flat, 0, 100, 10, 2, 1);
  A.equal(t.why, "time"); A.equal(t.exitBar, 1); A.equal(t.exitPx, 100);
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
const symbols = mode === "all"
  ? info.symbols.filter((s) => s.contractType === "PERPETUAL" && s.quoteAsset === "USDT" && s.status === "TRADING").map((s) => s.symbol)
  : mode.split(",");
console.log(`sweep symbols=${symbols.length}  조합=${STOPS.length * TARGETS.length * TIMES.length}`);

// 조합별 독립 상태 — 청산 봉이 달라 쿨다운도 달라진다.
const combos = [];
for (const s of STOPS) for (const t of TARGETS) for (const tb of TIMES) {
  combos.push({ stopAtr: s, targetR: t, timeBars: tb, trades: [], cooldown: -1 });
}

let done = 0, signals = 0;
for (const sym of symbols) {
  if (++done % 50 === 0) console.error(`  ${done}/${symbols.length}`);
  const raw = await j(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=4h&limit=1000`);
  if (!raw || raw.length < 300) continue;
  const c = raw.map((k) => ({ time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5], quoteVolume: +k[7] }));
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
    const r = buildEarlyResult(item, c.slice(0, i + 1), [], null, CONFIG);
    if (!r || r.score < CONFIG.earlyMinScore) continue;
    signals++;

    const fill = c[i + 1].open;
    const a = atrArr[i];
    if (!(a > 0)) continue;
    for (const cb of combos) {
      if (i <= cb.cooldown) continue;
      const risk = a * cb.stopAtr;
      if (!(risk > 0) || risk >= fill) continue;
      const ex = simulate(c, i, fill, risk, cb.targetR, cb.timeBars);
      cb.trades.push({ r: rMultOf(fill, ex.exitPx, risk), why: ex.why, score: r.score });
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
  return { n, win: wins.length / n * 100, avg: total / n, total, pf: gl > 0 ? gp / gl : Infinity, dd,
           tg: list.filter((t) => t.why === "target").length, st: list.filter((t) => t.why === "stop").length };
}

console.log(`\n신호 ${signals}건 · 왕복비용 ${(COST * 100).toFixed(2)}%\n`);
console.log("손절   목표    시간    n     승률   평균R    합계R    PF     MDD     목표/손절");
const rows = combos.map((cb) => ({ cb, s: summarize(cb.trades) })).filter((x) => x.s);
rows.sort((a, b) => b.s.avg - a.s.avg);
for (const { cb, s } of rows) {
  console.log(
    `ATR×${String(cb.stopAtr).padEnd(4)} ${String(cb.targetR + "R").padEnd(6)} ${String(cb.timeBars + "봉").padEnd(6)} ` +
    `${String(s.n).padStart(5)} ${s.win.toFixed(0).padStart(4)}% ${s.avg >= 0 ? " " : ""}${s.avg.toFixed(3)}R ` +
    `${s.total.toFixed(1).padStart(8)}R ${s.pf.toFixed(2).padStart(5)} ${s.dd.toFixed(1).padStart(7)}R  ${s.tg}/${s.st}`
  );
}

// 최고 조합의 점수 구간별 — 표시 하한을 올릴 근거가 되는지 본다.
const best = rows[0];
console.log(`\n최고 조합 (ATR×${best.cb.stopAtr} · ${best.cb.targetR}R · ${best.cb.timeBars}봉) 점수 구간별:`);
for (const [lo, hi] of [[40, 55], [55, 70], [70, 101]]) {
  const s = summarize(best.cb.trades.filter((t) => t.score >= lo && t.score < hi));
  if (s) console.log(`  ${lo}-${hi - 1}  n=${String(s.n).padStart(5)}  승률=${s.win.toFixed(0)}%  평균=${s.avg.toFixed(3)}R  PF=${s.pf.toFixed(2)}  MDD=${s.dd.toFixed(1)}R`);
}
