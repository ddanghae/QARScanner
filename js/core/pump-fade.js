// core/pump-fade.js — 급등 후 실제 하락 전환을 찾는 SHORT 전용 순수 계산 모듈.
// 호출자는 기본적으로 마감 캔들만 전달해야 한다. 연구 라벨/미래 캔들은 절대 받지 않는다.

import { atr, dailyVwap, ema, last } from "./indicators.js";
import { gradeFor, topSignals } from "./scoring.js";
import { finalizePlan } from "./plan-validation.js";

const finite = (v) => Number.isFinite(v);

function pctChange(closes, barsAgo) {
  const n = closes.length;
  if (n < barsAgo + 1) return null;
  const from = closes[n - 1 - barsAgo];
  const to = closes[n - 1];
  if (!finite(from) || !finite(to) || from <= 0) return null;
  return ((to - from) / from) * 100;
}

// 1h 마감봉만으로 급등 기준을 계산한다. 24h ticker 변화율은 사용하지 않는다.
export function pumpFadePrefilter(candles1h, cfg) {
  const p = cfg.pumpFade;
  if (!Array.isArray(candles1h) || candles1h.length < 25) {
    return {
      pass: false, reason: "1시간봉 자료 부족", change6h: null, change24h: null, price: null,
      openTime: null, asOf: null,
    };
  }
  const closes = candles1h.map((c) => Number(c?.close));
  const price = closes[closes.length - 1];
  const openTime = Number(candles1h[candles1h.length - 1]?.openTime);
  const asOf = Number(candles1h[candles1h.length - 1]?.closeTime);
  const change6h = pctChange(closes, 6);
  const change24h = pctChange(closes, 24);
  const valid = finite(price) && price > 0 && finite(change6h) && finite(change24h) &&
    finite(openTime) && finite(asOf);
  const pass = valid && (change6h >= p.pump6hMinPct || change24h >= p.pump24hMinPct);
  const normalizedStrength = valid
    ? Math.max(change6h / p.pump6hMinPct, change24h / p.pump24hMinPct)
    : null;
  return {
    pass,
    reason: !valid ? "급등률 계산 불가" : pass ? "급등 기준 충족" : "급등 기준 미달",
    change6h,
    change24h,
    price,
    openTime,
    asOf,
    normalizedStrength,
  };
}

function priorAverageVolume(candles, index, bars) {
  if (index < bars) return null;
  const win = candles.slice(index - bars, index);
  if (win.length !== bars || win.some((c) => !finite(c?.volume) || c.volume < 0)) return null;
  const avg = win.reduce((sum, c) => sum + c.volume, 0) / bars;
  return avg > 0 ? avg : null;
}

function volumeClimaxMetric(candles, cfg) {
  const p = cfg.pumpFade;
  const start = Math.max(p.volumeBaselineBars, candles.length - p.rejectionLookback15m);
  let bestRatio = null;
  let bestIndex = null;
  for (let i = start; i < candles.length; i++) {
    const avg = priorAverageVolume(candles, i, p.volumeBaselineBars);
    const volume = Number(candles[i]?.volume);
    if (!avg || !finite(volume) || volume < 0) continue;
    const ratio = volume / avg;
    if (bestRatio == null || ratio > bestRatio) {
      bestRatio = ratio;
      bestIndex = i;
    }
  }
  return {
    hit: finite(bestRatio) && bestRatio >= p.volumeClimaxRatio,
    ratio: bestRatio,
    index: bestIndex,
  };
}

function upperWickMetric(candles, cfg) {
  const p = cfg.pumpFade;
  const start = Math.max(0, candles.length - p.rejectionLookback15m);
  let bestHit = null;
  let bestAny = null;
  for (let i = start; i < candles.length; i++) {
    const c = candles[i];
    const range = Number(c?.high) - Number(c?.low);
    if (!(range > 0) || !finite(c?.open) || !finite(c?.close)) continue;
    const wickRatio = (c.high - Math.max(c.open, c.close)) / range;
    const closePosition = (c.close - c.low) / range;
    const hit = wickRatio >= p.upperWickMinRatio && closePosition <= p.rejectionClosePositionMax;
    const candidate = { hit, wickRatio, closePosition, index: i };
    if (!bestAny || wickRatio > bestAny.wickRatio) bestAny = candidate;
    if (hit && (!bestHit || wickRatio > bestHit.wickRatio)) bestHit = candidate;
  }
  return bestHit || bestAny || { hit: false, wickRatio: null, closePosition: null, index: null };
}

function highSweepFailureMetric(candles, cfg) {
  const p = cfg.pumpFade;
  const start = Math.max(p.priorHighLookback15m, candles.length - p.rejectionLookback15m);
  let best = null;
  for (let i = start; i < candles.length; i++) {
    const prior = candles.slice(i - p.priorHighLookback15m, i);
    if (prior.length !== p.priorHighLookback15m || prior.some((c) => !finite(c?.high))) continue;
    const level = Math.max(...prior.map((c) => c.high));
    const c = candles[i];
    const overshootPct = level > 0 ? ((c.high - level) / level) * 100 : null;
    const hit = finite(c?.high) && finite(c?.close) && c.high > level && c.close < level;
    if (hit && (!best || overshootPct > best.overshootPct)) {
      best = { hit: true, level, overshootPct, index: i };
    }
  }
  return best || { hit: false, level: null, overshootPct: null, index: null };
}

function takerExhaustionMetric(candles, cfg) {
  const bars = cfg.pumpFade.takerExhaustionBars;
  if (candles.length < bars) return { hit: false, ratio: null };
  const win = candles.slice(-bars);
  const ratios = win.map((c) => c?.volume > 0 && finite(c?.takerBuyBase)
    ? c.takerBuyBase / c.volume
    : null);
  if (ratios.some((v) => !finite(v))) return { hit: false, ratio: null };
  const ratio = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  return { hit: ratio <= cfg.pumpFade.takerBuyRatioMax, ratio };
}

function microBreakdownMetric(candles5m, signalCloseTime, cfg, options = {}) {
  if (!finite(signalCloseTime)) {
    return { valid: false, hit: false, level: null, close: null, alignedCount: 0 };
  }
  const aligned = candles5m
    .filter((c) => finite(c?.closeTime) && c.closeTime <= signalCloseTime &&
      (!options.provisional || (finite(c?.openTime) && c.openTime <= options.asOf)))
    .slice()
    .sort((a, b) => a.closeTime - b.closeTime);
  const bars = cfg.pumpFade.microBreakdownBars5m;
  if (aligned.length < bars + 1) {
    return { valid: false, hit: false, level: null, close: null, alignedCount: aligned.length };
  }
  const window = aligned.slice(-bars - 1);
  const current = window[window.length - 1];
  const currentAligned = options.provisional
    ? finite(options.asOf) && current.openTime <= options.asOf && current.closeTime >= options.asOf
    : current.closeTime === signalCloseTime;
  if (!currentAligned) {
    return { valid: false, hit: false, level: null, close: null, alignedCount: aligned.length };
  }
  for (let i = 1; i < window.length; i++) {
    if (window[i].closeTime - window[i - 1].closeTime !== cfg.pumpFade.interval5mMs) {
      return { valid: false, hit: false, level: null, close: null, alignedCount: aligned.length };
    }
  }
  const prior = window.slice(0, -1);
  if (!finite(current?.close) || prior.some((c) => !finite(c?.low))) {
    return { valid: false, hit: false, level: null, close: null, alignedCount: aligned.length };
  }
  const level = Math.min(...prior.map((c) => c.low));
  return { valid: true, hit: current.close < level, level, close: current.close, alignedCount: aligned.length };
}

export function buildPumpFadeMetrics(candles15m, candles5m, pump, cfg, options = {}) {
  const p = cfg.pumpFade;
  const min15 = Math.max(
    p.recentHighLookback15m,
    p.volumeBaselineBars + p.rejectionLookback15m,
    20,
    cfg.indicators.atrPeriod + 1,
  );
  if (!pump?.pass || !Array.isArray(candles15m) || !Array.isArray(candles5m) ||
      candles15m.length < min15) return null;

  const last15 = candles15m[candles15m.length - 1];
  const signalCloseTime = Number(last15?.closeTime);
  const signalOpenTime = Number(last15?.openTime);
  const provisional = Boolean(options.provisional);
  const asOf = Number(options.asOf);
  const effectiveAsOf = finite(asOf) ? asOf : signalCloseTime;
  const fresh15m = finite(effectiveAsOf) && effectiveAsOf >= signalCloseTime &&
    effectiveAsOf - signalCloseTime <= p.interval15mMs;
  const fresh1h = finite(pump.asOf) && effectiveAsOf >= pump.asOf &&
    effectiveAsOf - pump.asOf <= p.interval1hMs;
  const aligned = provisional
    ? finite(asOf) && finite(signalOpenTime) && signalOpenTime <= asOf && signalCloseTime >= asOf &&
      finite(pump.openTime) && pump.openTime <= asOf && pump.asOf >= asOf
    : fresh15m && fresh1h && pump.asOf <= signalCloseTime;
  if (!finite(last15?.close) || last15.close <= 0 || !finite(signalCloseTime) || !aligned) return null;
  const climax = volumeClimaxMetric(candles15m, cfg);
  const wick = upperWickMetric(candles15m, cfg);
  const sweep = highSweepFailureMetric(candles15m, cfg);
  const taker = takerExhaustionMetric(candles15m, cfg);

  const closes15 = candles15m.map((c) => Number(c?.close));
  if (closes15.some((v) => !finite(v))) return null;
  const ema20 = last(ema(closes15, 20));
  const vwap = last(dailyVwap(candles15m));
  const atrVal = last(atr(candles15m, cfg.indicators.atrPeriod));
  if (!finite(ema20) || !finite(vwap) || !finite(atrVal) || atrVal <= 0) return null;

  const recent = candles15m.slice(-p.recentHighLookback15m);
  if (recent.some((c) => !finite(c?.high))) return null;
  const pumpHigh = Math.max(...recent.map((c) => c.high));
  const drawdownPct = pumpHigh > 0 ? ((pumpHigh - last15.close) / pumpHigh) * 100 : null;
  const micro = microBreakdownMetric(candles5m, signalCloseTime, cfg, { provisional, asOf });
  if (!micro.valid) return null;
  const rejectionEvidence = [climax.hit, wick.hit, sweep.hit].filter(Boolean).length;

  return {
    pumpStrength: true,
    change6h: pump.change6h,
    change24h: pump.change24h,
    price: last15.close,
    signalCloseTime,
    volumeClimax: climax.hit,
    volumeClimaxRatio: climax.ratio,
    volumeClimaxIndex: climax.index,
    upperWick: wick.hit,
    upperWickRatio: wick.wickRatio,
    rejectionClosePosition: wick.closePosition,
    upperWickIndex: wick.index,
    highSweepFailure: sweep.hit,
    highSweepLevel: sweep.level,
    highSweepIndex: sweep.index,
    takerBuyExhaustion: taker.hit,
    takerBuyRatio3: taker.ratio,
    ema20Loss: last15.close < ema20,
    ema20,
    vwapLoss: last15.close < vwap,
    vwap,
    microBreakdown: micro.hit,
    microBreakdownLevel: micro.level,
    aligned5mCount: micro.alignedCount,
    pumpHigh,
    drawdownPct,
    drawdownConfirmed: finite(drawdownPct) && drawdownPct >= p.drawdownConfirmPct,
    lateShortRisk: finite(drawdownPct) && drawdownPct >= p.lateDrawdownPct,
    rejectionEvidence,
    atrVal,
  };
}

export function classifyPumpFadeStage(metrics, cfg) {
  if (!metrics?.pumpStrength) return null;
  const rejection = metrics.rejectionEvidence >= cfg.pumpFade.rejectionEvidenceMin;
  if (rejection && (metrics.ema20Loss || metrics.vwapLoss) &&
      metrics.microBreakdown && metrics.drawdownConfirmed) {
    return { stage: 3, key: "breakdown", label: "3 급락 확인", badge: "purple" };
  }
  if (rejection) return { stage: 2, key: "rejection", label: "2 고점 거절", badge: "yellow" };
  return { stage: 1, key: "overheat", label: "1 과열 감시", badge: "blue" };
}

function scoreItem(key, label, weight, hit) {
  return { key, label, weight, got: hit ? weight : 0, hit: Boolean(hit) };
}

export function scorePumpFade(metrics, cfg) {
  const w = cfg.pumpFadeScoreWeights;
  const breakdown = [
    scoreItem("pumpStrength", "급등 기준", w.pumpStrength, metrics?.pumpStrength),
    scoreItem("volumeClimax", "거래량 클라이맥스", w.volumeClimax, metrics?.volumeClimax),
    scoreItem("upperWick", "긴 윗꼬리 거절", w.upperWick, metrics?.upperWick),
    scoreItem("highSweepFailure", "고점 스윕 실패", w.highSweepFailure, metrics?.highSweepFailure),
    scoreItem("takerBuyExhaustion", "Taker Buy 소진", w.takerBuyExhaustion, metrics?.takerBuyExhaustion),
    scoreItem("ema20Loss", "15분 EMA20 하향 이탈", w.ema20Loss, metrics?.ema20Loss),
    scoreItem("vwapLoss", "15분 일간 VWAP 하향 이탈", w.vwapLoss, metrics?.vwapLoss),
    scoreItem("microBreakdown", "5분 단기 구조 붕괴", w.microBreakdown, metrics?.microBreakdown),
  ];
  let score = breakdown.reduce((sum, item) => sum + item.got, 0);
  const penalties = [];
  if (metrics?.lateShortRisk) {
    score += cfg.pumpFade.lateDrawdownPenalty;
    penalties.push({
      key: "lateShortRisk",
      label: "고점 대비 12% 이상 하락 — 늦은 숏 위험",
      val: cfg.pumpFade.lateDrawdownPenalty,
    });
  }
  return { score: Math.max(0, Math.min(100, Math.round(score))), breakdown, penalties };
}

export function pumpFadePlan(metrics, cfg) {
  const entry = Number(metrics?.price);
  const pumpHigh = Number(metrics?.pumpHigh);
  const atrVal = Number(metrics?.atrVal);
  if (!(entry > 0) || !(pumpHigh > 0) || !(atrVal > 0)) {
    return finalizePlan({
      direction: "short", entry, stop: null, tp1: null, tp2: null, tp3: null,
      invalidation: null, riskReward: 0, rrText: "-", valid: false,
      stopDistancePct: null, warning: "진입계획 자료 부족",
    });
  }
  const stop = Math.max(pumpHigh, entry) + atrVal * cfg.pumpFade.atrStopBuffer;
  const risk = stop - entry;
  const stopDistancePct = (risk / entry) * 100;
  const tp1 = entry - risk;
  const tp2 = entry - risk * 2;
  const tp3 = entry - risk * 3;
  const excessiveRisk = stopDistancePct >= cfg.pumpFade.maxStopDistancePct;
  const valid = risk > 0 && tp3 > 0 && !excessiveRisk;
  return finalizePlan({
    direction: "short",
    entry,
    stop,
    tp1,
    tp2,
    tp3,
    invalidation: stop,
    riskReward: 2,
    rrText: "1:2.00",
    valid,
    stopDistancePct,
    warning: excessiveRisk ? `손절 거리 ${stopDistancePct.toFixed(2)}% — 8% 이상 위험` : null,
  });
}

function pumpFadeGrade(score, cfg) {
  return gradeFor(score, { grades: cfg.pumpFadeGrades });
}

export function buildPumpFadeResult(item, candles1h, candles15m, candles5m, cfg, options = {}) {
  const pump = pumpFadePrefilter(candles1h, cfg);
  if (!pump.pass) return null;
  const metrics = buildPumpFadeMetrics(candles15m, candles5m, pump, cfg, options);
  if (!metrics) return null;
  const stageInfo = classifyPumpFadeStage(metrics, cfg);
  const scored = scorePumpFade(metrics, cfg);
  const plan = pumpFadePlan(metrics, cfg);
  return {
    scanMode: "pump_fade",
    experimental: true,
    provisional: Boolean(options.provisional),
    asOf: options.asOf ?? metrics.signalCloseTime,
    symbol: item.symbol,
    baseAsset: item.baseAsset,
    price: metrics.price,
    change6h: metrics.change6h,
    change24h: metrics.change24h,
    quoteVolume: item.quoteVolume,
    newListing: item.newListing,
    direction: "short",
    score: scored.score,
    grade: pumpFadeGrade(scored.score, cfg),
    stage: stageInfo,
    absorption: {
      level: metrics.takerBuyExhaustion ? "normal" : "insufficient",
      label: metrics.takerBuyExhaustion ? "Taker Buy 소진 추정" : "매수 소진 미확인",
      score: 0,
    },
    breakdown: scored.breakdown,
    penalties: scored.penalties,
    topSignals: topSignals(scored.breakdown, 3),
    goldenCrossRetest: { detected: false, reason: "pump_fade 모드" },
    near1hEma200: false,
    noise: { noisy: false, ci: null, relVol: metrics.volumeClimaxRatio, reasons: [] },
    pumpFade: metrics,
    plan,
    rsi1h: null,
    timeframes: {
      "15m": {
        price: metrics.price, rsi: null, ema20: metrics.ema20, vwap: metrics.vwap,
        lastStructure: metrics.ema20Loss || metrics.vwapLoss ? "bearish_loss" : null,
        lastLabel: null, relVol: metrics.volumeClimaxRatio, cvdSlope: metrics.takerBuyExhaustion ? "down" : "flat",
        fvg: false, ob: false,
      },
      "5m": {
        price: metrics.price, rsi: null, ema20: null, vwap: null,
        lastStructure: metrics.microBreakdown ? "micro_breakdown" : null,
        lastLabel: null, relVol: null, cvdSlope: "flat", fvg: false, ob: false,
      },
    },
  };
}

export default {
  pumpFadePrefilter,
  buildPumpFadeMetrics,
  classifyPumpFadeStage,
  scorePumpFade,
  pumpFadePlan,
  buildPumpFadeResult,
};
