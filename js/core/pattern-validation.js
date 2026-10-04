// Pattern validation and signal freshness helpers.
// These calculations are time ordered: a pattern only sees candles that existed
// at its cutoff, and its outcome only sees candles after that cutoff.

import { detectChartPatterns } from "./chart-patterns.js";

const TIMEFRAME_MS = { "5m": 5 * 60_000, "15m": 15 * 60_000, "1h": 60 * 60_000, "4h": 4 * 60 * 60_000 };
const finite = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));

export function timeframeDurationMs(timeframe) { return TIMEFRAME_MS[timeframe] || 60 * 60_000; }

/** Classify how old the latest closed candle is. This is freshness, not confidence. */
export function signalFreshness(latestCandleTime, timeframe, now = Date.now(), includeRealtime = false) {
  if (!finite(latestCandleTime)) return { status: "unknown", ageMs: null, timeframe, at: null };
  const at = Number(latestCandleTime), ageMs = Math.max(0, Number(now) - at), duration = timeframeDurationMs(timeframe);
  const freshLimit = duration * (includeRealtime ? 1.75 : 1.25);
  const delayedLimit = duration * (includeRealtime ? 3 : 2.5);
  const status = ageMs <= freshLimit ? "fresh" : ageMs <= delayedLimit ? "delayed" : "stale";
  return { status, ageMs, timeframe, at };
}

export function outcomeSummary(samples) {
  const wins = samples.filter((sample) => sample.status === "win").length;
  const losses = samples.filter((sample) => sample.status === "loss").length;
  const closed = wins + losses;
  const totalR = samples.filter(sample => ["win", "loss"].includes(sample.status)).reduce((sum, sample) => sum + (Number(sample.r) || 0), 0);
  return {
    n: samples.length, wins, losses,
    open: samples.filter((sample) => sample.status === "open").length,
    untriggered: samples.filter(sample => sample.status === "untriggered").length,
    unrealizedR: samples.filter(sample => sample.status === "open").reduce((sum, sample) => sum + (Number(sample.r) || 0), 0),
    insufficient: samples.filter((sample) => sample.status === "insufficient").length,
    closed,
    winRate: closed ? Math.round(wins / closed * 100) : null,
    avgR: closed ? Math.round(totalR / closed * 100) / 100 : null,
    totalR: Math.round(totalR * 100) / 100,
  };
}

function groupSummary(samples, key) {
  const map = new Map();
  for (const sample of samples) {
    const name = sample[key] || "unknown";
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(sample);
  }
  return Object.fromEntries([...map.entries()].map(([name, rows]) => [name, outcomeSummary(rows)]));
}

/** Evaluate a detected structure against future bars. Stop wins if both levels touch in one candle. */
export function evaluatePatternOutcome(pattern, futureBars, { horizonBars = 24 } = {}) {
  const direction = pattern?.bias === "bullish" ? "long" : pattern?.bias === "bearish" ? "short" : null;
  const entry = Number(pattern?.trigger), stop = Number(pattern?.invalidation), target = Number(pattern?.projection);
  if (!direction || ![pattern?.trigger, pattern?.invalidation, pattern?.projection].every(finite)) return { status: "insufficient", r: 0 };
  const valid = direction === "long" ? stop < entry && target > entry : stop > entry && target < entry;
  if (!valid) return { status: "insufficient", r: 0 };
  const risk = Math.abs(entry - stop), bars = (futureBars || []).slice(0, Math.max(1, horizonBars));
  if (!bars.length) return { status: "insufficient", r: 0 };
  let entered = false, entryAt = null;
  for (const bar of bars) {
    let enteredThisBar = false;
    if (!entered) {
      // Conditional retest at trigger: never assume a fill outside the candle range.
      if (Number(bar.low) > entry || Number(bar.high) < entry) {
        const invalid = direction === "long" ? Number(bar.low) <= stop : Number(bar.high) >= stop;
        if (invalid) return { status: "untriggered", r: 0, reason: "진입 전 구조 무효" };
        continue;
      }
      entered = true;
      enteredThisBar = true;
      entryAt = bar.closeTime ?? bar.openTime ?? null;
    }
    const hitStop = direction === "long" ? Number(bar.low) <= stop : Number(bar.high) >= stop;
    const hitTarget = direction === "long" ? Number(bar.high) >= target : Number(bar.low) <= target;
    if (hitStop) return { status: "loss", r: -1, entryAt, exitAt: bar.closeTime ?? bar.openTime ?? null, exitPx: stop };
    // A candle's high may precede a retest fill. Do not award an ambiguous entry-bar target.
    const targetAfterFill = !enteredThisBar || (direction === "long"
      ? (finite(bar.open) && Number(bar.open) <= entry) || Number(bar.close) >= target
      : (finite(bar.open) && Number(bar.open) >= entry) || Number(bar.close) <= target);
    if (hitTarget && targetAfterFill) return { status: "win", r: Math.abs(target - entry) / risk, entryAt, exitAt: bar.closeTime ?? bar.openTime ?? null, exitPx: target };
  }
  if (!entered) return { status: "untriggered", r: 0 };
  const last = bars.at(-1), mark = Number(last.close);
  const r = finite(mark) ? (direction === "long" ? mark - entry : entry - mark) / risk : 0;
  return { status: "open", r: Math.round(r * 100) / 100, entryAt, exitAt: null, exitPx: mark };
}

function actionable(pattern, minFit) {
  return pattern && !pattern.provisional && (pattern.status === "breakout" || pattern.status === "reaction") && (pattern.bias === "bullish" || pattern.bias === "bearish")
    && Number(pattern.fitScore) >= minFit
    && [pattern.trigger, pattern.invalidation, pattern.projection].every(finite)
    && Math.abs(pattern.projection - pattern.trigger) / Math.abs(pattern.trigger - pattern.invalidation) >= 1.5;
}

/** Time ordered replay over one OHLCV series. Descriptive evidence, not a calibrated probability. */
export function replayPatternHistory(bars, {
  pivotDepth = 3, horizonBars = 24, warmup = 60, step = 6, maxSamples = 12,
  minFit = 55, trainRatio = 0.7, cooldownBars = 6,
} = {}) {
  const source = Array.isArray(bars) ? bars.filter(Boolean) : [];
  const samples = [], lastCounted = new Map();
  const firstCutoff = Math.max(30, warmup), lastCutoff = source.length - Math.max(1, horizonBars);
  const splitCutoff = Math.floor(source.length * trainRatio);
  let nextEligible = firstCutoff;
  if (lastCutoff <= firstCutoff) return buildReplayResult(samples, splitCutoff, horizonBars);
  for (let cutoff = firstCutoff; cutoff <= lastCutoff && samples.length < maxSamples; cutoff += Math.max(1, step)) {
    if (cutoff < nextEligible || (cutoff < splitCutoff && cutoff + horizonBars > splitCutoff)) continue;
    const found = detectChartPatterns(source.slice(0, cutoff), { pivotDepth })
      .filter((pattern) => actionable(pattern, minFit))
      .sort((a, b) => Number(b.fitScore) - Number(a.fitScore));
    const pattern = found.find((candidate) => cutoff - (lastCounted.get(candidate.id) ?? -Infinity) >= cooldownBars);
    if (!pattern) continue;
    lastCounted.set(pattern.id, cutoff);
    const outcome = evaluatePatternOutcome(pattern, source.slice(cutoff), { horizonBars });
    if (outcome.status === "insufficient") continue;
    samples.push({ cutoff, patternId: pattern.id, patternName: pattern.name, family: pattern.family, bias: pattern.bias, fitScore: pattern.fitScore, ...outcome });
    nextEligible = cutoff + horizonBars;
  }
  return buildReplayResult(samples, splitCutoff, horizonBars);
}

function buildReplayResult(samples, splitCutoff, horizonBars) {
  const train = samples.filter(sample => sample.cutoff + horizonBars <= splitCutoff), validation = samples.filter(sample => sample.cutoff >= splitCutoff);
  return {
    sampleCount: samples.length, summary: outcomeSummary(samples), byPattern: groupSummary(samples, "patternId"), byFamily: groupSummary(samples, "family"),
    train: outcomeSummary(train), validation: outcomeSummary(validation), samples,
    label: validation.length >= 10 ? "조건부 구조 재시험 · 타점 전략 성과 아님" : "표본 부족",
  };
}

export default { signalFreshness, timeframeDurationMs, evaluatePatternOutcome, replayPatternHistory };
