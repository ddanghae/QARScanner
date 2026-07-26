// Guards the port: the shipped scoreEarly must reproduce variant D's validated numbers.
// variants.mjs picks the model from held-out data; this asserts js/ actually ships that model.
// Run after touching earlyScoreWeights / earlyDetect ramps:  node verify-port.mjs
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { CONFIG } from "../js/config.js";
import { scoreEarly } from "../js/core/early-detect.js";

const raw = readFileSync("predict.csv", "utf8").trim().split("\n");
const head = raw[0].split(",");
const rows = raw.slice(1).map((l) => {
  const p = l.split(","); const o = {};
  head.forEach((h, i) => { o[h] = p[i] === "" ? null : (isNaN(+p[i]) ? p[i] : +p[i]); });
  return o;
}).filter((r) => r.fwdMax24h != null);
for (const r of rows) r.hit = r.fwdMax24h >= 40 ? 1 : 0;
rows.sort((a, b) => a.ts - b.ts);
const test = rows.filter((r) => r.ts >= rows[Math.floor(rows.length * 0.7)].ts);

// scoreEarly reads only these four fields now — the rest of the metrics object is display data.
const live = (r) => scoreEarly({
  mom14Abs: r.mom14 == null ? null : Math.abs(r.mom14),
  change24h: r.chg24, ageDays: r.ageDays, quoteVolume: r.qv,
}, CONFIG).score;

const base = test.reduce((s, r) => s + r.hit, 0) / test.length;
function topN(N) {
  const byDay = new Map();
  for (const r of test) {
    const d = new Date(r.ts).toISOString().slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(r);
  }
  let hit = 0, tot = 0;
  for (const l of byDay.values())
    for (const r of [...l].sort((a, c) => live(c) - live(a)).slice(0, N)) { tot++; hit += r.hit; }
  return hit / tot / base;
}

// Expected values come from variants.mjs "D 펀딩배제도 제거" on the same split.
const EXPECT = { 1: 9.89, 3: 10.71, 5: 10.88, 10: 7.83, 20: 6.35 };
for (const [N, want] of Object.entries(EXPECT)) {
  const got = topN(+N);
  console.log(`상위 ${String(N).padStart(2)}/일  ${got.toFixed(2)}x  (기대 ${want}x)`);
  assert(Math.abs(got - want) < 0.05, `상위 ${N} 리프트 ${got.toFixed(2)}x != 변형 D ${want}x`);
}
console.log(`\nOK — 배포 채점이 변형 D 와 동일 (검증셋 기준선 ${(base * 100).toFixed(2)}%)`);
