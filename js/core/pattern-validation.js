// Pattern validation and signal freshness helpers.
// These calculations are time ordered: a pattern only sees candles that existed
// at its cutoff, and its outcome only sees candles after that cutoff.

import { detectChartPatterns } from "./chart-patterns.js";

const TIMEFRAME_MS = { "5m": 5 * 60_000, "15m": 15 * 60_000, "1h": 60 * 60_000, "4h": 4 * 60 * 60_000 };
const finite = (value) => Number.isFinite(Number(value));

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

function outcomeSummary(samples) {
  const wins = samples.filter((sample) => sample.status === "win").length;
  const losses = samples.filter((sample) => sample.status === "loss").length;
  const closed = wins + losses;
  const totalR = samples.reduce((sum, sample) => sum + (Number(sample.r) || 0), 0);
  return {
    n: samples.length, wins, losses,
    open: samples.filter((sample) => sample.status === "open").length,
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
  if (!direction || ![entry, stop, target].every(finite)) return { status: "insufficient", r: 0 };
  const valid = direction === "long" ? stop < entry && target > entry : stop > entry && target < entry;
  if (!valid) return { status: "insufficient", r: 0 };
  const risk = Math.abs(entry - stop), bars = (futureBars || []).slice(0, Math.max(1, horizonBars));
  if (!bars.length) return { status: "insufficient", r: 0 };
  for (const bar of bars) {
    const hitStop = direction === "long" ? Number(bar.low) <= stop : Number(bar.high) >= stop;
    const hitTarget = direction === "long" ? Number(bar.high) >= target : Number(bar.low) <= target;
    if (hitStop) return { status: "loss", r: -1, exitAt: bar.closeTime ?? bar.openTime ?? null, exitPx: stop };
    if (hitTarget) return { status: "win", r: Math.abs(target - entry) / risk, exitAt: bar.closeTime ?? bar.openTime ?? null, exitPx: target };
  }
  const last = bars.at(-1), mark = Number(last.close);
  const r = finite(mark) ? (direction === "long" ? mark - entry : entry - mark) / risk : 0;
  return { status: "open", r: Math.round(r * 100) / 100, exitAt: null, exitPx: mark };
}

function actionable(pattern, minFit) {
  return pattern && (pattern.bias === "bullish" || pattern.bias === "bearish")
    && Number(pattern.fitScore) >= minFit
    && [pattern.trigger, pattern.invalidation, pattern.projection].every(finite);
}

/** Time ordered replay over one OHLCV series. Descriptive evidence, not a calibrated probability. */
export function replayPatternHistory(bars, {
  pivotDepth = 3, horizonBars = 24, warmup = 60, step = 6, maxSamples = 12,
  minFit = 55, trainRatio = 0.7, cooldownBars = 6,
} = {}) {
  const source = Array.isArray(bars) ? bars.filter(Boolean) : [];
  const samples = [], lastCounted = new Map();
  const firstCutoff = Math.max(30, warmup), lastCutoff = source.length - Math.max(1, horizonBars);
  if (lastCutoff <= firstCutoff) return buildReplayResult(samples, trainRatio);
  for (let cutoff = firstCutoff; cutoff <= lastCutoff && samples.length < maxSamples; cutoff += Math.max(1, step)) {
    const found = detectChartPatterns(source.slice(0, cutoff), { pivotDepth })
      .filter((pattern) => actionable(pattern, minFit))
      .sort((a, b) => Number(b.fitScore) - Number(a.fitScore));
    const pattern = found.find((candidate) => cutoff - (lastCounted.get(candidate.id) ?? -Infinity) >= cooldownBars);
    if (!pattern) continue;
    lastCounted.set(pattern.id, cutoff);
    const outcome = evaluatePatternOutcome(pattern, source.slice(cutoff), { horizonBars });
    if (outcome.status === "insufficient") continue;
    samples.push({ cutoff, patternId: pattern.id, patternName: pattern.name, family: pattern.family, bias: pattern.bias, fitScore: pattern.fitScore, ...outcome });
  }
  return buildReplayResult(samples, trainRatio);
}

function buildReplayResult(samples, trainRatio) {
  const splitAt = samples.length ? Math.max(1, Math.min(samples.length - 1, Math.round(samples.length * trainRatio))) : 0;
  const train = samples.slice(0, splitAt), validation = samples.slice(splitAt);
  return {
    sampleCount: samples.length, summary: outcomeSummary(samples), byPattern: groupSummary(samples, "patternId"), byFamily: groupSummary(samples, "family"),
    train: outcomeSummary(train), validation: outcomeSummary(validation), samples,
    label: validation.length >= 10 ? "참고용 검증" : "표본 부족",
  };
}

export default { signalFreshness, timeframeDurationMs, evaluatePatternOutcome, replayPatternHistory };
