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

// 5단계 분류. 잠재력 점수와 별도로 "지금 움직일 준비가 됐는가"만 판단한다.
// 매집(압축+거래량 고갈) 게이트는 제거했다. 표본 외 검증에서 리프트가 0.64~1.72x 로
// 흩어졌다(기준선 미만인 구간 존재) — 신호로 볼 근거가 없는데 하드 게이트로 쓰고 있었다.
// 대신 채점의 움직임 요인 2개(14일 추세·24시간 변동)의 히트 수로 단계를 나눈다.
export function classifyEarlyStage(m, cfg) {
  const e = cfg.earlyDetect;

  // 이미 크게 달렸다면 좋은 잠재력 후보라도 숨기지 않고 추격 금지로 보여준다.
  if ((m.change24h ?? 0) > e.pumpedMaxPct
    || (m.breakoutClose && m.runFromBreakoutPct > e.breakoutMaxRunPct)) {
    return stage(5, "chase", "5 추격 금지", "red");
  }

  // 4단계 확인 — 박스 상단 종가 돌파에 거래량과 변동성 확장이 함께 있어야 한다.
  if (m.breakoutClose && m.relVol3 >= e.breakoutRelVol && m.atrRising) {
    return stage(4, "confirmed", "4 확인 후보", "green");
  }

  const hits = coreHits(m, e);
  if (hits === 0) return null;
  const readiness = assessEarlyAxes(m, 0, cfg).readiness.score;
  // 점수는 상승·하락 양쪽의 "큰 움직임"을 잡는다. 그러나 3단계는 지금 상승 쪽으로
  // 되돌아온 후보만 뜻한다. 장기 추세/거래량이 좋아도 24시간 하락 중이면 임박으로
  // 승격하지 않는다. 다만 14일 추세는 아직 음수여도, 현재 24시간 반등 + EMA200 위면
  // 회복 초입일 수 있으므로 허용한다.
  const positiveRecovery = (m.change24h ?? 0) > 0
    && ((m.mom14 ?? 0) > 0 || Boolean(m.closeAboveEma200));
  if (hits >= 2 && positiveRecovery && readiness >= 55) {
    return stage(3, "imminent", "3 임박", "purple");
  }
  if (hits >= 2) return stage(2, "preparing", "2 준비", "yellow");
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

// 잠재력(검증 점수), 준비도(현재 방향/확장), 위험도(추격·하락 위험)를 분리한다.
// 준비도와 위험도는 아직 확률이 아닌 설명용 체크리스트 점수다. 후보 순위는 검증된
// scoreEarly만 사용해 새 휴리스틱이 몰래 성과 숫자로 보이지 않게 한다.
export function assessEarlyAxes(m, potentialScore, cfg) {
  const reasons = { readiness: [], risk: [] };
  let readiness = 0;
  const addReady = (cond, points, label) => {
    if (cond) { readiness += points; reasons.readiness.push(label); }
  };
  addReady((m.mom14 ?? 0) > 0, 20, "14일 방향 상승");
  addReady((m.change24h ?? 0) > 0, 15, "24시간 상승");
  addReady(Boolean(m.closeAboveEma200), 15, "4시간 EMA200 위");
  addReady(Boolean(m.ema200SlopeOk), 10, "EMA200 기울기 방어");
  addReady((m.rangePos ?? 0) >= 0.65, 15, "박스 상단 접근");
  addReady((m.relVol3 ?? 0) >= 1.2, 10, "거래량 확인");
  addReady(Boolean(m.atrRising), 5, "변동성 확장");
  addReady(Boolean(m.breakoutClose), 10, "종가 돌파");

  let risk = 100;
  const subtractRisk = (cond, points, label) => {
    if (cond) { risk -= points; reasons.risk.push(label); }
  };
  subtractRisk((m.mom14 ?? 0) <= -30, 25, "14일 하락이 큼");
  subtractRisk((m.change24h ?? 0) <= -10, 20, "24시간 하락 중");
  subtractRisk(!m.closeAboveEma200, 15, "4시간 EMA200 아래");
  subtractRisk(!m.ema200SlopeOk, 10, "EMA200 하락 기울기");
  subtractRisk((m.rangePos ?? 0.5) < 0.25, 15, "박스 하단 근처");
  subtractRisk((m.change24h ?? 0) > cfg.earlyDetect.pumpedMaxPct, 40, "이미 크게 상승");
  subtractRisk(Boolean(m.breakoutClose) && (m.runFromBreakoutPct ?? 0) > cfg.earlyDetect.breakoutMaxRunPct,
    30, "돌파 뒤 추격 구간");
  subtractRisk((m.quoteVolume ?? 0) < cfg.earlyDetect.minQuoteVolume, 15, "거래대금 부족");

  readiness = Math.max(0, Math.min(100, readiness));
  risk = Math.max(0, Math.min(100, risk));
  return {
    potential: { score: potentialScore, label: potentialScore >= 70 ? "강함" : potentialScore >= 55 ? "관심" : "관찰" },
    readiness: { score: readiness, label: readiness >= 70 ? "확인" : readiness >= 45 ? "준비" : "대기", reasons: reasons.readiness },
    risk: { score: risk, label: risk >= 75 ? "낮음" : risk >= 50 ? "주의" : "높음", reasons: reasons.risk },
  };
}

// ---- 진입 계획 ----
// R 배수 기반. 기존 plan 필드명을 그대로 채워 UI/상세패널이 수정 없이 동작하게 한다.
// 손절은 반드시 진입 아래의 양수 가격이어야 한다. 그 범위를 벗어나거나 지나치게
// 멀면 계획을 만들지 않는다. 임의로 그럴듯한 손절가를 만들어 내는 것보다 안전하다.
//
// 예전에는 박스 하단 = 손절, 박스 상단 + 박스폭 배수 = 목표였다. 후보군이 "좁은 횡보"
// 뿐일 때는 성립했지만, 지금은 폭락 후 반등(예: 14일 -88%)이 정식 후보라 박스 폭이
// 수백 % 가 된다. 실측에서 그대로 손익비 1:24 가 찍혔다 — 도달 불가능한 목표를 기준으로
// 계산한 숫자라 필터로도 표시로도 쓸 수 없다.
// 손절은 ATR 배수로 상한을 걸고, 목표는 그 리스크의 배수로 잡는다.
// 목표가 R 배수 고정이라 riskReward 는 tp2 기준 targetR로 고정된다. 종목별 저항선을
// 반영하려면 여기서 박스 상단·직전 스윙고점을 tp 후보로 섞어야 한다.
export function earlyPlan(m, atrVal, price, cfg) {
  const entry = Number.isFinite(Number(price)) ? Number(price) : null;
  const atr = Number.isFinite(Number(atrVal)) && Number(atrVal) > 0 ? Number(atrVal) : 0;
  const stopAtr = cfg?.earlyDetect?.stopAtr ?? 4;
  const targetR = cfg?.earlyDetect?.targetR ?? 4;
  // 설정을 아직 가진 배포본도 안전하게 동작하도록 기본 상한을 둔다. config 에 값을
  // 추가하면 그 값으로 조정할 수 있다.
  const configuredMaxRiskPct = Number(cfg?.earlyDetect?.maxPlanRiskPct);
  const maxRiskPct = Number.isFinite(configuredMaxRiskPct) && configuredMaxRiskPct > 0
    ? configuredMaxRiskPct : 25;
  const configuredMaxDriftPct = Number(cfg?.earlyDetect?.maxSignalPriceDriftPct);
  const maxDriftPct = Number.isFinite(configuredMaxDriftPct) && configuredMaxDriftPct > 0
    ? configuredMaxDriftPct : 8;
  const partialAtR = cfg?.earlyDetect?.partialAtR ?? 1;
  const partialFrac = cfg?.earlyDetect?.partialFrac ?? 0.5;

  const invalidPlan = (warning, riskPct = null) => ({
    entry,
    stop: null,
    tp1: null,
    tp2: null,
    tp3: null,
    invalidation: null,
    partialAtR,
    partialFrac,
    riskPct,
    riskReward: 0,
    rrText: "계획 보류",
    valid: false,
    warning,
    // 되돌림 실측은 채점 모델과 무관해 병렬 갈래(origin/main)의 결과를 그대로 가져왔다.
    // 파는 방식(부분 익절 여부)은 사용자가 고르므로 여기서 단정하지 않는다 — 상세 패널이 설명한다.
    note: "급등 141건 추적 결과 고점 이후 중앙 82% 를 반납했고(31%는 전량 반납) " +
          "상승폭의 절반 미만만 반납한 경우는 10.6% 였습니다.",
  });

  if (!(entry > 0)) return invalidPlan("현재 시세가 올바르지 않아 진입 계획을 보류합니다.");
  // 지표는 마지막 4시간 마감봉에서 계산한다. 현재 시세가 그 마감가와 너무 멀면
  // 진행 중 봉의 정보가 빠진 계획이 되므로, 새 마감봉이 나오기 전까지 가격 계획을 내지 않는다.
  const marketDriftPct = Number(m?.marketDriftPct);
  if (Number.isFinite(marketDriftPct) && Math.abs(marketDriftPct) > maxDriftPct) {
    return invalidPlan(`현재 시세가 4시간 신호 기준가에서 ${marketDriftPct.toFixed(1)}% 벗어나 계획을 보류합니다. 새 마감봉 뒤 재스캔해 주세요.`);
  }

  // 순수 ATR 배수. 예전에는 박스 하단(-0.5 ATR)과 ATR 배수 중 좁은 쪽이 채택됐는데,
  // 격자 탐색에서 그게 손해였다(위 config 주석). ATR 이 없을 때만 박스로 되돌아간다.
  let stop = atr > 0 ? entry - atr * stopAtr : Math.min(m.boxLow, entry) - entry * 1e-3;
  // 진입 위/같음이면(비정상 입력) 최소 리스크만 준다. 음수/0 손절은 절대 보정해
  // 실행 가능한 것처럼 보이게 하지 않고 아래에서 계획 자체를 보류한다.
  if (!(stop < entry)) stop = entry * (1 - 1e-3);

  if (!Number.isFinite(stop) || !(stop > 0)) {
    return invalidPlan("손절가가 0 이하라 계획을 보류합니다.");
  }

  const risk = entry - stop;
  const riskPct = (risk / entry) * 100;
  if (!(risk > 0) || !Number.isFinite(riskPct)) {
    return invalidPlan("손절 폭을 계산할 수 없어 계획을 보류합니다.");
  }
  // 부동소수점 오차로 정확히 25%인 계획이 "25.0% > 25%"로 보류되지 않게 한다.
  if (riskPct > maxRiskPct + 1e-9) {
    return invalidPlan(`손절 거리 ${riskPct.toFixed(2)}%가 최대 ${maxRiskPct.toFixed(2)}%를 넘습니다. 후보 관찰만 하고 계획은 보류합니다.`, riskPct);
  }

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
    riskPct,
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
export function buildEarlyMetrics(c4, oiSeries, funding, ticker, cfg, now = Date.now()) {
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
    ? (now - ticker.onboardDate) / 86_400_000 : null;

  const relVolArr = relativeVolume(c4, 20);
  const recentRel = relVolArr.slice(-3).filter((x) => x != null);
  const relVol3 = recentRel.length ? recentRel.reduce((a, b) => a + b, 0) / recentRel.length : 0;

  const ema200 = ema(closes, 200);
  const price = closes[closes.length - 1];
  const signalTime = Number(c4.at(-1)?.closeTime);
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
    price, signalTime: Number.isFinite(signalTime) ? signalTime : null, atrVal: atrNow,
  };
}

// ---- 결과 조립 ----
// 기존 deepAnalyze 와 동일한 shape 을 반환한다(스펙 "결과 객체 호환").
// 단계에 안 걸리거나 제외 사유가 있으면 null.
export function buildEarlyResult(item, c4, oiSeries, funding, cfg, now = Date.now()) {
  const m = buildEarlyMetrics(c4, oiSeries, funding, item, cfg, now);
  if (!m) return null;
  const stageInfo = classifyEarlyStage(m, cfg);
  if (!stageInfo) return null;

  const scored = scoreEarly(m, cfg);
  const earlyAxes = assessEarlyAxes(m, scored.score, cfg);
  const tickerPrice = Number(item?.lastPrice);
  // 화면의 현재가는 24시간 티커가 수집된 순간의 시장가다. 마지막 4시간 마감가는
  // 지표/신호 기준가로 따로 보존해, 둘을 같은 값처럼 보여 주지 않는다.
  const marketPrice = Number.isFinite(tickerPrice) && tickerPrice > 0 ? tickerPrice : m.price;
  const marketDriftPct = m.price > 0 ? ((marketPrice - m.price) / m.price) * 100 : null;
  const signalExpiresAt = Number.isFinite(m.signalTime) ? m.signalTime + 4 * 60 * 60 * 1000 + 1 : null;
  const plan = earlyPlan({ ...m, signalPrice: m.price, marketPrice, marketDriftPct }, m.atrVal, marketPrice, cfg);

  return {
    scanMode: "early",
    symbol: item.symbol,
    baseAsset: item.baseAsset,
    price: marketPrice,
    signalPrice: m.price,
    signalTime: m.signalTime,
    signalExpiresAt,
    signalInterval: "4h",
    marketPriceAt: now,
    marketDriftPct,
    change6h: null,
    change24h: m.change24h ?? 0,
    quoteVolume: item.quoteVolume,
    newListing: item.newListing,
    direction: "long",
    score: scored.score,
    earlyAxes,
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
    early: { squeezePct: m.squeezePct, volExpand: m.volExpand, relVol3: m.relVol3,
      mom14: m.mom14, ageDays: m.ageDays, rangePos: m.rangePos,
      closeAboveEma200: m.closeAboveEma200, ema200SlopeOk: m.ema200SlopeOk,
      breakoutClose: m.breakoutClose, runFromBreakoutPct: m.runFromBreakoutPct,
      oi: m.oi, funding: m.funding, boxHigh: m.boxHigh, boxLow: m.boxLow },
    plan,
    rsi1h: null,
    timeframes: {},
  };
}

export default {
  boxRange, squeezePercentile, volDryRatio, analyzeOi,
  classifyEarlyStage, earlyExclusion, scoreEarly, earlyPlan,
  assessEarlyAxes, buildEarlyMetrics, buildEarlyResult,
};
