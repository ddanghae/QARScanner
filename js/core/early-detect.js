// core/early-detect.js — 조기 포착 모드 계산.
// 큰 상승 이전 흔적(변동성 압축 + 거래량 고갈 + OI 이력/비감소)을 4시간봉에서 판정한다.
// OI 증가폭은 단계 공통 게이트와 분리해 근거 품질 점수로 반영한다.
// 모든 함수는 순수 함수이며 마감 캔들만 사용한다(미래 참조 없음).

import { bollinger, atr, ema, last } from "./indicators.js";
import { relativeVolume } from "./volume-analysis.js";
import { gradeFor, topSignals } from "./scoring.js";

// 최근 lookback 봉의 박스(고/저)와 그 안에서의 현재 위치.
export function boxRange(candles, lookback) {
  const n = candles.length;
  if (n < lookback) return null;
  const win = candles.slice(n - lookback);
  let boxHigh = -Infinity, boxLow = Infinity;
  for (const c of win) {
    if (c.high > boxHigh) boxHigh = c.high;
    if (c.low < boxLow) boxLow = c.low;
  }
  const mid = (boxHigh + boxLow) / 2;
  const span = boxHigh - boxLow;
  const price = candles[n - 1].close;
  return {
    boxHigh,
    boxLow,
    boxWidthPct: mid > 0 ? (span / mid) * 100 : 0,
    rangePos: span > 0 ? (price - boxLow) / span : 0,
  };
}

// 볼린저 폭 배열에서 "현재 폭이 최근 lookback 중 몇 %ile 로 좁은가".
// 0 에 가까울수록 압축. 현재보다 작은 값의 개수 비율.
export function squeezePercentile(widths, lookback) {
  if (!Array.isArray(widths) || !Number.isInteger(lookback) || lookback <= 0 || widths.length < lookback) return null;
  const win = widths.slice(widths.length - lookback);
  if (win.some((w) => !Number.isFinite(w))) return null;
  const cur = win[win.length - 1];
  let smaller = 0;
  for (const w of win) if (w < cur) smaller++;
  return (smaller / win.length) * 100;
}

// 최근 recentN 봉 평균 거래량 ÷ 그 이전 priorN 봉 평균 거래량. 낮을수록 고갈.
export function volDryRatio(candles, recentN, priorN) {
  const n = candles.length;
  if (n < recentN + priorN) return null;
  const recent = candles.slice(n - recentN);
  const prior = candles.slice(n - recentN - priorN, n - recentN);
  if (recent.some((c) => !Number.isFinite(c.volume)) || prior.some((c) => !Number.isFinite(c.volume))) return null;
  const avg = (arr) => arr.reduce((s, c) => s + c.volume, 0) / arr.length;
  const prev = avg(prior);
  if (!(prev > 0)) return null;
  return avg(recent) / prev;
}

// OI 시계열에서 timestamp 기준 변화율 3종.
// 목표 시각에 충분히 가까운 표본이 없으면 행 번호로 추정하지 않고 null(fail closed)이다.
const HOUR_MS = 60 * 60 * 1000;
export function analyzeOi(series, toleranceMs = 0) {
  const pct = (from, to) => (from > 0 ? ((to - from) / from) * 100 : null);
  const points = Array.isArray(series)
    ? series
      .map((p) => ({ time: Number(p?.time), oi: Number(p?.oi) }))
      .filter((p) => Number.isFinite(p.time) && Number.isFinite(p.oi) && p.oi > 0)
      .sort((a, b) => a.time - b.time)
    : [];
  if (!points.length) return { change72h: null, change12h: null, prev12h: null };

  const tolerance = Number.isFinite(toleranceMs) && toleranceMs >= 0
    ? toleranceMs
    : 0; // 생산 경로는 CONFIG.earlyDetect.oiTargetToleranceMs를 명시적으로 전달한다.
  const nowPoint = points[points.length - 1];
  const at = (backHours) => {
    const target = nowPoint.time - backHours * HOUR_MS;
    let best = null;
    let bestDistance = Infinity;
    for (const point of points) {
      const distance = Math.abs(point.time - target);
      if (distance < bestDistance) {
        best = point;
        bestDistance = distance;
      }
    }
    return best && bestDistance <= tolerance ? best.oi : null;
  };
  const now = nowPoint.oi;
  const h72 = at(72), h12 = at(12), h24 = at(24);
  return {
    change72h: now != null && h72 != null ? pct(h72, now) : null,
    change12h: now != null && h12 != null ? pct(h12, now) : null,
    prev12h: h12 != null && h24 != null ? pct(h24, h12) : null,
  };
}

// early 핵심 데이터 준비 상태. 누락을 좋은 신호로 간주하지 않는다.
export function earlyDataIssue(m) {
  if (!m || !Number.isFinite(m.boxWidthPct) || !Number.isFinite(m.rangePos) ||
      !Number.isFinite(m.squeezePct) || !Number.isFinite(m.volDry) ||
      !Number.isFinite(m.relVol3) || m.ema200Ready !== true || m.atrReady !== true) {
    return "4시간 지표 자료 부족";
  }
  if (!m.oi || !Number.isFinite(m.oi.change72h) ||
      !Number.isFinite(m.oi.change12h) || !Number.isFinite(m.oi.prev12h)) {
    return "미결제약정 자료 부족";
  }
  return null;
}

// 제외 사유. 없으면 null. 펀딩은 보조 데이터라 null이면 해당 조건만 건너뛴다.
export function earlyExclusion(m, cfg) {
  const e = cfg.earlyDetect;
  const dataIssue = earlyDataIssue(m);
  if (dataIssue) return dataIssue;
  if (m.change24h != null && m.change24h > e.pumpedMaxPct) return "이미 급등";
  if (m.oi.change72h <= e.oiDumpPct) return "미결제약정 급감";
  if (m.funding != null && Math.abs(m.funding) > e.fundingMaxAbs) return "펀딩 과열";
  return null;
}

// 3단계 분류. 위 단계부터 판정하고, 어디에도 안 걸리면 null(결과에서 제외).
export function classifyEarlyStage(m, cfg) {
  const e = cfg.earlyDetect;
  if (earlyDataIssue(m)) return null;

  // 모든 단계는 좁은 박스·후보용 압축/고갈 기준과 OI 비감소를 공통으로 요구한다.
  const candidateReady =
    m.boxWidthPct <= e.boxWidthMaxPct &&
    m.squeezePct <= e.prefilterSqueezePctMax &&
    m.volDry <= e.volDryMax &&
    m.oi.change72h >= e.oiChangeMinPct;
  if (!candidateReady) return null;

  // 3단계 돌파 — 박스 상단을 종가로 뚫고, 거래량 급증 + 변동성 확장. 단 아직 초입일 때만.
  const breakoutImpulse = Boolean(m.breakoutClose) && Number.isFinite(m.relVol3) &&
    m.relVol3 >= e.breakoutRelVol && m.atrRising === true;
  if (breakoutImpulse) {
    return isConfirmedEarlyBreakout(m, cfg)
      ? stage(3, "breakout", "3 돌파", "purple")
      : null; // 이미 많이 감 → 추격 방지
  }

  // 1단계 매집은 돌파 후보용 완화 기준과 달리 실제 압축 상한을 적용한다.
  const trendOk = m.closeAboveEma200 || m.ema200SlopeOk;
  const accumulation =
    m.squeezePct <= e.squeezePctMax &&
    trendOk;
  if (!accumulation) return null;

  // 2단계 임박 — 압축 극단 + 박스 상단 근접 + 거래량 회복 + OI 가속
  const oiAccel = m.oi.change12h != null && m.oi.prev12h != null && m.oi.change12h > m.oi.prev12h;
  if (
    m.squeezePct <= e.squeezePctTight &&
    m.rangePos >= e.rangePosMin &&
    m.relVol3 >= e.relVolMin &&
    oiAccel
  ) {
    return stage(2, "imminent", "2 임박", "yellow");
  }

  return stage(1, "accumulation", "1 매집", "blue");
}

function stage(n, key, label, badge) {
  return { stage: n, key, label, badge };
}

// ---- 채점 ----
// 기존 scoring.js 의 breakdown/penalties 형식을 그대로 따른다(topSignals 재사용 가능).
export function scoreEarly(m, cfg) {
  const w = cfg.earlyScoreWeights;
  const p = cfg.earlyPenalties;
  const clamp01 = (x) => Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0;

  // 압축: 백분위 0 → 만점, 50 이상 → 0점
  const squeezeGot = Number.isFinite(m.squeezePct) ? w.squeeze * (1 - Math.min(Math.max(m.squeezePct, 0), 50) / 50) : 0;
  // OI: oiScoreFullPct 이상이면 만점. 데이터 없으면 0점.
  const configuredOiFull = cfg.earlyDetect.oiScoreFullPct;
  const oiFull = Number.isFinite(configuredOiFull) && configuredOiFull > 0 ? configuredOiFull : null;
  const oiGot = oiFull && Number.isFinite(m.oi?.change72h)
    ? w.oiBuildUp * (Math.min(Math.max(m.oi.change72h, 0), oiFull) / oiFull)
    : 0;
  // 거래량 고갈: 낮을수록 높은 점수
  const volGot = Number.isFinite(m.volDry) ? w.volumeProfile * (1 - Math.min(Math.max(m.volDry, 0), 1)) : 0;
  // 박스 상단 근접
  const rangeGot = w.rangePosition * clamp01(m.rangePos);
  // 장기선 회복
  const trendGot = m.closeAboveEma200 ? w.trendReclaim : m.ema200SlopeOk ? w.trendReclaim * 0.5 : 0;

  const breakdown = [
    mkItem("squeeze", "변동성 압축", w.squeeze, squeezeGot),
    mkItem("oiBuildUp", "미결제약정 증가", w.oiBuildUp, oiGot),
    mkItem("volumeProfile", "거래량 고갈", w.volumeProfile, volGot),
    mkItem("rangePosition", "박스 상단 근접", w.rangePosition, rangeGot),
    mkItem("trendReclaim", "장기선 회복", w.trendReclaim, trendGot),
  ];

  let score = breakdown.reduce((s, b) => s + b.got, 0);

  const penalties = [];
  const pen = (cond, val, key, label) => {
    if (cond) { score += val; penalties.push({ key, label, val }); }
  };
  const e = cfg.earlyDetect;
  pen(m.change24h != null && m.change24h >= 25 && m.change24h <= e.pumpedMaxPct,
    p.alreadyPumped, "alreadyPumped", "이미 상당폭 상승");
  pen(m.oi.change72h != null && m.oi.change72h < 0, p.oiDump, "oiDump", "미결제약정 감소");
  pen(m.funding != null && Math.abs(m.funding) > e.fundingMaxAbs / 2,
    p.fundingOverheated, "fundingOverheated", "펀딩 쏠림");
  pen(m.quoteVolume != null && m.quoteVolume < 10_000_000, p.thinLiquidity, "thinLiquidity", "거래대금 부족");

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, breakdown, penalties };
}

function mkItem(key, label, weight, got) {
  const g = Math.round(got * 100) / 100;
  return { key, label, weight, got: g, hit: g > 0 };
}

export function isConfirmedEarlyBreakout(m, cfg) {
  const e = cfg.earlyDetect;
  return Boolean(m?.breakoutClose) && Number.isFinite(m?.relVol3) &&
    m.relVol3 >= e.breakoutRelVol && m?.atrRising === true &&
    Number.isFinite(m?.runFromBreakoutPct) && m.runFromBreakoutPct <= e.breakoutMaxRunPct;
}

export function earlyGradeFor(score, cfg) {
  return gradeFor(score, { grades: cfg.earlyGrades || cfg.grades });
}

// ---- 진입 계획 ----
// 박스 기반. 기존 plan 필드명을 그대로 채워 UI/상세패널이 수정 없이 동작하게 한다.
// 손절은 반드시 진입 아래로 clamp (risk-reward.js 의 RR 폭발 버그와 동일한 방어).
export function earlyPlan(m, atrVal, price) {
  const entry = price;
  const span = Math.max(m.boxHigh - m.boxLow, 1e-9);
  const buffer = (atrVal || 0) * 0.5;
  const stop = Math.min(m.boxLow, entry) - buffer;
  const tp1 = m.boxHigh + span * 1.0;
  const tp2 = m.boxHigh + span * 1.5;
  const tp3 = m.boxHigh + span * 2.0;
  const risk = Math.max(entry - stop, 1e-9);
  const reward = Math.max(tp2 - entry, 0);
  const rr = reward / risk;
  return {
    entry, stop, tp1, tp2, tp3,
    invalidation: stop,
    riskReward: rr,
    rrText: `1:${rr.toFixed(2)}`,
    valid: rr > 0 && entry > stop,
  };
}

// ---- 지표 조립 ----
// c4: 4시간봉 마감 캔들. oiSeries: [{time,oi}] (없으면 빈 배열). funding: number|null.
// ticker: { change24h, quoteVolume }
export function buildEarlyMetrics(c4, oiSeries, funding, ticker, cfg) {
  const e = cfg.earlyDetect;
  const box = boxRange(c4, e.boxLookback);
  if (!box) return null;

  const closes = c4.map((c) => c.close);
  const widths = bollinger(closes, cfg.indicators.bb.period, cfg.indicators.bb.mult).width;
  const squeezePct = squeezePercentile(widths, e.squeezeLookback);
  const volDry = volDryRatio(c4, e.volRecentN, e.volPriorN);
  const oi = analyzeOi(oiSeries || [], e.oiTargetToleranceMs);

  const relVolArr = relativeVolume(c4, 20);
  const recentRel = relVolArr.slice(-3).filter((x) => Number.isFinite(x));
  const relVol3 = recentRel.length === 3 ? recentRel.reduce((a, b) => a + b, 0) / 3 : null;

  const ema200 = ema(closes, 200);
  const price = closes[closes.length - 1];
  const ema200Now = last(ema200);
  const ema200Idx = ema200.length - 1;
  const ema200Prev = ema200Idx - 20 >= 0 ? ema200[ema200Idx - 20] : null;
  const closeAboveEma200 = ema200Now != null && price > ema200Now;
  const ema200SlopeOk = ema200Now != null && ema200Prev != null && ema200Now >= ema200Prev;
  const ema200Ready = Number.isFinite(ema200Now) && Number.isFinite(ema200Prev);

  // 돌파 판정: 직전 봉까지의 박스 상단을 현재 종가가 넘었는가
  const prevBox = boxRange(c4.slice(0, -1), e.boxLookback);
  const breakoutLevel = prevBox ? prevBox.boxHigh : box.boxHigh;
  const breakoutClose = price > breakoutLevel;
  const runFromBreakoutPct = breakoutLevel > 0 ? ((price - breakoutLevel) / breakoutLevel) * 100 : 0;

  const atrArr = atr(c4, cfg.indicators.atrPeriod);
  const atrNow = last(atrArr);
  const atrIdx = atrArr.length - 1;
  const atrPrev = atrIdx - 5 >= 0 ? atrArr[atrIdx - 5] : null;
  const atrRising = atrNow != null && atrPrev != null && atrNow > atrPrev;
  const atrReady = Number.isFinite(atrNow) && Number.isFinite(atrPrev);

  return {
    boxHigh: box.boxHigh, boxLow: box.boxLow,
    boxWidthPct: box.boxWidthPct, rangePos: box.rangePos,
    squeezePct, volDry, relVol3, oi,
    funding: funding == null ? null : funding,
    change24h: ticker?.change24h ?? null,
    quoteVolume: ticker?.quoteVolume ?? null,
    closeAboveEma200, ema200SlopeOk, ema200Ready,
    breakoutClose, atrRising, atrReady, runFromBreakoutPct,
    price, atrVal: atrNow,
  };
}

// ---- 결과 조립 ----
// 기존 deepAnalyze 와 동일한 shape 을 반환한다(스펙 "결과 객체 호환").
// 단계에 안 걸리거나 제외 사유가 있으면 null.
export function buildEarlyResult(item, c4, oiSeries, funding, cfg) {
  const m = buildEarlyMetrics(c4, oiSeries, funding, item, cfg);
  if (!m) return null;
  if (earlyExclusion(m, cfg)) return null;
  const stageInfo = classifyEarlyStage(m, cfg);
  if (!stageInfo) return null;

  const scored = scoreEarly(m, cfg);
  const plan = earlyPlan(m, m.atrVal, m.price);

  return {
    scanMode: "early",
    symbol: item.symbol,
    baseAsset: item.baseAsset,
    price: m.price,
    change6h: 0,
    change24h: m.change24h ?? 0,
    quoteVolume: item.quoteVolume,
    newListing: item.newListing,
    direction: "long",
    score: scored.score,
    grade: earlyGradeFor(scored.score, cfg),
    stage: stageInfo,
    absorption: { level: "insufficient", label: "조기 포착 모드 — 미적용", score: 0 },
    breakdown: scored.breakdown,
    penalties: scored.penalties,
    topSignals: topSignals(scored.breakdown, 3),
    goldenCrossRetest: { detected: false, reason: "조기 포착 모드" },
    near1hEma200: false,
    noise: { noisy: false, ci: null, relVol: m.relVol3, reasons: [] },
    early: { squeezePct: m.squeezePct, volDry: m.volDry, oi: m.oi, funding: m.funding, boxHigh: m.boxHigh, boxLow: m.boxLow },
    plan,
    rsi1h: null,
    timeframes: {},
  };
}

export default {
  boxRange, squeezePercentile, volDryRatio, analyzeOi,
  classifyEarlyStage, isConfirmedEarlyBreakout, earlyDataIssue, earlyExclusion, scoreEarly, earlyGradeFor, earlyPlan,
  buildEarlyMetrics, buildEarlyResult,
};
