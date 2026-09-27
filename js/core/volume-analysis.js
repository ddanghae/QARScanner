// core/volume-analysis.js — 거래량/Taker/Delta/CVD 분석.
// Binance kline 에 포함된 값만 사용 (실제 호가창 복원 아님).
// 계산식과 입력 데이터가 명확히 분리되도록 작성.

import { findPivots } from "./market-structure.js";

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

// 대량거래 봉 탐지 + 그 봉의 매수/매도 비율 해석. 1시간봉 기준으로 쓸 것을 전제로 만들었지만
// 타임프레임에 의존하지 않는다(호출자가 원하는 봉을 넘긴다).
//
// 기준선은 **그 봉 이전** 거래량만 쓴다. relativeVolume() 은 평균 창에 자기 봉을 포함하므로
// 10배 봉이 자기 기준선을 끌어올려 배수가 과소평가된다(period 20 이면 절반이 자기 몫).
// "앞전 거래량보다" 를 보려면 이전 봉만으로 재야 한다.
//
// 매수비율만 보면 방향을 거꾸로 읽는다. 매수가 공격적으로 들어왔는데(buyRatio 높음)
// 종가가 저가 근처면(closePos 낮음) 그건 상승이 아니라 **매수가 흡수당한** 것이다 — 숏 신호다.
// 그래서 buyRatio 와 closePos 를 같이 본다. 이 교차 두 경우가 실제로 가장 쓸모 있다.
//
// 리페인트: cvdDivergence 와 달리 이 함수는 미마감 봉을 구조적으로 막지 못한다. 피봇처럼
// 좌우 확정이 필요한 게 아니라 봉 하나만 보기 때문이다. 설정에서 진행 중인 봉을 포함하면
// (binance.js 의 closedOnly 가 통과) 마지막 봉이 barsAgo=0 급증으로 잡힐 수 있고 그 봉의
// closePos 는 마감까지 계속 변한다. 거래량은 아직 덜 쌓였으므로 과대가 아니라 과소 판정 쪽이다.
// 확정값이 필요하면 호출자가 closedOnly(candles, false) 를 넘길 것.
//
// ponytail: 기준선이 O(n*period) 다. 종목당 200봉·period 20 이면 무시할 수준.
//           봉이 수천 개로 늘면 누적합으로 바꿀 것.
export function volumeSpikes(candles, { period = 20, minRel = 3, lookback = 30, minSamples = 10 } = {}) {
  if (!candles || candles.length < minSamples + 2) return [];
  const out = [];
  const from = Math.max(minSamples, candles.length - lookback);

  for (let i = from; i < candles.length; i++) {
    const s = Math.max(0, i - period);
    if (i - s < minSamples) continue;               // 기준선 표본 부족 — 배수를 못 믿는다
    let sum = 0;
    for (let j = s; j < i; j++) sum += candles[j].volume;
    const base = sum / (i - s);
    if (!(base > 0)) continue;

    const c = candles[i];
    const relVol = c.volume / base;
    if (relVol < minRel) continue;

    const range = c.high - c.low;
    const buyRatio = c.volume > 0 ? c.takerBuyBase / c.volume : null;
    const closePos = range > 0 ? (c.close - c.low) / range : 0.5;
    if (buyRatio == null) continue;

    // 그 봉에서 큰 물량이 바뀐 가격대 — 이후 지지/저항으로 작동한다.
    const level = (c.high + c.low) / 2;
    const after = candles.slice(i + 1);
    const pctAbove = after.length
      ? after.filter((x) => x.close > level).length / after.length
      : null;

    out.push({
      idx: i, barsAgo: candles.length - 1 - i, time: c.openTime,
      relVol, buyRatio, closePos, level, pctAbove,
      verdict: spikeVerdict(buyRatio, closePos),
    });
  }
  // 최근 것이 먼저 — 호출자는 보통 [0] 만 본다.
  return out.reverse();
}

// buyRatio × closePos 4분면. 교차 두 칸(흡수)이 같은 방향 두 칸보다 중요하다.
//
// **이 판정은 급등 예측력이 없다.** 2026-07-30 · 529종목 · 57,796건 측정:
//   매도 흡수 0.79x · 매수 흡수 0.66x · 매도 우위 0.79x · 매수 우위 1.02x · 혼재 1.36x
// "매도 물량 흡수 → 상승 전환" 가설이 데이터에서 뒤집혔다(기준 미달). 화면에서 이 라벨을
// 렌더하지 않는 이유다 — 연구 컬럼(spVerdict)과 분류용으로만 남긴다.
//
// 임계는 측정값이다. 2026-07-30 · 529종목 · 4시간봉 · 급증봉 n=32,671:
//   buyRatio  p25=0.4693  p50=0.4880  p75=0.5047
//   closePos  p25=0.1957  p50=0.3932  p75=0.6348
// buyRatio 는 0.49 근처에 몰린다 — 중립점이 0.5 가 아니고, 0.6/0.4 로 자르면 아무것도
// 안 걸려 전부 "혼재" 가 된다(실측으로 확인).
// buyHi/buyLo 는 위 p75/p25 를 소수 셋째 자리로 반올림한 값이다.
// closePos 는 분포가 넓어 0.6/0.4 를 쓴다 — 각각 p75(0.635)/p25(0.196) 사이에 있어
// 대략 상위·하위 3할을 가른다. p75/p25 를 그대로 쓰지 않은 건 봉 안 위치는 반올림한
// 경계가 읽기 쉽고, 이 축은 예측력 검증 대상이 아니기 때문이다.
export function spikeVerdict(buyRatio, closePos, buyHi = 0.505, buyLo = 0.469, posHi = 0.6, posLo = 0.4) {
  const buyAggr = buyRatio >= buyHi, sellAggr = buyRatio <= buyLo;
  const closedHigh = closePos >= posHi, closedLow = closePos <= posLo;
  if (buyAggr && closedHigh) return "매수 우위";        // 공격적 매수 + 고가 마감 = 정상 상승
  if (sellAggr && closedLow) return "매도 우위";        // 공격적 매도 + 저가 마감 = 정상 하락
  if (buyAggr && closedLow) return "매수 흡수";         // 매수가 다 먹혔다 → 숏 쪽
  if (sellAggr && closedHigh) return "매도 흡수";       // 매도가 다 먹혔다 → 롱 쪽
  return "혼재";                                        // 물량만 크고 방향 없음 — 관망
}

// CVD 다이버전스. cvdSlope 는 "최근 n봉 올랐나" 만 본다 — 그건 추세 확인이고 선행이 아니다.
// 다이버전스는 가격이 저점을 깨는 동안 매도 압력이 따라오지 않은 상태를 잡는다:
//   롱: 가격 저점 하락(LL) + CVD 저점 상승(HL) → 저점 스윕 후 매도 물량 흡수
//   숏: 가격 고점 상승(HH) + CVD 고점 하락(LH) → 고점 물량 분배
//
// 리페인트 안전: findPivots 는 좌우 length 봉이 다 있어야 피봇을 확정하므로 가장 최근 피봇도
// 최소 length 봉 전이다. 진행 중인 봉이 피봇이 되는 일은 구조적으로 없다.
//
// CVD 값은 두 피봇 시점의 절대값을 그대로 비교한다 — 누적값이라 구간 시작점이 상쇄된다.
export function cvdDivergence(candles, length = 3, maxBars = 40) {
  const none = { bullish: false, bearish: false, lows: null, highs: null };
  if (!candles || candles.length < length * 2 + 2) return none;

  const c = cvd(candles);
  const cut = Math.max(0, candles.length - maxBars);
  const piv = findPivots(candles, length).filter((p) => p.idx >= cut);
  const lows = piv.filter((p) => p.kind === "low").slice(-2);
  const highs = piv.filter((p) => p.kind === "high").slice(-2);

  const pair = (a, b) => ({
    prevPrice: a.price, lastPrice: b.price,
    prevCvd: c[a.idx], lastCvd: c[b.idx],
    prevIdx: a.idx, lastIdx: b.idx,
  });

  const lo = lows.length === 2 ? pair(lows[0], lows[1]) : null;
  const hi = highs.length === 2 ? pair(highs[0], highs[1]) : null;

  return {
    // 가격은 더 낮은 저점, CVD 는 더 높은 저점
    bullish: !!lo && lo.lastPrice < lo.prevPrice && lo.lastCvd > lo.prevCvd,
    // 가격은 더 높은 고점, CVD 는 더 낮은 고점
    bearish: !!hi && hi.lastPrice > hi.prevPrice && hi.lastCvd < hi.prevCvd,
    lows: lo,
    highs: hi,
  };
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
  relativeVolume, volumeTrend, cvdSlope, cvdDivergence, candleAbsorption,
  volumeSpikes, spikeVerdict,
};
