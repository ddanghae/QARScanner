import { suite, test, assert, eq } from "./harness.js";
import {
  DIRECTION_FEATURE_NAMES,
  buildDirectionSeries,
  directionFeaturesAt,
  directionThresholdPct,
  forecastDirection,
  labelDirectionOutcome,
} from "../js/core/direction-forecast.js";
import { DIRECTION_MODEL } from "../js/core/direction-model-params.js";

function candles(n = 100, start = 100, step = 0.2, timeOffset = 0) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const close = start + step * i;
    out.push({
      openTime: timeOffset + i * 4 * 60 * 60 * 1000,
      closeTime: timeOffset + (i + 1) * 4 * 60 * 60 * 1000 - 1,
      open: close - step / 2, high: close + 1, low: close - 1, close,
      volume: 1000 + i * 2, quoteVolume: close * (1000 + i * 2),
    });
  }
  return out;
}

const fixtureModel = {
  version: 99,
  ready: true,
  dataAsOf: "2026-08-01T00:00:00.000Z",
  horizonBars: 6,
  thresholdAtr: 1.5,
  minThresholdPct: 2,
  maxThresholdPct: 8,
  featureNames: DIRECTION_FEATURE_NAMES,
  mean: new Array(DIRECTION_FEATURE_NAMES.length).fill(0),
  sd: new Array(DIRECTION_FEATURE_NAMES.length).fill(1),
  type: "multinomial_logit",
  params: {
    weights: [
      new Array(DIRECTION_FEATURE_NAMES.length).fill(0),
      new Array(DIRECTION_FEATURE_NAMES.length).fill(0),
      new Array(DIRECTION_FEATURE_NAMES.length).fill(0),
    ],
    bias: [1, 0, -1],
    temperature: 1,
  },
  metrics: { sampleCount: 1000, test: { accuracy: 0.5 } },
};

export function run() {
  suite("direction forecast");
  test("[direction] 특징 벡터는 현재까지의 4시간봉과 BTC만 사용한다", () => {
    const c = candles();
    const btc = candles(100, 1000, 1);
    const series = buildDirectionSeries(c);
    const b = buildDirectionSeries(btc);
    const f = directionFeaturesAt(series, 90, b, 90);
    eq(f.vector.length, DIRECTION_FEATURE_NAMES.length, "특징 수");
    assert(f.vector.every(Number.isFinite), "모든 특징 유한");
    const changedFuture = c.map((x, i) => i > 90 ? { ...x, close: x.close * 10, high: x.high * 10 } : x);
    const f2 = directionFeaturesAt(buildDirectionSeries(changedFuture), 90, b, 90);
    eq(JSON.stringify(f.vector), JSON.stringify(f2.vector), "미래 봉 변경이 현재 특징을 바꾸지 않음");
  });

  test("[direction] 변동성 경계는 2~8%로 제한된다", () => {
    eq(directionThresholdPct(0.1), 2, "하한");
    eq(directionThresholdPct(10), 8, "상한");
    eq(directionThresholdPct(2), 3, "ATR 1.5배");
  });

  test("[direction] 라벨은 상승·하락·횡보·동일봉 모호성을 분리한다", () => {
    const base = candles(10, 100, 0);
    const up = base.map((c) => ({ ...c })); up[4].high = 103;
    const down = base.map((c) => ({ ...c })); down[4].low = 97;
    const both = base.map((c) => ({ ...c })); both[4].high = 103; both[4].low = 97;
    eq(labelDirectionOutcome(up, 2, 2, 6).outcome, "up", "상승");
    eq(labelDirectionOutcome(down, 2, 2, 6).outcome, "down", "하락");
    eq(labelDirectionOutcome(base, 2, 5, 6).outcome, "neutral", "횡보");
    eq(labelDirectionOutcome(both, 2, 2, 6).outcome, "ambiguous", "동일봉 양쪽");
    eq(labelDirectionOutcome(base, 8, 2, 6).outcome, "incomplete", "미래 구간 부족");
  });

  test("[direction] 세 확률은 100%이고 예측 근거·기간·경계를 제공한다", () => {
    const f = forecastDirection(candles(), candles(100, 1000, 1), {}, fixtureModel);
    assert(f.available, "예측 가능");
    eq(f.up + f.down + f.neutral, 100, "확률 합");
    eq(f.lead, "up", "최대 확률 방향");
    eq(f.horizonHours, 24, "24시간");
    assert(f.thresholdPct >= 2 && f.thresholdPct <= 8, "경계 범위");
    assert(f.referencePrice > 0, "마지막 4시간 마감 기준가격");
    assert(f.upperBoundary > f.referencePrice && f.lowerBoundary < f.referencePrice, "위아래 경계가격");
    assert(Array.isArray(f.drivers), "설명 근거");
  });

  test("[direction] 준비되지 않은 모델은 확률을 꾸며내지 않는다", () => {
    const f = forecastDirection(candles(), candles(100, 1000, 1), {}, { ready: false });
    assert(!f.available && f.reason, "산출 보류");
  });

  test("[direction] 후보 모델 3종의 배포 추론 경로가 모두 유효하다", () => {
    const base = { ...fixtureModel };
    const factorized = {
      ...base,
      type: "factorized_logit",
      params: {
        moveModel: { weights: new Array(DIRECTION_FEATURE_NAMES.length).fill(0), bias: 1 },
        upModel: { weights: new Array(DIRECTION_FEATURE_NAMES.length).fill(0), bias: 1 },
        moveCalibration: { scale: 1, bias: 0 },
        upCalibration: { scale: 1, bias: 0 },
      },
    };
    const gaussian = {
      ...base,
      type: "gaussian_nb",
      params: {
        priors: [0.4, 0.3, 0.3],
        means: Array.from({ length: 3 }, () => new Array(DIRECTION_FEATURE_NAMES.length).fill(0)),
        variances: Array.from({ length: 3 }, () => new Array(DIRECTION_FEATURE_NAMES.length).fill(1)),
        temperature: 1,
      },
    };
    const forest = {
      ...base,
      type: "extra_trees",
      params: {
        trees: [{ probs: [0.6, 0.2, 0.2], n: 100 }],
        priors: [0.4, 0.3, 0.3], blend: 0.2,
      },
    };
    for (const model of [factorized, gaussian, forest]) {
      const f = forecastDirection(candles(), candles(100, 1000, 1), {}, model);
      assert(f.available, `${model.type} 산출`);
      eq(f.up + f.down + f.neutral, 100, `${model.type} 확률 합`);
    }
  });

  test("[direction] 함께 배포되는 모델은 검증 게이트를 통과했다", () => {
    assert(DIRECTION_MODEL.ready, "배포 모델 활성화");
    assert(DIRECTION_MODEL.promotionGate?.passed, "승격 게이트 통과");
    eq(DIRECTION_MODEL.type, "factorized_logit", "검증 구간에서 선택한 모델");
    assert(DIRECTION_MODEL.metrics?.test?.n >= 5000, "충분한 시험 표본");
    assert(
      DIRECTION_MODEL.promotionGate.selectedTest.logLoss
        < DIRECTION_MODEL.promotionGate.priorTest.logLoss,
      "시험 log loss 기준선 개선",
    );
    assert(
      DIRECTION_MODEL.promotionGate.selectedTest.brier
        < DIRECTION_MODEL.promotionGate.priorTest.brier,
      "시험 Brier 기준선 개선",
    );
  });
}

export default { run };
