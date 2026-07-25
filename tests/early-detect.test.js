// tests/early-detect.test.js — 조기 포착 모드 계산 검증.

import { suite, test, assert, eq } from "./harness.js";
import { CONFIG } from "../js/config.js";
import {
  boxRange, squeezePercentile, volDryRatio, analyzeOi,
  classifyEarlyStage, earlyExclusion, scoreEarly, earlyPlan,
  buildEarlyMetrics, buildEarlyResult,
} from "../js/core/early-detect.js";
import { ema } from "../js/core/indicators.js";
import { gradeFor, coreStrengthPct } from "../js/core/scoring.js";
import { candlesFromCloses } from "./fixtures.js";
import { stage2Liquidity, excludeMajors, stage3EvaluateEarly } from "../js/scanner/prefilter.js";

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

  test("거래량 고갈 점수는 게이트값 기준으로 만점까지 쓴다", () => {
    const w = CONFIG.earlyScoreWeights.volumeProfile;
    const got = (volDry) => scoreEarly(baseMetrics({ volDry }), CONFIG)
      .breakdown.find((b) => b.key === "volumeProfile").got;
    eq(got(0), w, "완전 고갈이면 만점");
    eq(got(CONFIG.earlyDetect.volDryMax), 0, "게이트 경계면 0점");
    assert(got(CONFIG.earlyDetect.volDryMax / 2) > w * 0.4, "중간값이면 절반 근처");
  });

  test("early 등급은 전용 밴드를 쓴다 (reversal 밴드면 정상 후보가 '제외')", () => {
    const eg = CONFIG.earlyGrades;
    eq(eg.length, CONFIG.grades.length, "밴드 개수 동일");
    eq(eg.map((g) => g.key).join(), CONFIG.grades.map((g) => g.key).join(), "key 는 CSS 와 물려 있어 동일해야 함");
    assert(eg[0].min < CONFIG.grades[0].min, "early 최상위 경계는 reversal 보다 낮아야 함");
    // 2026-07-25 라이브 실측: 게이트 통과 종목이 26·35점이었다. 둘 다 하위 2개 등급이면 안 된다.
    for (const score of [26, 35]) {
      const g = gradeFor(score, { grades: eg });
      assert(g.key !== "excluded" && g.key !== "weak", `${score}점이 "${g.label}" 로 표시됨`);
    }
    // 표시 하한은 밴드 경계와 일치해야 한다(경계 중간에 걸치면 등급이 잘려 보인다).
    // "확실한 소수" 방향이라 관찰 후보(observe) 이상만 노출한다.
    const observeMin = eg.find((g) => g.key === "observe").min;
    assert(eg.some((g) => g.min === CONFIG.earlyMinScore), "표시 하한이 밴드 경계와 안 맞음");
    assert(CONFIG.earlyMinScore >= observeMin, `표시 하한(${CONFIG.earlyMinScore})은 관찰 후보(${observeMin}) 이상이어야 함`);
  });

  test("핵심 소계 — 보조 항목만으로 끌어올린 후보는 제외된다", () => {
    // 실측 ZEC 형태: 장기선(15/15) 만점 + 박스위치로 총점은 나오지만
    // 핵심 3항목(압축·OI·고갈)이 약한 케이스. 총점이 높아도 후보가 아니어야 한다.
    const weakCore = baseMetrics({
      squeezePct: 28, oi: { change72h: 0.5, change12h: 1, prev12h: 0.5 },
      volDry: 0.98, rangePos: 1, closeAboveEma200: true,
    });
    const sc = scoreEarly(weakCore, CONFIG);
    const pct = coreStrengthPct(sc.breakdown, CONFIG.earlyCoreKeys);
    assert(pct < CONFIG.earlyCoreMinPct, `핵심 소계 ${pct.toFixed(0)}% 는 하한 미만이어야 함`);
    // 보조 항목이 만점이라 총점 자체는 낮지 않다 — 그래서 소계 게이트가 필요하다.
    assert(sc.score > CONFIG.earlyMinScore, `총점(${sc.score})만 보면 통과했을 것`);

    const strongCore = baseMetrics({
      squeezePct: 2, oi: { change72h: 12, change12h: 5, prev12h: 2 },
      volDry: 0.3, rangePos: 0, closeAboveEma200: false, ema200SlopeOk: false,
    });
    const pct2 = coreStrengthPct(scoreEarly(strongCore, CONFIG).breakdown, CONFIG.earlyCoreKeys);
    assert(pct2 >= CONFIG.earlyCoreMinPct, `핵심이 강하면 보조가 0이어도 통과 (실제 ${pct2.toFixed(0)}%)`);
  });

  test("핵심 항목 키는 채점 항목에 실제로 존재한다", () => {
    const keys = scoreEarly(baseMetrics(), CONFIG).breakdown.map((b) => b.key);
    for (const k of CONFIG.earlyCoreKeys) assert(keys.includes(k), `earlyCoreKeys 의 ${k} 가 breakdown 에 없음`);
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

  // 진폭이 줄어드는 완만한 상승 → 압축 19, 거래량 고갈 0.8, 종가가 EMA200 위(1단계 통과).
  // 예전 픽스처는 EMA200 조건에 걸려 항상 null 이었고 아래 테스트가 if(r) 로 감싸 아무것도
  // 검증하지 않았다. 결과가 실제로 나오는 픽스처여야 게이트 회귀를 잡는다.
  function earlyFixture() {
    const closes = Array.from({ length: 200 }, (_, i) => 100 + i * 0.06 + Math.sin(i / 5) * (5 * (1 - i / 200)));
    return {
      candles: candlesFromCloses(closes, { spread: 0.05, vol: (i) => (i < 180 ? 100 : 80) }),
      item: { symbol: "TESTUSDT", baseAsset: "TEST", quoteVolume: 5e7, change24h: 2, newListing: false },
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

  test("OI 조회 실패 — 핵심 소계 분모에서 oiBuildUp 을 뺀다", () => {
    // OI 없으면 oiBuildUp 은 늘 0점이다. 분모에 남기면 천장이 64% 로 내려가 이 픽스처가
    // 27.9% 로 탈락하고, early 모드가 OI 엔드포인트 하나 때문에 조용히 0건이 된다.
    const { candles, item } = earlyFixture();
    const r = buildEarlyResult(item, candles, [], null, CONFIG);
    assert(r != null, "OI 없다는 이유로 탈락시키면 안 됨");
    eq(r.early.oi.change72h, null, "픽스처 전제 — OI 는 없는 상태");
    assert(r.early.corePct >= CONFIG.earlyCoreMinPct,
      `분모에서 빠졌는지 확인 (실제 ${r.early.corePct.toFixed(1)}%)`);
    // OI 가 있으면 분모에 다시 들어가고 증가분이 점수에 반영된다(같은 캔들, OI 만 추가).
    const oiSeries = Array.from({ length: 73 }, (_, i) => ({ oi: 1000 + i * 2 }));
    assert(buildEarlyResult(item, candles, oiSeries, null, CONFIG).score > r.score,
      "OI 증가분이 점수에 반영돼야 함");
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
}
