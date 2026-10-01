// Experimental continuation -> breakout -> first retest -> closed-bar confirmation.
// Every pattern is detected on a historical prefix and its levels are frozen.
import { CONFIG } from "../config.js";
import { detectChartPatterns } from "./chart-patterns.js";
import { confirmedFractalTrend } from "./fractal-continuation.js";
import { ema, atr } from "./indicators.js";
import { cvdDivergence } from "./volume-analysis.js";

const MS = { "5m": 300000, "15m": 900000, "1h": 3600000, "4h": 14400000 };
const average = a => a.reduce((s, x) => s + x, 0) / a.length;
const finite = x => typeof x === "number" && Number.isFinite(x);
export const RETEST_LABELS = {
  unavailable: "자료 확인 필요", watch: "패턴 형성 관찰", breakout: "돌파 확인 · 첫 눌림 대기",
  retest: "첫 눌림 · 전환 대기", ready: "전환 확인 · 검토 후보", invalid: "구조 무효화",
  expired: "신호 만료", late: "목표 진행 · 추격 제외", risk: "손익비·손절 조건 부족",
};

function closedSeries(raw, tf, now) {
  const bars = (raw || []).filter(c => finite(c.closeTime) && c.closeTime < now);
  if (!bars.length || now - bars.at(-1).closeTime > MS[tf] + 2000) return null;
  for (let i = 0; i < bars.length; i++) {
    const c = bars[i];
    if (![c.openTime, c.closeTime, c.open, c.high, c.low, c.close, c.volume].every(finite)
      || c.low <= 0 || c.volume < 0 || c.high < Math.max(c.open, c.close)
      || c.low > Math.min(c.open, c.close) || c.high < c.low
      || c.closeTime - c.openTime !== MS[tf] - 1
      || (i && c.openTime - bars[i - 1].openTime !== MS[tf])) return null;
  }
  return bars;
}

function directionContext(bars, at) {
  const prefix = bars.filter(c => c.closeTime <= at);
  if (prefix.length < 200) return null;
  const ma = ema(prefix.map(c => c.close), 200).at(-1);
  const trend = confirmedFractalTrend(prefix, 3), price = prefix.at(-1).close;
  return { direction: price > ma && trend === "up" ? "long" : price < ma && trend === "down" ? "short" : null,
    ema200: ma, trend, at: prefix.at(-1).closeTime };
}

function actionable(p, cfg) {
  return p.family === "continuation" && p.fitScore >= cfg.minFit
    && [p.trigger, p.invalidation, p.projection].every(x => finite(x) && x > 0)
    && (p.bias === "bullish" ? p.invalidation < p.trigger && p.trigger < p.projection
      : p.bias === "bearish" && p.projection < p.trigger && p.trigger < p.invalidation);
}

// Diagnostic observations only: none of these fields increases the entry score.
export function observeSupply(bars, asOf, context = {}) {
  const valid = closedSeries(bars, "5m", asOf);
  const none = { available: false, at: null, evidence: [], label: "수급 자료 부족", oiChangePct: null, funding: null };
  if (!valid || valid.length < 23) return none;
  const last = valid.at(-1), baseline = valid.slice(-23, -3), recent = valid.slice(-3);
  const mean = average(baseline.map(c => c.volume));
  const relVolume = mean > 0 ? average(recent.map(c => c.volume)) / mean : null;
  const usable = recent.every(c => finite(c.takerBuyBase) && c.takerBuyBase >= 0 && c.takerBuyBase <= c.volume);
  const total = recent.reduce((s, c) => s + c.volume, 0);
  const buyRatio = usable && total > 0 ? recent.reduce((s, c) => s + c.takerBuyBase, 0) / total : null;
  const delta = buyRatio == null ? null : total * (2 * buyRatio - 1);
  const evidence = [];
  if (relVolume >= 2) evidence.push({ side: "neutral", text: `최근 3봉 거래량 ${relVolume.toFixed(1)}배` });
  if (buyRatio >= .55) evidence.push({ side: "long", text: `공격적 매수 비중 ${(buyRatio * 100).toFixed(1)}%` });
  if (buyRatio <= .45 && buyRatio != null) evidence.push({ side: "short", text: `공격적 매도 비중 ${((1 - buyRatio) * 100).toFixed(1)}%` });
  const pos = last.high > last.low ? (last.close - last.low) / (last.high - last.low) : .5;
  if (buyRatio <= .45 && buyRatio != null && pos >= .65) evidence.push({ side: "long", text: "매도 체결에도 고가권 마감 · 흡수 추정" });
  if (buyRatio >= .55 && pos <= .35) evidence.push({ side: "short", text: "매수 체결에도 저가권 마감 · 흡수 추정" });
  const prior = valid.slice(-21, -1), hi = Math.max(...prior.map(c => c.high)), lo = Math.min(...prior.map(c => c.low));
  if (last.low < lo && last.close > lo) evidence.push({ side: "long", text: "최근 20봉 저점 이탈 후 회복" });
  if (last.high > hi && last.close < hi) evidence.push({ side: "short", text: "최근 20봉 고점 돌파 후 복귀" });
  if (valid.every(c => finite(c.takerBuyBase) && c.takerBuyBase >= 0 && c.takerBuyBase <= c.volume)) {
    const div = cvdDivergence(valid, 3, 40);
    if (div.bullish) evidence.push({ side: "long", text: "가격 저점 하락 · CVD 저점 상승" });
    if (div.bearish) evidence.push({ side: "short", text: "가격 고점 상승 · CVD 고점 하락" });
  }
  const oi = (context.oi || []).filter(x => finite(x.time) && x.time <= asOf && finite(x.oi) && x.oi > 0).sort((a,b) => a.time-b.time);
  const latest = oi.at(-1), previous = latest && oi.findLast(x => x.time <= latest.time - 900000);
  const oiFresh = latest && asOf - latest.time <= 600000;
  const oiChangePct = oiFresh && previous && latest.time - previous.time <= 1200000 ? (latest.oi / previous.oi - 1) * 100 : null;
  if (oiChangePct != null) evidence.push({ side: "neutral", text: `미결제약정 15분 ${oiChangePct >= 0 ? "+" : ""}${oiChangePct.toFixed(2)}% · 방향 확정 불가` });
  const funding = finite(context.funding) && finite(context.fundingAt) && asOf - context.fundingAt >= 0 && asOf - context.fundingAt <= 120000 ? context.funding : null;
  return { available: true, at: last.closeTime, observedAt: asOf, label: evidence.length ? "수급 변화 관측" : "뚜렷한 수급 변화 없음",
    evidence, relVolume, buyRatio, delta, oiChangePct, oiAt: oiFresh ? latest.time : null, funding, fundingAt: funding == null ? null : context.fundingAt };
}

function inspectSetup(setup, bars, cfg, now) {
  const { pattern: p, breakoutIndex: b, direction } = setup, long = direction === "long", sign = long ? 1 : -1;
  const result = { ...setup, status: "breakout", plan: null, asOf: bars.at(-1).closeTime };
  const stopHit = c => long ? c.low <= p.invalidation : c.high >= p.invalidation;
  const targetHit = c => long ? c.high >= p.projection : c.low <= p.projection;
  const band = setup.atr * cfg.retestAtr;
  const zones = [{ low: p.trigger - band, high: p.trigger + band, name: "돌파선" }];
  let retest = -1, confirm = -1, stop = null;
  for (let i = b; i < bars.length; i++) {
    const c = bars[i];
    if (stopHit(c)) return { ...result, status: "invalid", reason: "패턴 구조 무효화선을 잃었습니다." };
    if (targetHit(c)) return { ...result, status: "late", reason: "패턴 목표가 이미 진행됐습니다." };
    if (i === b) continue;
    // FVG must have formed before the retracement; never create a zone from the retest candle itself.
    if (retest < 0 && i >= b + 2) {
      const a = bars[i - 3], z = bars[i - 1];
      if (a && (long ? z.low > a.high : z.high < a.low)) {
        zones.push({ low: long ? a.high : z.high, high: long ? z.low : a.low, name: "돌파 후 FVG" });
      }
    }
    if (retest < 0) {
      if (i - b > cfg.retestBars) return { ...result, status: "expired", reason: "첫 눌림 대기 시간이 지났습니다." };
      const zone = zones.find(z => c.low <= z.high && c.high >= z.low);
      if (zone) { retest = i; result.retestAt = c.closeTime; result.zone = zone; result.status = "retest"; }
      else continue;
    }
    if (confirm < 0) {
      if (i - retest > cfg.confirmBars) return { ...result, status: "expired", reason: "눌림 뒤 전환 확인 시간이 지났습니다." };
      if (i > retest && (long ? c.close > bars[i - 1].high && c.close > p.trigger : c.close < bars[i - 1].low && c.close < p.trigger)) {
        confirm = i;
        const retracement = bars.slice(retest, i + 1);
        stop = (long ? Math.min(...retracement.map(x => x.low)) : Math.max(...retracement.map(x => x.high))) - sign * setup.atr * cfg.stopAtrBuffer;
        result.confirmedAt = c.closeTime;
        result.expiresAt = c.closeTime + cfg.freshBars * MS["5m"];
        result.status = "ready";
      }
    } else if (long ? c.low <= stop : c.high >= stop) return { ...result, status: "invalid", reason: "확인 뒤 눌림 손절선을 잃었습니다." };
  }
  if (confirm < 0) return { ...result, reason: retest < 0 ? "마감 돌파 후 첫 되돌림을 기다립니다." : "첫 되돌림 뒤 5분봉 전환을 기다립니다." };
  if (now >= result.expiresAt) return { ...result, status: "expired", reason: "전환 확인의 유효 시간이 지났습니다." };
  const entry = bars[confirm].close, entryBand = Math.min(setup.atr * .1, entry * .0015);
  const entryLow = entry - entryBand, entryHigh = entry + entryBand, conservative = long ? entryHigh : entryLow;
  const risk = sign * (conservative - stop), reward = sign * (p.projection - conservative);
  const cost = conservative * cfg.roundTripCostPct / 100, netRR = (reward - cost) / (risk + cost), riskPct = risk / conservative * 100;
  if (risk <= 0 || reward <= 0 || riskPct < cfg.minStopPct || riskPct > cfg.maxStopPct || netRR < cfg.minNetRR)
    return { ...result, status: "risk", reason: "비용 후 손익비 또는 손절 거리 조건이 부족합니다." };
  if (Math.abs(bars.at(-1).close - entry) > entryBand) return { ...result, status: "late", reason: "현재 마감 가격이 확인 당시 검토 구간을 벗어났습니다." };
  result.plan = { entryLow, entryHigh, entry: conservative, stop, target: p.projection,
    tp1: conservative + sign * risk, tp2: (conservative + sign * risk + p.projection) / 2,
    tp3: p.projection, riskPct, lossWithCostPct: riskPct + cfg.roundTripCostPct,
    netRR, roundTripCostPct: cfg.roundTripCostPct };
  return { ...result, reason: "첫 눌림과 5분봉 전환 확인 · 수급 정보는 별도 관찰 근거입니다." };
}

export function assessTrendRetest(frames, { asOf = Date.now(), config = CONFIG.trendRetest, detect = detectChartPatterns } = {}) {
  const cfg = config;
  const bars = closedSeries(frames["5m"], "5m", asOf), hourly = closedSeries(frames["1h"], "1h", asOf);
  const supply = observeSupply(frames["5m"], asOf);
  const unavailable = reason => ({ status: "unavailable", reason, plan: null, supply });
  if (!bars || !hourly || bars.length < 65 || hourly.length < 200) return unavailable("최신의 연속된 마감 5분봉·1시간봉이 필요합니다. 두 시간봉을 선택해 다시 스캔하세요.");
  const fifteen = closedSeries(frames["15m"], "15m", asOf);
  const context = directionContext(hourly, bars.at(-1).closeTime);
  const four = closedSeries(frames["4h"], "4h", asOf), context4h = four ? directionContext(four, bars.at(-1).closeTime) : null;
  const patternCache = new Map(), candidates = [];
  function patternsAt(tf, prefix) {
    if (prefix.length < 60) return [];
    const key = `${tf}:${prefix.at(-1).closeTime}`;
    if (!patternCache.has(key)) patternCache.set(key, detect(prefix, { pivotDepth: 3 }).filter(p => actionable(p, cfg)));
    return patternCache.get(key);
  }
  for (let i = Math.max(60, bars.length - cfg.lookbackBars); i < bars.length - 1; i++) {
    const prefix = bars.slice(0, i + 1), next = bars[i + 1];
    const h = directionContext(hourly, next.closeTime);
    if (!h?.direction) continue;
    const trend = confirmedFractalTrend(prefix, 3);
    if (trend !== (h.direction === "long" ? "up" : "down")) continue;
    const sources = [["5m", prefix]];
    if (fifteen) sources.push(["15m", fifteen.filter(c => c.closeTime <= prefix.at(-1).closeTime)]);
    const a = atr(prefix, 14).at(-1);
    if (!(a > 0)) continue;
    for (const [timeframe, data] of sources) for (const p of patternsAt(timeframe, data)) {
      const long = h.direction === "long";
      if (p.bias !== (long ? "bullish" : "bearish")) continue;
      if (!(long ? prefix.at(-1).close <= p.trigger && next.close > p.trigger : prefix.at(-1).close >= p.trigger && next.close < p.trigger)) continue;
      const setup = { direction: h.direction, timeframe, pattern: p, breakoutIndex: i + 1,
        breakoutAt: next.closeTime, sourceAt: data.at(-1).closeTime, atr: a, context: h };
      candidates.push(inspectSetup(setup, bars, cfg, asOf));
    }
  }
  const active = candidates.filter(c => ["ready", "retest", "breakout"].includes(c.status));
  const best = (active.length ? active : candidates).sort((a,b) => b.breakoutAt-a.breakoutAt || b.pattern.fitScore-a.pattern.fitScore)[0];
  if (best) {
    if (active.includes(best) && context?.direction !== best.direction)
      return { ...best, status: "invalid", label: RETEST_LABELS.invalid, plan: null, supply, context4h, reason: "현재 1시간 추세 방향이 돌파 당시와 일치하지 않습니다." };
    return { ...best, label: RETEST_LABELS[best.status], supply, context4h };
  }
  const forming = context?.direction ? patternsAt("5m", bars).find(p => p.bias === (context.direction === "long" ? "bullish" : "bearish") && p.status === "forming") : null;
  return { status: "watch", label: RETEST_LABELS.watch, reason: forming ? "같은 방향의 지속형 패턴 · 종가 돌파를 기다립니다." : "1시간 추세·5분 프랙탈·지속형 패턴의 정렬을 기다립니다.",
    direction: context?.direction || null, pattern: forming, context, context4h, plan: null, supply, asOf: bars.at(-1).closeTime };
}

export function currentRetestSignal(signal, now = Date.now()) {
  if (!signal) return null;
  const stale = finite(signal.asOf) && now - signal.asOf > MS["5m"] + 2000;
  if ((signal.expiresAt && now >= signal.expiresAt) || stale) return { ...signal, status: "expired", label: RETEST_LABELS.expired, plan: null, reason: "마감봉 또는 확인 신호가 오래됐습니다. 다시 스캔하세요." };
  return signal;
}
