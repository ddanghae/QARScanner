// Confirmed-fractal context for chart patterns. Pass only candles closed by
// the assessment timestamp; no future candle is needed to classify a pivot.

const DETECTOR_WINDOW = 240;

export function confirmedFractalTrend(closedBars, depth = 3) {
  const bars = Array.isArray(closedBars) ? closedBars.slice(-DETECTOR_WINDOW) : [];
  const highs = [], lows = [];
  for (let i = depth; i < bars.length - depth; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - depth; j <= i + depth; j++) {
      if (i === j) continue;
      if (bars[i].high <= bars[j].high) isHigh = false;
      if (bars[i].low >= bars[j].low) isLow = false;
    }
    if (isHigh) highs.push(bars[i].high);
    if (isLow) lows.push(bars[i].low);
  }
  if (highs.length < 2 || lows.length < 2) return "insufficient";
  if (highs.at(-1) > highs.at(-2) && lows.at(-1) > lows.at(-2)) return "up";
  if (highs.at(-1) < highs.at(-2) && lows.at(-1) < lows.at(-2)) return "down";
  return "mixed";
}

function actionable(pattern, minFit) {
  if (!pattern || !["bullish", "bearish"].includes(pattern.bias) || Number(pattern.fitScore) < minFit) return false;
  const [trigger, invalidation, projection] = [pattern.trigger, pattern.invalidation, pattern.projection].map(Number);
  if (![trigger, invalidation, projection].every(Number.isFinite)) return false;
  return pattern.bias === "bullish"
    ? invalidation < trigger && trigger < projection
    : projection < trigger && trigger < invalidation;
}

export function highestActionablePattern(patterns, minFit = 55) {
  return (patterns || []).filter((pattern) => actionable(pattern, minFit))
    .sort((a, b) => Number(b.fitScore) - Number(a.fitScore))[0] || null;
}

export function assessFractalContinuation(closedBars, patterns, { pivotDepth = 3, minFit = 55, asOf = Date.now() } = {}) {
  const lastBar = closedBars?.at(-1);
  if (Number.isFinite(Number(lastBar?.closeTime)) && Number(lastBar.closeTime) > asOf) {
    return { matched: false, reason: "unfinished-candle", pattern: null, fractalTrend: "insufficient", fractalAlignment: "insufficient" };
  }
  const pattern = highestActionablePattern(patterns, minFit);
  if (!pattern) return { matched: false, reason: "no-actionable-pattern", pattern: null, fractalTrend: "insufficient", fractalAlignment: "insufficient" };
  const trend = confirmedFractalTrend(closedBars, pivotDepth);
  const aligned = (pattern.bias === "bullish" && trend === "up") || (pattern.bias === "bearish" && trend === "down");
  const opposed = (pattern.bias === "bullish" && trend === "down") || (pattern.bias === "bearish" && trend === "up");
  const alignment = aligned ? "aligned" : opposed ? "opposed" : trend;
  return {
    matched: pattern.family === "continuation" && aligned,
    reason: pattern.family !== "continuation" ? "not-continuation" : aligned ? "matched" : "fractal-not-aligned",
    pattern, fractalTrend: trend, fractalAlignment: alignment,
  };
}

export default { confirmedFractalTrend, highestActionablePattern, assessFractalContinuation };
