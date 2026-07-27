// tests/early-detect.test.js — 조기 포착 모드 계산 검증.

import { suite, test, assert, eq } from "./harness.js";
import { CONFIG, minScoreFor, strictnessPreset, STRICTNESS_LEVELS } from "../js/config.js";
import {
  boxRange, squeezePercentile, volDryRatio, analyzeOi,
  classifyEarlyStage, earlyDataIssue, earlyExclusion, scoreEarly, earlyGradeFor, earlyPlan,
  buildEarlyMetrics, buildEarlyResult,
} from "../js/core/early-detect.js";
import { candlesFromCloses } from "./fixtures.js";
import {
  stage2Liquidity, excludeMajors, stage3EvaluateEarly, prioritizeEarlyCandidates,
  earlyPrefilterGate,
} from "../js/scanner/prefilter.js";

const HOUR_MS = 60 * 60 * 1000;

function oiSeries(length = 80, value = (i) => 1000 + i) {
  return Array.from({ length }, (_, i) => ({ time: i * HOUR_MS, oi: value(i) }));
}

// 1단계(매집) 조건을 모두 만족하는 기본 지표. 개별 테스트에서 필요한 값만 덮어쓴다.
function baseMetrics(over = {}) {
  return {
    boxWidthPct: 20, rangePos: 0.5, boxHigh: 120, boxLow: 100,
    squeezePct: 20, volDry: 0.7, relVol3: 0.9,
    oi: { change72h: 10, change12h: 3, prev12h: 2 },
    funding: 0.0001, change24h: 5, quoteVolume: 50_000_000,
    closeAboveEma200: true, ema200SlopeOk: true, ema200Ready: true,
    breakoutClose: false, atrRising: false, atrReady: true, runFromBreakoutPct: 0,
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
    for (const k of ["boxLookback", "squeezeLookback", "boxWidthMaxPct", "prefilterSqueezePctMax", "squeezePctMax",
      "volDryMax", "oiChangeMinPct", "squeezePctTight", "rangePosMin", "relVolMin",
      "breakoutRelVol", "breakoutMaxRunPct", "pumpedMaxPct", "oiDumpPct", "fundingMaxAbs",
      "oiScoreFullPct", "oiTargetToleranceMs"]) {
      assert(e[k] !== undefined, `earlyDetect.${k} 필요`);
    }
    assert(e.squeezePctTight < e.squeezePctMax && e.squeezePctMax < e.prefilterSqueezePctMax,
      "압축 경계는 임박 < 매집 < 후보 선별 순서");
    assert(Number.isFinite(e.oiScoreFullPct) && e.oiScoreFullPct > 0, "OI 만점 기준은 양의 유한값");
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
    const series = Array.from({ length: 73 }, (_, i) => ({ time: i * HOUR_MS, oi: 100 + (100 * i) / 72 }));
    const r = analyzeOi(series);
    assert(Math.abs(r.change72h - 100) < 1e-6, `72h +100% (실제 ${r.change72h})`);
    assert(r.change12h > 0, "12h 증가");
  });

  test("OI 변화율 — 가속 판정", () => {
    // 앞 구간은 완만, 최근 12h 가 급증
    const series = [];
    for (let i = 0; i <= 60; i++) series.push({ time: i * HOUR_MS, oi: 100 });
    for (let i = 61; i <= 72; i++) series.push({ time: i * HOUR_MS, oi: 100 + (i - 60) * 5 });
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

  test("압축 백분위 — 최근 창에 NaN이 있으면 fail closed", () => {
    eq(squeezePercentile([1, 2, NaN], 3), null, "NaN을 최강 압축으로 오인하지 않음");
  });

  test("OI 변화율 — 행 번호가 아니라 timestamp 기준", () => {
    // 마지막은 79h, 72h 전은 7h. 중간 20h 한 행을 빼도 7h 표본을 사용해야 한다.
    const series = oiSeries(80, (i) => 100 + i).filter((p) => p.time !== 20 * HOUR_MS);
    const r = analyzeOi(series, CONFIG.earlyDetect.oiTargetToleranceMs);
    const expected = ((179 - 107) / 107) * 100;
    assert(Math.abs(r.change72h - expected) < 1e-9, `timestamp 7h 기준 (${r.change72h})`);
  });

  test("OI 변화율 — 목표 시각 근처 표본이 없으면 null", () => {
    const series = oiSeries(80).filter((p) => ![6, 7, 8].includes(p.time / HOUR_MS));
    const r = analyzeOi(series, CONFIG.earlyDetect.oiTargetToleranceMs);
    eq(r.change72h, null, "72h 목표에서 2시간 이상 떨어지면 추정하지 않음");
  });

  test("OI 변화율 — 허용오차 경계와 역순 입력", () => {
    const now = 100 * HOUR_MS;
    const base = [
      { time: now, oi: 200 },
      { time: now - 12 * HOUR_MS, oi: 180 },
      { time: now - 24 * HOUR_MS, oi: 160 },
      { time: now - 72 * HOUR_MS + CONFIG.earlyDetect.oiTargetToleranceMs, oi: 100 },
    ];
    const atBoundary = analyzeOi(base, CONFIG.earlyDetect.oiTargetToleranceMs);
    assert(atBoundary.change72h != null, "정확히 허용오차 경계면 통과");
    const outside = base.map((p, i) => i === 3 ? { ...p, time: p.time + 1 } : p).reverse();
    const pastBoundary = analyzeOi(outside, CONFIG.earlyDetect.oiTargetToleranceMs);
    eq(pastBoundary.change72h, null, "허용오차 +1ms면 실패");
    assert(pastBoundary.change12h != null, "역순 입력도 timestamp로 정렬");
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

  test("후보용 압축 60은 돌파만 허용하고 1단계 매집은 허용하지 않는다", () => {
    const loose = baseMetrics({ squeezePct: 60 });
    eq(classifyEarlyStage(loose, CONFIG), null, "압축 점수 0인 후보는 매집 아님");
    const breakout = classifyEarlyStage({
      ...loose, breakoutClose: true, relVol3: 2.5, atrRising: true, runFromBreakoutPct: 5,
    }, CONFIG);
    eq(breakout.stage, 3, "동일 압축에서도 확인된 돌파는 3단계");
  });

  test("early 압축 경계 — 매집 30과 임박 15", () => {
    eq(classifyEarlyStage(baseMetrics({ squeezePct: 30 }), CONFIG).stage, 1, "매집 30 포함");
    eq(classifyEarlyStage(baseMetrics({ squeezePct: 30.01 }), CONFIG), null, "매집 30 초과 제외");
    const imminentBase = {
      rangePos: 0.97, relVol3: 1.2,
      oi: { change72h: 10, change12h: 6, prev12h: 2 },
    };
    eq(classifyEarlyStage(baseMetrics({ ...imminentBase, squeezePct: 15 }), CONFIG).stage, 2, "임박 15 포함");
    eq(classifyEarlyStage(baseMetrics({ ...imminentBase, squeezePct: 15.01 }), CONFIG).stage, 1,
      "임박 15 초과는 매집으로 복귀");
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

  test("OI 없으면 1단계 후보를 만들지 않는다", () => {
    const s = classifyEarlyStage(baseMetrics({
      oi: { change72h: null, change12h: null, prev12h: null },
    }), CONFIG);
    eq(s, null, "OI 자료 부족은 fail closed");
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

  test("제외 — OI null 은 자료 부족, 펀딩 null 만 허용", () => {
    eq(earlyExclusion(baseMetrics({
      oi: { change72h: null, change12h: null, prev12h: null }, funding: null,
    }), CONFIG), "미결제약정 자료 부족");
    eq(earlyExclusion(baseMetrics({ funding: null }), CONFIG), null, "보조 펀딩 자료만 없으면 유지");
  });

  test("필수 4시간 지표 준비 상태를 명시적으로 검사", () => {
    eq(earlyDataIssue(baseMetrics()), null, "정상 지표");
    eq(earlyDataIssue(baseMetrics({ relVol3: null })), "4시간 지표 자료 부족");
    eq(earlyDataIssue(baseMetrics({ ema200Ready: false })), "4시간 지표 자료 부족");
    eq(earlyDataIssue(baseMetrics({ atrReady: false })), "4시간 지표 자료 부족");
  });

  test("채점 — 조건 좋을수록 점수 높음(단조성)", () => {
    const weak = scoreEarly(baseMetrics({ squeezePct: 45, oi: { change72h: 1, change12h: 0, prev12h: 0 }, volDry: 0.95, rangePos: 0.1 }), CONFIG).score;
    const strong = scoreEarly(baseMetrics({ squeezePct: 2, oi: { change72h: 30, change12h: 10, prev12h: 3 }, volDry: 0.2, rangePos: 0.98 }), CONFIG).score;
    assert(strong > weak, `강한 조건이 더 높아야 (${strong} > ${weak})`);
  });

  test("채점 — 최고 조건은 만점 근처", () => {
    const r = scoreEarly(baseMetrics({
      squeezePct: 0, oi: { change72h: 30, change12h: 10, prev12h: 3 },
      volDry: 0, rangePos: 1, closeAboveEma200: true,
    }), CONFIG);
    eq(r.score, 100, "모든 항목 만점");
  });

  test("채점 — OI 없으면 해당 항목 0점, 나머지는 살아있음", () => {
    const r = scoreEarly(baseMetrics({ oi: { change72h: null, change12h: null, prev12h: null } }), CONFIG);
    const oiItem = r.breakdown.find((b) => b.key === "oiBuildUp");
    eq(oiItem.got, 0, "OI 항목 0점");
    assert(r.score > 0, "다른 항목 점수는 남음");
  });

  test("채점 — 잘못된 OI 만점 설정에서도 NaN을 만들지 않는다", () => {
    const cfg = { ...CONFIG, earlyDetect: { ...CONFIG.earlyDetect, oiScoreFullPct: 0 } };
    const r = scoreEarly(baseMetrics(), cfg);
    assert(Number.isFinite(r.score), `점수는 유한해야 함 (${r.score})`);
  });

  test("early 전용 등급은 표시 컷 후보를 제외로 표시하지 않는다", () => {
    eq(earlyGradeFor(25, CONFIG).key, "weak", "강도 1 컷");
    eq(earlyGradeFor(40, CONFIG).key, "observe", "기본 컷");
    eq(earlyGradeFor(60, CONFIG).key, "watch", "엄격 컷");
    for (const preset of STRICTNESS_LEVELS) {
      assert(earlyGradeFor(preset.earlyMinScore, CONFIG).key !== "excluded",
        `강도 ${preset.level} 표시 컷은 제외 등급이 아니어야 함`);
    }
  });

  test("채점 — 감점 반영", () => {
    const base = scoreEarly(baseMetrics(), CONFIG).score;
    const penalized = scoreEarly(baseMetrics({ change24h: 30, quoteVolume: 1_000_000 }), CONFIG).score;
    assert(penalized < base, `감점 후 하락 (${penalized} < ${base})`);
  });

  test("plan — 손절은 진입 아래, 손익비 유한", () => {
    const p = earlyPlan(baseMetrics({ boxHigh: 120, boxLow: 100 }), 2, 110);
    assert(p.stop < p.entry, "손절 < 진입");
    assert(isFinite(p.riskReward) && p.riskReward > 0, `손익비 유한 (${p.riskReward})`);
    assert(p.tp2 > p.tp1, "TP2 > TP1");
  });

  test("plan — 박스 하단이 진입 위여도 손절은 진입 아래로 clamp", () => {
    // 비정상 입력(박스 하단 > 현재가)에서도 손절이 진입 위로 가지 않아야 한다
    const p = earlyPlan(baseMetrics({ boxHigh: 120, boxLow: 150 }), 2, 110);
    assert(p.stop < p.entry, `손절 clamp (stop ${p.stop} < entry ${p.entry})`);
    assert(isFinite(p.riskReward), "손익비 유한");
  });

  test("지표 조립 — 캔들 부족하면 null", () => {
    const c = candlesFromCloses([1, 2, 3], { spread: 0 });
    eq(buildEarlyMetrics(c, [], null, { change24h: 0, quoteVolume: 1e7 }, CONFIG), null);
  });

  test("지표 조립 — 좁은 횡보에서 압축·고갈 지표가 나온다", () => {
    // 200봉 좁은 횡보 + 최근 거래량 감소
    // 진폭이 점점 줄어드는 횡보 → 최근 볼린저 폭이 가장 좁아 압축 백분위가 낮게 나온다
    const closes = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 5) * (5 * (1 - i / 200)));
    const c = candlesFromCloses(closes, { spread: 0.05, vol: (i) => (i < 140 ? 100 : 50) });
    const m = buildEarlyMetrics(c, [], null, { change24h: 2, quoteVolume: 5e7 }, CONFIG);
    assert(m !== null, "지표 생성됨");
    assert(m.boxWidthPct < 25, `박스 좁음 (${m.boxWidthPct})`);
    assert(m.volDry != null && m.volDry < 1, `거래량 고갈 (${m.volDry})`);
    assert(m.squeezePct != null, "압축 백분위 계산됨");
  });

  test("결과 조립 — 기존 결과 shape 을 채운다", () => {
    // 진폭이 점점 줄어드는 횡보 → 최근 볼린저 폭이 가장 좁아 압축 백분위가 낮게 나온다
    const closes = Array.from({ length: 250 }, (_, i) => 100 + i * 0.01 + Math.sin(i / 5) * (5 * (1 - i / 250)));
    const c = candlesFromCloses(closes, { spread: 0.05, vol: (i) => (i < 230 ? 100 : 50) });
    const item = { symbol: "TESTUSDT", baseAsset: "TEST", quoteVolume: 5e7, change24h: 2, newListing: false };
    const r = buildEarlyResult(item, c, oiSeries(), null, CONFIG);
    assert(r, "충분한 이력과 정상 조건이면 결과가 생성되어야 함");
    for (const k of ["symbol", "price", "score", "grade", "stage", "breakdown", "penalties", "topSignals", "plan", "direction"]) {
      assert(r[k] !== undefined, `결과에 ${k} 필요`);
    }
    eq(r.scanMode, "early", "early 결과는 모드를 명시");
    eq(r.direction, "long", "early 는 롱 전용");
    assert(r.stage.stage >= 1 && r.stage.stage <= 3, "단계는 1~3");
    assert(r.grade.key !== "excluded", "표시 후보는 early 전용 등급 사용");
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

  test("early 1차 선별 — 좁은 횡보는 통과", () => {
    // 진폭이 점점 줄어드는 횡보 → 최근 볼린저 폭이 가장 좁아 압축 백분위가 낮게 나온다
    const closes = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 5) * (5 * (1 - i / 200)));
    const c = candlesFromCloses(closes, { spread: 0.05, vol: (i) => (i < 140 ? 100 : 50) });
    const r = stage3EvaluateEarly({ symbol: "XUSDT" }, c, CONFIG);
    eq(r.pass, true, `통과해야 함 (사유: ${r.reason})`);
  });

  test("early 1차 선별 — 넓게 출렁이면 탈락", () => {
    const closes = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 5) * 40);
    const c = candlesFromCloses(closes, { spread: 1 });
    const r = stage3EvaluateEarly({ symbol: "YUSDT" }, c, CONFIG);
    eq(r.pass, false, "박스가 넓으면 탈락");
  });

  test("early 1차 선별 — 캔들 부족하면 탈락", () => {
    const c = candlesFromCloses([1, 2, 3], { spread: 0 });
    eq(stage3EvaluateEarly({ symbol: "ZUSDT" }, c, CONFIG).pass, false);
  });

  test("early 1차 선별 — 박스만 계산되고 압축 이력이 부족해도 탈락", () => {
    const closes = Array.from({ length: 100 }, (_, i) => 100 + Math.sin(i / 5));
    const c = candlesFromCloses(closes, { spread: 0.05, vol: 100 });
    const r = stage3EvaluateEarly({ symbol: "SHORTUSDT" }, c, CONFIG);
    eq(r.pass, false, "필수 압축 이력 부족은 fail closed");
  });

  test("early 1차 선별 — 후보 압축 60 경계", () => {
    const metrics = { boxWidthPct: 20, squeezePct: 60, volDry: 0.7 };
    eq(earlyPrefilterGate(metrics, CONFIG).pass, true, "60 포함");
    eq(earlyPrefilterGate({ ...metrics, squeezePct: 60.01 }, CONFIG).pass, false, "60.01 제외");
  });

  test("early 후보 상한은 확인된 돌파를 압축 후보보다 우선한다", () => {
    const compressed = Array.from({ length: 50 }, (_, i) => ({
      item: { symbol: `C${String(i).padStart(2, "0")}USDT` },
      res: { pass: true, breakoutReady: false, squeezePct: 0 },
    }));
    const breakout = {
      item: { symbol: "BREAKOUTUSDT" },
      res: { pass: true, breakoutReady: true, squeezePct: 48 },
    };
    const ranked = prioritizeEarlyCandidates([...compressed, breakout], 50);
    assert(ranked.some((x) => x.item.symbol === "BREAKOUTUSDT"), "돌파 후보가 cap 안에 남아야 함");
    eq(ranked[0].item.symbol, "BREAKOUTUSDT", "돌파 후보 우선");
  });

  // ---- 데이터 창이 lookback 을 못 덮으면 계산이 "조용히 null" 이 되는 계열 회귀 방지 ----
  // 실제로 두 건 다 발생했다: oiLimit=72 → change72h 영구 null(=oiBuildUp 25점 사장),
  // 4h limit=220 → EMA200 기울기 영구 false(=매집 후보 60% 사망).

  test("설정된 oiLimit 만큼 받으면 72시간 변화가 계산된다", () => {
    // 실제 API 가 주는 만큼(= oiLimit 개)만 있는 시계열
    const series = oiSeries(CONFIG.earlyDetect.oiLimit);
    const r = analyzeOi(series);
    assert(r.change72h != null,
      `oiLimit=${CONFIG.earlyDetect.oiLimit} 로는 72시간 전 값을 못 집는다 → oiBuildUp 이 항상 0점`);
    assert(r.change72h > 0, "증가 시계열이면 양수");
  });

  test("early 는 reversal 과 최소 점수 컷을 공유하지 않는다", () => {
    // 두 모드는 품질 점수 분포와 표시 목적이 달라 강도별 컷을 분리한다.
    eq(minScoreFor({ scanMode: "reversal", minScore: 55 }), 55, "reversal 은 사용자 설정 그대로");
    eq(minScoreFor({ scanMode: "early", minScore: 55, strictnessLevel: 3 }),
      strictnessPreset(3).earlyMinScore, "early 는 강도 단계별 자체 컷");
    for (const p of STRICTNESS_LEVELS) {
      assert(p.earlyMinScore < p.minScore,
        `강도 ${p.level}: early 컷(${p.earlyMinScore})은 reversal 컷(${p.minScore})보다 낮아야 매집이 보인다`);
    }
  });

  test("채점 강도가 early 컷에도 반영된다 (죽은 컨트롤 방지)", () => {
    const cut = (lv) => minScoreFor({ scanMode: "early", strictnessLevel: lv });
    for (let lv = 1; lv < 5; lv++) {
      assert(cut(lv) < cut(lv + 1), `강도 ${lv} → ${lv + 1} 로 갈수록 컷이 높아져야 함`);
    }
    assert(cut(1) < cut(3), "1단계(널널)가 기본보다 후보를 많이 보여줘야 함");
  });

  test("설정된 4h 캔들 수로 EMA200 기울기가 실제로 판정된다", () => {
    const n = CONFIG.klinesLimit["4h"] - 1; // 진행 중 캔들 제외한 마감 캔들 수
    const rising = candlesFromCloses(
      Array.from({ length: n }, (_, i) => 100 + i * 0.5), { spread: 0.1 });
    const up = buildEarlyMetrics(rising, [], null, {}, CONFIG);
    assert(up, "지표 계산됨");
    eq(up.ema200SlopeOk, true, "상승 시계열이면 EMA200 기울기가 상승이어야 함(창이 좁으면 항상 false)");

    const falling = candlesFromCloses(
      Array.from({ length: n }, (_, i) => 200 - i * 0.5), { spread: 0.1 });
    eq(buildEarlyMetrics(falling, [], null, {}, CONFIG).ema200SlopeOk, false,
      "하락 시계열이면 기울기 상승이 아니어야 함");
  });
}
