// core/direction-forecast.js — 스캐너 점수와 독립된 24시간 방향 확률 모델.
//
// 질문: 마지막 마감 4시간봉 이후 24시간(6봉) 안에, 해당 마감가와 변동성에 맞춘 위/아래 경계 중
// 어느 쪽을 먼저 건드리는가? 둘 다 안 건드리면 횡보다. 같은 봉에서 양쪽을 모두 건드린
// 학습 표본은 선후를 알 수 없어 제외한다.
//
// 주의: 이 확률은 TP/SL 도달률이나 수익 보장이 아니다. 스캐너 전략 점수도 입력하지 않는다.
// 그래야 경험 가중치인 reversal/pump_fade 점수를 확률로 둔갑시키지 않는다.

import { atr, ema, rsi } from "./indicators.js";
import { DIRECTION_MODEL } from "./direction-model-params.js";

export const DIRECTION_FEATURE_NAMES = [
  "ret4h", "ret24h", "ret72h", "ret14d", "rsi14", "ema20Gap", "ema50Gap",
  "atrPct", "relVol6", "rangePos20", "btcRet24h", "btcRet14d", "btcEma50Gap", "btcAtrPct",
];

export const DIRECTION_CLASSES = ["up", "down", "neutral"];

export const DIRECTION_FEATURE_LABELS = {
  ret4h: "최근 4시간 움직임",
  ret24h: "최근 24시간 움직임",
  ret72h: "최근 3일 흐름",
  ret14d: "최근 14일 추세",
  rsi14: "4시간 RSI 위치",
  ema20Gap: "4시간 EMA20 거리",
  ema50Gap: "4시간 EMA50 거리",
  atrPct: "현재 변동성",
  relVol6: "최근 거래량 변화",
  rangePos20: "최근 가격 범위 안 위치",
  btcRet24h: "BTC 최근 24시간 흐름",
  btcRet14d: "BTC 최근 14일 추세",
  btcEma50Gap: "BTC EMA50 거리",
  btcAtrPct: "BTC 변동성",
};

export { DIRECTION_MODEL };

const finite = (v) => Number.isFinite(v);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const pct = (now, then) => finite(now) && finite(then) && then !== 0 ? ((now / then) - 1) * 100 : null;
const signedLog = (v, scale) => finite(v) ? Math.asinh(v / scale) : null;
const safeLog = (v) => finite(v) && v >= 0 ? Math.log(v + 0.1) : null;

function average(values) {
  const valid = values.filter(finite);
  return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
}

export function buildDirectionSeries(candles) {
  const list = Array.isArray(candles) ? candles : [];
  const closes = list.map((c) => Number(c.close));
  return {
    candles: list,
    closes,
    rsi14: rsi(closes, 14),
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    atr14: atr(list, 14),
  };
}

function atOrBefore(series, closeTime) {
  if (!series?.candles?.length || !finite(closeTime)) return -1;
  let lo = 0, hi = series.candles.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = Number(series.candles[mid]?.closeTime ?? series.candles[mid]?.time);
    if (finite(t) && t <= closeTime) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best;
}

function rawFeatures(series, index) {
  if (!series?.candles?.length || index < 84 || index >= series.candles.length) return null;
  const c = series.candles[index];
  const close = series.closes[index];
  const atrNow = series.atr14[index];
  const e20 = series.ema20[index];
  const e50 = series.ema50[index];
  if (![close, atrNow, e20, e50, series.rsi14[index]].every(finite) || close <= 0) return null;

  const recentVol = average(series.candles.slice(index - 5, index + 1).map((x) => Number(x.volume)));
  const priorVol = average(series.candles.slice(index - 35, index - 5).map((x) => Number(x.volume)));
  const range = series.candles.slice(index - 19, index + 1);
  const high20 = Math.max(...range.map((x) => Number(x.high)));
  const low20 = Math.min(...range.map((x) => Number(x.low)));
  const rangePos = high20 > low20 ? (close - low20) / (high20 - low20) : 0.5;

  return {
    close,
    atrPctRaw: (atrNow / close) * 100,
    values: {
      ret4h: signedLog(pct(close, series.closes[index - 1]), 3),
      ret24h: signedLog(pct(close, series.closes[index - 6]), 5),
      ret72h: signedLog(pct(close, series.closes[index - 18]), 8),
      ret14d: signedLog(pct(close, series.closes[index - 84]), 15),
      rsi14: (series.rsi14[index] - 50) / 25,
      ema20Gap: signedLog(pct(close, e20), 3),
      ema50Gap: signedLog(pct(close, e50), 5),
      atrPct: safeLog((atrNow / close) * 100),
      relVol6: safeLog(priorVol > 0 ? recentVol / priorVol : 1),
      rangePos20: clamp(rangePos * 2 - 1, -1, 1),
    },
  };
}

export function directionFeaturesAt(series, index, btcSeries = null, btcIndex = null) {
  const base = rawFeatures(series, index);
  if (!base) return null;
  let bi = btcIndex;
  if (!Number.isInteger(bi)) {
    const c = series.candles[index];
    bi = atOrBefore(btcSeries, Number(c?.closeTime ?? c?.time));
  }
  const btc = rawFeatures(btcSeries, bi);
  if (!btc) return null;
  const values = {
    ...base.values,
    btcRet24h: btc.values.ret24h,
    btcRet14d: btc.values.ret14d,
    btcEma50Gap: btc.values.ema50Gap,
    btcAtrPct: btc.values.atrPct,
  };
  const vector = DIRECTION_FEATURE_NAMES.map((name) => values[name]);
  if (!vector.every(finite)) return null;
  return { vector, values, close: base.close, atrPctRaw: base.atrPctRaw, btcIndex: bi };
}

export function extractDirectionFeatures(candles, btcCandles) {
  const series = buildDirectionSeries(candles);
  const btcSeries = buildDirectionSeries(btcCandles);
  return directionFeaturesAt(series, series.candles.length - 1, btcSeries);
}

export function directionThresholdPct(atrPct, model = DIRECTION_MODEL) {
  if (!finite(atrPct)) return null;
  return clamp(
    atrPct * (model.thresholdAtr ?? 1.5),
    model.minThresholdPct ?? 2,
    model.maxThresholdPct ?? 8,
  );
}

// 연구 전용 라벨러도 이 순수 함수를 사용한다. signalIndex 이후 봉만 소비한다.
export function labelDirectionOutcome(candles, signalIndex, thresholdPct, horizonBars = 6) {
  const entry = Number(candles?.[signalIndex]?.close);
  if (!(entry > 0) || !(thresholdPct > 0)) return { outcome: "incomplete" };
  const upBarrier = entry * (1 + thresholdPct / 100);
  const downBarrier = entry * (1 - thresholdPct / 100);
  const end = Math.min(candles.length - 1, signalIndex + horizonBars);
  if (end < signalIndex + horizonBars) return { outcome: "incomplete", upBarrier, downBarrier };
  for (let i = signalIndex + 1; i <= end; i++) {
    const high = Number(candles[i]?.high), low = Number(candles[i]?.low);
    if (!finite(high) || !finite(low)) return { outcome: "incomplete", upBarrier, downBarrier };
    const up = high >= upBarrier;
    const down = low <= downBarrier;
    if (up && down) return { outcome: "ambiguous", upBarrier, downBarrier, hitIndex: i };
    if (up) return { outcome: "up", upBarrier, downBarrier, hitIndex: i };
    if (down) return { outcome: "down", upBarrier, downBarrier, hitIndex: i };
  }
  return { outcome: "neutral", upBarrier, downBarrier, hitIndex: end };
}

function softmax(logits) {
  const max = Math.max(...logits);
  const exps = logits.map((x) => Math.exp(x - max));
  const sum = exps.reduce((a, b) => a + b, 0) || 1;
  return exps.map((x) => x / sum);
}

function roundedPercents(probs) {
  const raw = probs.map((p) => p * 100);
  const out = raw.map(Math.floor);
  let remain = 100 - out.reduce((a, b) => a + b, 0);
  const order = raw.map((v, i) => ({ i, frac: v - out[i] })).sort((a, b) => b.frac - a.frac);
  for (let i = 0; i < remain; i++) out[order[i % order.length].i]++;
  return out;
}

function entropy(probs) {
  const h = -probs.reduce((sum, p) => sum + (p > 0 ? p * Math.log(p) : 0), 0);
  return h / Math.log(probs.length);
}

const sigmoid = (v) => 1 / (1 + Math.exp(-clamp(v, -35, 35)));
const linearScore = (spec, z) => spec.bias + spec.weights.reduce((sum, w, j) => sum + w * z[j], 0);

function modelProbabilities(z, model) {
  const p = model.params || {};
  if (model.type === "multinomial_logit") {
    const temp = p.temperature > 0 ? p.temperature : 1;
    return softmax(p.bias.map((b, i) =>
      (b + p.weights[i].reduce((sum, w, j) => sum + w * z[j], 0)) / temp
    ));
  }
  if (model.type === "factorized_logit") {
    const moveRaw = linearScore(p.moveModel, z);
    const upRaw = linearScore(p.upModel, z);
    const move = sigmoid(p.moveCalibration.scale * moveRaw + p.moveCalibration.bias);
    const upGivenMove = sigmoid(p.upCalibration.scale * upRaw + p.upCalibration.bias);
    return [move * upGivenMove, move * (1 - upGivenMove), 1 - move];
  }
  if (model.type === "gaussian_nb") {
    const raw = DIRECTION_CLASSES.map((_, k) => {
      let out = Math.log(p.priors[k]);
      for (let j = 0; j < z.length; j++) {
        const variance = Math.max(1e-6, p.variances[k][j]);
        out += -0.5 * (Math.log(2 * Math.PI * variance) + ((z[j] - p.means[k][j]) ** 2) / variance);
      }
      return out / (p.temperature > 0 ? p.temperature : 1);
    });
    return softmax(raw);
  }
  if (model.type === "extra_trees") {
    const sum = new Array(DIRECTION_CLASSES.length).fill(0);
    for (const tree of p.trees || []) {
      let node = tree;
      while (node && !node.probs) node = z[node.feature] <= node.threshold ? node.left : node.right;
      if (!node?.probs) return null;
      for (let k = 0; k < sum.length; k++) sum[k] += node.probs[k];
    }
    if (!p.trees?.length) return null;
    const blend = clamp(p.blend ?? 0, 0, 1);
    return sum.map((value, k) => (value / p.trees.length) * (1 - blend) + p.priors[k] * blend);
  }
  return null;
}

function driverEffects(z, leadIndex, model) {
  const p = model.params || {};
  if (model.type === "multinomial_logit") {
    const other = DIRECTION_CLASSES.map((_, i) => i).filter((i) => i !== leadIndex);
    return z.map((value, j) => {
      const lead = p.weights[leadIndex][j] * value;
      const rest = other.reduce((sum, i) => sum + p.weights[i][j] * value, 0) / other.length;
      return lead - rest;
    });
  }
  if (model.type === "factorized_logit") {
    return z.map((value, j) => {
      const move = p.moveModel.weights[j] * p.moveCalibration.scale;
      const up = p.upModel.weights[j] * p.upCalibration.scale;
      const combined = leadIndex === 0 ? move + up : leadIndex === 1 ? move - up : -move;
      return combined * value;
    });
  }
  if (model.type === "gaussian_nb") {
    const other = DIRECTION_CLASSES.map((_, i) => i).filter((i) => i !== leadIndex);
    return z.map((value, j) => {
      const ll = (k) => {
        const variance = Math.max(1e-6, p.variances[k][j]);
        return -0.5 * (Math.log(2 * Math.PI * variance) + ((value - p.means[k][j]) ** 2) / variance);
      };
      return ll(leadIndex) - other.reduce((sum, i) => sum + ll(i), 0) / other.length;
    });
  }
  if (model.type === "extra_trees") {
    const used = new Array(z.length).fill(0);
    for (const tree of p.trees || []) {
      let node = tree;
      while (node && !node.probs) {
        used[node.feature]++;
        node = z[node.feature] <= node.threshold ? node.left : node.right;
      }
    }
    return used.map((count, j) => count * Math.abs(z[j]));
  }
  return z.map(() => 0);
}

function driverList(z, leadIndex, model) {
  return driverEffects(z, leadIndex, model).map((effect, j) => ({
    key: DIRECTION_FEATURE_NAMES[j], label: DIRECTION_FEATURE_LABELS[DIRECTION_FEATURE_NAMES[j]], effect,
  })).filter((x) => x.effect > 0).sort((a, b) => b.effect - a.effect).slice(0, 3);
}

export function forecastDirection(candles, btcCandles, options = {}, model = DIRECTION_MODEL) {
  if (!model?.ready) return { available: false, reason: "방향 모델이 준비되지 않았습니다." };
  const f = extractDirectionFeatures(candles, btcCandles);
  if (!f) return { available: false, reason: "4시간봉 이력이 부족합니다." };
  if (model.featureNames.join("|") !== DIRECTION_FEATURE_NAMES.join("|") ||
      model.mean.length !== f.vector.length || model.sd.length !== f.vector.length) {
    return { available: false, reason: "방향 모델과 입력 형식이 맞지 않습니다." };
  }
  const z = f.vector.map((v, i) => (v - model.mean[i]) / (model.sd[i] || 1));
  const probs = modelProbabilities(z, model);
  if (!probs || probs.length !== DIRECTION_CLASSES.length || !probs.every(finite)) {
    return { available: false, reason: "방향 모델 계산에 실패했습니다." };
  }
  const [up, down, neutral] = roundedPercents(probs);
  const leadIndex = probs.indexOf(Math.max(...probs));
  const thresholdPct = directionThresholdPct(f.atrPctRaw, model);
  const maxZ = Math.max(...z.map(Math.abs));
  const uncertain = entropy(probs) > 0.94 || Math.max(...probs) < 0.46;
  const ood = maxZ > 4.5;
  let confidence = uncertain ? "low" : Math.max(...probs) >= 0.6 ? "high" : "medium";
  if (ood || options.provisional) confidence = "low";
  return {
    available: true,
    modelVersion: model.version,
    dataAsOf: model.dataAsOf,
    horizonHours: model.horizonBars * 4,
    referencePrice: f.close,
    thresholdPct,
    upperBoundary: f.close * (1 + thresholdPct / 100),
    lowerBoundary: f.close * (1 - thresholdPct / 100),
    up, down, neutral,
    lead: DIRECTION_CLASSES[leadIndex],
    confidence,
    provisional: Boolean(options.provisional),
    outOfDistribution: ood,
    sampleCount: model.metrics?.sampleCount ?? null,
    testMetrics: model.metrics?.test ?? null,
    drivers: driverList(z, leadIndex, model),
    definition: "마지막 4시간 마감가에서 24시간 안에 변동성 경계를 먼저 건드리는 방향",
  };
}

export default {
  DIRECTION_MODEL, DIRECTION_FEATURE_NAMES, DIRECTION_CLASSES,
  buildDirectionSeries, directionFeaturesAt, extractDirectionFeatures,
  directionThresholdPct, labelDirectionOutcome, forecastDirection,
};
