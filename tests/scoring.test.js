// tests/scoring.test.js — 흡수/단계/점수 검증.

import { suite, test, assert, eq } from "./harness.js";
import { estimateAbsorption, classifyStage, scoreCandidate, gradeFor, topSignals, coreStrengthPct } from "../js/core/scoring.js";
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

  // 밴드 수치는 실측 분포를 보고 조정한다. 수치를 박아두면 조정할 때마다 깨지므로
  // 경계가 스스로 일관적인지(내림차순·경계 위/아래 등급)를 확인한다.
  test("등급 경계", () => {
    const g = CONFIG.grades;
    for (let i = 1; i < g.length; i++) assert(g[i].min < g[i - 1].min, "경계는 내림차순");
    eq(g[g.length - 1].min, 0, "마지막 밴드는 0부터");
    for (const band of g) {
      eq(gradeFor(band.min, CONFIG).key, band.key, `${band.min}점은 ${band.label}`);
      if (band.min > 0) {
        assert(gradeFor(band.min - 1, CONFIG).min < band.min, `${band.min - 1}점은 아래 밴드`);
      }
    }
  });

  // 실전 최고점보다 최상위 경계가 높으면 그 등급은 영원히 안 나온다.
  // 예전 reversal 밴드(85+)가 실측 최고 60 이라 "강한 후보" 가 한 번도 안 나왔던 회귀 방지.
  test("최상위 등급이 채점 가능 범위 안에 있다", () => {
    const maxWeight = Object.values(CONFIG.scoreWeights).reduce((a, b) => a + b, 0);
    eq(maxWeight, 100, "가중치 총합 100");
    assert(CONFIG.grades[0].min <= 60, `최상위 경계(${CONFIG.grades[0].min})가 실측 최고점(60)보다 높으면 도달 불가`);
    // 채점 강도의 minScore 도 전부 도달 가능해야 한다.
    for (const s of STRICTNESS_LEVELS) {
      assert(s.minScore <= 60, `채점 강도 ${s.level} 의 minScore(${s.minScore})가 도달 불가`);
    }
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

  test("진입가는 절대 방향을 거스르지 않는다", () => {
    // 예전엔 FVG·OB·VWAP·EMA 를 단순 평균해서 롱인데 진입가가 현재가보다 위인 경우가
    // 50건 중 20건 나왔다(최대 +4.49%). 실행 불가한 계획이라 방향에 맞는 쪽만 쓴다.
    const zones = { fvg15: { mid: 108 }, ob15: { mid: 112 }, vwap1h: 95, ema20_15: 97 };
    const long = computeLongPlan({ price: 100, ...zones, swingLow: 90, atr: 2, majorHigh1h: 130 });
    assert(long.entry <= 100, `롱 진입가는 현재가 이하여야 함 (실제 ${long.entry})`);
    eq(long.entry, 97, "현재가 아래 중 가장 가까운 지지");

    const short = computeShortPlan({ price: 100, ...zones, swingHigh: 120, atr: 2, majorLow1h: 70 });
    assert(short.entry >= 100, `숏 진입가는 현재가 이상이어야 함 (실제 ${short.entry})`);
    eq(short.entry, 108, "현재가 위 중 가장 가까운 저항");

    // 방향에 맞는 레벨이 하나도 없으면 현재가를 쓴다(허공 가격을 만들지 않는다)
    const none = computeLongPlan({ price: 100, fvg15: { mid: 130 }, swingLow: 90, atr: 2 });
    eq(none.entry, 100, "쓸 수 있는 지지가 없으면 현재가");
  });

  test("최소 손절 폭 — 저변동성에서 손익비가 폭주하지 않는다", () => {
    // 실측: ETCUSDT 리스크 폭 0.16% → RR 1:30.1. ATR 이 아주 작으면 손절이 진입에 붙는다.
    const p = computeLongPlan({ price: 100, swingLow: 99.99, atr: 0.0001, majorHigh1h: 130 });
    const riskPct = ((p.entry - p.stop) / p.entry) * 100;
    assert(riskPct >= CONFIG.riskReward.minStopPct * 0.99,
      `손절 폭 ${riskPct.toFixed(3)}% 가 최소치(${CONFIG.riskReward.minStopPct}%) 미만`);
  });

  test("핵심 소계 — 쉬운 항목만으로 올린 후보는 걸러진다", () => {
    // 급락·거래대금·5분 트리거 등 보조만 맞고 스윕·구조전환이 없는 경우
    const weak = { ...strongSignals(), lowSweepValid: false, sweepRecovered: false,
      structureShift1h: false, fvgObOverlap: false };
    const sc = scoreCandidate(weak, estimateAbsorption(weak), classifyStage(weak), CONFIG);
    const pct = coreStrengthPct(sc.breakdown, CONFIG.reversalCoreKeys);
    assert(pct < CONFIG.reversalCoreMinPct, `핵심 소계 ${pct}% 는 하한 미만이어야 함`);
    assert(sc.score > 0, `총점(${sc.score})만 보면 남았을 것`);
    // 핵심 키가 실제 채점 항목에 있어야 게이트가 동작한다
    const keys = sc.breakdown.map((b) => b.key);
    for (const k of CONFIG.reversalCoreKeys) assert(keys.includes(k), `reversalCoreKeys 의 ${k} 가 breakdown 에 없음`);
  });

  test("상관된 감점은 그룹당 하나만 — 한 사실에 중복 차감 안 함", () => {
    // 실측 XPLUSDT: "위로 갈 공간 없음" 하나로 -8/-8/-10 = -26 이 나가
    // 핵심 4항목 만점(50/50)인 종목이 34점까지 밀렸다.
    const sig = { ...strongSignals(),
      strongResistanceAbove: true, shortTargetDistance: true, poorRiskReward: true };
    const sc = scoreCandidate(sig, estimateAbsorption(sig), classifyStage(sig), CONFIG);
    const group = CONFIG.penaltyGroups.upsideSpace;
    const applied = sc.penalties.filter((p) => group.includes(p.key));
    eq(applied.length, 1, "그룹에서 하나만 적용");
    const worst = Math.min(...group.map((k) => CONFIG.penalties[k]));
    eq(applied[0].val, worst, "가장 센 감점이 남아야 함");

    // 그룹 밖 감점은 그대로 누적된다
    const both = { ...sig, strongDowntrend4h: true, newListingThin: true };
    const sc2 = scoreCandidate(both, estimateAbsorption(both), classifyStage(both), CONFIG);
    eq(sc2.penalties.filter((p) => !group.includes(p.key)).length, 2, "그룹 밖은 전부 적용");
    assert(sc2.score < sc.score, "그룹 밖 감점이 늘면 점수는 더 내려간다");
  });

  test("감점 그룹 키는 실제 감점 항목이어야 한다", () => {
    for (const [name, keys] of Object.entries(CONFIG.penaltyGroups)) {
      for (const k of keys) assert(CONFIG.penalties[k] !== undefined, `penaltyGroups.${name} 의 ${k} 가 penalties 에 없음`);
    }
  });

  test("손익비는 단계 분류를 좌우하지 않는다", () => {
    // RR 만 나쁘고 과열 신호가 없으면 5단계(추격 금지)가 아니어야 한다.
    // 예전엔 poorRiskReward 가 5단계 트리거라 50건 중 33건이 추격 금지로 몰렸다.
    const sig = { ...strongSignals(), poorRiskReward: true,
      change15mOverExtended: false, farFromLowAtr: false, shortTargetDistance: false, rsiOverheated: false };
    assert(classifyStage(sig).stage !== 5, "RR 만으로 추격 금지 판정하면 안 됨");
    // 실제 과열 신호가 있으면 여전히 5단계
    assert(classifyStage({ ...sig, rsiOverheated: true }).stage === 5, "과열이면 추격 금지");
  });
}
