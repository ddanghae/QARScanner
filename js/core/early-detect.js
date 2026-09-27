// core/early-detect.js — 조기 포착 모드 계산.
// 큰 상승 이전 흔적(변동성 압축 + 거래량 고갈 + 미결제약정 증가)을 4시간봉에서 판정한다.
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
  const valid = widths.filter((w) => w != null);
  if (valid.length < lookback) return null;
  const win = valid.slice(valid.length - lookback);
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
  const avg = (arr) => arr.reduce((s, c) => s + c.volume, 0) / arr.length;
  const prev = avg(prior);
  if (!(prev > 0)) return null;
  return avg(recent) / prev;
}

// OI 시계열(1시간 간격, 과거→현재)에서 변화율 3종.
// change72h: 72시간 변화, change12h: 최근 12시간, prev12h: 그 이전 12시간(가속 비교용).
export function analyzeOi(series) {
  const pct = (from, to) => (from > 0 ? ((to - from) / from) * 100 : null);
  const n = Array.isArray(series) ? series.length : 0;
  const at = (backHours) => (n > backHours ? series[n - 1 - backHours].oi : null);
  const now = n > 0 ? series[n - 1].oi : null;
  const h72 = at(72), h12 = at(12), h24 = at(24);
  return {
    change72h: now != null && h72 != null ? pct(h72, now) : null,
    change12h: now != null && h12 != null ? pct(h12, now) : null,
    prev12h: h12 != null && h24 != null ? pct(h24, h12) : null,
  };
}

// 제외 사유. 없으면 null.
// 펀딩 쏠림은 더 이상 제외 사유가 아니다 — 2026-07-26 실측에서 |펀딩| 이 가장 안정적인
// 선행 신호로 나왔다(3개 구간 전부 리프트 2.1~3.2x, 반대로 펀딩 중립은 0.67~0.77x).
// 과열로 걸러내던 조건이 사실은 1순위 신호였다. 이제 crowding 점수로 반영한다.
// OI 급감 제외도 뺐다 — 표본 n=5~6 으로 방향조차 확인되지 않는다(근거 없는 게이트).
export function earlyExclusion(m, cfg) {
  const e = cfg.earlyDetect;
  if (m.change24h != null && m.change24h > e.pumpedMaxPct) return "이미 급등";
  return null;
}

// 3단계 분류. 위 단계부터 판정하고, 어디에도 안 걸리면 null(결과에서 제외).
// 매집(압축+거래량 고갈) 게이트는 제거했다. 표본 외 검증에서 리프트가 0.64~1.72x 로
// 흩어졌다(기준선 미만인 구간 존재) — 신호로 볼 근거가 없는데 하드 게이트로 쓰고 있었다.
// 대신 채점의 움직임 요인 2개(14일 추세·24시간 변동)의 히트 수로 단계를 나눈다.
export function classifyEarlyStage(m, cfg) {
  const e = cfg.earlyDetect;

  // 3단계 돌파 — 박스 상단을 종가로 뚫고, 거래량 급증 + 변동성 확장. 단 아직 초입일 때만.
  if (m.breakoutClose && m.relVol3 >= e.breakoutRelVol && m.atrRising) {
    return m.runFromBreakoutPct <= e.breakoutMaxRunPct
      ? stage(3, "breakout", "3 돌파", "purple")
      : null; // 이미 많이 감 → 추격 방지
  }

  const hits = coreHits(m, e);
  if (hits === 0) return null;
  // 2단계 임박 — 둘 다 성립. 14일 추세와 24시간 변동이 동시에 크면 재적합 점수도 최상위권.
  if (hits >= 2) return stage(2, "imminent", "2 임박", "yellow");
  return stage(1, "accumulation", "1 관찰", "blue");
}

// 움직임 요인 2개 중 몇 개가 램프 하단을 넘었나(= 채점에서 0점이 아닌 항목 수).
function coreHits(m, e) {
  let n = 0;
  if (m.mom14Abs != null && m.mom14Abs >= e.deadZonePct) n++;
  if (m.change24h != null && Math.abs(m.change24h) >= e.chg24MinPct) n++;
  return n;
}

function stage(n, key, label, badge) {
  return { stage: n, key, label, badge };
}

// ---- 채점 ----
// 기존 scoring.js 의 breakdown/penalties 형식을 그대로 따른다(topSignals 재사용 가능).
// 2026-07-26 재적합(변형 D). 57,720행 시간순 70/30 분할, 학습셋에서만 변형 선택.
//   momentum   |14일 수익률|  45점  ramp(15% → 60%)
//   change24h  |24시간 변동|  32점  ramp(5% → 20%)
//   freshness  상장 경과일    23점  200일 이하 만점 → 800일 0점
//   thinLiquidity            -10점  24시간 거래대금 minQuoteVolume 미만
// 뺀 것: crowding(|펀딩|)·volExpansion·oiBuildUp. 단변량 리프트는 있었지만 다변량에서
// 계수가 각각 -0.135 / +0.030 으로 죽었다 = 모멘텀 대리변수. 검증셋 상위3 리프트
// 6.04x → 10.71x. 되살릴 근거가 생기면 research/variants.mjs 에 변형을 추가해 재확인할 것.
export function scoreEarly(m, cfg) {
  const w = cfg.earlyScoreWeights;
  const p = cfg.earlyPenalties;
  const e = cfg.earlyDetect;
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  // lo 이하 0점, hi 이상 만점인 선형 램프.
  const ramp = (v, lo, hi) => (v == null ? 0 : clamp01((v - lo) / (hi - lo)));

  const momGot = w.momentum * ramp(m.mom14Abs, e.deadZonePct, e.momentumFullPct);
  const chgGot = w.change24h * ramp(
    m.change24h == null ? null : Math.abs(m.change24h), e.chg24MinPct, e.chg24FullPct);
  // 오래된 종목일수록 0 으로. freshFullDays 이하 만점, freshZeroDays 이상 0점.
  // 상장일 미상은 400일로 본다(재적합에서 쓴 결측 대체값 — 중립보다 약간 위).
  const freshGot = w.freshness *
    (1 - clamp01(((m.ageDays ?? 400) - e.freshFullDays) / (e.freshZeroDays - e.freshFullDays)));

  const breakdown = [
    mkItem("momentum", "14일 추세 강도", w.momentum, momGot),
    mkItem("change24h", "24시간 변동", w.change24h, chgGot),
    mkItem("freshness", "신규 상장", w.freshness, freshGot),
  ];

  let score = breakdown.reduce((s, b) => s + b.got, 0);

  const penalties = [];
  const pen = (cond, val, key, label) => {
    if (cond) { score += val; penalties.push({ key, label, val }); }
  };
  pen((m.quoteVolume ?? 0) < e.minQuoteVolume, p.thinLiquidity, "thinLiquidity", "거래대금 부족");

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, breakdown, penalties };
}

function mkItem(key, label, weight, got) {
  const g = Math.round(got * 100) / 100;
  return { key, label, weight, got: g, hit: g > 0 };
}

// ---- 진입 계획 ----
// R 배수 기반. 기존 plan 필드명을 그대로 채워 UI/상세패널이 수정 없이 동작하게 한다.
// 손절은 반드시 진입 아래로 clamp (risk-reward.js 의 RR 폭발 버그와 동일한 방어).
//
// 예전에는 박스 하단 = 손절, 박스 상단 + 박스폭 배수 = 목표였다. 후보군이 "좁은 횡보"
// 뿐일 때는 성립했지만, 지금은 폭락 후 반등(예: 14일 -88%)이 정식 후보라 박스 폭이
// 수백 % 가 된다. 실측에서 그대로 손익비 1:24 가 찍혔다 — 도달 불가능한 목표를 기준으로
// 계산한 숫자라 필터로도 표시로도 쓸 수 없다.
// 손절은 ATR 배수로 상한을 걸고, 목표는 그 리스크의 배수로 잡는다.
// ponytail: 목표가 R 배수 고정이라 riskReward 는 항상 tp2 기준 1:2 다. 종목별 저항선을
// 반영하려면 여기서 박스 상단·직전 스윙고점을 tp 후보로 섞어야 한다.
export function earlyPlan(m, atrVal, price, cfg) {
  const entry = price;
  const atr = atrVal > 0 ? atrVal : 0;
  const stopAtr = cfg?.earlyDetect?.stopAtr ?? 4;
  const targetR = cfg?.earlyDetect?.targetR ?? 4;

  // 순수 ATR 배수. 예전에는 박스 하단(-0.5 ATR)과 ATR 배수 중 좁은 쪽이 채택됐는데,
  // 격자 탐색에서 그게 손해였다(위 config 주석). ATR 이 없을 때만 박스로 되돌아간다.
  let stop = atr > 0 ? entry - atr * stopAtr : Math.min(m.boxLow, entry) - entry * 1e-3;
  // 그래도 진입 위/같음이면(비정상 입력) 최소 리스크를 준다.
  if (!(stop < entry)) stop = entry * (1 - 1e-3);

  const risk = entry - stop;
  const partialAtR = cfg?.earlyDetect?.partialAtR ?? 1;
  const partialFrac = cfg?.earlyDetect?.partialFrac ?? 0.5;
  // tp1 은 "여기서 일부 빼고 손절을 본전으로 올리는 지점" 이다 — 측정으로 정한 값(config 주석).
  // tp2 는 나머지의 목표. tp3 은 그 위 참고선(측정 안 됨).
  const tp1 = entry + risk * partialAtR;
  const tp2 = entry + risk * targetR;
  const tp3 = entry + risk * targetR * 1.5;
  const rr = (tp2 - entry) / risk;
  return {
    entry, stop, tp1, tp2, tp3,
    invalidation: stop,
    partialAtR, partialFrac,
    riskReward: rr,
    rrText: `1:${rr.toFixed(2)}`,
    valid: rr > 0 && entry > stop,
    // 되돌림 실측은 채점 모델과 무관해 병렬 갈래(origin/main)의 결과를 그대로 가져왔다.
    // 파는 방식(부분 익절 여부)은 사용자가 고르므로 여기서 단정하지 않는다 — 상세 패널이 설명한다.
    note: "급등 141건 추적 결과 고점 이후 중앙 82% 를 반납했고(31%는 전량 반납) " +
          "상승폭의 절반 미만만 반납한 경우는 10.6% 였습니다.",
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
  // 같은 비율을 "고갈" 이 아니라 "확장" 으로 읽는다. 1 초과 = 최근 거래량이 늘고 있음.
  const volExpand = volDryRatio(c4, e.volRecentN, e.volPriorN);
  const oi = analyzeOi(oiSeries || []);

  // 14일 추세 강도. 부호가 아니라 크기가 신호라 절대값을 쓴다(상승·하락 양쪽 다 선행).
  const momIdx = closes.length - 1 - e.momentumBars;
  const mom14 = momIdx >= 0 && closes[momIdx] > 0
    ? ((closes[closes.length - 1] - closes[momIdx]) / closes[momIdx]) * 100 : null;
  // 펀딩도 방향 무관 — 롱 쏠림이든 숏 쏠림이든 둘 다 급등에 선행했다.
  const crowdAbs = funding == null ? null : Math.abs(funding);
  const ageDays = ticker?.onboardDate
    ? (Date.now() - ticker.onboardDate) / 86_400_000 : null;

  const relVolArr = relativeVolume(c4, 20);
  const recentRel = relVolArr.slice(-3).filter((x) => x != null);
  const relVol3 = recentRel.length ? recentRel.reduce((a, b) => a + b, 0) / recentRel.length : 0;

  const ema200 = ema(closes, 200);
  const price = closes[closes.length - 1];
  const ema200Now = last(ema200);
  const ema200Idx = ema200.length - 1;
  const ema200Prev = ema200Idx - 20 >= 0 ? ema200[ema200Idx - 20] : null;
  const closeAboveEma200 = ema200Now != null && price > ema200Now;
  const ema200SlopeOk = ema200Now != null && ema200Prev != null && ema200Now >= ema200Prev;

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

  return {
    boxHigh: box.boxHigh, boxLow: box.boxLow,
    boxWidthPct: box.boxWidthPct, rangePos: box.rangePos,
    squeezePct, volExpand, relVol3, oi,
    mom14, mom14Abs: mom14 == null ? null : Math.abs(mom14), crowdAbs, ageDays,
    funding: funding == null ? null : funding,
    change24h: ticker?.change24h ?? null,
    quoteVolume: ticker?.quoteVolume ?? null,
    closeAboveEma200, ema200SlopeOk,
    breakoutClose, atrRising, runFromBreakoutPct,
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
  const plan = earlyPlan(m, m.atrVal, m.price, cfg);

  return {
    symbol: item.symbol,
    baseAsset: item.baseAsset,
    price: m.price,
    change6h: 0,
    change24h: m.change24h ?? 0,
    quoteVolume: item.quoteVolume,
    newListing: item.newListing,
    direction: "long",
    score: scored.score,
    // 등급만 early 전용 밴드로 (gradeFor 는 cfg.grades 만 읽는다).
    grade: gradeFor(scored.score, { grades: cfg.earlyGrades }),
    stage: stageInfo,
    absorption: { level: "insufficient", label: "조기 포착 모드 — 미적용", score: 0 },
    breakdown: scored.breakdown,
    penalties: scored.penalties,
    topSignals: topSignals(scored.breakdown, 3),
    goldenCrossRetest: { detected: false, reason: "조기 포착 모드" },
    near1hEma200: false,
    noise: { noisy: false, ci: null, relVol: m.relVol3, reasons: [] },
    early: { squeezePct: m.squeezePct, volExpand: m.volExpand, mom14: m.mom14, ageDays: m.ageDays,
      oi: m.oi, funding: m.funding, boxHigh: m.boxHigh, boxLow: m.boxLow },
    plan,
    rsi1h: null,
    timeframes: {},
  };
}

export default {
  boxRange, squeezePercentile, volDryRatio, analyzeOi,
  classifyEarlyStage, earlyExclusion, scoreEarly, earlyPlan,
  buildEarlyMetrics, buildEarlyResult,
};
