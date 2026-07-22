// core/volume-analysis.js — 거래량/Taker/Delta/CVD 분석.
// Binance kline 에 포함된 값만 사용 (실제 호가창 복원 아님).
// 계산식과 입력 데이터가 명확히 분리되도록 작성.

// 캔들별 Volume Delta = TakerBuyBase - TakerSellBase
export function volumeDelta(candles) {
  return candles.map((c) => c.takerBuyBase - c.takerSellBase);
}

// 누적 CVD (Cumulative Volume Delta)
export function cvd(candles) {
  const d = volumeDelta(candles);
  const out = new Array(candles.length).fill(0);
  let acc = 0;
  for (let i = 0; i < candles.length; i++) { acc += d[i]; out[i] = acc; }
  return out;
}

// Taker Buy 비율 (0~1). volume 0 이면 null.
export function takerBuyRatio(candles) {
  return candles.map((c) => (c.volume > 0 ? c.takerBuyBase / c.volume : null));
}
export function takerSellRatio(candles) {
  return candles.map((c) => (c.volume > 0 ? c.takerSellBase / c.volume : null));
}

// 이동평균 거래량
export function avgVolume(candles, period = 20) {
  const out = new Array(candles.length).fill(null);
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i].volume;
    if (i >= period) sum -= candles[i - period].volume;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

// 평균 거래량 대비 현재 거래량 비율
export function relativeVolume(candles, period = 20) {
  const av = avgVolume(candles, period);
  return candles.map((c, i) => (av[i] && av[i] > 0 ? c.volume / av[i] : null));
}

// 최근 n 캔들 거래량 급증/급감 판단
export function volumeTrend(candles, lookback = 5, period = 20) {
  const rel = relativeVolume(candles, period);
  const recent = rel.slice(-lookback).filter((x) => x != null);
  if (!recent.length) return { avgRel: null, surge: false, fade: false };
  const avgRel = recent.reduce((a, b) => a + b, 0) / recent.length;
  return { avgRel, surge: avgRel >= 1.6, fade: avgRel <= 0.6 };
}

// CVD 방향: 최근 구간 CVD 기울기 부호
export function cvdSlope(candles, lookback = 10) {
  const c = cvd(candles);
  const n = c.length;
  if (n < lookback + 1) return 0;
  return c[n - 1] - c[n - 1 - lookback];
}

// 흡수 추정용 요약치 (한 캔들). 롱=매도 흡수(아래꼬리), 숏=매수 흡수(위꼬리).
export function candleAbsorption(c, avgVol) {
  const range = c.high - c.low || 1e-9;
  const lowerWickRatio = (Math.min(c.open, c.close) - c.low) / range; // 아래꼬리 비중
  const upperWickRatio = (c.high - Math.max(c.open, c.close)) / range; // 위꼬리 비중
  const closePos = (c.close - c.low) / range; // 종가가 캔들 내 어디서 마감했나 0~1
  const sellRatio = c.volume > 0 ? c.takerSellBase / c.volume : 0;
  const highVol = avgVol ? c.volume / avgVol >= 1.2 : false;
  return { lowerWickRatio, upperWickRatio, closePos, sellRatio, highVol };
}

export default {
  volumeDelta, cvd, takerBuyRatio, takerSellRatio, avgVolume,
  relativeVolume, volumeTrend, cvdSlope, candleAbsorption,
};
