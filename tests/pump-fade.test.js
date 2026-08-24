// tests/pump-fade.test.js — pump_fade SHORT 파이프라인의 결정적 회귀 테스트.

import { suite, test, assert, eq, approx } from "./harness.js";
import { CONFIG } from "../js/config.js";
import {
  pumpFadePrefilter,
  buildPumpFadeMetrics,
  classifyPumpFadeStage,
  scorePumpFade,
  pumpFadePlan,
  buildPumpFadeResult,
} from "../js/core/pump-fade.js";
import { computeLongPlan } from "../js/core/risk-reward.js";
import { closedOnly } from "../js/api/binance.js";
import { candlesFromCloses } from "./fixtures.js";

const HOUR = 60 * 60 * 1000;
const MIN15 = 15 * 60 * 1000;
const MIN5 = 5 * 60 * 1000;

function oneHourPump(finalPrice = 112.5) {
  const closes = new Array(30).fill(100);
  for (let i = 24; i < closes.length; i++) {
    closes[i] = 100 + (finalPrice - 100) * ((i - 23) / 6);
  }
  return candlesFromCloses(closes, { step: HOUR, spread: 0.4, vol: 100 });
}

function rejection15m() {
  const closes = new Array(100).fill(127);
  closes[96] = 126.5;
  closes[97] = 126;
  closes[98] = 125.5;
  closes[99] = 125;
  const start = Date.UTC(2025, 0, 1, 0, 0, 0);
  const candles = candlesFromCloses(closes, {
    start,
    step: MIN15,
    spread: 0.5,
    vol: 100,
    buyRatio: (i) => i >= 97 ? 0.4 : 0.52,
  });
  Object.assign(candles[95], {
    open: 127,
    high: 130,
    low: 125,
    close: 126,
    volume: 300,
    quoteVolume: 37_800,
    takerBuyBase: 156,
    takerBuyQuote: 19_656,
    takerSellBase: 144,
  });
  return candles;
}

function breakdown5m(signalCloseTime, includeFuture = false) {
  const closes = new Array(40).fill(126);
  closes[39] = 124.5;
  const start = signalCloseTime - 40 * MIN5;
  const candles = candlesFromCloses(closes, {
    start,
    step: MIN5,
    spread: 0.2,
    vol: 80,
    buyRatio: 0.42,
  });
  if (includeFuture) {
    const future = candlesFromCloses([140], {
      start: signalCloseTime + 1,
      step: MIN5,
      spread: 0.2,
      vol: 80,
      buyRatio: 0.8,
    })[0];
    candles.push(future);
  }
  return candles;
}

function fullMetrics() {
  const c1 = oneHourPump();
  const pump = pumpFadePrefilter(c1, CONFIG);
  const c15 = rejection15m();
  const c5 = breakdown5m(c15[c15.length - 1].closeTime);
  return { c1, c15, c5, pump, metrics: buildPumpFadeMetrics(c15, c5, pump, CONFIG) };
}

export function run() {
  suite("pump fade");

  test("pump_fade 가중치 합은 100", () => {
    eq(Object.values(CONFIG.pumpFadeScoreWeights).reduce((a, b) => a + b, 0), 100, "가중치 합");
    eq(CONFIG.pumpFade.minScore, 45, "초기 표시 하한");
    eq(CONFIG.pumpFade.keepMax, 5, "상위 후보 수");
  });

  test("급등하지 않은 코인은 1차 필터에서 제외", () => {
    const r = pumpFadePrefilter(oneHourPump(110), CONFIG);
    eq(r.pass, false, "6h/24h 급등 기준 미달");
  });

  test("6시간 +12% 경계 또는 24시간 +25% 기준으로 통과", () => {
    const sixHour = pumpFadePrefilter(oneHourPump(112), CONFIG);
    assert(sixHour.pass, "6h +12% 경계 통과");
    const closes = new Array(30).fill(100);
    for (let i = 6; i < closes.length; i++) closes[i] = 125;
    const day = pumpFadePrefilter(candlesFromCloses(closes), CONFIG);
    assert(day.pass && day.change6h < 12 && day.change24h >= 25, "24h 기준 단독 통과");
  });

  test("급등만 지속하면 표시 하한보다 높은 점수를 받지 않는다", () => {
    const scored = scorePumpFade({ pumpStrength: true, volumeClimax: true }, CONFIG);
    eq(scored.score, 35, "단순 급등+거래량만 35점");
    assert(scored.score < CONFIG.pumpFade.minScore, "45점 표시 하한 미달");
  });

  test("거래량 클라이맥스는 현재 봉을 제외한 이전 20봉 평균으로 감지", () => {
    const { metrics } = fullMetrics();
    assert(metrics.volumeClimax, "2.5배 이상 감지");
    approx(metrics.volumeClimaxRatio, 3, 1e-9, "300/100");
  });

  test("긴 윗꼬리와 중하단 종가를 감지", () => {
    const { metrics } = fullMetrics();
    assert(metrics.upperWick, "윗꼬리 거절");
    assert(metrics.upperWickRatio >= 0.35 && metrics.rejectionClosePosition <= 0.5, "비율 경계");
  });

  test("유효한 윗꼬리는 이후의 더 큰 비유효 윗꼬리에 덮어쓰이지 않음", () => {
    const c1 = oneHourPump();
    const pump = pumpFadePrefilter(c1, CONFIG);
    const c15 = rejection15m();
    for (const i of [94, 97, 98, 99]) {
      Object.assign(c15[i], {
        open: c15[i].close,
        high: c15[i].close + 0.1,
        low: c15[i].close - 0.9,
      });
    }
    Object.assign(c15[95], { open: 126.4, high: 130, low: 120, close: 124 }); // wick .36, close pos .4
    Object.assign(c15[96], { open: 123, high: 130, low: 120, close: 126 });   // wick .4, close pos .6
    const c5 = breakdown5m(c15[c15.length - 1].closeTime);
    const metrics = buildPumpFadeMetrics(c15, c5, pump, CONFIG);
    assert(metrics.upperWick, "앞선 유효 거절 유지");
    approx(metrics.upperWickRatio, 0.36, 1e-9, "유효 윗꼬리 선택");
  });

  test("이전 고점 돌파 후 종가 복귀를 sweep 실패로 감지", () => {
    const { metrics } = fullMetrics();
    assert(metrics.highSweepFailure, "고점 sweep 실패");
    assert(metrics.highSweepLevel < 130, "이전 고점 아래 복귀");
  });

  test("최근 3봉 Taker Buy 소진 감지", () => {
    const { metrics } = fullMetrics();
    assert(metrics.takerBuyExhaustion, "평균 0.48 이하");
    approx(metrics.takerBuyRatio3, 0.4, 1e-9, "최근 3봉 평균");
  });

  test("15분 EMA20과 일간 VWAP 하향 이탈 감지", () => {
    const { metrics } = fullMetrics();
    assert(metrics.ema20Loss, "EMA20 이탈");
    assert(metrics.vwapLoss, "VWAP 이탈");
    assert(metrics.price < metrics.ema20 && metrics.price < metrics.vwap, "현재 종가가 두 기준 아래");
  });

  test("5분 현재 종가가 이전 4봉 저점 아래면 구조 붕괴", () => {
    const { metrics } = fullMetrics();
    assert(metrics.microBreakdown, "5m 구조 붕괴");
    assert(metrics.price > 0 && metrics.microBreakdownLevel > 0, "유효 레벨");
  });

  test("고점 거절과 하락 확인 조합은 3단계", () => {
    const { metrics } = fullMetrics();
    eq(classifyPumpFadeStage(metrics, CONFIG).stage, 3, "급락 확인");
  });

  test("단계 경계 — 급등만 1단계, 거절 근거 2개면 2단계", () => {
    const stage1 = classifyPumpFadeStage({ pumpStrength: true, rejectionEvidence: 1 }, CONFIG);
    const stage2 = classifyPumpFadeStage({
      pumpStrength: true, rejectionEvidence: 2,
      ema20Loss: false, vwapLoss: false, microBreakdown: false, drawdownConfirmed: false,
    }, CONFIG);
    eq(stage1.stage, 1, "과열 감시");
    eq(stage2.stage, 2, "고점 거절");
  });

  test("이미 고점 대비 12% 이상 폭락하면 25점 감점", () => {
    const base = {
      pumpStrength: true, volumeClimax: true, upperWick: true, highSweepFailure: true,
      takerBuyExhaustion: true, ema20Loss: true, vwapLoss: true, microBreakdown: true,
      lateShortRisk: false,
    };
    const normal = scorePumpFade(base, CONFIG);
    const late = scorePumpFade({ ...base, lateShortRisk: true }, CONFIG);
    eq(normal.score, 100, "감점 전 만점");
    eq(late.score, 75, "25점 감점");
  });

  test("SHORT 계획은 손절이 위, TP는 아래", () => {
    const { metrics } = fullMetrics();
    const plan = pumpFadePlan(metrics, CONFIG);
    assert(plan.stop > plan.entry, "SHORT stop > entry");
    assert(plan.tp1 < plan.entry && plan.tp2 < plan.tp1 && plan.tp3 < plan.tp2, "SHORT TP 하향");
    eq(plan.direction, "short", "SHORT 명시");
  });

  test("손절 거리가 8% 이상이면 계획 무효", () => {
    const plan = pumpFadePlan({ price: 100, pumpHigh: 110, atrVal: 1 }, CONFIG);
    eq(plan.valid, false, "과도한 손절 거리");
    assert(plan.warning?.includes("8%"), "위험 경고");
  });

  test("기존 LONG 계획은 손절 아래와 TP 위를 유지", () => {
    const plan = computeLongPlan({ price: 100, swingLow: 95, atr: 2 });
    assert(plan.stop < plan.entry, "LONG stop < entry");
    assert(plan.tp1 > plan.entry && plan.tp2 > plan.entry && plan.tp3 > plan.entry, "LONG TP 위");
  });

  test("자료 부족은 fail closed", () => {
    const pump = pumpFadePrefilter(oneHourPump(), CONFIG);
    eq(buildPumpFadeMetrics(rejection15m().slice(-20), [], pump, CONFIG), null, "15m 자료 부족");
  });

  test("기본 경로는 마지막 진행 중 캔들을 제외하고 opt-in에서만 포함", () => {
    const candles = oneHourPump();
    eq(closedOnly(candles, false).length, candles.length - 1, "기본 마감봉만");
    eq(closedOnly(candles, true).length, candles.length, "실시간 opt-in");
  });

  test("거래량 0인 최근 봉은 Taker 소진으로 간주하지 않는다", () => {
    const { pump, c15, c5 } = fullMetrics();
    for (const c of c15.slice(-3)) {
      c.volume = 0;
      c.takerBuyBase = 0;
      c.takerSellBase = 0;
    }
    const metrics = buildPumpFadeMetrics(c15, c5, pump, CONFIG);
    eq(metrics.takerBuyExhaustion, false, "0 denominator fail closed");
    eq(metrics.takerBuyRatio3, null, "비율 미계산");
  });

  test("15분 신호 이후 5분봉은 구조 판정에 섞지 않는다", () => {
    const { pump, c15 } = fullMetrics();
    const signalCloseTime = c15[c15.length - 1].closeTime;
    const prefix5 = breakdown5m(signalCloseTime, false);
    const full5 = breakdown5m(signalCloseTime, true);
    const a = buildPumpFadeMetrics(c15, prefix5, pump, CONFIG);
    const b = buildPumpFadeMetrics(c15, full5, pump, CONFIG);
    eq(a.microBreakdown, b.microBreakdown, "미래 5m 무시");
    eq(a.aligned5mCount, b.aligned5mCount, "정렬된 봉 수 불변");
  });

  test("뒤섞인 5분봉도 시각순으로 정렬하고 미래 봉은 제외", () => {
    const { pump, c15 } = fullMetrics();
    const signalCloseTime = c15[c15.length - 1].closeTime;
    const ordered = breakdown5m(signalCloseTime);
    const shuffled = [...ordered].reverse();
    const a = buildPumpFadeMetrics(c15, ordered, pump, CONFIG);
    const b = buildPumpFadeMetrics(c15, shuffled, pump, CONFIG);
    eq(b.microBreakdown, a.microBreakdown, "입력 배열 순서에 독립");
    eq(b.microBreakdownLevel, a.microBreakdownLevel, "구조 레벨 동일");
  });

  test("15분 신호 시각이 없으면 fail closed", () => {
    const { pump, c15, c5 } = fullMetrics();
    delete c15[c15.length - 1].closeTime;
    eq(buildPumpFadeMetrics(c15, c5, pump, CONFIG), null, "시각 없는 신호 거부");
  });

  test("prefix == full — 미래 5분봉 추가 후 과거 pump_fade 신호 불변", () => {
    const { pump, c15 } = fullMetrics();
    const signalCloseTime = c15[c15.length - 1].closeTime;
    const prefix = buildPumpFadeMetrics(c15, breakdown5m(signalCloseTime), pump, CONFIG);
    const extended = buildPumpFadeMetrics(c15, breakdown5m(signalCloseTime, true), pump, CONFIG);
    for (const key of ["volumeClimax", "upperWick", "highSweepFailure", "takerBuyExhaustion", "ema20Loss", "vwapLoss", "microBreakdown", "drawdownPct"]) {
      eq(extended[key], prefix[key], `${key} 불변`);
    }
  });

  test("결과 객체는 SHORT 전용 호환 shape과 실험 표시를 가진다", () => {
    const { c1, c15, c5 } = fullMetrics();
    const result = buildPumpFadeResult({
      symbol: "PUMPUSDT", baseAsset: "PUMP", quoteVolume: 50_000_000, newListing: false,
    }, c1, c15, c5, CONFIG);
    assert(result, "결과 생성");
    eq(result.scanMode, "pump_fade", "모드");
    eq(result.direction, "short", "방향");
    eq(result.experimental, true, "실험 표시");
    for (const key of ["score", "grade", "stage", "breakdown", "penalties", "topSignals", "plan", "timeframes"]) {
      assert(result[key] != null, `${key} 존재`);
    }
  });
}
