// core/noise-filter.js — 신호 노이즈 필터.
// 후보 문턱을 완화하면 잡신호가 늘어난다. 두 가지로 걸러낸다:
//  1) Choppiness Index — 횡보/촙 구간(방향 없이 톱니처럼 오르내림)일수록 값이 높다.
//     추세가 없는 구간의 신호는 되돌림에 쉽게 무효화되므로 노이즈로 본다.
//  2) 상대 거래량 — 평균 대비 거래량이 너무 낮으면(거래 죽은 코인) 신호 신뢰도가 낮다.
// 마감 캔들만 사용. 순수 함수.

import { trueRange } from "./indicators.js";

// Choppiness Index (Dreiss). 0~100. 높을수록 횡보(촙), 낮을수록 추세.
// CI = 100 * log10( sum(TR, n) / (highestHigh(n) - lowestLow(n)) ) / log10(n)
export function choppinessIndex(candles, period = 14) {
  const n = candles.length;
  if (n < period + 1) return null;
  const tr = trueRange(candles);
  let sumTr = 0;
  let hi = -Infinity, lo = Infinity;
  for (let i = n - period; i < n; i++) {
    sumTr += tr[i] ?? 0;
    if (candles[i].high > hi) hi = candles[i].high;
    if (candles[i].low < lo) lo = candles[i].low;
  }
  const range = hi - lo;
  if (range <= 0 || sumTr <= 0) return null;
  return (100 * Math.log10(sumTr / range)) / Math.log10(period);
}

// 노이즈 판정. analyzeTf 결과(a) + config.noiseFilter → { noisy, ci, relVol, reasons }.
export function evaluateNoise(a, cfg) {
  const nf = cfg.noiseFilter;
  const ci = choppinessIndex(a.candles, nf.choppinessPeriod);
  const relVol = a.volTrend?.avgRel ?? a.relVolNow ?? null;
  const reasons = [];
  // CI 계산 불가(데이터 부족)면 촙 판정은 보류 — 저거래량만으로 판단
  const chop = ci != null && ci > nf.choppinessMax;
  const lowVol = relVol != null && relVol < nf.minRelVol;
  if (chop) reasons.push("횡보(촙)");
  if (lowVol) reasons.push("거래량 부족");
  return { noisy: chop || lowVol, ci, relVol, reasons };
}

export default { choppinessIndex, evaluateNoise };
