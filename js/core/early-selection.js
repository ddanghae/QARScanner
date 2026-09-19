// core/early-selection.js — 조기 포착의 "보이는 후보"와 확인 대상이 같은 규칙을 쓴다.
// CRT/TBS 는 이 선택 뒤에 산출되는 값이라 여기서 걸러내지 않는다. 그래야 필요한 소수에만
// 5분봉 확인을 요청할 수 있고, 다른 화면 필터와도 순환 의존이 생기지 않는다.

import { CONFIG } from "../config.js";
import { resultMode } from "../scan-modes.js";

function asSet(value) {
  return new Set(Array.isArray(value) ? value : []);
}

function scoreOf(result) {
  return Number.isFinite(result?.score) ? result.score : 0;
}

function volumeOf(result) {
  return Number.isFinite(result?.quoteVolume) ? result.quoteVolume : 0;
}

// CRT/TBS를 제외한, 확인 전에도 판정 가능한 조기 포착 화면 필터.
// 이 함수를 UI와 스캔 컨트롤러가 함께 쓰면 "화면에 안 보일 후보"를 확인 대상으로
// 고르는 일이 없다.
export function filterEarlyReviewCandidates(results, settings = {}, cfg = CONFIG) {
  const favorites = asSet(settings.favorites);
  const excluded = asSet(settings.excluded);
  const stageFilter = String(settings.stageFilter ?? "all");
  const minScore = Number.isFinite(cfg?.earlyMinScore) ? cfg.earlyMinScore : CONFIG.earlyMinScore;

  return (Array.isArray(results) ? results : []).filter((result) => {
    if (resultMode(result) !== "early") return false;
    if (scoreOf(result) < minScore) return false;
    if (settings.showFavoritesOnly && !favorites.has(result.symbol)) return false;
    if (settings.excludeChaseBan && result.stage?.stage === 5) return false;
    if (settings.excludeNewListing && result.newListing) return false;
    if (excluded.has(result.symbol)) return false;
    if (stageFilter !== "all" && String(result.stage?.stage) !== stageFilter) return false;
    return true;
  });
}

// 검증 점수 → 유동성 → 심볼 순서의 안정적인 순위. 거래량은 동점의 보조 기준일 뿐
// 점수 기반 후보 집합을 바꾸는 필터가 아니다.
export function rankEarlyReviewCandidates(results) {
  return [...(Array.isArray(results) ? results : [])].sort((a, b) =>
    scoreOf(b) - scoreOf(a) ||
    volumeOf(b) - volumeOf(a) ||
    String(a?.symbol ?? "").localeCompare(String(b?.symbol ?? ""))
  );
}

// 비싼 1h/15m/5m 확인을 줄 소수. 결과 화면의 기본 후보 계약과 동일한 base filter를 쓴다.
export function selectEarlyConfirmationTargets(results, settings = {}, cfg = CONFIG) {
  const keepTop = Number.isFinite(cfg?.earlyKeepTop) ? cfg.earlyKeepTop : CONFIG.earlyKeepTop;
  return rankEarlyReviewCandidates(filterEarlyReviewCandidates(results, settings, cfg)).slice(0, keepTop);
}

export default {
  filterEarlyReviewCandidates,
  rankEarlyReviewCandidates,
  selectEarlyConfirmationTargets,
};
