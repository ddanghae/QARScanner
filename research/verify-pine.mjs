// Guards the Pine port: qar_scanner_sync_indicator.pine mode 2 must use the same numbers
// as js/config.js. Pine has no local compiler, so this checks the part that actually rots —
// someone retunes config.js and the chart quietly keeps scoring the old model.
// Formula shape still needs eyes; constants and grade bands do not.  node verify-pine.mjs
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { CONFIG } from "../js/config.js";

const src = readFileSync("../pine/qar_scanner_sync_indicator.pine", "utf8");
const num = (name) => {
  const m = src.match(new RegExp(`^${name}\\s*=\\s*(-?[\\d.]+)`, "m"));
  assert(m, `${name} 이 .pine 에 없음`);
  return +m[1];
};

const e = CONFIG.earlyDetect;
const w = CONFIG.earlyScoreWeights;
const PAIRS = [
  ["E_BOX_LOOKBACK", e.boxLookback], ["E_MOM_BARS", e.momentumBars],
  ["E_DEAD_ZONE", e.deadZonePct], ["E_MOM_FULL", e.momentumFullPct],
  ["E_CHG_MIN", e.chg24MinPct], ["E_CHG_FULL", e.chg24FullPct],
  ["E_FRESH_FULL", e.freshFullDays], ["E_FRESH_ZERO", e.freshZeroDays],
  ["E_MIN_QUOTE_VOL", e.minQuoteVolume], ["E_PUMPED_MAX", e.pumpedMaxPct],
  ["E_BREAK_REL_VOL", e.breakoutRelVol], ["E_BREAK_MAX_RUN", e.breakoutMaxRunPct],
  ["E_STOP_ATR", e.stopAtr], ["E_TARGET_R", e.targetR],
  ["E_MIN_SCORE", CONFIG.earlyMinScore],
  ["EW_MOM", w.momentum], ["EW_CHG", w.change24h], ["EW_FRESH", w.freshness],
  ["EP_THIN", CONFIG.earlyPenalties.thinLiquidity],
];
for (const [name, want] of PAIRS) {
  assert.equal(num(name), want, `${name}: .pine ${num(name)} != config ${want}`);
}
assert.equal(PAIRS.filter(([n]) => n.startsWith("EW_")).length, Object.keys(w).length,
  "채점 항목이 늘었는데 .pine 가중치는 그대로다");

// 등급 밴드 — f_earlyGrade 의 경계가 earlyGrades 의 min 과 같아야 한다.
// f_grade(reversal 전용)에도 같은 모양의 삼항식이 있으므로 함수 본문만 떼어내서 본다.
const gradeBody = src.match(/f_earlyGrade\(score\) =>\s*\n(.+)/)[1];
const bands = [...gradeBody.matchAll(/score >= (\d+) \? "([^"]+)"/g)].map((m) => [+m[1], m[2]]);
const want = CONFIG.earlyGrades.filter((g) => g.min > 0).map((g) => [g.min, g.label]);
assert.deepEqual(bands, want, `등급 밴드 불일치: .pine ${JSON.stringify(bands)}`);

// 제거한 항목이 되살아났는지 — 되살리려면 재적합부터 다시 할 것.
for (const dead of ["EW_SQ", "EW_OI", "EW_VOL", "EW_RANGE", "EW_TREND", "oiChg72"]) {
  assert(!src.includes(dead), `${dead} 가 .pine 에 되살아났다`);
}

console.log(`OK — .pine 모드 2 상수 ${PAIRS.length}개 + 등급 밴드 ${bands.length}개가 config 와 일치`);
