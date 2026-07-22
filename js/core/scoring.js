// core/scoring.js — 흡수 추정(§11) + 상승 초기 단계 분류(§12) + 점수 체계(§13).
// 입력: deep-scanner 가 만든 signals(ctx). 출력: 점수/등급/단계/흡수/근거.
// 모든 가중치·감점은 config 에서 주입 → 사용자 조정 가능.

// ---------- §11 흡수 추정 ----------
// 실제 호가창 복원 아님. 캔들 + Taker Volume 기반 추정.
// dir: "long"=매도 흡수(아래꼬리·저점 스윕), "short"=매수 흡수(위꼬리·고점 스윕).
export function estimateAbsorption(sig, dir = "long") {
  const c = sig.absorptionCandle; // 15m 마지막 유효 캔들 요약
  if (!c) return { level: "insufficient", label: "흡수 근거 부족", score: 0 };
  const short = dir === "short";
  let pts = 0;
  if ((short ? 1 - c.sellRatio : c.sellRatio) > 0.5) pts++;   // 흡수 방향 Taker 증가
  if (c.highVol) pts++;                                        // 거래량 평균 이상
  if (short ? c.closePos <= 0.5 : c.closePos >= 0.5) pts++;    // 종가 위치
  if ((short ? c.upperWickRatio : c.lowerWickRatio) >= 0.3) pts++; // 꼬리 형성
  if (sig.sweepRecovered) pts++;                              // 스윕 후 되돌림
  if (short ? (sig.cvdUp && sig.priceFlatOrDown) : (sig.cvdDown && sig.priceFlatOrUp)) pts++;

  const side = short ? "매수" : "매도";
  let level = "insufficient", label = "흡수 근거 부족";
  if (pts >= 5) { level = "strong"; label = `강한 ${side} 흡수 추정`; }
  else if (pts >= 3) { level = "normal"; label = `보통 ${side} 흡수 추정`; }
  return { level, label, points: pts, score: level === "strong" ? 10 : level === "normal" ? 6 : 0 };
}

// ---------- §12 상승 초기 단계 분류 ----------
// 1 매집 → 2 유동성 회수 → 3 구조전환 초기 → 4 진입 구간 → 5 추격 금지
export function classifyStage(sig) {
  // 5단계 추격 금지 먼저 (과열/급등)
  if (
    sig.change15mOverExtended ||
    sig.farFromLowAtr ||
    sig.shortTargetDistance ||
    sig.rsiOverheated ||
    sig.poorRiskReward
  ) {
    return stage(5, "chase_ban", "늦음·추격 금지", "danger");
  }
  // 4단계 진입 구간
  if (
    (sig.fvgReentry || sig.obReentry) &&
    (sig.choch5m || sig.low5mDefended) &&
    sig.volumeReSurge
  ) {
    return stage(4, "entry_zone", "진입 검토", "purple");
  }
  // 3단계 구조전환 초기
  if (
    (sig.choch1h || sig.choch15m) &&
    (sig.firstHH || sig.firstHL) &&
    (sig.fvgCreated || sig.obCreated) &&
    !sig.firstPushDone
  ) {
    return stage(3, "structure_shift", "구조전환 초기", "yellow");
  }
  // 2단계 유동성 회수
  if (
    sig.lowSweep &&
    sig.sweepRecovered &&
    sig.volumeReacted &&
    (sig.cvdImproved || sig.deltaImproved)
  ) {
    return stage(2, "liquidity_grab", "유동성 회수", "green");
  }
  // 1단계 매집 (기본)
  return stage(1, "accumulation", "관찰 초기", "blue");
}
function stage(n, key, label, badge) {
  return { stage: n, key, label, badge };
}

// ---------- §13 점수 체계 ----------
// 기본 100점 만점 항목 가중합 - 감점.
// dir 로 방향 특정 라벨만 교체. 가중치·감점 수치는 롱/숏 동일.
const LABELS = {
  long: {
    dropAndOversold: "급락 및 과매도 상태", lowLiquiditySweep: "저점 유동성 스윕",
    sweepPriceRecovery: "스윕 후 가격 회수", sellAbsorption: "매도 흡수 추정",
    overExtended15m: "15분봉 과도 상승", farFromLowAtr: "저점에서 ATR 기준 멀어짐",
    strongResistanceAbove: "바로 위 강한 저항", strongDowntrend4h: "4시간봉 강한 하락 추세",
  },
  short: {
    dropAndOversold: "급등 및 과매수 상태", lowLiquiditySweep: "고점 유동성 스윕",
    sweepPriceRecovery: "스윕 후 가격 반락", sellAbsorption: "매수 흡수 추정",
    overExtended15m: "15분봉 과도 하락", farFromLowAtr: "고점에서 ATR 기준 멀어짐",
    strongResistanceAbove: "바로 아래 강한 지지", strongDowntrend4h: "4시간봉 강한 상승 추세",
  },
};

export function scoreCandidate(sig, absorption, stageInfo, cfg, dir = "long") {
  const w = cfg.scoreWeights;
  const p = cfg.penalties;
  const L = LABELS[dir] || LABELS.long;
  const breakdown = [];
  let score = 0;

  const add = (cond, weight, key, label) => {
    const got = cond ? weight : 0;
    if (got) score += got;
    breakdown.push({ key, label, weight, got, hit: !!cond });
  };

  add(sig.dropAndOversold, w.dropAndOversold, "dropAndOversold", L.dropAndOversold);
  add(sig.goodLiquidity, w.volumeLiquidity, "volumeLiquidity", "거래대금과 유동성");
  add(sig.lowSweepValid, w.lowLiquiditySweep, "lowLiquiditySweep", L.lowLiquiditySweep);
  add(sig.sweepRecovered, w.sweepPriceRecovery, "sweepPriceRecovery", L.sweepPriceRecovery);
  add(absorption.level !== "insufficient", w.sellAbsorption, "sellAbsorption", L.sellAbsorption);
  add(sig.structureShift1h, w.structureShift1h, "structureShift1h", "1시간봉 구조전환");
  add(sig.fvgObOverlap, w.fvgObOverlap, "fvgObOverlap", "15분봉 FVG·OB 중첩");
  add(sig.volumeDeltaShift, w.volumeDeltaShift, "volumeDeltaShift", "거래량 및 Delta 전환");
  add(sig.entryTrigger5m, w.entryTrigger5m, "entryTrigger5m", "5분봉 진입 트리거");
  add(sig.riskRewardOk, w.riskReward, "riskReward", "예상 손익비 1:2 이상");

  // ---- 감점 ----
  const penalties = [];
  const pen = (cond, val, key, label) => {
    if (cond) { score += val; penalties.push({ key, label, val }); }
  };
  pen(sig.change15mOverExtended, p.overExtended15m, "overExtended15m", L.overExtended15m);
  pen(sig.farFromLowAtr, p.farFromLowAtr, "farFromLowAtr", L.farFromLowAtr);
  pen(sig.strongResistanceAbove, p.strongResistanceAbove, "strongResistanceAbove", L.strongResistanceAbove);
  pen(sig.shortTargetDistance, p.shortTargetDistance, "shortTargetDistance", "목표까지 거리 짧음");
  pen(sig.tooLowVolume, p.tooLowVolume, "tooLowVolume", "거래량 지나치게 낮음");
  pen(sig.strongDowntrend4h, p.strongDowntrend4h, "strongDowntrend4h", L.strongDowntrend4h);
  pen(sig.newListingThin, p.newListingThin, "newListingThin", "신규 상장 데이터 부족");
  pen(sig.poorRiskReward, p.poorRiskReward, "poorRiskReward", "손익비 1:1.5 미만");

  score = Math.max(0, Math.min(100, Math.round(score)));
  const grade = gradeFor(score, cfg);
  return { score, grade, breakdown, penalties };
}

export function gradeFor(score, cfg) {
  for (const g of cfg.grades) if (score >= g.min) return g;
  return cfg.grades[cfg.grades.length - 1];
}

// 상위 3개 핵심 신호 (breakdown 에서 hit 된 것 중 가중치 높은 순)
export function topSignals(breakdown, n = 3) {
  return breakdown.filter((b) => b.hit).sort((a, b) => b.weight - a.weight)
    .slice(0, n).map((b) => b.label);
}

export default { estimateAbsorption, classifyStage, scoreCandidate, gradeFor, topSignals };
