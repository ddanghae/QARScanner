// scanner/deep-scanner.js — 남은 후보 정밀 분석 (4H·1H·15M·5M).
// 종목 하나를 멀티타임프레임 분석 → signals → 흡수/단계/점수 → 결과 객체.

import { CONFIG } from "../config.js";
import { getKlines, closedOnly } from "../api/binance.js";
import { computeIndicators, last } from "../core/indicators.js";
import {
  volumeDelta, cvd, cvdSlope, avgVolume, relativeVolume, candleAbsorption, volumeTrend,
} from "../core/volume-analysis.js";
import { findPivots, structureSummary } from "../core/market-structure.js";
import { analyzeLiquidity } from "../core/liquidity.js";
import { detectFvgs, activeFvgAt, latestFvg } from "../core/fvg.js";
import { detectOrderBlocks, activeObAt, latestValidOb } from "../core/order-block.js";
import { computeLongPlan, computeShortPlan } from "../core/risk-reward.js";
import { estimateAbsorption, classifyStage, scoreCandidate, topSignals } from "../core/scoring.js";
import { detectGoldenCrossRetest } from "../core/golden-cross-retest.js";

// 한 시간봉 분석 묶음
function analyzeTf(candlesRaw, includeRealtime, tf) {
  const candles = closedOnly(candlesRaw, includeRealtime);
  if (candles.length < 40) return null;
  const ind = computeIndicators(candles, CONFIG.indicators);
  const atrVal = last(ind.atr);
  const avgVol = last(avgVolume(candles, 20));
  const pivotsSwing = findPivots(candles, CONFIG.structure.swingPivot);
  const struct = structureSummary(candles, pivotsSwing, tf, includeRealtime);
  const liq = analyzeLiquidity(candles, CONFIG, atrVal, avgVol);
  const fvgs = detectFvgs(candles, atrVal, CONFIG);
  const obs = detectOrderBlocks(candles, struct.events, 20);
  const relVol = relativeVolume(candles, 20);
  return {
    tf, candles, ind, atrVal, avgVol,
    price: candles[candles.length - 1].close,
    struct, liq, fvgs, obs,
    relVolNow: last(relVol) ?? 1,
    cvdArr: cvd(candles),
    cvdSlope: cvdSlope(candles, 10),
    deltaLast: last(volumeDelta(candles).map((v, i, a) => v)) ?? 0,
    volTrend: volumeTrend(candles, 5, 20),
  };
}

// 멀티타임프레임 데이터 요청
async function fetchAll(symbol) {
  const [k4h, k1h, k15m, k5m] = await Promise.all([
    getKlines(symbol, "4h"),
    getKlines(symbol, "1h"),
    getKlines(symbol, "15m"),
    getKlines(symbol, "5m"),
  ]);
  return { k4h, k1h, k15m, k5m };
}

// long 관점 signals 조립
function buildLongSignals(item, a4, a1, a15, a5, pre) {
  const price = a15.price;
  const atr15 = a15.atrVal || price * 0.01;

  // 저점 스윕/회복 (15m + 1h)
  const lowSweep15 = a15.liq.lowSweep;
  const lowSweep = !!(lowSweep15 || a1.liq.lowSweep);
  const lowSweepValid = !!(lowSweep15 && lowSweep15.valid);
  const sweepRecovered = !!(lowSweep15?.recovered || a1.liq.lowSweep?.recovered);

  // 구조전환
  const choch1h = a1.struct.choch && a1.struct.bullishShift;
  const choch15 = a15.struct.choch && a15.struct.bullishShift;
  const choch5 = a5.struct.choch && a5.struct.bullishShift;
  const structureShift1h = !!(a1.struct.lastEvent && a1.struct.bullishShift);

  // FVG / OB 중첩 (15m)
  const fvg15 = activeFvgAt(a15.fvgs, price, "bullish") || latestFvg(a15.fvgs, "bullish");
  const ob15 = activeObAt(a15.obs, price, "bullish") || latestValidOb(a15.obs, "bullish");
  const fvgObOverlap = !!(fvg15 && ob15 &&
    rangesOverlap(fvg15.gapLow, fvg15.gapHigh, ob15.bottom, ob15.top));

  // 진입 재진입 (4단계용)
  const fvgReentry = !!(fvg15 && price >= fvg15.gapLow && price <= fvg15.gapHigh);
  const obReentry = !!(ob15 && price >= ob15.bottom && price <= ob15.top);

  // 거래량/Delta 전환
  const volumeDeltaShift = a15.cvdSlope > 0 && a15.volTrend.avgRel >= 1.0;
  const cvdImproved = a15.cvdSlope > 0;
  const deltaImproved = a15.deltaLast > 0;

  // 5분 진입 트리거
  const low5mDefended = a5.liq.lowSweep ? a5.liq.lowSweep.recovered : false;
  const entryTrigger5m = !!(choch5 || (a5.struct.firstHigherLow && a5.volTrend.avgRel >= 1.1));
  const volumeReSurge = a5.volTrend.avgRel >= 1.2 || a15.volTrend.surge;
  const volumeReacted = a15.volTrend.avgRel >= 1.0;

  // 급락 + 과매도
  const rsi1h = last(a1.ind.rsi);
  const dropAndOversold = (pre.change6h <= CONFIG.candidateFilter.drop6hMax || pre.nearLowPct <= CONFIG.candidateFilter.nearLowPct)
    && rsi1h != null && rsi1h <= 50;

  // 유동성/거래대금
  const goodLiquidity = item.quoteVolume >= CONFIG.prefilter.minQuoteVolume * 1.5;

  // 흡수용 캔들 요약 (15m 마지막)
  const lastC = a15.candles[a15.candles.length - 1];
  const absorptionCandle = candleAbsorption(lastC, a15.avgVol);

  // 첫 HH/HL (구조전환 초기)
  const firstHH = a15.struct.firstHigherHigh || a1.struct.firstHigherHigh;
  const firstHL = a15.struct.firstHigherLow || a1.struct.firstHigherLow;
  const fvgCreated = !!latestFvg(a15.fvgs, "bullish");
  const obCreated = !!latestValidOb(a15.obs, "bullish");
  // 첫 임펄스 이미 크게 나갔는지 (진입구간 지나침)
  const firstPushDone = a15.struct.lastLabel === "HH" && pctFromRecentLow(a15) > 8;

  // ---- 감점 신호 ----
  const change15mOverExtended = pctFromRecentLow(a15) > 12 && (last(a15.ind.rsi) ?? 50) > 70;
  const recentLow = a15.liq.lows.length ? a15.liq.lows[a15.liq.lows.length - 1].price : lastC.low;
  const farFromLowAtr = (price - recentLow) / atr15 > 8;
  const buyTarget = a1.liq.targets.buySideTarget;
  const shortTargetDistance = buyTarget != null && (buyTarget - price) / atr15 < 1.5;
  const resistanceAbove = a1.liq.eqHighs.find((h) => h.price > price);
  const strongResistanceAbove = !!(resistanceAbove && (resistanceAbove.price - price) / atr15 < 1);
  const tooLowVolume = a15.volTrend.avgRel != null && a15.volTrend.avgRel < 0.5;
  const strongDowntrend4h = is4hStrongDown(a4);
  const newListingThin = item.newListing;
  const rsiOverheated = (last(a15.ind.rsi) ?? 50) > 78 || (last(a5.ind.rsi) ?? 50) > 82;

  // ---- 손익비 ----
  const plan = computeLongPlan({
    price,
    fvg15, ob15,
    vwap1h: last(a1.ind.vwap),
    ema20_15: last(a15.ind.ema[20]),
    internalHigh: nearestAbove(a15.liq.highs, price),
    majorHigh1h: nearestAbove(a1.liq.highs, price),
    buySideTarget: buyTarget,
    swingLow: recentLow,
    atr: atr15,
  });
  const riskRewardOk = plan.riskReward >= 2;
  const poorRiskReward = plan.riskReward < 1.5;

  return {
    direction: "long",
    price,
    // 점수 신호
    dropAndOversold, goodLiquidity, lowSweepValid, sweepRecovered,
    structureShift1h, fvgObOverlap, volumeDeltaShift, entryTrigger5m, riskRewardOk,
    // 단계 신호
    lowSweep, volumeReacted, cvdImproved, deltaImproved,
    choch1h, choch15m: choch15, choch5m: choch5,
    firstHH, firstHL, fvgCreated, obCreated, firstPushDone,
    fvgReentry, obReentry, low5mDefended, volumeReSurge,
    change15mOverExtended, farFromLowAtr, shortTargetDistance,
    rsiOverheated, poorRiskReward,
    // 감점
    strongResistanceAbove, tooLowVolume, strongDowntrend4h, newListingThin,
    // 흡수
    absorptionCandle,
    cvdDown: a15.cvdSlope < 0,
    priceFlatOrUp: pre.change6h >= -1,
    // 부가
    plan, fvg15, ob15, rsi1h,
  };
}

// ---- 헬퍼 ----
function rangesOverlap(a1, a2, b1, b2) {
  return Math.max(a1, b1) <= Math.min(a2, b2);
}
function nearestAbove(levels, price) {
  const above = levels.filter((l) => l.price > price).sort((a, b) => a.price - b.price)[0];
  return above ? above.price : null;
}
function pctFromRecentLow(a) {
  const lows = a.liq.lows;
  if (!lows.length) return 0;
  const lo = lows[lows.length - 1].price;
  return ((a.price - lo) / lo) * 100;
}
function is4hStrongDown(a4) {
  const e50 = last(a4.ind.ema[50]);
  const e200 = last(a4.ind.ema[200]);
  const price = a4.price;
  const rsi = last(a4.ind.rsi);
  return e50 != null && e200 != null && price < e50 && e50 < e200 && (rsi ?? 50) < 42;
}
function is4hStrongUp(a4) {
  const e50 = last(a4.ind.ema[50]);
  const e200 = last(a4.ind.ema[200]);
  const rsi = last(a4.ind.rsi);
  return e50 != null && e200 != null && a4.price > e50 && e50 > e200 && (rsi ?? 50) > 58;
}
function nearestBelow(levels, price) {
  const below = levels.filter((l) => l.price < price).sort((a, b) => b.price - a.price)[0];
  return below ? below.price : null;
}
function pctFromRecentHigh(a) {
  const highs = a.liq.highs;
  if (!highs.length) return 0;
  const hi = highs[highs.length - 1].price;
  return ((hi - a.price) / hi) * 100;
}

// short 관점 signals 조립 — buildLongSignals 의 대칭(고점 스윕·하락 구조전환·bearish FVG/OB).
function buildShortSignals(item, a4, a1, a15, a5, pre) {
  const price = a15.price;
  const atr15 = a15.atrVal || price * 0.01;

  const highSweep15 = a15.liq.highSweep;
  const lowSweep = !!(highSweep15 || a1.liq.highSweep);            // 키 재사용(=고점 스윕)
  const lowSweepValid = !!(highSweep15 && highSweep15.valid);
  const sweepRecovered = !!(highSweep15?.recovered || a1.liq.highSweep?.recovered); // 반락

  const bearShift = (a) => !!a.struct.lastEvent && !a.struct.bullishShift;
  const choch1h = a1.struct.choch && !a1.struct.bullishShift;
  const choch15 = a15.struct.choch && !a15.struct.bullishShift;
  const choch5 = a5.struct.choch && !a5.struct.bullishShift;
  const structureShift1h = bearShift(a1);

  const fvg15 = activeFvgAt(a15.fvgs, price, "bearish") || latestFvg(a15.fvgs, "bearish");
  const ob15 = activeObAt(a15.obs, price, "bearish") || latestValidOb(a15.obs, "bearish");
  const fvgObOverlap = !!(fvg15 && ob15 &&
    rangesOverlap(fvg15.gapLow, fvg15.gapHigh, ob15.bottom, ob15.top));
  const fvgReentry = !!(fvg15 && price >= fvg15.gapLow && price <= fvg15.gapHigh);
  const obReentry = !!(ob15 && price >= ob15.bottom && price <= ob15.top);

  // 거래량/Delta 전환(하락 방향) — 키 재사용
  const volumeDeltaShift = a15.cvdSlope < 0 && a15.volTrend.avgRel >= 1.0;
  const cvdImproved = a15.cvdSlope < 0;
  const deltaImproved = a15.deltaLast < 0;

  const high5mDefended = a5.liq.highSweep ? a5.liq.highSweep.recovered : false;
  const entryTrigger5m = !!(choch5 || (lowerHigh(a5) && a5.volTrend.avgRel >= 1.1));
  const volumeReSurge = a5.volTrend.avgRel >= 1.2 || a15.volTrend.surge;
  const volumeReacted = a15.volTrend.avgRel >= 1.0;

  const rsi1h = last(a1.ind.rsi);
  const dropAndOversold = (pre.change6h >= CONFIG.candidateFilter.surge6hMin || pctFromRecentHigh(a1) <= CONFIG.candidateFilter.nearHighPct)
    && rsi1h != null && rsi1h >= 50; // 급등 + 과매수

  const goodLiquidity = item.quoteVolume >= CONFIG.prefilter.minQuoteVolume * 1.5;
  const lastC = a15.candles[a15.candles.length - 1];
  const absorptionCandle = candleAbsorption(lastC, a15.avgVol);

  const firstLL = a15.struct.swings.some((s) => s.label === "LL") || a1.struct.swings.some((s) => s.label === "LL");
  const firstLH = a15.struct.swings.some((s) => s.label === "LH") || a1.struct.swings.some((s) => s.label === "LH");
  const fvgCreated = !!latestFvg(a15.fvgs, "bearish");
  const obCreated = !!latestValidOb(a15.obs, "bearish");
  const firstPushDone = a15.struct.lastLabel === "LL" && pctFromRecentHigh(a15) > 8;

  // ---- 감점 (대칭) ----
  const change15mOverExtended = pctFromRecentHigh(a15) > 12 && (last(a15.ind.rsi) ?? 50) < 30;
  const recentHigh = a15.liq.highs.length ? a15.liq.highs[a15.liq.highs.length - 1].price : lastC.high;
  const farFromLowAtr = (recentHigh - price) / atr15 > 8;                    // 고점에서 멀어짐
  const sellTarget = a1.liq.targets.sellSideTarget;
  const shortTargetDistance = sellTarget != null && (price - sellTarget) / atr15 < 1.5;
  const supportBelow = a1.liq.eqLows.find((l) => l.price < price);
  const strongResistanceAbove = !!(supportBelow && (price - supportBelow.price) / atr15 < 1); // =아래 강한 지지
  const tooLowVolume = a15.volTrend.avgRel != null && a15.volTrend.avgRel < 0.5;
  const strongDowntrend4h = is4hStrongUp(a4);                                // =강한 상승 추세(숏 역행)
  const newListingThin = item.newListing;
  const rsiOverheated = (last(a15.ind.rsi) ?? 50) < 22 || (last(a5.ind.rsi) ?? 50) < 18; // 과매도 과열

  const plan = computeShortPlan({
    price, fvg15, ob15,
    vwap1h: last(a1.ind.vwap),
    ema20_15: last(a15.ind.ema[20]),
    internalLow: nearestBelow(a15.liq.lows, price),
    majorLow1h: nearestBelow(a1.liq.lows, price),
    sellSideTarget: sellTarget,
    swingHigh: recentHigh,
    atr: atr15,
  });
  const riskRewardOk = plan.riskReward >= 2;
  const poorRiskReward = plan.riskReward < 1.5;

  return {
    direction: "short", price,
    dropAndOversold, goodLiquidity, lowSweepValid, sweepRecovered,
    structureShift1h, fvgObOverlap, volumeDeltaShift, entryTrigger5m, riskRewardOk,
    lowSweep, volumeReacted, cvdImproved, deltaImproved,
    choch1h, choch15m: choch15, choch5m: choch5,
    firstHH: firstLL, firstHL: firstLH, fvgCreated, obCreated, firstPushDone, // 키 재사용
    fvgReentry, obReentry, low5mDefended: high5mDefended, volumeReSurge,
    change15mOverExtended, farFromLowAtr, shortTargetDistance,
    rsiOverheated, poorRiskReward,
    strongResistanceAbove, tooLowVolume, strongDowntrend4h, newListingThin,
    absorptionCandle,
    cvdUp: a15.cvdSlope > 0,
    priceFlatOrDown: pre.change6h <= 1,
    plan, fvg15, ob15, rsi1h,
  };
}
// 5분봉 마지막 스윙이 Lower High 인지 (숏 진입 트리거용)
function lowerHigh(a5) {
  const sw = a5.struct.swings;
  return sw.length ? sw[sw.length - 1].label === "LH" : false;
}

// 최종: 종목 하나 정밀 분석
export async function deepAnalyze(item, settings) {
  const includeRt = settings.includeRealtimeCandle;
  const { k4h, k1h, k15m, k5m } = await fetchAll(item.symbol);
  const a4 = analyzeTf(k4h, includeRt, "4h");
  const a1 = analyzeTf(k1h, includeRt, "1h");
  const a15 = analyzeTf(k15m, includeRt, "15m");
  const a5 = analyzeTf(k5m, includeRt, "5m");
  if (!a4 || !a1 || !a15 || !a5) {
    return { symbol: item.symbol, error: "캔들 데이터 부족", skipped: true };
  }

  // 빠른 지표(1h) — stage3 결과가 없으면 여기서 근사
  const closes1h = a1.ind.closes;
  const pre = {
    change6h: pctChange(closes1h, 6),
    change24h: pctChange(closes1h, 24),
    nearLowPct: pctFromRecentLow(a1),
  };

  // 방향별 점수 계산. both 면 양쪽 다 계산 후 높은 점수 채택(한 종목 한 행).
  const dir = item.pre?.dirHint || settings.direction || "long";
  const sides = [];
  if (dir === "long" || dir === "both") sides.push(scoreSide("long", buildLongSignals(item, a4, a1, a15, a5, pre), settings));
  if (dir === "short" || dir === "both") sides.push(scoreSide("short", buildShortSignals(item, a4, a1, a15, a5, pre), settings));
  const best = sides.sort((x, y) => y.scored.score - x.scored.score)[0];
  if (!best) return { symbol: item.symbol, error: "방향 없음", skipped: true };

  const { side, sig, absorption, stageInfo, scored } = best;
  // 골든크로스 리테스트 — 스코어링과 별개, 4시간봉 EMA50/200 기준 독립 필터/배지
  const goldenCrossRetest = detectGoldenCrossRetest(a4.candles, a4.ind.ema[50], a4.ind.ema[200], a4.atrVal, CONFIG);
  // 1시간봉 200일선 밀착 — 스코어링과 별개, 독립 필터/배지
  const ema200_1h = last(a1.ind.ema[200]);
  const near1hEma200 = ema200_1h != null && a1.atrVal
    ? Math.abs(a1.price - ema200_1h) <= a1.atrVal * CONFIG.near1hEma200AtrRatio
    : false;
  return {
    symbol: item.symbol,
    baseAsset: item.baseAsset,
    price: sig.price,
    change6h: pre.change6h,
    change24h: item.change24h ?? pre.change24h,
    quoteVolume: item.quoteVolume,
    newListing: item.newListing,
    direction: side,
    score: scored.score,
    grade: scored.grade,
    stage: stageInfo,
    absorption,
    breakdown: scored.breakdown,
    penalties: scored.penalties,
    topSignals: topSignals(scored.breakdown, 3),
    goldenCrossRetest,
    near1hEma200,
    plan: sig.plan,
    rsi1h: sig.rsi1h,
    timeframes: {
      "4h": tfSummary(a4, side),
      "1h": tfSummary(a1, side),
      "15m": tfSummary(a15, side),
      "5m": tfSummary(a5, side),
    },
  };
}

// 한 방향 점수 묶음 — 감점은 사용자 채점 강도(settings.penalties, §13 STRICTNESS_LEVELS) 있으면 그걸로 덮어씀
function scoreSide(side, sig, settings) {
  const absorption = estimateAbsorption(sig, side);
  const stageInfo = classifyStage(sig);
  const cfg = settings?.penalties ? { ...CONFIG, penalties: settings.penalties } : CONFIG;
  const scored = scoreCandidate(sig, absorption, stageInfo, cfg, side);
  return { side, sig, absorption, stageInfo, scored };
}

function pctChange(closes, barsAgo) {
  const n = closes.length;
  if (n < barsAgo + 1) return 0;
  const then = closes[n - 1 - barsAgo], now = closes[n - 1];
  return ((now - then) / then) * 100;
}
function tfSummary(a, side = "long") {
  const d = side === "short" ? "bearish" : "bullish";
  return {
    price: a.price,
    rsi: round(last(a.ind.rsi)),
    ema20: round(last(a.ind.ema[20])),
    ema50: round(last(a.ind.ema[50])),
    vwap: round(last(a.ind.vwap)),
    lastStructure: a.struct.lastEvent ? a.struct.lastEvent.type : null,
    lastLabel: a.struct.lastLabel,
    relVol: round2(a.relVolNow),
    cvdSlope: a.cvdSlope > 0 ? "up" : a.cvdSlope < 0 ? "down" : "flat",
    fvg: !!latestFvg(a.fvgs, d),
    ob: !!latestValidOb(a.obs, d),
  };
}
function round(x) { return x == null ? null : Math.round(x * 1e6) / 1e6; }
function round2(x) { return x == null ? null : Math.round(x * 100) / 100; }

export default { deepAnalyze };
