// core/market-regime.js — BTC 4시간 마감봉으로 시장 국면을 설명한다.
//
// 이 결과는 아직 전략 수익률로 검증된 가중치가 아니다. 따라서 점수를 올리거나 내리지 않고,
// 후보가 시장 흐름과 같은 방향인지 보여주고 페이퍼 기록에 당시 환경을 고정하는 데만 쓴다.

import { atr, ema } from "./indicators.js";

const finite = Number.isFinite;
const pct = (now, then) => finite(now) && finite(then) && then !== 0
  ? ((now / then) - 1) * 100
  : null;

function median(values) {
  const list = values.filter(finite).sort((a, b) => a - b);
  if (!list.length) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

function unavailable(reason) {
  return {
    available: false,
    key: "unavailable",
    label: "국면 산출 보류",
    bias: "neutral",
    volatility: "unknown",
    confidence: "low",
    reason,
  };
}

export function analyzeMarketRegime(candles, cfg = {}, now = Date.now()) {
  const list = Array.isArray(candles)
    ? candles.filter((c) => c && finite(Number(c.close)) && Number(c.close) > 0)
    : [];
  const fastPeriod = cfg.emaFast ?? 20;
  const slowPeriod = cfg.emaSlow ?? 50;
  const returnBars = cfg.trendReturnBars ?? 42;
  const slopeBars = cfg.slopeBars ?? 6;
  const volLookback = cfg.volLookback ?? 42;
  const minBars = Math.max(cfg.minBars ?? 84, slowPeriod + slopeBars + 1, returnBars + 1, volLookback + 14);
  if (list.length < minBars) return unavailable(`BTC 4시간봉이 ${minBars}개보다 적음`);

  const closes = list.map((c) => Number(c.close));
  const fast = ema(closes, fastPeriod);
  const slow = ema(closes, slowPeriod);
  const atr14 = atr(list, 14);
  const i = list.length - 1;
  const close = closes[i];
  const fastNow = fast[i];
  const slowNow = slow[i];
  const fastPast = fast[i - slopeBars];
  const atrNow = atr14[i];
  if (![close, fastNow, slowNow, fastPast, atrNow].every(finite)) {
    return unavailable("BTC 지표 계산에 필요한 값이 부족함");
  }

  const closeTime = Number(list[i].closeTime ?? list[i].time);
  const staleMs = cfg.staleMs ?? 8 * 60 * 60 * 1000;
  if (finite(closeTime) && now - closeTime > staleMs) return unavailable("BTC 4시간봉이 오래됨");

  const ret24h = pct(close, closes[i - 6]);
  const ret7d = pct(close, closes[i - returnBars]);
  const ret14d = pct(close, closes[i - 84]);
  const fastSlopePct = pct(fastNow, fastPast);
  const emaGapPct = pct(fastNow, slowNow);
  const atrPct = (atrNow / close) * 100;
  const historicalAtrPct = atr14
    .slice(Math.max(0, i - volLookback), i)
    .map((value, offset) => {
      const price = closes[Math.max(0, i - volLookback) + offset];
      return finite(value) && price > 0 ? (value / price) * 100 : null;
    });
  const baselineAtrPct = median(historicalAtrPct);
  const volRatio = baselineAtrPct > 0 ? atrPct / baselineAtrPct : 1;

  const bullEvidence = [close > slowNow, fastNow > slowNow, fastSlopePct > 0, ret7d > 0];
  const bearEvidence = [close < slowNow, fastNow < slowNow, fastSlopePct < 0, ret7d < 0];
  const bullScore = bullEvidence.filter(Boolean).length;
  const bearScore = bearEvidence.filter(Boolean).length;

  let key = "range";
  if (bullScore === 4) key = "bull";
  else if (bearScore === 4) key = "bear";

  const extremeVolRatio = cfg.extremeVolRatio ?? 1.8;
  const highVolRatio = cfg.highVolRatio ?? 1.35;
  const lowVolRatio = cfg.lowVolRatio ?? 0.75;
  const volatility = volRatio >= extremeVolRatio ? "extreme"
    : volRatio >= highVolRatio ? "high"
      : volRatio <= lowVolRatio ? "low" : "normal";

  const trendLabel = key === "bull" ? "상승 국면" : key === "bear" ? "하락 국면" : "횡보·혼조";
  const volLabel = volatility === "extreme" ? "극고변동"
    : volatility === "high" ? "고변동"
      : volatility === "low" ? "저변동" : "보통 변동";
  const evidence = Math.max(bullScore, bearScore);
  const confidence = key === "range" ? "low" : evidence === 4 ? "high" : "medium";

  return {
    available: true,
    key,
    label: `${trendLabel} · ${volLabel}`,
    trendLabel,
    volatility,
    volatilityLabel: volLabel,
    bias: key === "bull" ? "long" : key === "bear" ? "short" : "neutral",
    confidence,
    asOf: finite(closeTime) ? closeTime : null,
    metrics: {
      close,
      ret24h,
      ret7d,
      ret14d,
      emaGapPct,
      fastSlopePct,
      atrPct,
      volRatio,
    },
  };
}

export function regimeAlignment(regime, direction) {
  if (!regime?.available || !["long", "short"].includes(direction)) {
    return { key: "unknown", label: "국면 확인 전" };
  }
  if (regime.bias === "neutral") return { key: "neutral", label: "국면 중립" };
  if (regime.bias === direction) return { key: "aligned", label: "시장 흐름 우호" };
  return { key: "counter", label: "시장 흐름 역행" };
}

export default { analyzeMarketRegime, regimeAlignment };
