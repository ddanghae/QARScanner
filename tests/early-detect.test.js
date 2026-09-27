// tests/early-detect.test.js — 조기 포착 모드 계산 검증.

import { suite, test, assert, eq } from "./harness.js";
import { CONFIG } from "../js/config.js";
import {
  boxRange, squeezePercentile, volDryRatio, analyzeOi,
  classifyEarlyStage, earlyExclusion, scoreEarly, earlyPlan,
  buildEarlyMetrics, buildEarlyResult,
} from "../js/core/early-detect.js";
import { ema } from "../js/core/indicators.js";
import { gradeFor } from "../js/core/scoring.js";
import { candlesFromCloses } from "./fixtures.js";
import { planMoney, fmtWon } from "../js/ui/format.js";
import { stage2Liquidity, excludeMajors, stage3EvaluateEarly } from "../js/scanner/prefilter.js";

// 움직임 요인 1개(momentum)만 걸린 기본 지표 = 1단계. 개별 테스트에서 필요한 값만 덮어쓴다.
// change24h 는 문턱(5%) 미만으로 둬서 단계 상승을 테스트가 명시적으로 켜도록 한다.
function baseMetrics(over = {}) {
  return {
    boxWidthPct: 20, rangePos: 0.5, boxHigh: 120, boxLow: 100,
    squeezePct: 20, volExpand: 0.7, relVol3: 0.9,
    oi: { change72h: 10, change12h: 3, prev12h: 2 },
    funding: 0.0001, crowdAbs: 0.0001, mom14: 25, mom14Abs: 25, ageDays: 400,
    change24h: 2, quoteVolume: 50_000_000,
    closeAboveEma200: true, ema200SlopeOk: true,
    breakoutClose: false, atrRising: false, runFromBreakoutPct: 0,
    ...over,
  };
}

export function run() {
  suite("early");

  test("early 가중치 합 = 100", () => {
    const sum = Object.values(CONFIG.earlyScoreWeights).reduce((a, b) => a + b, 0);
    eq(sum, 100, "early 점수 가중치 총합 100");
  });

  test("early 감점은 모두 음수", () => {
    for (const [k, v] of Object.entries(CONFIG.earlyPenalties)) {
      assert(v < 0, `${k} 는 음수여야 함 (실제 ${v})`);
    }
  });

  test("early 임계값 존재", () => {
    const e = CONFIG.earlyDetect;
    for (const k of ["boxLookback", "squeezeLookback", "momentumBars", "deadZonePct",
      "momentumFullPct", "chg24MinPct", "chg24FullPct",
      "freshFullDays", "freshZeroDays", "minQuoteVolume",
      "breakoutRelVol", "breakoutMaxRunPct", "pumpedMaxPct", "prefilterDeadZonePct"]) {
      assert(e[k] !== undefined, `earlyDetect.${k} 필요`);
    }
    // 램프 문턱은 반드시 lo < hi 여야 한다(뒤집히면 clamp 가 조용히 전부 0/만점을 준다).
    assert(e.deadZonePct < e.momentumFullPct, "deadZonePct < momentumFullPct");
    assert(e.chg24MinPct < e.chg24FullPct, "chg24MinPct < chg24FullPct");
    assert(e.freshFullDays < e.freshZeroDays, "freshFullDays < freshZeroDays");
  });

  // config 경계값 회귀 방지 — 아래 둘은 계산식이 아니라 "표본이 1개 모자라" 죽었던 버그다.
  test("oiLimit 표본으로 change72h 가 실제로 나온다", () => {
    const series = Array.from({ length: CONFIG.earlyDetect.oiLimit }, (_, i) => ({ time: i, oi: 100 + i }));
    const r = analyzeOi(series);
    assert(r.change72h != null, `oiLimit=${CONFIG.earlyDetect.oiLimit} 로는 72시간 변화율이 안 나옴`);
  });

  test("klinesLimit 4h 로 EMA200 기울기(20봉 전 비교)가 계산된다", () => {
    const n = CONFIG.klinesLimit["4h"] - 1; // 마감 캔들만
    const e200 = ema(Array.from({ length: n }, (_, i) => 100 + Math.sin(i / 7)), 200);
    const idx = e200.length - 1;
    assert(e200[idx] != null && e200[idx - 20] != null,
      `4h ${CONFIG.klinesLimit["4h"]}봉으로는 EMA200 기울기가 항상 null`);
  });

  // 채점에서 뺀 항목이 되살아나면 여기서 잡힌다(재적합에서 다변량 기여가 0 이었다).
  test("거래량 확장·펀딩·OI 는 더 이상 채점 항목이 아니다", () => {
    const keys = scoreEarly(baseMetrics(), CONFIG).breakdown.map((b) => b.key);
    eq(keys.join(), "momentum,change24h,freshness", "채점은 3항목뿐");
    const a = scoreEarly(baseMetrics({ volExpand: 0.3, crowdAbs: 0, funding: 0, oi: { change72h: null, change12h: null, prev12h: null } }), CONFIG).score;
    const b = scoreEarly(baseMetrics({ volExpand: 5, crowdAbs: 0.01, funding: 0.01, oi: { change72h: 100, change12h: 20, prev12h: 1 } }), CONFIG).score;
    eq(a, b, "셋을 바꿔도 점수는 같아야 함");
  });

  test("24시간 변동 점수는 방향 무관 — 급등과 급락이 같은 점수", () => {
    const e = CONFIG.earlyDetect;
    const w = CONFIG.earlyScoreWeights.change24h;
    const got = (change24h) => scoreEarly(baseMetrics({ change24h }), CONFIG)
      .breakdown.find((b) => b.key === "change24h").got;
    eq(got(e.chg24FullPct), got(-e.chg24FullPct), "부호가 반대여도 동일");
    eq(got(e.chg24FullPct), w, "큰 변동 만점");
    eq(got(e.chg24MinPct), 0, "문턱 경계면 0점");
    eq(got(0), 0, "안 움직이면 0점");
  });

  test("신규 상장 점수는 오래될수록 내려간다", () => {
    const e = CONFIG.earlyDetect;
    const w = CONFIG.earlyScoreWeights.freshness;
    const got = (ageDays) => scoreEarly(baseMetrics({ ageDays }), CONFIG)
      .breakdown.find((b) => b.key === "freshness").got;
    eq(got(e.freshFullDays), w, "신규면 만점");
    eq(got(e.freshZeroDays), 0, "오래됐으면 0점");
    eq(got(e.freshZeroDays * 2), 0, "더 오래돼도 음수로 안 감");
    assert(got(0) === w, "상장 직후도 만점 (램프 위로 clamp)");
  });

  test("early 등급은 전용 밴드를 쓴다 (reversal 밴드면 정상 후보가 '제외')", () => {
    const eg = CONFIG.earlyGrades;
    eq(eg.length, CONFIG.grades.length, "밴드 개수 동일");
    eq(eg.map((g) => g.key).join(), CONFIG.grades.map((g) => g.key).join(), "key 는 CSS 와 물려 있어 동일해야 함");
    // 2026-07-26 라이브 실측(재적합 후): 노출 후보가 96·78·57점대였다.
    for (const score of [96, 78, 57]) {
      const g = gradeFor(score, { grades: eg });
      assert(g.key !== "excluded" && g.key !== "weak", `${score}점이 "${g.label}" 로 표시됨`);
    }
    // 표시 하한은 밴드 경계와 일치해야 한다(경계 중간에 걸치면 등급이 잘려 보인다).
    // "확실한 소수" 방향이라 관찰 후보(observe) 이상만 노출한다.
    const observeMin = eg.find((g) => g.key === "observe").min;
    assert(eg.some((g) => g.min === CONFIG.earlyMinScore), "표시 하한이 밴드 경계와 안 맞음");
    assert(CONFIG.earlyMinScore >= observeMin, `표시 하한(${CONFIG.earlyMinScore})은 관찰 후보(${observeMin}) 이상이어야 함`);
  });

  // 화면이 손익비 대신 이 확률을 보여준다. 밴드를 손대면서 확률을 안 옮기면 거짓말이 표시된다.
  test("등급마다 실측 적중률이 붙어 있고 점수와 같은 방향이다", () => {
    const eg = CONFIG.earlyGrades;
    for (const g of eg) assert(typeof g.hitRate === "number" && g.hitRate > 0, `${g.label} 에 hitRate 없음`);
    const byMin = [...eg].sort((a, b) => a.min - b.min);
    for (let i = 1; i < byMin.length; i++) {
      assert(byMin[i].hitRate > byMin[i - 1].hitRate,
        `점수가 높은데 확률이 안 높다: ${byMin[i - 1].label} ${byMin[i - 1].hitRate}% → ${byMin[i].label} ${byMin[i].hitRate}%`);
    }
    assert(CONFIG.earlyHitBaseline > 0, "기준선 없으면 확률 크기를 못 읽는다");
    const shown = eg.filter((g) => g.min >= CONFIG.earlyMinScore);
    assert(shown.every((g) => g.hitRate > CONFIG.earlyHitBaseline),
      "노출되는 등급은 전부 무작위 기준선보다 높아야 한다");
  });

  // 핵심 소계 하한을 없앤 근거 — 움직임 없이 신규 상장만으로는 표시 하한을 못 넘는다.
  test("신규 상장 단독으로는 표시 하한을 못 넘는다", () => {
    const freshOnly = scoreEarly(baseMetrics({
      mom14: 0, mom14Abs: 0, change24h: 0, ageDays: 0,
    }), CONFIG).score;
    eq(freshOnly, CONFIG.earlyScoreWeights.freshness, "freshness 만점만 남음");
    assert(freshOnly < CONFIG.earlyMinScore,
      `freshness 만점(${freshOnly})이 표시 하한(${CONFIG.earlyMinScore})을 넘으면 소계 하한이 다시 필요하다`);
  });

  test("박스 범위·폭·위치 계산", () => {
    // 10~20 사이를 오간 뒤 마지막이 19 → 상단 근처
    const closes = [10, 20, 12, 18, 11, 19];
    const c = candlesFromCloses(closes, { spread: 0 });
    const box = boxRange(c, 6);
    eq(box.boxHigh, 20, "박스 상단");
    eq(box.boxLow, 10, "박스 하단");
    // (20-10) / 15 * 100 = 66.67
    assert(Math.abs(box.boxWidthPct - 66.666) < 0.01, `박스 폭 % (실제 ${box.boxWidthPct})`);
    // (19-10)/(20-10) = 0.9
    assert(Math.abs(box.rangePos - 0.9) < 1e-9, `박스 내 위치 (실제 ${box.rangePos})`);
  });

  test("박스 — 캔들 부족하면 null", () => {
    const c = candlesFromCloses([1, 2, 3], { spread: 0 });
    eq(boxRange(c, 60), null, "lookback 미만이면 null");
  });

  test("압축 백분위 — 현재가 가장 좁으면 0", () => {
    const widths = [5, 4, 3, 2, 1]; // 마지막이 최소
    eq(squeezePercentile(widths, 5), 0, "가장 좁으면 0");
  });

  test("압축 백분위 — 현재가 가장 넓으면 높음", () => {
    const widths = [1, 2, 3, 4, 5]; // 마지막이 최대
    eq(squeezePercentile(widths, 5), 80, "5개 중 4개가 더 작음 → 80");
  });

  test("거래량 고갈 비율", () => {
    // 이전 4봉 볼륨 100, 최근 2봉 볼륨 50 → 0.5
    const c = candlesFromCloses([1, 1, 1, 1, 1, 1], { spread: 0, vol: (i) => (i < 4 ? 100 : 50) });
    const r = volDryRatio(c, 2, 4);
    assert(Math.abs(r - 0.5) < 1e-9, `고갈 비율 0.5 (실제 ${r})`);
  });

  test("OI 변화율 — 증가", () => {
    // 73개: 0번 100, 이후 선형 증가해서 마지막 200 → 72h 변화 +100%
    const series = Array.from({ length: 73 }, (_, i) => ({ time: i, oi: 100 + (100 * i) / 72 }));
    const r = analyzeOi(series);
    assert(Math.abs(r.change72h - 100) < 1e-6, `72h +100% (실제 ${r.change72h})`);
    assert(r.change12h > 0, "12h 증가");
  });

  test("OI 변화율 — 가속 판정", () => {
    // 앞 구간은 완만, 최근 12h 가 급증
    const series = [];
    for (let i = 0; i <= 60; i++) series.push({ time: i, oi: 100 });
    for (let i = 61; i <= 72; i++) series.push({ time: i, oi: 100 + (i - 60) * 5 });
    const r = analyzeOi(series);
    assert(r.change12h > r.prev12h, `최근 12h 가 이전 12h 보다 큼 (${r.change12h} > ${r.prev12h})`);
  });

  test("OI 데이터 부족 → null", () => {
    const r = analyzeOi([{ time: 1, oi: 100 }]);
    eq(r.change72h, null, "72h 계산 불가");
    eq(r.change12h, null, "12h 계산 불가");
  });

  test("OI 빈 배열 → 전부 null", () => {
    const r = analyzeOi([]);
    eq(r.change72h, null);
    eq(r.prev12h, null);
  });

  test("1단계 관찰 — 검증 항목 1개만 성립", () => {
    const s = classifyEarlyStage(baseMetrics(), CONFIG);
    eq(s.stage, 1, "관찰 단계");
    eq(s.key, "accumulation");
  });

  test("2단계 임박 — 14일 추세 + 24시간 변동 동시 성립", () => {
    const s = classifyEarlyStage(baseMetrics({ mom14Abs: 30, change24h: 12 }), CONFIG);
    eq(s.stage, 2, "임박 단계");
    eq(s.key, "imminent");
  });

  test("2단계 임박 — 하락 쪽 움직임도 동일하게 잡힌다(U자)", () => {
    const up = classifyEarlyStage(baseMetrics({ mom14: 30, mom14Abs: 30, change24h: 12 }), CONFIG);
    const down = classifyEarlyStage(baseMetrics({ mom14: -30, mom14Abs: 30, change24h: -12 }), CONFIG);
    eq(up.stage, down.stage, "부호가 반대여도 같은 단계");
  });

  test("3단계 돌파 — 상단 종가돌파 + 거래량 급증 + ATR 상승 + 초입", () => {
    const s = classifyEarlyStage(baseMetrics({
      breakoutClose: true, relVol3: 2.5, atrRising: true, runFromBreakoutPct: 5,
    }), CONFIG);
    eq(s.stage, 3, "돌파 단계");
    eq(s.key, "breakout");
  });

  test("돌파했지만 이미 많이 오름 → 단계 없음", () => {
    const s = classifyEarlyStage(baseMetrics({
      breakoutClose: true, relVol3: 2.5, atrRising: true, runFromBreakoutPct: 30,
    }), CONFIG);
    eq(s, null, "초입 아니면 제외");
  });

  test("죽은 구간(움직임 0개) 이면 단계 없음", () => {
    eq(classifyEarlyStage(baseMetrics({
      mom14: 3, mom14Abs: 3, change24h: 1,
    }), CONFIG), null, "14일 ±15% 안 + 24시간 ±5% 안 = 후보 아님");
  });

  test("박스가 넓어도 단계는 유지 — 박스 폭은 더 이상 게이트가 아니다", () => {
    const s = classifyEarlyStage(baseMetrics({ boxWidthPct: 90 }), CONFIG);
    assert(s != null && s.stage === 1, "넓은 박스는 momentum 후보를 죽이면 안 됨");
  });

  test("OI 없어도(null) 1단계 통과 — 후보 유지", () => {
    const s = classifyEarlyStage(baseMetrics({
      oi: { change72h: null, change12h: null, prev12h: null },
    }), CONFIG);
    eq(s.stage, 1, "OI 는 단계 판정에 안 쓴다");
  });

  test("제외 — 이미 급등", () => {
    assert(earlyExclusion(baseMetrics({ change24h: 60 }), CONFIG) !== null, "24h +60% 제외");
  });

  // 아래 둘은 예전에 "제외" 였다. 실측에서 방향이 반대이거나(펀딩 쏠림 = 1순위 신호)
  // 표본이 없어(OI 감소 n=5) 근거가 없었다. 되살아나면 여기서 잡힌다.
  test("펀딩 쏠림은 제외 사유가 아니다", () => {
    eq(earlyExclusion(baseMetrics({ funding: 0.005, crowdAbs: 0.005 }), CONFIG), null,
      "펀딩 0.5% 를 제외하면 안 됨");
  });

  test("OI 급감은 제외 사유가 아니다", () => {
    eq(earlyExclusion(baseMetrics({
      oi: { change72h: -20, change12h: -5, prev12h: -3 },
    }), CONFIG), null, "OI -20% 를 제외하면 안 됨");
  });

  test("제외 — OI·펀딩 null 이면 해당 조건 건너뜀", () => {
    eq(earlyExclusion(baseMetrics({
      oi: { change72h: null, change12h: null, prev12h: null }, funding: null, crowdAbs: null,
    }), CONFIG), null, "null 이면 제외하지 않음");
  });

  test("채점 — 조건 좋을수록 점수 높음(단조성)", () => {
    const weak = scoreEarly(baseMetrics({ mom14Abs: 5, change24h: 1, ageDays: 1500 }), CONFIG).score;
    const strong = scoreEarly(baseMetrics({ mom14Abs: 60, change24h: 20, ageDays: 100 }), CONFIG).score;
    assert(strong > weak, `강한 조건이 더 높아야 (${strong} > ${weak})`);
  });

  test("채점 — 최고 조건은 만점", () => {
    const r = scoreEarly(baseMetrics({
      mom14: 60, mom14Abs: 60, change24h: 20, ageDays: 0,
    }), CONFIG);
    eq(r.score, 100, "모든 항목 만점");
    eq(r.penalties.length, 0, "만점 조건에 감점이 붙으면 안 됨");
  });

  test("채점 — 죽은 구간은 감점이 아니라 0점", () => {
    const r = scoreEarly(baseMetrics({ mom14: 3, mom14Abs: 3 }), CONFIG);
    eq(r.breakdown.find((b) => b.key === "momentum").got, 0, "램프 하단 아래 = 0점");
    eq(r.penalties.length, 0, "이중 처벌하지 않는다");
  });

  test("채점 — 상장일 미상이면 400일로 본다", () => {
    const unknown = scoreEarly(baseMetrics({ ageDays: null }), CONFIG).score;
    eq(unknown, scoreEarly(baseMetrics({ ageDays: 400 }), CONFIG).score, "결측 대체값 400일");
  });

  test("채점 — 감점 반영", () => {
    const base = scoreEarly(baseMetrics(), CONFIG).score;
    const penalized = scoreEarly(baseMetrics({ quoteVolume: 1_000_000 }), CONFIG).score;
    assert(penalized < base, `감점 후 하락 (${penalized} < ${base})`);
  });

  // 24h 상승은 더 이상 감점이 아니다 — 실측에서 모멘텀은 급등에 선행했다(리프트 2.4~5.5x).
  test("이미 오른 종목을 감점하지 않는다", () => {
    const keys = scoreEarly(baseMetrics({ change24h: 30 }), CONFIG).penalties.map((p) => p.key);
    assert(!keys.includes("alreadyPumped"), "24h 상승 감점이 되살아남");
  });

  test("plan — 손절은 진입 아래, 손익비 유한", () => {
    const p = earlyPlan(baseMetrics({ boxHigh: 120, boxLow: 100 }), 2, 110, CONFIG);
    assert(p.stop < p.entry, "손절 < 진입");
    assert(isFinite(p.riskReward) && p.riskReward > 0, `손익비 유한 (${p.riskReward})`);
    assert(p.tp2 > p.tp1 && p.tp3 > p.tp2, "TP 순서");
  });

  test("plan — 박스 하단이 진입 위여도 손절은 진입 아래로 clamp", () => {
    // 비정상 입력(박스 하단 > 현재가)에서도 손절이 진입 위로 가지 않아야 한다
    const p = earlyPlan(baseMetrics({ boxHigh: 120, boxLow: 150 }), 2, 110, CONFIG);
    assert(p.stop < p.entry, `손절 clamp (stop ${p.stop} < entry ${p.entry})`);
    assert(isFinite(p.riskReward), "손익비 유한");
  });

  // 폭락 후 반등 후보에서 박스 폭이 수백 % 라 손익비 1:24 가 찍히던 버그.
  // 박스 폭이 수백 % 라 손익비 1:24 가 찍히던 버그. 이제 손절은 박스를 아예 안 본다 —
  // 2026-07-29 격자 탐색에서 박스 기준(둘 중 좁은 쪽)이 목표 도달 전에 먼저 맞아 손해였다.
  test("plan — 손절은 박스와 무관하게 정확히 ATR 배수다", () => {
    const wide = earlyPlan(baseMetrics({ boxHigh: 1000, boxLow: 1 }), 2, 110, CONFIG);
    const tight = earlyPlan(baseMetrics({ boxHigh: 120, boxLow: 109 }), 2, 110, CONFIG);
    const risk = 2 * CONFIG.earlyDetect.stopAtr;
    assert(Math.abs(wide.entry - wide.stop - risk) < 1e-9,
      `손절 폭 ${wide.entry - wide.stop} 는 ATR×${CONFIG.earlyDetect.stopAtr}=${risk} 여야 함`);
    eq(wide.stop, tight.stop, "박스 폭이 손절을 바꾸면 안 됨");
    eq(wide.riskReward, CONFIG.earlyDetect.targetR, "손익비는 목표 배수 그대로");
    // ATR 이 없을 때만 박스로 되돌아간다 — 그때도 진입 위로 가면 안 된다.
    const noAtr = earlyPlan(baseMetrics({ boxHigh: 120, boxLow: 100 }), 0, 110, CONFIG);
    assert(noAtr.stop < noAtr.entry && noAtr.valid, `ATR 없을 때 폴백 (stop ${noAtr.stop})`);
  });

  // 화면에 원 단위 금액이 뜨므로 산수가 틀리면 사용자가 바로 손해를 오해한다.
  // 부분 익절 전제라 결과가 셋이다 — 손절 / 절반만 먹고 본전 / 끝까지.
  test("손익 금액 — 시드에 비례하고 왕복 비용이 양쪽에서 빠진다", () => {
    // 리스크 10(=1R), 목표 4R, TP1 1R 에서 절반 익절
    const plan = { entry: 100, invalidation: 90, tp2: 140, valid: true, partialAtR: 1, partialFrac: 0.5 };
    const cost = CONFIG.tradeCostRoundTripPct;
    const fee = 1_000_000 * cost / 100;
    const m = planMoney(plan, 1_000_000, cost);
    eq(m.lossPct, 10, "손절 거리 10%");
    eq(m.gainPct, 40, "목표 거리 40%");
    eq(m.loss, -(100_000 + fee), "손절 금액 = 거리 + 비용");
    eq(m.partialPct, 5, "절반 × 1R = 5%");
    eq(m.partial, 50_000 - fee, "절반만 먹고 본전이면 0.5R");
    eq(m.fullPct, 25, "절반 1R + 절반 4R = 2.5R = 25%");
    eq(m.gain, 250_000 - fee, "끝까지 가면 2.5R");
    assert(m.gain > m.partial && m.partial > 0, "끝까지 > 절반 > 0");

    // "파는 방식" 을 끄면(비중 0) 부분 익절 이전 규칙 그대로여야 한다 — 두 방식을 나란히 비교하는 근거.
    const off = planMoney(plan, 1_000_000, cost, 1, CONFIG.maintenanceMarginPct, 0);
    eq(off.partialPct, 0, "절반 익절 없음");
    eq(off.fullPct, off.gainPct, "끝까지 = 목표 거리 그대로");
    eq(off.gain, 400_000 - fee, "목표까지 통째로 버티면 4R");
    eq(off.loss, m.loss, "손절 금액은 방식과 무관");
    // 시드를 바꾸면 금액도 같은 배수로 바뀐다 — 컨트롤이 실제로 먹히는지 고정.
    const dbl = planMoney(plan, 2_000_000, cost);
    assert(Math.abs(dbl.gain - m.gain * 2) < 1e-9 && Math.abs(dbl.loss - m.loss * 2) < 1e-9,
      `시드 2배면 금액도 2배 (${m.gain} → ${dbl.gain})`);
    eq(planMoney(plan, 0, cost), null, "시드 0 이면 표시할 게 없다");
    eq(planMoney({ ...plan, valid: false }, 1e6, cost), null, "계획이 무효면 금액도 없다");
    eq(fmtWon(-102_000), "-10.2만원");
    eq(fmtWon(398_000), "39.8만원");
  });

  // 레버리지를 배수로만 곱하면 도달 불가능한 손실 금액을 보여주게 된다 — 청산이 먼저 온다.
  test("레버리지 — 손익은 배수로 커지고, 청산이 손절보다 앞서면 알린다", () => {
    const cost = CONFIG.tradeCostRoundTripPct;
    const mmr = CONFIG.maintenanceMarginPct;
    const plan = { entry: 100, invalidation: 90, tp2: 140, valid: true };  // 손절 -10%
    const x1 = planMoney(plan, 1_000_000, cost, 1, mmr);
    const x3 = planMoney(plan, 1_000_000, cost, 3, mmr);
    assert(Math.abs(x3.gain - x1.gain * 3) < 1e-9, `3배면 이익도 3배 (${x1.gain} → ${x3.gain})`);
    assert(Math.abs(x3.loss - x1.loss * 3) < 1e-9, `3배면 손실도 3배 (${x1.loss} → ${x3.loss})`);
    eq(x1.liquidated, false, "1배는 청산 없음");
    eq(x1.liqPrice, null, "1배는 청산가도 없음");
    eq(x3.liquidated, false, `손절 10% < 3배 청산선 ${x3.liqDropPct}%`);

    // 손절이 깊은 실제 후보(ATR×4 는 -38% 대가 흔하다) + 3배 = 청산이 먼저.
    const deep = { entry: 100, invalidation: 62, tp2: 252, valid: true };  // 손절 -38%
    const bad = planMoney(deep, 1_000_000, cost, 3, mmr);
    assert(bad.liquidated, `손절 -38% 는 3배 청산선 -${bad.liqDropPct.toFixed(1)}% 보다 깊다`);
    assert(bad.maxSafeLeverage < 3 && bad.maxSafeLeverage >= 1, `안전 상한 제시 (${bad.maxSafeLeverage}배)`);
    eq(planMoney(deep, 1_000_000, cost, bad.maxSafeLeverage, mmr).liquidated, false,
      "제시한 상한에서는 청산이 손절보다 뒤여야 한다");
    // 격리 마진 — 증거금보다 더 잃을 수 없다. 배수를 그대로 곱하면 -114만원이 나온다.
    eq(bad.loss, -1_000_000, `청산 손실은 증거금 전액에서 잘린다 (실제 ${bad.loss})`);
    assert(bad.gain > 0, "위쪽 목표는 청산과 무관하므로 이익은 그대로 나온다");
    // 청산 안 나는 구간은 자르지 않는다.
    assert(x3.loss < 0 && x3.loss > -1_000_000, `2배 미만 손실은 그대로 (${x3.loss})`);
  });

  test("지표 조립 — 캔들 부족하면 null", () => {
    const c = candlesFromCloses([1, 2, 3], { spread: 0 });
    eq(buildEarlyMetrics(c, [], null, { change24h: 0, quoteVolume: 1e7 }, CONFIG), null);
  });

  test("지표 조립 — 14일 추세·거래량 비율·상장일수가 나온다", () => {
    // 200봉 상승 + 최근 거래량 증가. 14일(84봉) 상승률이 실제로 계산돼야 한다.
    const closes = Array.from({ length: 200 }, (_, i) => 100 * Math.pow(1.004, i));
    const c = candlesFromCloses(closes, { spread: 0.05, vol: (i) => (i < 180 ? 50 : 200) });
    const onboardDate = Date.now() - 250 * 86_400_000;
    const m = buildEarlyMetrics(c, [], 0.0004, { change24h: 2, quoteVolume: 5e7, onboardDate }, CONFIG);
    assert(m !== null, "지표 생성됨");
    // 1.004^84 ≈ 1.396 → +39.6%
    assert(m.mom14 > 35 && m.mom14 < 45, `14일 수익률 (${m.mom14})`);
    eq(m.mom14Abs, Math.abs(m.mom14), "절대값 동반 계산");
    assert(m.volExpand > 1, `거래량 확장 (${m.volExpand})`);
    eq(m.crowdAbs, 0.0004, "펀딩 절대값");
    assert(m.ageDays > 240 && m.ageDays < 260, `상장 경과일 (${m.ageDays})`);
  });

  test("지표 조립 — 14일치가 없으면 mom14 는 null (신규 상장을 죽이지 않는다)", () => {
    const closes = Array.from({ length: 205 }, () => 100);
    const c = candlesFromCloses(closes, { spread: 0.05 });
    const short = c.slice(-(CONFIG.earlyDetect.momentumBars - 10));
    // 박스 계산은 되지만 14일 lookback 은 모자란 길이
    const m = buildEarlyMetrics(short, [], null, { change24h: 0, quoteVolume: 5e7 }, CONFIG);
    if (m) eq(m.mom14, null, "데이터 부족이면 null (0 으로 채우면 죽은 구간 감점을 맞는다)");
  });

  // 14일 +39.6% 상승 + 최근 거래량 확장 → 검증 항목 2개 성립(2단계). 결과가 실제로
  // 나오는 픽스처여야 게이트 회귀를 잡는다.
  function earlyFixture() {
    const closes = Array.from({ length: 200 }, (_, i) => 100 * Math.pow(1.004, i));
    return {
      candles: candlesFromCloses(closes, { spread: 0.05, vol: (i) => (i < 180 ? 50 : 200) }),
      item: { symbol: "TESTUSDT", baseAsset: "TEST", quoteVolume: 5e7, change24h: 2,
        newListing: false, onboardDate: Date.now() - 250 * 86_400_000 },
    };
  }

  test("결과 조립 — 기존 결과 shape 을 채운다", () => {
    const { candles, item } = earlyFixture();
    const r = buildEarlyResult(item, candles, [], null, CONFIG);
    assert(r != null, "1단계 조건을 만족하는 픽스처인데 null");
    for (const k of ["symbol", "price", "score", "grade", "stage", "breakdown", "penalties", "topSignals", "plan", "direction"]) {
      assert(r[k] !== undefined, `결과에 ${k} 필요`);
    }
    eq(r.direction, "long", "early 는 롱 전용");
    assert(r.stage.stage >= 1 && r.stage.stage <= 3, "단계는 1~3");
  });

  test("펀딩·OI 조회 실패해도 후보는 살아있다 — 엔드포인트 하나로 0건이 되면 안 된다", () => {
    const { candles, item } = earlyFixture();
    const r = buildEarlyResult(item, candles, [], null, CONFIG);
    assert(r != null, "펀딩 없다는 이유로 탈락시키면 안 됨");
    eq(r.early.funding, null, "픽스처 전제 — 펀딩은 없는 상태");
    assert(r.score >= CONFIG.earlyMinScore, `표시 하한 이상 (실제 ${r.score})`);
    const oiSeries = Array.from({ length: 73 }, (_, i) => ({ oi: 1000 + i * 2 }));
    eq(buildEarlyResult(item, candles, oiSeries, null, CONFIG).score, r.score,
      "OI 는 더 이상 점수를 바꾸지 않는다");
  });

  test("리페인트 — 박스는 최근 60봉만 사용(창 밖 데이터 영향 없음)", () => {
    const closes = Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 7) * 2);
    const full = candlesFromCloses(closes, { spread: 0.3 });
    const lookback = 60;

    // 1) 창 안 정확성: boxHigh/boxLow 가 마지막 60봉의 실제 최대/최소와 일치해야 한다
    const box = boxRange(full, lookback);
    const win = full.slice(full.length - lookback);
    const expectHigh = Math.max(...win.map((c) => c.high));
    const expectLow = Math.min(...win.map((c) => c.low));
    eq(box.boxHigh, expectHigh, "boxHigh == 최근 60봉 중 최대 high");
    eq(box.boxLow, expectLow, "boxLow == 최근 60봉 중 최소 low");

    // 2) 창 밖 무영향: 창 이전 캔들을 극단값으로 바꿔도 결과가 그대로여야 한다
    const tampered = full.map((c, i) =>
      i < full.length - lookback ? { ...c, high: 99999, low: -99999 } : c
    );
    const tamperedBox = boxRange(tampered, lookback);
    eq(JSON.stringify(tamperedBox), JSON.stringify(box), "창 밖 데이터를 극단값으로 바꿔도 결과 불변");
  });

  test("stage2 — pfOverride 로 유니버스 기준 교체", () => {
    const universe = [
      { symbol: "AUSDT", baseAsset: "A", onboardDate: 0 },
      { symbol: "BUSDT", baseAsset: "B", onboardDate: 0 },
    ];
    const mkTick = (symbol, qv) => ({
      symbol, quoteVolume: String(qv), count: "999999", lastPrice: "1",
      priceChangePercent: "1", highPrice: "1", lowPrice: "1", weightedAvgPrice: "1",
    });
    const tickers = [mkTick("AUSDT", 8_000_000), mkTick("BUSDT", 30_000_000)];
    // 기본(20M)이면 B 만 통과
    const def = stage2Liquidity(universe, tickers, Date.now());
    eq(def.prefiltered.length, 1, "기본 기준으로는 1개");
    // early(5M)면 둘 다 통과
    const early = stage2Liquidity(universe, tickers, Date.now(), {
      ...CONFIG.prefilter,
      minQuoteVolume: CONFIG.earlyDetect.minQuoteVolume,
      topByVolume: CONFIG.earlyDetect.topByVolume,
    });
    eq(early.prefiltered.length, 2, "early 기준으로는 2개");
  });

  test("대형코인 제외", () => {
    const list = [{ baseAsset: "BTC" }, { baseAsset: "PEPE" }, { baseAsset: "ETH" }];
    const out = excludeMajors(list, ["BTC", "ETH"]);
    eq(out.length, 1, "1개만 남음");
    eq(out[0].baseAsset, "PEPE");
  });

  // 1차 선별의 게이트가 뒤집혔다: 예전에는 좁은 횡보를 통과시키고 큰 움직임을 잘랐다.
  test("early 1차 선별 — 추세 없는 횡보는 탈락", () => {
    const closes = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 5) * (5 * (1 - i / 200)));
    const c = candlesFromCloses(closes, { spread: 0.05, vol: (i) => (i < 140 ? 100 : 50) });
    const r = stage3EvaluateEarly({ symbol: "XUSDT" }, c, CONFIG);
    eq(r.pass, false, "죽은 구간은 정밀 분석까지 안 간다");
  });

  test("early 1차 선별 — 14일 추세가 크면 통과 (상승·하락 양쪽)", () => {
    for (const [name, f] of [
      ["상승", (i) => 100 * Math.pow(1.004, i)],
      ["하락", (i) => 100 * Math.pow(0.996, i)],
    ]) {
      const c = candlesFromCloses(Array.from({ length: 200 }, (_, i) => f(i)), { spread: 0.05 });
      const r = stage3EvaluateEarly({ symbol: "YUSDT" }, c, CONFIG);
      eq(r.pass, true, `${name} 추세는 통과해야 함 (사유: ${r.reason}, mom14 ${r.mom14})`);
    }
  });

  test("early 1차 선별 — 캔들 부족하면 탈락", () => {
    const c = candlesFromCloses([1, 2, 3], { spread: 0 });
    eq(stage3EvaluateEarly({ symbol: "ZUSDT" }, c, CONFIG).pass, false);
  });
}
