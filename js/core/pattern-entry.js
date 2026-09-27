// Turns scanned pattern structure into conditional entry areas. These are heuristic setups,
// not orders, recommendations, or calibrated outcome probabilities.
import { assessSymbolDirection, PATTERN_DIRECTION_WEIGHTS } from "./pattern-direction.js";

const MIN_DIRECTION_PCT = 60;
const MIN_PATTERN_DIRECTION_PCT = 55;
const MIN_FIT_SCORE = 55;
const MIN_RR = 1.5;
const RETEST_ATR = 0.1;
const MAX_RETEST_PRICE_PCT = 0.0015;

const finite = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
const validInterval = (low, high) => finite(low) && finite(high) && Number(low) > 0 && Number(high) >= Number(low);

function isDirectionSupported(assessment, direction) {
  const overallPct = direction === "long" ? assessment.overall?.longPct : assessment.overall?.shortPct;
  const patternPct = direction === "long" ? assessment.pattern?.longPct : assessment.pattern?.shortPct;
  const patternCount = direction === "long" ? assessment.pattern?.bullishCount : assessment.pattern?.bearishCount;
  return overallPct >= MIN_DIRECTION_PCT && patternPct >= MIN_PATTERN_DIRECTION_PCT && patternCount > 0;
}

function levelCandidate(pattern, timeframe, direction, atr14, price) {
  const detail = pattern.timeframes?.[timeframe];
  if (!detail || detail.bias !== (direction === "long" ? "bullish" : "bearish")
    || (Number(detail.fitScore) || 0) < MIN_FIT_SCORE
    || !finite(detail.trigger) || !finite(detail.invalidation) || !finite(detail.projection)
    || !(atr14 > 0)) return null;

  const trigger = Number(detail.trigger), invalidation = Number(detail.invalidation), projection = Number(detail.projection);
  const long = direction === "long";
  // Keep the entry area close to the trigger even on volatile higher timeframes.
  const band = Math.min(atr14 * RETEST_ATR, trigger * MAX_RETEST_PRICE_PCT);
  let entryLow = trigger - band, entryHigh = trigger + band;
  if (detail.status === "reaction" && validInterval(detail.zone?.low, detail.zone?.high)) {
    entryLow = Math.max(entryLow, Number(detail.zone.low));
    entryHigh = Math.min(entryHigh, Number(detail.zone.high));
  }
  if (!(entryHigh >= entryLow) || entryLow <= 0) return null;

  // Use the conservative edge of the retest area to calculate loss and reward.
  const riskDistance = long ? entryHigh - invalidation : invalidation - entryLow;
  const rewardDistance = long ? projection - entryHigh : entryLow - projection;
  if (!(riskDistance > 0) || !(rewardDistance > 0)) return null;
  if ((long && (invalidation >= entryLow || projection <= entryHigh))
    || (!long && (invalidation <= entryHigh || projection >= entryLow))) return null;
  if (long ? price <= invalidation || price >= projection : price >= invalidation || price <= projection) return null;

  const rr = rewardDistance / riskDistance;
  if (rr < MIN_RR) return { rejected: "투영 목표 기준 손익비가 1.5 미만" };
  const timeframeWeight = PATTERN_DIRECTION_WEIGHTS[timeframe] || 1;
  const score = (Number(detail.fitScore) || 0) * 0.65
    + Math.min(100, Number(detail.completionPct) || 0) * 0.1
    + timeframeWeight * 5
    + (detail.status === "breakout" || detail.status === "reaction" ? 5 : 0);
  return {
    direction,
    state: detail.status === "breakout" ? "wait-retest"
      : detail.status === "reaction" ? "wait-pullback" : "wait-breakout",
    timeframe,
    patternId: pattern.id,
    patternName: pattern.name,
    patternStatus: detail.status,
    fitScore: Number(detail.fitScore) || 0,
    completionPct: detail.completionPct ?? null,
    trigger,
    entryLow,
    entryHigh,
    stop: invalidation,
    target: projection,
    riskPct: riskDistance / (long ? entryHigh : entryLow) * 100,
    rewardPct: rewardDistance / (long ? entryHigh : entryLow) * 100,
    rr: Math.round(rr * 100) / 100,
    timeframeWeight,
    score,
  };
}

/** Derive the strongest eligible setup from a symbol's pattern and EMA200 evidence. */
export function derivePatternEntryCandidate({
  patterns = [], ema200ByTimeframe = {}, timeframes = [], atrByTimeframe = {}, price,
} = {}) {
  const assessment = assessSymbolDirection(patterns, ema200ByTimeframe, timeframes);
  if (!assessment.overall) {
    return { state: "watch", title: "관망 · 방향 근거 부족", reason: "방향 패턴 또는 EMA200 근거가 충분하지 않습니다.", assessment };
  }

  const direction = assessment.overall.longPct >= MIN_DIRECTION_PCT ? "long"
    : assessment.overall.shortPct >= MIN_DIRECTION_PCT ? "short" : null;
  if (!direction) {
    return { state: "mixed", title: "관망 · 방향 근거 혼재", reason: "롱 또는 숏 종합 근거가 60%에 도달하지 않았습니다.", assessment };
  }
  if (!isDirectionSupported(assessment, direction)) {
    return { state: "watch", direction, title: "관망 · 패턴 확인 필요", reason: "EMA200 방향은 우세하지만 같은 방향의 패턴 근거가 부족합니다.", assessment };
  }
  if (!finite(price) || Number(price) <= 0) {
    return { state: "watch", direction, title: "관망 · 기준 가격 없음", reason: "최근 마감 가격을 확인할 수 없습니다.", assessment };
  }

  const candidates = [];
  let rejectedForRR = false;
  for (const pattern of patterns) {
    for (const timeframe of timeframes) {
      const result = levelCandidate(pattern, timeframe, direction, Number(atrByTimeframe[timeframe]), Number(price));
      if (result?.rejected) rejectedForRR = true;
      else if (result) candidates.push(result);
    }
  }
  candidates.sort((a, b) => b.score - a.score || b.rr - a.rr || b.timeframeWeight - a.timeframeWeight);
  const selected = candidates[0];
  if (!selected) {
    return {
      state: "structure-needed", direction,
      title: `관망 · ${direction === "long" ? "롱" : "숏"} 구조 확인 필요`,
      reason: rejectedForRR ? "패턴 투영 목표 기준 손익비가 1.5 미만인 구조라 후보에서 제외했습니다." : "방향은 우세하지만 진입·무효화·목표 가격이 함께 있는 패턴이 없습니다.",
      assessment,
    };
  }

  const agreementTimeframes = [...new Set(candidates
    .filter((candidate) => candidate.direction === direction)
    .map((candidate) => candidate.timeframe))];
  const inEntryZone = Number(price) >= selected.entryLow && Number(price) <= selected.entryHigh;
  const state = selected.state === "wait-retest" && inEntryZone ? "zone-now"
    : selected.state === "wait-pullback" && inEntryZone ? "zone-now" : selected.state;
  const stateTitles = {
    "wait-retest": "돌파 확인 · 리테스트 대기",
    "wait-breakout": "돌파 확인 대기",
    "wait-pullback": "반응 확인 · 되돌림 대기",
    "zone-now": "후보 구간 도달 · 추가 확인 필요",
  };
  return {
    ...selected,
    state,
    title: `${direction === "long" ? "롱" : "숏"} 타점 후보 · ${stateTitles[state]}`,
    reason: `${selected.timeframe} ${selected.patternName} · 적합도 ${selected.fitScore}점${agreementTimeframes.length > 1 ? ` · ${agreementTimeframes.length}개 시간봉 같은 방향` : ""}`,
    agreementTimeframes,
    assessment,
  };
}
