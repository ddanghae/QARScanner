// Refit the pump-prediction score. Time-split: train on the older 70%, test on the newest 30%.
// Everything reported is TEST set. Fitting and judging on the same rows would just relearn noise.
//
// Two candidates are compared against the shipped score:
//   LOGIT    plain logistic regression (learns signs + relative magnitude)
//   ADDITIVE the shippable form: weighted 0..1 ramps summed to 0..100, weights from LOGIT
// Only ADDITIVE can go into scoreEarly, so ADDITIVE is what has to win.
import { readFileSync } from "node:fs";

const raw = readFileSync("predict.csv", "utf8").trim().split("\n");
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
const rate = (l) => l.reduce((s, r) => s + r.hit, 0) / l.length;
console.log(`학습 ${train.length}행 (~${new Date(train[0].ts).toISOString().slice(0,10)}~${new Date(cut).toISOString().slice(0,10)}) 기준선 ${(rate(train)*100).toFixed(2)}%`);
console.log(`검증 ${test.length}행 (${new Date(cut).toISOString().slice(0,10)}~) 기준선 ${(rate(test)*100).toFixed(2)}%\n`);

// ---- features (all computable live in the scanner) ----
const lg = (x, eps) => Math.log((x == null ? 0 : Math.abs(x)) + eps);
const FEATS = [
  ["fundAbs",  (r) => lg(r.crowdAbs, 1e-6)],
  ["momUp",    (r) => Math.log(Math.max(r.mom14 ?? 0, 0) + 1)],
  ["momDn",    (r) => Math.log(Math.max(-(r.mom14 ?? 0), 0) + 1)],
  ["vol",      (r) => Math.log((r.volExpand ?? 1) + 0.1)],
  ["age",      (r) => Math.log((r.ageDays ?? 400) + 1)],
  ["chgUp",    (r) => Math.log(Math.max(r.chg24 ?? 0, 0) + 1)],
  ["chgDn",    (r) => Math.log(Math.max(-(r.chg24 ?? 0), 0) + 1)],
  ["qv",       (r) => Math.log((r.qv ?? 1e6) + 1)],
];
const X = (l) => l.map((r) => FEATS.map(([, f]) => f(r)));
const mean = [], sd = [];
{
  const m = X(train);
  for (let j = 0; j < FEATS.length; j++) {
    const col = m.map((v) => v[j]);
    const mu = col.reduce((a, b) => a + b, 0) / col.length;
    const s = Math.sqrt(col.reduce((a, b) => a + (b - mu) ** 2, 0) / col.length) || 1;
    mean.push(mu); sd.push(s);
  }
}
const z = (l) => X(l).map((v) => v.map((x, j) => (x - mean[j]) / sd[j]));

// ---- logistic regression, plain gradient descent + L2 ----
function fit(Z, y, { iters = 4000, lr = 0.3, l2 = 1e-3 } = {}) {
  const d = Z[0].length; const w = new Array(d).fill(0); let b = 0;
  const n = Z.length;
  for (let it = 0; it < iters; it++) {
    const gw = new Array(d).fill(0); let gb = 0;
    for (let i = 0; i < n; i++) {
      let s = b; for (let j = 0; j < d; j++) s += w[j] * Z[i][j];
      const p = 1 / (1 + Math.exp(-s));
      const e = p - y[i];
      for (let j = 0; j < d; j++) gw[j] += e * Z[i][j];
      gb += e;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / n + l2 * w[j]);
    b -= lr * (gb / n);
  }
  return { w, b };
}
const Ztr = z(train), ytr = train.map((r) => r.hit);
const { w, b } = fit(Ztr, ytr);
console.log("=== 로지스틱 계수 (표준화, 절대값 = 중요도) ===");
FEATS.map(([n], j) => [n, w[j]]).sort((a, c) => Math.abs(c[1]) - Math.abs(a[1]))
  .forEach(([n, v]) => console.log(`  ${n.padEnd(9)} ${v >= 0 ? "+" : ""}${v.toFixed(3)}`));

// ---- ADDITIVE candidate: ramps + weights proportional to |coef| ----
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const ramp = (v, lo, hi) => (v == null ? 0 : clamp01((v - lo) / (hi - lo)));
// thresholds read off the bucket table, weights read off the fitted coefficients
const W = { mom: 34, chg: 26, vol: 16, age: 14, fund: 10 };
function additive(r) {
  const mom = ramp(Math.abs(r.mom14 ?? 0), 15, 60);
  const chg = ramp(Math.abs(r.chg24 ?? 0), 5, 20);
  const vol = ramp(r.volExpand ?? 1, 1.2, 5);
  const age = 1 - clamp01(((r.ageDays ?? 400) - 200) / 600);
  const fnd = ramp(r.crowdAbs ?? 0, 0.00006, 0.0004);
  let s = W.mom * mom + W.chg * chg + W.vol * vol + W.age * age + W.fund * fnd;
  // 펀딩 중립은 거의 안 간다(리프트 0.27x) — 가점이 아니라 배제로 쓴다.
  if (r.crowdAbs != null && r.crowdAbs < 0.00006) s -= 25;
  if ((r.qv ?? 0) < 5e6) s -= 10;
  return Math.max(0, Math.min(100, Math.round(s)));
}
const logit = (r, i, Zt) => { let s = b; for (let j = 0; j < w.length; j++) s += w[j] * Zt[i][j]; return s; };

const Zte = z(test);
const scored = test.map((r, i) => ({ hit: r.hit, ts: r.ts, cur: r.score, add: additive(r), lgt: logit(r, i, Zte) }));
const baseT = rate(test);

function topN(key, N) {
  const byDay = new Map();
  for (const r of scored) { const d = new Date(r.ts).toISOString().slice(0, 10); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(r); }
  let hit = 0, tot = 0;
  for (const list of byDay.values()) for (const r of [...list].sort((a, c) => c[key] - a[key]).slice(0, N)) { tot++; hit += r.hit; }
  return { rate: hit / tot, lift: hit / tot / baseT, n: tot };
}
console.log(`\n=== 검증셋 상위 N/일 정밀도 (기준선 ${(baseT*100).toFixed(2)}%) ===`);
console.log("N     현재점수            새 가산점수          로지스틱");
for (const N of [1, 3, 5, 10, 20]) {
  const a = topN("cur", N), c = topN("add", N), l = topN("lgt", N);
  console.log(`${String(N).padStart(2)}   ${(a.rate*100).toFixed(1).padStart(5)}% (${a.lift.toFixed(2)}x)   ` +
              `${(c.rate*100).toFixed(1).padStart(5)}% (${c.lift.toFixed(2)}x)   ` +
              `${(l.rate*100).toFixed(1).padStart(5)}% (${l.lift.toFixed(2)}x)`);
}

console.log("\n=== 검증셋 점수 구간별 (새 가산점수) ===");
for (const [lo, hi] of [[0,25],[25,40],[40,55],[55,70],[70,101]]) {
  const l = scored.filter((r) => r.add >= lo && r.add < hi);
  if (l.length < 30) continue;
  const h = l.reduce((s, r) => s + r.hit, 0) / l.length;
  console.log(`  ${lo}-${hi-1}`.padEnd(10) + `n=${String(l.length).padStart(6)}  적중=${(h*100).toFixed(2).padStart(5)}%  리프트=${(h/baseT).toFixed(2)}x`);
}
console.log("\n=== 검증셋 점수 구간별 (현재 점수) ===");
for (const [lo, hi] of [[0,25],[25,40],[40,55],[55,70],[70,101]]) {
  const l = scored.filter((r) => r.cur >= lo && r.cur < hi);
  if (l.length < 30) continue;
  const h = l.reduce((s, r) => s + r.hit, 0) / l.length;
  console.log(`  ${lo}-${hi-1}`.padEnd(10) + `n=${String(l.length).padStart(6)}  적중=${(h*100).toFixed(2).padStart(5)}%  리프트=${(h/baseT).toFixed(2)}x`);
}
