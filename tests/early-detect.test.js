// tests/early-detect.test.js — 조기 포착 모드 계산 검증.

import { suite, test, assert, eq } from "./harness.js";
import { CONFIG } from "../js/config.js";
import {
  boxRange, squeezePercentile, volDryRatio, analyzeOi,
  classifyEarlyStage, earlyExclusion,
} from "../js/core/early-detect.js";
import { candlesFromCloses } from "./fixtures.js";

// 1단계(매집) 조건을 모두 만족하는 기본 지표. 개별 테스트에서 필요한 값만 덮어쓴다.
function baseMetrics(over = {}) {
  return {
    boxWidthPct: 20, rangePos: 0.5, boxHigh: 120, boxLow: 100,
    squeezePct: 20, volDry: 0.7, relVol3: 0.9,
    oi: { change72h: 10, change12h: 3, prev12h: 2 },
    funding: 0.0001, change24h: 5, quoteVolume: 50_000_000,
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
    for (const k of ["boxLookback", "squeezeLookback", "boxWidthMaxPct", "squeezePctMax",
      "volDryMax", "oiChangeMinPct", "squeezePctTight", "rangePosMin", "relVolMin",
      "breakoutRelVol", "breakoutMaxRunPct", "pumpedMaxPct", "oiDumpPct", "fundingMaxAbs"]) {
      assert(e[k] !== undefined, `earlyDetect.${k} 필요`);
    }
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

  test("1단계 매집 판정", () => {
    const s = classifyEarlyStage(baseMetrics(), CONFIG);
    eq(s.stage, 1, "매집 단계");
    eq(s.key, "accumulation");
  });

  test("2단계 임박 — 압축 극단 + 상단 근접 + 거래량 회복 + OI 가속", () => {
    const s = classifyEarlyStage(baseMetrics({
      squeezePct: 10, rangePos: 0.97, relVol3: 1.2,
      oi: { change72h: 10, change12h: 6, prev12h: 2 },
    }), CONFIG);
    eq(s.stage, 2, "임박 단계");
    eq(s.key, "imminent");
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

  test("박스 넓으면 단계 없음", () => {
    eq(classifyEarlyStage(baseMetrics({ boxWidthPct: 90 }), CONFIG), null);
  });

  test("OI 없어도(null) 1단계 통과 — 후보 유지", () => {
    const s = classifyEarlyStage(baseMetrics({
      oi: { change72h: null, change12h: null, prev12h: null },
    }), CONFIG);
    eq(s.stage, 1, "OI null 이면 OI 조건은 통과로 간주");
  });

  test("제외 — 이미 급등", () => {
    assert(earlyExclusion(baseMetrics({ change24h: 60 }), CONFIG) !== null, "24h +60% 제외");
  });

  test("제외 — OI 급감", () => {
    assert(earlyExclusion(baseMetrics({
      oi: { change72h: -20, change12h: -5, prev12h: -3 },
    }), CONFIG) !== null, "OI -20% 제외");
  });

  test("제외 — 펀딩 과열", () => {
    assert(earlyExclusion(baseMetrics({ funding: 0.005 }), CONFIG) !== null, "펀딩 0.5% 제외");
  });

  test("제외 — OI·펀딩 null 이면 해당 조건 건너뜀", () => {
    eq(earlyExclusion(baseMetrics({
      oi: { change72h: null, change12h: null, prev12h: null }, funding: null,
    }), CONFIG), null, "null 이면 제외하지 않음");
  });
}
