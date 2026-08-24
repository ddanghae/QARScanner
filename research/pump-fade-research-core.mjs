// Pure research helpers for pump-fade labels and metrics.
// Production scoring must never import this file because it consumes post-signal candles.

export const HOUR_MS = 60 * 60 * 1000;
export const FIVE_MIN_MS = 5 * 60 * 1000;

const finite = (v) => Number.isFinite(v);
const round = (v, digits = 6) => finite(v) ? Number(v.toFixed(digits)) : null;

export function labelPumpFadeOutcome(candles5m, signalTime, entry, options = {}) {
  const horizonMs = options.horizonMs ?? 6 * HOUR_MS;
  const targetPct = options.targetPct ?? 8;
  const stopPct = options.stopPct ?? 5;
  const endTime = signalTime + horizonMs;
  if (!finite(signalTime) || !(entry > 0) || !Array.isArray(candles5m)) {
    return { status: "INCOMPLETE", returnPct: null, mfePct: null, maePct: null, endTime };
  }
  const future = candles5m
    .filter((c) => finite(c?.closeTime) && c.closeTime > signalTime && c.closeTime <= endTime)
    .sort((a, b) => a.closeTime - b.closeTime);
  if (!future.length) {
    return { status: "INCOMPLETE", returnPct: null, mfePct: null, maePct: null, endTime };
  }

  const target = entry * (1 - targetPct / 100);
  const stop = entry * (1 + stopPct / 100);
  let minLow = entry;
  let maxHigh = entry;
  let previousTime = signalTime;
  for (const candle of future) {
    // 누락 구간에서는 목표와 손절의 선후를 알 수 없으므로 라벨을 강제하지 않는다.
    if (candle.closeTime <= previousTime || candle.closeTime - previousTime > FIVE_MIN_MS + 1) {
      return { status: "INCOMPLETE", returnPct: null, mfePct: null, maePct: null, endTime };
    }
    if (!finite(candle?.low) || !finite(candle?.high) || !finite(candle?.close)) {
      return { status: "INCOMPLETE", returnPct: null, mfePct: null, maePct: null, endTime };
    }
    previousTime = candle.closeTime;
    minLow = Math.min(minLow, candle.low);
    maxHigh = Math.max(maxHigh, candle.high);
    const hitTarget = candle.low <= target;
    const hitStop = candle.high >= stop;
    const mfePct = ((entry - minLow) / entry) * 100;
    const maePct = ((maxHigh - entry) / entry) * 100;
    if (hitTarget && hitStop) {
      return { status: "AMBIGUOUS", returnPct: null, mfePct: round(mfePct), maePct: round(maePct), endTime };
    }
    if (hitTarget) {
      return { status: "HIT", returnPct: targetPct, mfePct: round(mfePct), maePct: round(maePct), endTime };
    }
    if (hitStop) {
      return { status: "STOP", returnPct: -stopPct, mfePct: round(mfePct), maePct: round(maePct), endTime };
    }
  }

  const last = future[future.length - 1];
  if (last.closeTime < endTime) {
    return {
      status: "INCOMPLETE",
      returnPct: null,
      mfePct: round(((entry - minLow) / entry) * 100),
      maePct: round(((maxHigh - entry) / entry) * 100),
      endTime,
    };
  }
  return {
    status: "MISS",
    returnPct: round(((entry - last.close) / entry) * 100),
    mfePct: round(((entry - minLow) / entry) * 100),
    maePct: round(((maxHigh - entry) / entry) * 100),
    endTime,
  };
}

function average(values) {
  const valid = values.filter(finite);
  return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
}

function profitFactor(returns) {
  const gains = returns.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const losses = Math.abs(returns.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  return losses > 0 ? gains / losses : null;
}

function maxDrawdown(samples) {
  const ordered = samples
    .filter((s) => finite(s?.outcome?.returnPct))
    .sort((a, b) => a.signalTime - b.signalTime);
  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  for (const sample of ordered) {
    equity *= Math.max(0, 1 + sample.outcome.returnPct / 100);
    peak = Math.max(peak, equity);
    if (peak > 0) maxDd = Math.max(maxDd, ((peak - equity) / peak) * 100);
  }
  return maxDd;
}

export function summarizeOutcomes(samples) {
  const all = Array.isArray(samples) ? samples : [];
  const ambiguous = all.filter((s) => s.outcome?.status === "AMBIGUOUS").length;
  const incomplete = all.filter((s) => s.outcome?.status === "INCOMPLETE").length;
  const evaluable = all.filter((s) => ["HIT", "STOP", "MISS"].includes(s.outcome?.status));
  const hits = evaluable.filter((s) => s.outcome.status === "HIT").length;
  const returns = evaluable.map((s) => s.outcome.returnPct).filter(finite);
  return {
    sampleCount: all.length,
    evaluableCount: evaluable.length,
    hitCount: hits,
    hitRate: evaluable.length ? round(hits / evaluable.length) : null,
    averageReturnPct: round(average(returns)),
    mfePct: round(average(evaluable.map((s) => s.outcome.mfePct))),
    maePct: round(average(evaluable.map((s) => s.outcome.maePct))),
    profitFactor: round(profitFactor(returns)),
    maxDrawdownPct: round(maxDrawdown(evaluable)),
    ambiguousCount: ambiguous,
    incompleteCount: incomplete,
  };
}

export function chronologicalBoundaries(startTime, endTime, trainRatio = 0.6, validationRatio = 0.2) {
  if (!finite(startTime) || !finite(endTime) || endTime <= startTime) throw new Error("유효한 시간 경계가 필요합니다.");
  if (!(trainRatio > 0) || !(validationRatio > 0) || trainRatio + validationRatio >= 1) {
    throw new Error("train/validation 비율이 잘못되었습니다.");
  }
  const span = endTime - startTime;
  return {
    startTime,
    trainEnd: startTime + span * trainRatio,
    validationEnd: startTime + span * (trainRatio + validationRatio),
    endTime,
  };
}

export function splitChronologically(samples, boundaries, horizonMs = 6 * HOUR_MS) {
  const out = { train: [], validation: [], test: [], purged: [] };
  for (const sample of samples || []) {
    const t = sample.signalTime;
    if (!finite(t) || t < boundaries.startTime || t > boundaries.endTime) continue;
    if (t < boundaries.trainEnd) {
      (t + horizonMs <= boundaries.trainEnd ? out.train : out.purged).push(sample);
    } else if (t < boundaries.validationEnd) {
      (t + horizonMs <= boundaries.validationEnd ? out.validation : out.purged).push(sample);
    } else {
      (t + horizonMs <= boundaries.endTime ? out.test : out.purged).push(sample);
    }
  }
  return out;
}

export function liftFrom(signalSummary, baseSummary) {
  if (!finite(signalSummary?.hitRate) || !finite(baseSummary?.hitRate) || baseSummary.hitRate <= 0) return null;
  return round(signalSummary.hitRate / baseSummary.hitRate);
}
