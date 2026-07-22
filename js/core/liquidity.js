// core/liquidity.js — 유동성 분석.
// 최근 전고점/전저점, Equal High/Low, Buy/Sell-side Liquidity,
// 스윕(고점/저점), 스윕 후 회수, 스윕 실패, 목표 유동성.
// Equal 허용 오차는 고정 %가 아니라 ATR 비율로 조절.

import { findPivots } from "./market-structure.js";

// 최근 스윙 하이/로우 목록 (가격 내림/오름차 정렬용 원자료)
export function swingLevels(candles, length) {
  const pivots = findPivots(candles, length);
  return {
    highs: pivots.filter((p) => p.kind === "high"),
    lows: pivots.filter((p) => p.kind === "low"),
  };
}

// Equal High/Low: 인접 스윙이 ATR*tol 이내로 비슷하면 클러스터 = 유동성 풀
export function equalLevels(levels, atrVal, tolRatio) {
  const tol = (atrVal || 0) * tolRatio;
  const clusters = [];
  const sorted = [...levels].sort((a, b) => a.price - b.price);
  let cur = [];
  for (const lv of sorted) {
    if (!cur.length || Math.abs(lv.price - cur[cur.length - 1].price) <= tol) {
      cur.push(lv);
    } else {
      if (cur.length >= 2) clusters.push(mkCluster(cur));
      cur = [lv];
    }
  }
  if (cur.length >= 2) clusters.push(mkCluster(cur));
  return clusters;
}
function mkCluster(arr) {
  const price = arr.reduce((s, x) => s + x.price, 0) / arr.length;
  return { price, count: arr.length, members: arr };
}

// 저점 유동성 스윕(롱 조건):
// 1) 현재 저가가 이전 Swing Low 아래로 내려감
// 2) 종가가 이전 Swing Low 위로 회복
// 3) 거래량 증가 또는 Taker Sell 증가
// 4) 이후 추가 저점 갱신 없음
export function detectLowSweep(candles, swingLows, opts = {}) {
  const { lookback = 6, avgVol = null } = opts;
  const n = candles.length;
  if (!swingLows.length || n < 3) return null;

  // 최근 스윕 후보: 마지막 lookback 캔들에서 이전 swing low 이탈 후 회복
  const recentLows = swingLows.filter((s) => s.idx < n - 1);
  if (!recentLows.length) return null;
  const priorLow = recentLows[recentLows.length - 1];

  let sweepIdx = -1;
  for (let i = Math.max(priorLow.idx + 1, n - lookback); i < n; i++) {
    const c = candles[i];
    if (c.low < priorLow.price && c.close > priorLow.price) { sweepIdx = i; break; }
  }
  if (sweepIdx < 0) return null;

  const sweepCandle = candles[sweepIdx];
  // 이후 추가 저점 갱신 없음
  let brokenAgain = false;
  for (let i = sweepIdx + 1; i < n; i++) {
    if (candles[i].low < sweepCandle.low) { brokenAgain = true; break; }
  }
  const volConfirm = avgVol ? sweepCandle.volume >= avgVol * 1.1 : true;
  const sellPressure = sweepCandle.takerSellBase > sweepCandle.takerBuyBase;
  const recovered = candles[n - 1].close > priorLow.price;

  return {
    type: "low_sweep",
    sweptLevel: priorLow.price,
    sweepPrice: sweepCandle.low,
    sweepTime: sweepCandle.openTime,
    recovered,
    failed: brokenAgain,           // 스윕 실패 = 다시 저점 깨짐
    volumeConfirm: volConfirm,
    sellPressure,
    valid: !brokenAgain && recovered,
  };
}

// 고점 스윕(숏 조건) — 대칭
export function detectHighSweep(candles, swingHighs, opts = {}) {
  const { lookback = 6, avgVol = null } = opts;
  const n = candles.length;
  if (!swingHighs.length || n < 3) return null;
  const recentHighs = swingHighs.filter((s) => s.idx < n - 1);
  if (!recentHighs.length) return null;
  const priorHigh = recentHighs[recentHighs.length - 1];

  let sweepIdx = -1;
  for (let i = Math.max(priorHigh.idx + 1, n - lookback); i < n; i++) {
    const c = candles[i];
    if (c.high > priorHigh.price && c.close < priorHigh.price) { sweepIdx = i; break; }
  }
  if (sweepIdx < 0) return null;
  const sweepCandle = candles[sweepIdx];
  let brokenAgain = false;
  for (let i = sweepIdx + 1; i < n; i++) {
    if (candles[i].high > sweepCandle.high) { brokenAgain = true; break; }
  }
  const volConfirm = avgVol ? sweepCandle.volume >= avgVol * 1.1 : true;
  const recovered = candles[n - 1].close < priorHigh.price;
  return {
    type: "high_sweep",
    sweptLevel: priorHigh.price,
    sweepPrice: sweepCandle.high,
    sweepTime: sweepCandle.openTime,
    recovered, failed: brokenAgain, volumeConfirm: volConfirm,
    valid: !brokenAgain && recovered,
  };
}

// 위쪽/아래쪽 목표 유동성 (가장 가까운 반대편 스윙 클러스터)
export function targetLiquidity(price, highs, lows) {
  const above = highs.filter((h) => h.price > price).sort((a, b) => a.price - b.price)[0] || null;
  const below = lows.filter((l) => l.price < price).sort((a, b) => b.price - a.price)[0] || null;
  return {
    buySideTarget: above ? above.price : null,   // 위쪽 목표 (롱 TP 후보)
    sellSideTarget: below ? below.price : null,   // 아래쪽 목표
  };
}

// 통합 유동성 분석
export function analyzeLiquidity(candles, cfg, atrVal, avgVol) {
  const { highs, lows } = swingLevels(candles, cfg.structure.swingPivot);
  const eqHighs = equalLevels(highs, atrVal, cfg.structure.equalTolAtrRatio);
  const eqLows = equalLevels(lows, atrVal, cfg.structure.equalTolAtrRatio);
  const price = candles[candles.length - 1].close;
  const lowSweep = detectLowSweep(candles, lows, { avgVol });
  const highSweep = detectHighSweep(candles, highs, { avgVol });
  const targets = targetLiquidity(price, highs, lows);
  return {
    highs, lows, eqHighs, eqLows,
    buySideLiquidity: eqHighs,   // 위쪽 = buy-side liquidity
    sellSideLiquidity: eqLows,   // 아래쪽 = sell-side liquidity
    lowSweep, highSweep, targets, price,
  };
}

export default {
  swingLevels, equalLevels, detectLowSweep, detectHighSweep,
  targetLiquidity, analyzeLiquidity,
};
