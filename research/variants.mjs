// Variant selection done on TRAIN only; the winner is then reported once on TEST.
// Picking a variant by its test score would turn the test set into a training set.
import { readFileSync } from "node:fs";

// predict-dump.mjs 가 OUT 을 받으므로 소비자도 같이 받아야 한다 — 안 그러면 소량 검증본을 못 먹인다.
const raw = readFileSync(process.env.OUT || "predict.csv", "utf8").trim().split("\n");
const head = raw[0].split(",");
const rows = raw.slice(1).map((l) => {
  const p = l.split(","); const o = {};
  head.forEach((h, i) => { o[h] = p[i] === "" ? null : (isNaN(+p[i]) ? p[i] : +p[i]); });
  return o;
}).filter((r) => r.fwdMax24h != null);
for (const r of rows) r.hit = r.fwdMax24h >= 40 ? 1 : 0;
rows.sort((a, b) => a.ts - b.ts);
const cut = rows[Math.floor(rows.length * 0.7)].ts;
const train = rows.filter((r) => r.ts < cut);
const test = rows.filter((r) => r.ts >= cut);

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const ramp = (v, lo, hi) => (v == null ? 0 : clamp01((v - lo) / (hi - lo)));
const parts = (r) => ({
  mom: ramp(Math.abs(r.mom14 ?? 0), 15, 60),
  chg: ramp(Math.abs(r.chg24 ?? 0), 5, 20),
  vol: ramp(r.volExpand ?? 1, 1.2, 5),
  age: 1 - clamp01(((r.ageDays ?? 400) - 200) / 600),
  fnd: ramp(r.crowdAbs ?? 0, 0.00006, 0.0004),
  qvOk: (r.qv ?? 0) >= 5e6,
  fndFlat: r.crowdAbs != null && r.crowdAbs < 0.00006,
});
const mk = (W, opt = {}) => (r) => {
  const p = parts(r);
  let s = (W.mom||0)*p.mom + (W.chg||0)*p.chg + (W.vol||0)*p.vol + (W.age||0)*p.age + (W.fnd||0)*p.fnd;
  if (opt.flatPen && p.fndFlat) s -= opt.flatPen;
  if (opt.thinPen && !p.qvOk) s -= opt.thinPen;
  return Math.max(0, Math.min(100, Math.round(s)));
};

const VARIANTS = {
  "A 펀딩가점 유지":   mk({ mom:34, chg:26, vol:16, age:14, fnd:10 }, { flatPen:25, thinPen:10 }),
  "B 펀딩가점 제거":   mk({ mom:38, chg:28, vol:16, age:18 },         { flatPen:25, thinPen:10 }),
  "C 거래량까지 제거": mk({ mom:45, chg:32, age:23 },                 { flatPen:25, thinPen:10 }),
  "D 펀딩배제도 제거": mk({ mom:45, chg:32, age:23 },                 { thinPen:10 }),
  "E 배제 강화":       mk({ mom:38, chg:28, vol:16, age:18 },         { flatPen:40, thinPen:20 }),
};

function topN(list, fn, N, base) {
  const byDay = new Map();
  for (const r of list) { const d = new Date(r.ts).toISOString().slice(0,10); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(r); }
  let hit = 0, tot = 0;
  for (const l of byDay.values()) for (const r of [...l].sort((a,c) => fn(c)-fn(a)).slice(0,N)) { tot++; hit += r.hit; }
  return hit / tot / base;
}
const rate = (l) => l.reduce((s, r) => s + r.hit, 0) / l.length;
const bTr = rate(train), bTe = rate(test);

console.log("=== 학습셋에서 변형 선택 (상위 N/일 리프트) ===");
console.log("변형".padEnd(20) + "N=3     N=5     N=10    평균");
const scoreOf = {};
for (const [name, fn] of Object.entries(VARIANTS)) {
  const l = [3, 5, 10].map((N) => topN(train, fn, N, bTr));
  scoreOf[name] = l.reduce((a, b) => a + b, 0) / 3;
  console.log(name.padEnd(20) + l.map((x) => x.toFixed(2).padStart(5) + "x").join("  ") + "  " + scoreOf[name].toFixed(2) + "x");
}
const winner = Object.entries(scoreOf).sort((a, b) => b[1] - a[1])[0][0];
console.log(`\n선택: ${winner}`);

console.log(`\n=== 검증셋 최종 확인 (기준선 ${(bTe*100).toFixed(2)}%) ===`);
console.log("N     현재점수        " + winner);
for (const N of [1, 3, 5, 10, 20]) {
  const cur = topN(test, (r) => r.score, N, bTe);
  const nw = topN(test, VARIANTS[winner], N, bTe);
  console.log(`${String(N).padStart(2)}   ${cur.toFixed(2).padStart(5)}x          ${nw.toFixed(2).padStart(5)}x`);
}
console.log("\n검증셋 구간별:");
for (const [lo, hi] of [[0,25],[25,40],[40,55],[55,70],[70,101]]) {
  const l = test.filter((r) => { const s = VARIANTS[winner](r); return s >= lo && s < hi; });
  if (l.length < 30) continue;
  console.log(`  ${lo}-${hi-1}`.padEnd(10) + `n=${String(l.length).padStart(6)}  적중=${(rate(l)*100).toFixed(2).padStart(5)}%  리프트=${(rate(l)/bTe).toFixed(2)}x`);
}
