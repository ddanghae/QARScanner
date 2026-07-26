// Prediction quality of the shipped score. No entry/exit anywhere.
// Q1: does a higher score mean a higher chance the coin pumps?
// Q2: does the gate (buildEarlyResult != null) select better than not gating?
// Q3: which single factor carries the signal, and is the current weighting right?
import { readFileSync } from "node:fs";

const raw = readFileSync(process.argv[2] || "predict.csv", "utf8").trim().split("\n");
const head = raw[0].split(",");
const rows = raw.slice(1).map((l) => {
  const p = l.split(","); const o = {};
  head.forEach((h, i) => { o[h] = p[i] === "" ? null : (isNaN(+p[i]) ? p[i] : +p[i]); });
  return o;
});
// label: a +40% 24h move happens within the next 7 days
const PUMP = 40;
for (const r of rows) r.hit = r.fwdMax24h != null && r.fwdMax24h >= PUMP;
const base = rows.filter((r) => r.hit).length / rows.length;
console.log(`rows=${rows.length}  기준선(7일 내 24h +${PUMP}% 발생)=${(base * 100).toFixed(2)}%\n`);

function bucket(label, list) {
  if (list.length < 30) { console.log(`${label.padEnd(24)} n=${String(list.length).padStart(6)}  (표본 부족)`); return; }
  const h = list.filter((r) => r.hit).length;
  const rate = h / list.length;
  const medPk = med(list.map((r) => r.fwdPeak7));
  const medTr = med(list.map((r) => r.fwdTrough7));
  console.log(
    `${label.padEnd(24)} n=${String(list.length).padStart(6)}  적중=${(rate * 100).toFixed(2).padStart(5)}%  ` +
    `리프트=${(rate / base).toFixed(2).padStart(5)}x  7일고점중앙=${medPk.toFixed(1).padStart(6)}%  7일저점중앙=${medTr.toFixed(1).padStart(6)}%`
  );
}
function med(a) { const x = a.filter((v) => v != null).sort((p, q) => p - q); return x.length ? x[x.length >> 1] : NaN; }

console.log("=== 점수 구간별 ===");
for (const [lo, hi] of [[0,10],[10,20],[20,25],[25,35],[35,45],[45,55],[55,65],[65,75],[75,101]])
  bucket(`점수 ${lo}-${hi - 1}`, rows.filter((r) => r.score >= lo && r.score < hi));

console.log("\n=== 게이트 ===");
bucket("게이트 통과", rows.filter((r) => r.gate === 1));
bucket("게이트 탈락", rows.filter((r) => r.gate === 0));
for (const s of [1, 2, 3]) bucket(`  ${s}단계`, rows.filter((r) => r.stage === s));

console.log("\n=== 표시 하한 적용 (점수>=25 & 게이트) ===");
bucket("실제 노출 후보", rows.filter((r) => r.gate === 1 && r.score >= 25));

console.log("\n=== 개별 요인 ===");
const f = (name, pred) => bucket(name, rows.filter(pred));
f("|펀딩| >0.0002", (r) => r.crowdAbs != null && r.crowdAbs > 0.0002);
f("|펀딩| >0.0006", (r) => r.crowdAbs != null && r.crowdAbs > 0.0006);
f("|펀딩| <0.00006", (r) => r.crowdAbs != null && r.crowdAbs < 0.00006);
f("14d > +25%", (r) => r.mom14 != null && r.mom14 > 25);
f("14d > +60%", (r) => r.mom14 != null && r.mom14 > 60);
f("14d < -25%", (r) => r.mom14 != null && r.mom14 < -25);
f("14d < -60%", (r) => r.mom14 != null && r.mom14 < -60);
f("14d 중립 ±15%", (r) => r.mom14 != null && Math.abs(r.mom14) < 15);
f("거래량비 >2.5", (r) => r.volExpand != null && r.volExpand > 2.5);
f("거래량비 >5", (r) => r.volExpand != null && r.volExpand > 5);
f("거래량비 <0.7", (r) => r.volExpand != null && r.volExpand < 0.7);
f("상장 <300일", (r) => r.ageDays != null && r.ageDays < 300);
f("상장 >800일", (r) => r.ageDays != null && r.ageDays > 800);
f("24h > +15%", (r) => r.chg24 != null && r.chg24 > 15);
f("24h < -15%", (r) => r.chg24 != null && r.chg24 < -15);
f("거래대금 <10M", (r) => r.qv != null && r.qv < 1e7);
f("거래대금 >100M", (r) => r.qv != null && r.qv > 1e8);

console.log("\n=== 상위 N 정밀도 (하루에 N개만 본다면) ===");
const byDay = new Map();
for (const r of rows) { const d = new Date(r.ts).toISOString().slice(0, 10); (byDay.get(d) || byDay.set(d, []).get(d)).push(r); }
for (const N of [1, 3, 5, 10, 20]) {
  let hit = 0, tot = 0;
  for (const list of byDay.values()) {
    const top = [...list].sort((a, b) => b.score - a.score).slice(0, N);
    for (const r of top) { tot++; if (r.hit) hit++; }
  }
  console.log(`  상위 ${String(N).padStart(2)}개/일   n=${String(tot).padStart(5)}  적중=${(hit / tot * 100).toFixed(2).padStart(5)}%  리프트=${(hit / tot / base).toFixed(2)}x`);
}
