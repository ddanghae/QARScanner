// Live smoke test: run the real early pipeline modules against Binance.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.window = globalThis;

const B = "../js/";
const { CONFIG } = await import(B + "config.js");
const api = await import(B + "api/binance.js");
const { stage1Universe, stage2Liquidity, excludeMajors, stage3EvaluateEarly } = await import(B + "scanner/prefilter.js");
const { buildEarlyResult } = await import(B + "core/early-detect.js");

const e = CONFIG.earlyDetect;
const now = Date.now();
const universe = stage1Universe(await api.getExchangeInfo());
const { prefiltered } = stage2Liquidity(universe, await api.getTicker24h(), now, {
  ...CONFIG.prefilter, minQuoteVolume: e.minQuoteVolume, topByVolume: e.topByVolume,
});
const pool = excludeMajors(prefiltered, e.excludeMajors);
console.log(`universe=${universe.length} liquid=${prefiltered.length} pool=${pool.length}`);

// stage3 prefilter
const passed = [];
let dead = 0;
for (const item of pool) {
  const k4h = api.closedOnly(await api.getKlines(item.symbol, "4h"), false);
  const res = stage3EvaluateEarly(item, k4h, CONFIG);
  if (res.pass) passed.push({ item, k4h }); else dead++;
}
console.log(`stage3: pass=${passed.length} dropped(dead zone)=${dead}`);

// deep
const fundingMap = await api.getPremiumIndexAll();
const results = [];
for (const { item, k4h } of passed.slice(0, e.keepMax)) {
  const oi = await api.getOpenInterestHist(item.symbol);
  const r = buildEarlyResult(item, k4h, oi, fundingMap.get(item.symbol) ?? null, CONFIG);
  if (r) results.push(r);
}
results.sort((a, b) => b.score - a.score);
const shown = results.filter((r) => r.score >= CONFIG.earlyMinScore);
console.log(`deep: results=${results.length} shown(>=${CONFIG.earlyMinScore})=${shown.length}\n`);

console.log("sym          score grade      stage  fund%    mom14%  volExp  age   RR");
for (const r of shown.slice(0, 15)) {
  const q = r.early;
  console.log(
    r.symbol.padEnd(13) +
    String(r.score).padStart(4) + "  " +
    r.grade.label.padEnd(9) + " " +
    String(r.stage.stage) + "     " +
    (q.funding == null ? "  n/a" : (q.funding * 100).toFixed(3)).padStart(7) + " " +
    (q.mom14 == null ? "n/a" : q.mom14.toFixed(1)).padStart(8) + " " +
    (q.volExpand == null ? "n/a" : q.volExpand.toFixed(2)).padStart(7) + " " +
    (q.ageDays == null ? "n/a" : Math.round(q.ageDays)).toString().padStart(5) + "  " +
    r.plan.rrText
  );
}
