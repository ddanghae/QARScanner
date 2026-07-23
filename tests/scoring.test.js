// tests/scoring.test.js — 흡수/단계/점수 검증.

import { suite, test, assert, eq } from "./harness.js";
import { estimateAbsorption, classifyStage, scoreCandidate, gradeFor, topSignals } from "../js/core/scoring.js";
import { computeLongPlan, computeShortPlan } from "../js/core/risk-reward.js";
import { CONFIG, STRICTNESS_LEVELS, strictnessPreset } from "../js/config.js";

// 강한 롱 후보 signals
function strongSignals() {
  return {
    dropAndOversold: true, goodLiquidity: true, lowSweepValid: true, sweepRecovered: true,
    structureShift1h: true, fvgObOverlap: true, volumeDeltaShift: true, entryTrigger5m: true, riskRewardOk: true,
    lowSweep: true, volumeReacted: true, cvdImproved: true, deltaImproved: true,
    choch1h: true, choch15m: true, choch5m: true,
    firstHH: true, firstHL: true, fvgCreated: true, obCreated: true, firstPushDone: false,
    fvgReentry: true, obReentry: true, low5mDefended: true, volumeReSurge: true,
    change15mOverExtended: false, farFromLowAtr: false, shortTargetDistance: false,
    rsiOverheated: false, poorRiskReward: false,
    strongResistanceAbove: false, tooLowVolume: false, strongDowntrend4h: false, newListingThin: false,
    absorptionCandle: { sellRatio: 0.6, highVol: true, closePos: 0.7, lowerWickRatio: 0.4 },
    cvdDown: true, priceFlatOrUp: true,
  };
}

export function run() {
  suite("scoring");

  test("가중치 합 = 100", () => {
    const sum = Object.values(CONFIG.scoreWeights).reduce((a, b) => a + b, 0);
    eq(sum, 100, "점수 가중치 총합 100");
  });

  test("강한 흡수 추정", () => {
    const abs = estimateAbsorption(strongSignals());
    eq(abs.level, "strong", "강한 매도 흡수");
  });

  test("흡수 근거 부족 처리", () => {
    const abs = estimateAbsorption({ absorptionCandle: null });
    eq(abs.level, "insufficient", "캔들 없으면 근거 부족");
  });

  test("강한 후보 → 높은 점수 + 강한 후보 등급", () => {
    const sig = strongSignals();
    const abs = estimateAbsorption(sig);
    const stage = classifyStage(sig);
    const sc = scoreCandidate(sig, abs, stage, CONFIG);
    assert(sc.score >= 85, `강한 후보 점수 85+ (실제 ${sc.score})`);
    eq(sc.grade.key, "strong", "강한 후보 등급");
  });

  test("과열 → 5단계 추격 금지", () => {
    const sig = strongSignals();
    sig.rsiOverheated = true;
    const stage = classifyStage(sig);
    eq(stage.stage, 5, "과열이면 추격 금지");
  });

  test("유동성 회수만 → 2단계", () => {
    const sig = {
      lowSweep: true, sweepRecovered: true, volumeReacted: true, cvdImproved: true,
      choch1h: false, choch15m: false, firstHH: false, firstHL: false,
      fvgReentry: false, obReentry: false, choch5m: false, volumeReSurge: false,
      change15mOverExtended: false, farFromLowAtr: false, shortTargetDistance: false,
      rsiOverheated: false, poorRiskReward: false,
    };
    const stage = classifyStage(sig);
    eq(stage.stage, 2, "유동성 회수 단계");
  });

  test("감점 반영 — 점수 하락", () => {
    const sig = strongSignals();
    const base = scoreCandidate(sig, estimateAbsorption(sig), classifyStage(sig), CONFIG).score;
    sig.strongDowntrend4h = true; sig.tooLowVolume = true;
    const penalized = scoreCandidate(sig, estimateAbsorption(sig), classifyStage(sig), CONFIG).score;
    assert(penalized < base, `감점 후 점수 하락 (${penalized} < ${base})`);
  });

  test("등급 경계", () => {
    eq(gradeFor(90, CONFIG).key, "strong");
    eq(gradeFor(70, CONFIG).key, "observe");
    eq(gradeFor(50, CONFIG).key, "excluded");
  });

  test("핵심 신호 상위 3개", () => {
    const sig = strongSignals();
    const sc = scoreCandidate(sig, estimateAbsorption(sig), classifyStage(sig), CONFIG);
    const top = topSignals(sc.breakdown, 3);
    eq(top.length, 3, "상위 3개 반환");
  });

  test("숏 흡수 = 매수 흡수 (위꼬리·고점 스윕)", () => {
    const sig = { absorptionCandle: { sellRatio: 0.2, upperWickRatio: 0.4, closePos: 0.3, highVol: true },
      sweepRecovered: true, cvdUp: true, priceFlatOrDown: true };
    const abs = estimateAbsorption(sig, "short");
    eq(abs.level, "strong", "강한 흡수");
    assert(abs.label.includes("매수"), "매수 흡수 라벨");
  });

  test("숏 점수 라벨 방향 반영", () => {
    const sig = strongSignals();
    const sc = scoreCandidate(sig, estimateAbsorption(sig, "short"), classifyStage(sig), CONFIG, "short");
    assert(sc.breakdown.some((b) => b.label.includes("고점 유동성 스윕")), "숏 라벨 적용");
    assert(sc.breakdown.some((b) => b.label.includes("급등 및 과매수")), "숏 급등 라벨");
  });

  test("채점 강도 5단계 — minScore/감점 단조 증가, 3단계=기본값", () => {
    eq(STRICTNESS_LEVELS.length, 5, "5단계");
    for (let i = 1; i < STRICTNESS_LEVELS.length; i++) {
      const prev = STRICTNESS_LEVELS[i - 1], cur = STRICTNESS_LEVELS[i];
      assert(cur.minScore > prev.minScore, `minScore 단조 증가 (${prev.level}→${cur.level})`);
      for (const key of Object.keys(CONFIG.penalties)) {
        assert(cur.penalties[key] <= prev.penalties[key], `${key} 감점 세기 단조 증가 (${prev.level}→${cur.level})`);
      }
    }
    eq(JSON.stringify(strictnessPreset(3).penalties), JSON.stringify(CONFIG.penalties), "3단계 = CONFIG 기본 감점값");
  });

  test("scoreCandidate cfg override 반영 (강도별 penalties 교체 경로)", () => {
    const sig = strongSignals();
    const customCfg = {
      ...CONFIG,
      scoreWeights: { ...CONFIG.scoreWeights, dropAndOversold: 0 },
      penalties: CONFIG.penalties,
    };
    const base = scoreCandidate(sig, estimateAbsorption(sig), classifyStage(sig), CONFIG).score;
    const custom = scoreCandidate(sig, estimateAbsorption(sig), classifyStage(sig), customCfg).score;
    assert(custom < base, `가중치 낮추면 점수 하락 (${custom} < ${base})`);
  });

  test("손절 clamp — 스윙이 잘못된 쪽이어도 진입 반대편 + RR 유한", () => {
    // 신저점 갱신 중: swingLow 가 진입 위(잘못)여도 손절은 진입 아래로
    const long = computeLongPlan({ price: 100, swingLow: 105, atr: 2, majorHigh1h: 120 });
    assert(long.stop < long.entry, "롱 손절 < 진입");
    assert(isFinite(long.riskReward) && long.riskReward < 1000, `롱 RR 유한 (${long.riskReward})`);
    // 신고가 갱신 중: swingHigh 가 진입 아래(잘못)여도 손절은 진입 위로
    const short = computeShortPlan({ price: 100, swingHigh: 95, atr: 2, majorLow1h: 80 });
    assert(short.stop > short.entry, "숏 손절 > 진입");
    assert(isFinite(short.riskReward) && short.riskReward < 1000, `숏 RR 유한 (${short.riskReward})`);
  });
}
