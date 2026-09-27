// Per-symbol directional evidence from detected patterns and EMA200 context.
// These heuristic shares summarize evidence; they are not probabilities or backtested win rates.

export const PATTERN_DIRECTION_WEIGHTS = { "5m": 1, "15m": 1.5, "1h": 2, "4h": 3 };
const PATTERN_COMPONENT_WEIGHT = 0.6;
const EMA200_COMPONENT_WEIGHT = 0.4;

function percentage(long, short) {
  const total = long + short;
  if (!(total > 0)) return null;
  const longPct = Math.round(long / total * 100);
  return { longPct, shortPct: 100 - longPct };
}

// Several detectors can describe the same move (for example a flag and a
// triangle). Keep the strongest pattern per family and direction in each
// timeframe so one price structure cannot inflate the ratio.
export function dedupePatternsForDirection(patterns = [], timeframe, maxPerFamilyPerSide = 1) {
  const best = new Map();
  for (const pattern of patterns) {
    const found = pattern?.timeframes?.[timeframe];
    if (!found) continue;
    const bias = found.bias || "neutral";
    const family = pattern.family || "unknown";
    const key = `${family}:${bias}`;
    const current = best.get(key);
    if (!current || (Number(found.fitScore) || 0) > (Number(current.found.fitScore) || 0)) {
      best.set(key, { pattern, found });
    }
  }
  return [...best.values()];
}

export function assessSymbolDirection(patterns, ema200ByTimeframe, timeframes) {
  const frames = [...new Set(timeframes || [])].map((timeframe) => {
    let longPatternFit = 0, shortPatternFit = 0, bullishCount = 0, bearishCount = 0, neutralCount = 0;
    for (const { found } of dedupePatternsForDirection(patterns, timeframe)) {
      const fit = Math.min(100, Math.max(0, Number(found.fitScore) || 0));
      if (found.bias === "bullish") { longPatternFit += fit; bullishCount++; }
      else if (found.bias === "bearish") { shortPatternFit += fit; bearishCount++; }
      else neutralCount++;
    }
    const framePattern = percentage(longPatternFit, shortPatternFit);
    const ema200 = ema200ByTimeframe?.[timeframe] || null;
    return {
      timeframe,
      patternLongPct: framePattern?.longPct ?? null,
      patternShortPct: framePattern?.shortPct ?? null,
      bullishCount,
      bearishCount,
      neutralCount,
      ema200Position: ema200?.position || null,
      ema200DistancePct: Number.isFinite(ema200?.distancePct) ? ema200.distancePct : null,
    };
  });

  let patternLong = 0, patternShort = 0;
  let emaLong = 0, emaShort = 0;
  let bullishCount = 0, bearishCount = 0, neutralCount = 0, emaAboveCount = 0, emaBelowCount = 0;
  for (const frame of frames) {
    const weight = PATTERN_DIRECTION_WEIGHTS[frame.timeframe] || 1;
    bullishCount += frame.bullishCount;
    bearishCount += frame.bearishCount;
    neutralCount += frame.neutralCount;
    if (frame.patternLongPct != null) {
      patternLong += frame.patternLongPct * weight;
      patternShort += frame.patternShortPct * weight;
    }
    if (frame.ema200Position === "above") { emaLong += weight; emaAboveCount++; }
    else if (frame.ema200Position === "below") { emaShort += weight; emaBelowCount++; }
  }

  const patternShare = percentage(patternLong, patternShort);
  const ema200Share = percentage(emaLong, emaShort);
  let combinedLong = 0, combinedShort = 0, combinedWeight = 0;
  if (patternShare) {
    combinedLong += patternShare.longPct * PATTERN_COMPONENT_WEIGHT;
    combinedShort += patternShare.shortPct * PATTERN_COMPONENT_WEIGHT;
    combinedWeight += PATTERN_COMPONENT_WEIGHT;
  }
  if (ema200Share) {
    combinedLong += ema200Share.longPct * EMA200_COMPONENT_WEIGHT;
    combinedShort += ema200Share.shortPct * EMA200_COMPONENT_WEIGHT;
    combinedWeight += EMA200_COMPONENT_WEIGHT;
  }
  const combinedShare = combinedWeight > 0 ? percentage(combinedLong, combinedShort) : null;

  return {
    overall: combinedShare,
    pattern: patternShare ? { ...patternShare, bullishCount, bearishCount, neutralCount, timeframesUsed: frames.filter((x) => x.patternLongPct != null).length } : null,
    ema200: ema200Share ? { ...ema200Share, aboveCount: emaAboveCount, belowCount: emaBelowCount, timeframesUsed: emaAboveCount + emaBelowCount } : null,
    timeframes: frames,
  };
}
