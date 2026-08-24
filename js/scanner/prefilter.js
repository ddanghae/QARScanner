// scanner/prefilter.js — 1~3단계 필터 로직 (순수/반순수).
// Stage 1 종목 수집 → Stage 2 24h 유동성 필터 → Stage 3 급락·초기 후보 필터.

import { CONFIG, STABLE_BASES, LEVERAGED_RE } from "../config.js";
import { rsi, bollinger, atr, last } from "../core/indicators.js";
import { relativeVolume } from "../core/volume-analysis.js";
import { boxRange, squeezePercentile, volDryRatio, isConfirmedEarlyBreakout } from "../core/early-detect.js";

// ---- Stage 1: 거래 가능한 USDT 무기한 선물만 ----
export function stage1Universe(symbols) {
  return symbols.filter((s) =>
    s.contractType === "PERPETUAL" &&
    s.quoteAsset === "USDT" &&
    s.status === "TRADING" &&
    !isExcludedBase(s.baseAsset, s.symbol)
  ).map((s) => ({
    symbol: s.symbol,
    baseAsset: s.baseAsset,
    onboardDate: s.onboardDate || 0,
    pricePrecision: s.pricePrecision,
    filters: s.filters,
  }));
}

function isExcludedBase(base, symbol) {
  if (CONFIG.prefilter.excludeStable && STABLE_BASES.has(base)) return true;
  if (CONFIG.prefilter.excludeLeveraged && LEVERAGED_RE.test(symbol)) return true;
  return false;
}

// 신규 상장 여부 (onboardDate 기준)
export function isNewListing(onboardDate, nowMs) {
  if (!onboardDate) return false;
  const days = (nowMs - onboardDate) / 86_400_000;
  return days < CONFIG.prefilter.newListingDays;
}

// ---- Stage 2: 24h 티커 기반 유동성 필터 ----
// universe + tickers(배열) 병합 후 거래대금/거래횟수/가격 필터, 상위 N.
export function stage2Liquidity(universe, tickers, nowMs, pfOverride) {
  const tickMap = new Map(tickers.map((t) => [t.symbol, t]));
  const pf = pfOverride || CONFIG.prefilter;
  const merged = [];
  const newListings = [];

  for (const u of universe) {
    const t = tickMap.get(u.symbol);
    if (!t) continue;
    const quoteVolume = +t.quoteVolume;
    const count = +t.count;
    const lastPrice = +t.lastPrice;
    const change24h = +t.priceChangePercent;
    const newListing = isNewListing(u.onboardDate, nowMs);
    if (newListing) newListings.push(u.symbol);

    // 필터
    if (lastPrice < pf.minPrice) continue;
    if (quoteVolume < pf.minQuoteVolume) continue;
    if (count < pf.minTradeCount) continue;

    merged.push({
      ...u,
      quoteVolume, count, lastPrice, change24h,
      high24h: +t.highPrice, low24h: +t.lowPrice,
      weightedAvg: +t.weightedAvgPrice,
      newListing,
    });
  }

  merged.sort((a, b) => b.quoteVolume - a.quoteVolume);
  return {
    prefiltered: merged.slice(0, pf.topByVolume),
    newListings,
  };
}

// ---- Stage 3: 급락/급등 초기 후보 필터 (1h 캔들 사용) ----
// item + 1h 캔들(마감) + direction("long"|"short"|"both") → 통과 여부 + 빠른 지표.
// 롱=급락·과매도 admit, 숏=급등·과매수 admit.
export function directionalMovePass(change6h, change24h, direction, dropBasis, cf = CONFIG.candidateFilter) {
  const use24h = dropBasis === "24h";
  if (direction === "long") {
    return use24h
      ? change24h <= -Math.abs(cf.move24hMinAbs)
      : change6h <= cf.drop6hMax;
  }
  return use24h
    ? change24h >= Math.abs(cf.move24hMinAbs)
    : change6h >= cf.surge6hMin;
}

export function stage3Evaluate(item, klines1h, direction = "long", dropBasis = "6h") {
  const cf = CONFIG.candidateFilter;
  const n = klines1h.length;
  if (n < 30) return { pass: false, reason: "데이터 부족" };

  const closes = klines1h.map((c) => c.close);
  const price = closes[n - 1];
  const price6hAgo = closes[n - 7] ?? closes[0];
  const change6h = ((price - price6hAgo) / price6hAgo) * 100;
  const price24hAgo = closes[Math.max(0, n - 25)];
  const change24h = ((price - price24hAgo) / price24hAgo) * 100;
  const rsiNow = rsi(closes, CONFIG.indicators.rsiPeriod)[n - 1];
  const relVolNow = relativeVolume(klines1h, 20)[n - 1] ?? 1;

  const win = klines1h.slice(-24);
  const recentLow = Math.min(...win.map((c) => c.low));
  const recentHigh = Math.max(...win.map((c) => c.high));
  const nearLowPct = ((price - recentLow) / recentLow) * 100;
  const nearHighPct = ((recentHigh - price) / recentHigh) * 100;

  const wantLong = direction === "long" || direction === "both";
  const wantShort = direction === "short" || direction === "both";
  const use24h = dropBasis === "24h";
  const longDirectionalMove = directionalMovePass(change6h, change24h, "long", dropBasis, cf);
  const shortDirectionalMove = directionalMovePass(change6h, change24h, "short", dropBasis, cf);

  // 롱 후보: (급락 OR 저점 근접) AND RSI 과매도권. 단 이미 급등이면 제외.
  const longCand = wantLong && change24h <= cf.surge24hExclude &&
    ((longDirectionalMove || nearLowPct <= cf.nearLowPct)
      && rsiNow != null && rsiNow <= cf.rsiLongMax);

  // 숏 후보: (급등 OR 고점 근접) AND RSI 과매수권. 단 이미 폭락이면 제외.
  const shortCand = wantShort && change24h >= cf.crash24hExclude &&
    ((shortDirectionalMove || nearHighPct <= cf.nearHighPct)
      && rsiNow != null && rsiNow >= cf.rsiShortMin);

  const pass = longCand || shortCand;
  // both 일 때 더 강하게 걸린 쪽을 힌트로 (deep 은 both 면 양쪽 다 계산)
  const dirHint = longCand && !shortCand ? "long" : shortCand && !longCand ? "short" : direction;

  return {
    pass,
    reason: pass ? "후보" : "조건 미달",
    dirHint,
    change6h, change24h, basisChange: use24h ? change24h : change6h,
    dropBasis: use24h ? "24h" : "6h",
    rsiNow, relVolNow, nearLowPct, nearHighPct, recentLow, recentHigh, price,
  };
}

// stage3 결과 목록에서 상한 적용
export function capCandidates(list) {
  return list.slice(0, CONFIG.candidateFilter.keepMax);
}

// 대형코인 제외 (조기 포착 모드 — 큰 상승이 드묾)
export function excludeMajors(list, majors) {
  if (!majors || !majors.length) return list;
  const set = new Set(majors);
  return list.filter((x) => !set.has(x.baseAsset));
}

// ---- early 1차 선별 ----
// 4시간봉으로 "좁은 박스 + 압축 + 거래량 고갈" 을 빠르게 확인해 정밀 분석 후보를 줄인다.
// OI 호출 전에 걸러내는 것이 목적이므로 여기서는 OI 를 보지 않는다.
export function stage3EvaluateEarly(item, k4h, cfg) {
  const e = cfg.earlyDetect;
  const box = boxRange(k4h, e.boxLookback);
  if (!box) return { pass: false, reason: "데이터 부족" };

  const closes = k4h.map((c) => c.close);
  const widths = bollinger(closes, cfg.indicators.bb.period, cfg.indicators.bb.mult).width;
  const squeezePct = squeezePercentile(widths, e.squeezeLookback);
  const volDry = volDryRatio(k4h, e.volRecentN, e.volPriorN);

  const prevBox = boxRange(k4h.slice(0, -1), e.boxLookback);
  const price = closes[closes.length - 1];
  const breakoutLevel = prevBox?.boxHigh ?? null;
  const breakoutClose = Number.isFinite(breakoutLevel) && price > breakoutLevel;
  const runFromBreakoutPct = breakoutLevel > 0 ? ((price - breakoutLevel) / breakoutLevel) * 100 : Infinity;
  const relVolArr = relativeVolume(k4h, 20);
  const recentRel = relVolArr.slice(-3).filter((x) => Number.isFinite(x));
  const relVol3 = recentRel.length === 3 ? recentRel.reduce((a, b) => a + b, 0) / 3 : null;
  const atrArr = atr(k4h, cfg.indicators.atrPeriod);
  const atrNow = last(atrArr);
  const atrPrev = atrArr.length > 5 ? atrArr[atrArr.length - 6] : null;
  const atrRising = Number.isFinite(atrNow) && Number.isFinite(atrPrev) && atrNow > atrPrev;
  const breakoutReady = isConfirmedEarlyBreakout({
    breakoutClose, relVol3, atrRising, runFromBreakoutPct,
  }, cfg);

  const gate = earlyPrefilterGate({ boxWidthPct: box.boxWidthPct, squeezePct, volDry }, cfg);

  return {
    pass: gate.pass,
    reason: gate.reason,
    boxWidthPct: box.boxWidthPct,
    squeezePct,
    volDry,
    breakoutClose,
    breakoutReady,
    relVol3,
    atrRising,
  };
}

export function earlyPrefilterGate(metrics, cfg) {
  const e = cfg.earlyDetect;
  const boxOk = Number.isFinite(metrics?.boxWidthPct) && metrics.boxWidthPct <= e.boxWidthMaxPct;
  const squeezeOk = Number.isFinite(metrics?.squeezePct) && metrics.squeezePct <= e.prefilterSqueezePctMax;
  const volOk = Number.isFinite(metrics?.volDry) && metrics.volDry <= e.volDryMax;
  const pass = boxOk && squeezeOk && volOk;
  return {
    pass,
    reason: pass ? "후보" : !boxOk ? "박스 넓음 또는 자료 부족"
      : !squeezeOk ? "압축 부족 또는 자료 부족" : "거래량 고갈 아님 또는 자료 부족",
  };
}

// 후보 상한에서 이미 확인된 돌파를 먼저 보존하고, 나머지는 압축이 강한 순으로 정렬한다.
export function prioritizeEarlyCandidates(evaluated, keepMax) {
  const limit = Number.isInteger(keepMax) && keepMax >= 0 ? keepMax : 0;
  return evaluated
    .filter((x) => x.res?.pass)
    .sort((a, b) => {
      const breakoutOrder = Number(Boolean(b.res.breakoutReady)) - Number(Boolean(a.res.breakoutReady));
      if (breakoutOrder) return breakoutOrder;
      const squeezeOrder = (a.res.squeezePct ?? 100) - (b.res.squeezePct ?? 100);
      if (squeezeOrder) return squeezeOrder;
      const aSymbol = String(a.item?.symbol || "");
      const bSymbol = String(b.item?.symbol || "");
      return aSymbol < bSymbol ? -1 : aSymbol > bSymbol ? 1 : 0;
    })
    .slice(0, limit);
}

export default {
  stage1Universe, isNewListing, stage2Liquidity, stage3Evaluate, capCandidates,
  excludeMajors, stage3EvaluateEarly, earlyPrefilterGate, prioritizeEarlyCandidates,
};
