// core/fvg.js — Fair Value Gap 탐지.
// 3개 캔들 구조 기준. Bullish/Bearish/Filled/Partially/Inverse.
// 너무 작은 FVG(ATR 또는 % 기준)는 제외.

// Bullish FVG: candle[i-2].high < candle[i].low  (가운데 캔들 상승 임펄스)
// Bearish FVG: candle[i-2].low  > candle[i].high
// gap 구간을 이후 캔들이 얼마나 채웠는지로 상태 분류.
export function detectFvgs(candles, atrVal, cfg) {
  const out = [];
  const minAtr = (atrVal || 0) * cfg.fvg.minSizeAtrRatio;
  for (let i = 2; i < candles.length; i++) {
    const a = candles[i - 2], c = candles[i];
    // Bullish
    if (a.high < c.low) {
      const gapLow = a.high, gapHigh = c.low;
      out.push(mkFvg("bullish", i, gapLow, gapHigh, candles, atrVal, minAtr, cfg));
    }
    // Bearish
    if (a.low > c.high) {
      const gapLow = c.high, gapHigh = a.low;
      out.push(mkFvg("bearish", i, gapLow, gapHigh, candles, atrVal, minAtr, cfg));
    }
  }
  // 크기 필터 적용된 것만
  return out.filter((f) => f && f.significant);
}

function mkFvg(dir, idx, gapLow, gapHigh, candles, atrVal, minAtr, cfg) {
  const size = gapHigh - gapLow;
  const mid = (gapHigh + gapLow) / 2;
  const pct = mid ? (size / mid) * 100 : 0;
  const significant = size >= minAtr && pct >= cfg.fvg.minSizePct;

  // 이후 캔들이 gap 을 얼마나 침범/반전했는지
  let fillLevel = 0;   // 0=미충족, 1=완전
  let inverted = false;
  for (let j = idx + 1; j < candles.length; j++) {
    const k = candles[j];
    if (dir === "bullish") {
      // 아래로 되돌림 → gap 채움
      const penetrate = Math.min(gapHigh, Math.max(gapLow, gapHigh - (gapHigh - k.low)));
      if (k.low <= gapLow) { fillLevel = 1; if (k.close < gapLow) inverted = true; break; }
      if (k.low < gapHigh) fillLevel = Math.max(fillLevel, (gapHigh - k.low) / (size || 1e-9));
    } else {
      if (k.high >= gapHigh) { fillLevel = 1; if (k.close > gapHigh) inverted = true; break; }
      if (k.high > gapLow) fillLevel = Math.max(fillLevel, (k.high - gapLow) / (size || 1e-9));
    }
  }

  let status = "open";
  if (inverted) status = "inverse";
  else if (fillLevel >= 0.99) status = "filled";
  else if (fillLevel > 0.05) status = "partial";

  return {
    dir, idx, gapLow, gapHigh, mid, size, pct, significant,
    status,                       // open|partial|filled|inverse
    filled: status === "filled",
    partiallyFilled: status === "partial",
    inverse: status === "inverse",
    time: candles[idx].openTime,
  };
}

// 현재가가 들어와 있는 미충족/부분충족 FVG (진입 구간 후보)
export function activeFvgAt(fvgs, price, dir) {
  return fvgs
    .filter((f) => f.dir === dir && (f.status === "open" || f.status === "partial"))
    .filter((f) => price >= f.gapLow && price <= f.gapHigh)
    .sort((a, b) => b.time - a.time)[0] || null;
}

// 가장 최근 유효 FVG
export function latestFvg(fvgs, dir) {
  return fvgs.filter((f) => f.dir === dir && f.status !== "filled")
    .sort((a, b) => b.time - a.time)[0] || null;
}

export default { detectFvgs, activeFvgAt, latestFvg };
