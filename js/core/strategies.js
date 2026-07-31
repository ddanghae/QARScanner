// core/strategies.js — 기존 두 모드(급락 반등 · 조기 포착) 밖의 매매 방식 4종.
//
// **전부 미측정이다.** 이 파일의 임계값 중 research 로 검증된 것은 하나도 없다.
// config.js 에 안 넣은 이유가 그것이다 — 그쪽 항목들은 측정 출처를 달고 있는데
// 근거 없는 값이 섞이면 그 규약이 무의미해진다. variants.mjs 에서 리프트가 나오면
// 그때 출처와 함께 config.js 로 옮길 것.
//
// 기존 두 모드와 다른 점: 조기 포착은 mom14/chg24 의 **절대값**을 쓴다(많이 움직이는 것을
// 고른다 — 방향 무관, refit 에서 그게 이겼다). 여기 추세 추종은 정반대로 부호를 본다.

import { returnsFrom, pearson } from "./correlation.js";

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const ramp = (v, lo, hi) => (v == null ? 0 : clamp01((v - lo) / (hi - lo)));

// ─────────────────────────────────────────────────────────────
// 4. 추세 추종 — 이미 오른 것을 더 산다
// ─────────────────────────────────────────────────────────────
// 조기 포착은 earlyExclusion 으로 "이미 급등" 을 버린다. 이건 그 조건을 뒤집는다.
// 절대값이 아니라 **부호 있는** 값을 쓴다 — 내려가는 것에 점수를 주면 추세 추종이 아니다.
//
// 상단도 자른다: 이미 200% 오른 것을 따라 사는 건 추세 추종이 아니라 꼭지 잡기다.
// runawayPct 위로는 감점한다.
export function scoreTrendFollow(m, {
  momMinPct = 10, momFullPct = 60,      // 14일 추세: 이 구간에서 선형 가점
  chgMinPct = 3, chgFullPct = 25,       // 24시간 변동
  runawayPct = 120,                     // 이 이상 오른 건 과열
  runawayPenalty = -20,
  minQuoteVolume = 5e6, thinPenalty = -10,
  weights = { mom: 45, chg: 35, vol: 20 },
} = {}) {
  const w = weights;
  // 부호 있는 값만 받는다. 하락 중이면 0 점 — abs 를 쓰면 조기 포착과 같아진다.
  const mom = m.mom14 == null || m.mom14 <= 0 ? 0 : ramp(m.mom14, momMinPct, momFullPct);
  const chg = m.change24h == null || m.change24h <= 0 ? 0 : ramp(m.change24h, chgMinPct, chgFullPct);
  // 거래량 확장은 추세에 물량이 실렸는지 — 조용히 오른 건 못 믿는다.
  const vol = ramp(m.volExpand ?? 1, 1.2, 4);

  // scoring.js 의 topSignals 가 { weight, got, hit } 를 읽는다 — 모양을 맞춘다.
  const item = (key, label, weight, got) => {
    const g = Math.round(got * 100) / 100;
    return { key, label, weight, max: weight, got: g, hit: g > 0 };
  };
  const breakdown = [
    item("mom14", "14일 상승 추세", w.mom, w.mom * mom),
    item("chg24", "24시간 상승", w.chg, w.chg * chg),
    item("volExpand", "거래량 확장", w.vol, w.vol * vol),
  ];
  let score = breakdown.reduce((s, b) => s + b.got, 0);

  const penalties = [];
  if (m.change24h != null && m.change24h >= runawayPct) {
    score += runawayPenalty;
    penalties.push({ key: "runaway", label: "과열(꼭지 위험)", val: runawayPenalty });
  }
  if ((m.quoteVolume ?? 0) < minQuoteVolume) {
    score += thinPenalty;
    penalties.push({ key: "thinLiquidity", label: "거래대금 부족", val: thinPenalty });
  }
  return { score: Math.max(0, Math.min(100, Math.round(score))), breakdown, penalties };
}

// 추세 단계. early 의 3단계(매집→임박→돌파)와 달리 여기는 "얼마나 갔나" 한 축이다.
// 추세 추종은 어디서 들어가도 되는 대신 늦게 들어갈수록 손절폭이 커진다 — 그걸 알리는 용도.
export function classifyTrendStage(m, cfg) {
  const t = cfg?.trendFollow ?? {};
  const chg = m.change24h ?? 0;
  const mk = (stage, key, label, color) => ({ stage, key, label, color });
  if (chg >= (t.runawayPct ?? 120)) return mk(3, "runaway", "3 과열", "purple");
  if (chg >= (t.chgFullPct ?? 25)) return mk(2, "running", "2 진행", "yellow");
  return mk(1, "starting", "1 초기", "blue");
}

// 추세 추종 제외 규칙. early 는 "이미 급등" 을 버리지만 여기는 그게 대상이다.
// 대신 **오르지 않는 것**을 버린다 — 그게 이 모드의 존재 이유다.
export function trendExclusion(m, cfg) {
  const t = cfg?.trendFollow ?? {};
  if (m.mom14 == null || m.mom14 <= 0) return "상승 추세 아님";
  if (m.change24h != null && m.change24h < 0) return "24시간 하락";
  if ((m.quoteVolume ?? 0) < (t.minQuoteVolume ?? 5e6) / 5) return "거래대금 극소";
  return null;
}

// buildEarlyResult 와 같은 모양의 결과를 만든다 — 대시보드·상세패널·기록장이
// 그 모양을 전제로 돌아가므로 필드를 빼면 조용히 깨진다.
// 지표 계산(buildEarlyMetrics)과 진입 계획(earlyPlan)은 그대로 재사용한다.
// 계획을 새로 짜지 않는 이유: earlyPlan 의 손절·목표 배수는 격자 탐색으로 정해진 값이고
// 추세 추종용으로 다시 잰 적이 없다. 근거 있는 값을 근거 없는 값으로 바꿀 이유가 없다.
export function buildTrendResult(item, c4, funding, cfg, deps) {
  const { buildEarlyMetrics, earlyPlan, gradeFor, topSignals } = deps;
  const m = buildEarlyMetrics(c4, [], funding, item, cfg);
  if (!m) return null;
  if (trendExclusion(m, cfg)) return null;

  const scored = scoreTrendFollow(m, cfg.trendFollow);
  const plan = earlyPlan(m, m.atrVal, m.price, cfg);
  const stageInfo = classifyTrendStage(m, cfg);

  return {
    symbol: item.symbol,
    baseAsset: item.baseAsset,
    price: m.price,
    change6h: null,
    change24h: m.change24h ?? 0,
    quoteVolume: item.quoteVolume,
    newListing: item.newListing,
    direction: "long",                 // 추세 추종은 상승만 본다(숏은 별도 측정 필요)
    score: scored.score,
    grade: gradeFor(scored.score, { grades: cfg.trendGrades }),
    stage: stageInfo,
    absorption: { level: "insufficient", label: "추세 추종 모드 — 미적용", score: 0 },
    breakdown: scored.breakdown,
    penalties: scored.penalties,
    topSignals: topSignals(scored.breakdown, 3),
    goldenCrossRetest: { detected: false, reason: "추세 추종 모드" },
    near1hEma200: false,
    noise: { noisy: false, ci: null, relVol: m.relVol3, reasons: [] },
    trend: { mom14: m.mom14, volExpand: m.volExpand, ageDays: m.ageDays },
    plan,
    rsi1h: null,
    timeframes: {},
  };
}

// ─────────────────────────────────────────────────────────────
// 5. 신규 상장 초기 — 사냥터 자체를 바꾼다
// ─────────────────────────────────────────────────────────────
// 조기 포착도 신규에 23점을 주지만 전 종목과 같은 잣대로 잰다. 문제는 지표들이
// warm-up 을 못 채운다는 것 — EMA200 은 200봉이 필요한데 상장 3일차 4시간봉은 18개다.
// 그래서 여기서는 **봉 수를 세어** 못 믿을 지표를 아예 쓰지 않는다.
//
// 반환의 usableBars 는 호출자가 "이 후보에 EMA200 을 들이대지 마라" 를 알 수 있게 하는 값이다.
export function scoreNewListing(m, {
  freshDays = 14,           // 이 안쪽이 대상
  primeDays = 3,            // 가장 높은 점수 구간
  minBars = 30,             // 이보다 봉이 적으면 판단 자체를 보류
  minQuoteVolume = 5e6,
  w = { fresh: 40, vol: 35, range: 25 },
} = {}) {
  const age = m.ageDays;
  if (age == null || age > freshDays) {
    return { score: 0, eligible: false, reason: "신규 아님", breakdown: [], penalties: [], usableBars: null };
  }
  const bars = m.barCount ?? null;
  if (bars != null && bars < minBars) {
    // 억지로 점수를 매기면 표본 6개짜리 지표를 신뢰하게 된다. 보류가 정직하다.
    return { score: 0, eligible: false, reason: `봉 부족(${bars})`, breakdown: [], penalties: [], usableBars: bars };
  }

  // 상장 직후일수록 높게. primeDays 이내 만점 → freshDays 에서 0.
  const fresh = 1 - clamp01((age - primeDays) / (freshDays - primeDays));
  const vol = ramp(m.quoteVolume ?? 0, minQuoteVolume, minQuoteVolume * 10);
  // 신규는 가격 기준선이 없어 변동폭 자체가 재료다. 박스 폭을 그대로 쓴다.
  const range = ramp(m.boxWidthPct ?? 0, 5, 40);

  const breakdown = [
    { key: "fresh", label: `상장 ${Math.round(age)}일차`, max: w.fresh, got: w.fresh * fresh },
    { key: "volume", label: "거래대금", max: w.vol, got: w.vol * vol },
    { key: "range", label: "변동폭", max: w.range, got: w.range * range },
  ];
  const score = Math.round(breakdown.reduce((s, b) => s + b.got, 0));
  return {
    score: Math.max(0, Math.min(100, score)),
    eligible: true, reason: null, breakdown, penalties: [],
    usableBars: bars,
    // 상장 초기에 신뢰할 수 없는 지표. 화면에서 회색 처리하거나 숨기라는 뜻.
    unreliable: bars == null ? [] : [
      ...(bars < 200 ? ["ema200"] : []),
      ...(bars < 50 ? ["ema50", "bollinger"] : []),
      ...(bars < 20 ? ["rsi", "atr"] : []),
    ],
  };
}

// ─────────────────────────────────────────────────────────────
// 2. 횡보 그리드 — 옆으로 가야 돈을 번다
// ─────────────────────────────────────────────────────────────
// 점수가 아니라 **매매 계획**을 돌려준다. "얼마나 좋은 후보인가" 가 아니라
// "이 박스에 그리드를 깔면 한 칸에 얼마 남는가" 가 답이어야 하는 전략이다.
//
// 가장 중요한 가드: 한 칸 수익이 왕복 비용보다 커야 한다. 칸을 촘촘히 깔수록 자주
// 체결되지만 칸당 수익이 줄어 어느 지점부터 수수료에 먹힌다. 그 지점을 넘으면
// 아무리 잘 맞춰도 구조적으로 손해다 — 그래서 viable=false 로 잘라낸다.
//
// noise-filter.js 는 촙 구간을 **제외** 대상으로 본다. 이 전략에서는 그게 재료다.
export function rangeGridPlan(m, {
  maxBoxWidthPct = 25,      // 박스가 너무 넓으면 횡보가 아니라 추세다
  minBoxWidthPct = 3,       // 너무 좁으면 칸 수익이 비용을 못 넘는다
  maxSqueezePct = 60,       // 변동성이 수축 중이어야 박스가 유지된다
  grids = 10,
  roundTripCostPct = 0.2,   // config.tradeCostRoundTripPct 와 같은 값
  costMultiple = 2,         // 칸 수익이 비용의 이 배는 돼야 한다
  stopBufferPct = 1.5,      // 박스 이탈 손절 여유
} = {}) {
  const none = (reason) => ({ viable: false, reason, grids: null, plan: null });
  if (m.boxHigh == null || m.boxLow == null || !(m.boxHigh > m.boxLow)) return none("박스 없음");

  const width = m.boxWidthPct;
  if (width == null) return none("박스 폭 미상");
  if (width > maxBoxWidthPct) return none(`박스가 넓다(${width.toFixed(1)}%) — 추세 구간`);
  if (width < minBoxWidthPct) return none(`박스가 좁다(${width.toFixed(1)}%)`);
  if (m.squeezePct != null && m.squeezePct > maxSqueezePct) return none("변동성 확장 중");

  // 한 칸 수익률 = 박스 폭 / 칸 수. 비용은 칸마다 왕복으로 나간다.
  const perGridPct = width / grids;
  const netPerGridPct = perGridPct - roundTripCostPct;
  if (netPerGridPct <= 0 || perGridPct < roundTripCostPct * costMultiple) {
    return none(`칸 수익 ${perGridPct.toFixed(2)}% < 비용 ${roundTripCostPct}%×${costMultiple}`);
  }

  const step = (m.boxHigh - m.boxLow) / grids;
  const levels = Array.from({ length: grids + 1 }, (_, i) => m.boxLow + step * i);
  return {
    viable: true, reason: null, grids,
    plan: {
      boxHigh: m.boxHigh, boxLow: m.boxLow, boxWidthPct: width,
      levels,
      perGridPct, netPerGridPct,
      // 박스를 벗어나면 그리드는 즉시 손실 기계가 된다. 위아래 둘 다 필요하다.
      stopAbove: m.boxHigh * (1 + stopBufferPct / 100),
      stopBelow: m.boxLow * (1 - stopBufferPct / 100),
      // 박스 안을 한 번 왕복하면 이만큼. 실제로는 전 구간을 다 먹지 못한다.
      fullSweepPct: netPerGridPct * grids,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// 3. 페어 트레이딩 — 두 종목의 차이만 본다
// ─────────────────────────────────────────────────────────────
// 같이 움직이던 두 종목이 벌어지면 좁혀질 쪽에 건다. 한 종목만 보는 기존 모드와
// 입력 자체가 다르다(캔들 2세트).
//
// 스프레드는 **누적 수익률 차이**로 잡는다. 가격 차를 쓰면 단가가 다른 두 종목을
// 비교할 수 없다. z 점수는 그 차이가 평소 대비 몇 시그마인지.
//
// 상관이 낮으면 애초에 "같이 움직이던" 이 성립하지 않으므로 신호를 내지 않는다 —
// 이걸 빼면 무관한 두 종목의 우연한 벌어짐을 매매 신호로 착각한다.
export function pairDivergence(candlesA, candlesB, {
  lookback = 60, minCorr = 0.7, minZ = 2, minSamples = 30,
} = {}) {
  const none = (reason) => ({ signal: false, reason, corr: null, z: null });
  const ra = returnsFrom(candlesA, lookback);
  const rb = returnsFrom(candlesB, lookback);
  if (!ra || !rb) return none("표본 부족");
  const n = Math.min(ra.length, rb.length);
  if (n < minSamples) return none(`표본 부족(${n})`);
  const a = ra.slice(-n), b = rb.slice(-n);

  const corr = pearson(a, b);
  if (corr == null) return none("상관 계산 불가");
  if (corr < minCorr) return none(`상관 낮음(${corr.toFixed(2)}) — 페어가 아니다`);

  // 누적 수익률 차이의 시계열. 마지막 값이 현재 벌어진 정도.
  const spread = [];
  let ca = 0, cb = 0;
  for (let i = 0; i < n; i++) { ca += a[i]; cb += b[i]; spread.push(ca - cb); }
  const mean = spread.reduce((s, x) => s + x, 0) / n;
  const varr = spread.reduce((s, x) => s + (x - mean) ** 2, 0) / n;
  const sd = Math.sqrt(varr);
  if (!(sd > 0)) return none("스프레드 변동 없음");

  const z = (spread[n - 1] - mean) / sd;
  if (Math.abs(z) < minZ) return none(`평소 범위(z=${z.toFixed(2)})`);

  // z 가 양수 = A 가 B 보다 앞서갔다 → 좁혀지려면 A 가 내리거나 B 가 오른다.
  return {
    signal: true, reason: null, corr, z,
    long: z > 0 ? "B" : "A",
    short: z > 0 ? "A" : "B",
    spreadNow: spread[n - 1], spreadMean: mean, spreadSd: sd,
  };
}

export default {
  scoreTrendFollow, classifyTrendStage, trendExclusion, buildTrendResult,
  scoreNewListing, rangeGridPlan, pairDivergence,
};
