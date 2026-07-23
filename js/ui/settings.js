// ui/settings.js — 필터 영역(§15) + 설정 관리(§17).
// localStorage 저장은 state.js 가 담당. 여기선 UI 바인딩 + 필터 적용 로직.

import { state, updateSettings, resetSettings, emit } from "../state.js";
import { strictnessPreset } from "../config.js";
import { toast } from "./notifications.js";

// 결과 목록에 현재 설정(필터/정렬) 적용
export function applyFilters(results) {
  const s = state.settings;
  let list = results.slice();

  // 방향
  if (s.direction !== "both") list = list.filter((r) => r.direction === s.direction);
  // 최소 점수
  list = list.filter((r) => r.score >= s.minScore);
  // 관심 종목만
  if (s.showFavoritesOnly) list = list.filter((r) => s.favorites.includes(r.symbol));
  // 추격 금지(5단계) 제외
  if (s.excludeChaseBan) list = list.filter((r) => r.stage.stage !== 5);
  // 신규 종목 제외
  if (s.excludeNewListing) list = list.filter((r) => !r.newListing);
  // 제외 종목
  if (s.excluded.length) list = list.filter((r) => !s.excluded.includes(r.symbol));
  // 단계 필터
  if (s.stageFilter !== "all") list = list.filter((r) => String(r.stage.stage) === String(s.stageFilter));

  // 정렬
  const sortFns = {
    score: (a, b) => b.score - a.score,
    change: (a, b) => a.change6h - b.change6h,
    volume: (a, b) => b.quoteVolume - a.quoteVolume,
  };
  list.sort(sortFns[s.sort] || sortFns.score);
  return list.map((r, i) => ({ ...r, rank: i + 1 }));
}

// 필터 바 초기화
export function initSettingsUI() {
  bindSelect("filter-direction", "direction");
  bindSelect("filter-minscore", "minScore", Number);
  bindSelect("filter-dropbasis", "dropBasis");
  bindSelect("filter-timeframe", "timeframeFocus");
  bindSelect("filter-stage", "stageFilter");
  bindSelect("filter-sort", "sort");
  bindCheck("filter-favorites-only", "showFavoritesOnly");
  bindCheck("filter-exclude-chase", "excludeChaseBan");
  bindCheck("filter-exclude-new", "excludeNewListing");

  // 실시간 캔들 포함 — 다음 스캔에 반영 (필터 재적용 불필요)
  const rt = document.getElementById("filter-realtime-candle");
  if (rt) rt.addEventListener("change", () => updateSettings({ includeRealtimeCandle: rt.checked }));

  // 자동 갱신 — 시작/중지 신호
  const ar = document.getElementById("filter-autorefresh");
  if (ar) ar.addEventListener("change", () => {
    updateSettings({ autoRefresh: ar.checked });
    emit("autorefresh:toggle", ar.checked);
  });

  const minVol = document.getElementById("filter-minvolume");
  if (minVol) {
    minVol.value = String(state.settings.minQuoteVolume);
    minVol.addEventListener("change", () => {
      updateSettings({ minQuoteVolume: Number(minVol.value) });
      emit("filters:apply");
    });
  }

  const applyBtn = document.getElementById("filter-apply");
  if (applyBtn) applyBtn.addEventListener("click", () => emit("filters:apply"));

  const resetBtn = document.getElementById("settings-reset");
  if (resetBtn) resetBtn.addEventListener("click", () => {
    resetSettings();
    syncControls();
    applyDarkMode();
    emit("filters:apply");
    toast("설정을 초기화했습니다.", "success");
  });

  const strictness = document.getElementById("filter-strictness");
  if (strictness) strictness.addEventListener("change", () => {
    const preset = strictnessPreset(Number(strictness.value));
    updateSettings({ strictnessLevel: preset.level, minScore: preset.minScore, penalties: { ...preset.penalties } });
    syncControls();
    toast("다음 스캔부터 적용됩니다.", "info");
  });

  const darkBtn = document.getElementById("toggle-dark");
  if (darkBtn) darkBtn.addEventListener("click", () => {
    updateSettings({ darkMode: !state.settings.darkMode });
    applyDarkMode();
  });

  syncControls();
  applyDarkMode();
}

function bindSelect(id, key, cast) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("change", () => {
    updateSettings({ [key]: cast ? cast(el.value) : el.value });
    emit("filters:apply");
  });
}
function bindCheck(id, key) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("change", () => {
    updateSettings({ [key]: el.checked });
    emit("filters:apply");
  });
}

// 설정값 → 컨트롤 반영
export function syncControls() {
  const s = state.settings;
  setVal("filter-direction", s.direction);
  setVal("filter-minscore", s.minScore);
  setVal("filter-dropbasis", s.dropBasis);
  setVal("filter-timeframe", s.timeframeFocus);
  setVal("filter-stage", s.stageFilter);
  setVal("filter-sort", s.sort);
  setChk("filter-favorites-only", s.showFavoritesOnly);
  setChk("filter-exclude-chase", s.excludeChaseBan);
  setChk("filter-exclude-new", s.excludeNewListing);
  setChk("filter-realtime-candle", s.includeRealtimeCandle);
  setChk("filter-autorefresh", s.autoRefresh);
  setVal("filter-minvolume", s.minQuoteVolume);
  setVal("filter-strictness", s.strictnessLevel);
}
function setVal(id, v) { const el = document.getElementById(id); if (el) el.value = String(v); }
function setChk(id, v) { const el = document.getElementById(id); if (el) el.checked = !!v; }

export function applyDarkMode() {
  document.documentElement.classList.toggle("dark", !!state.settings.darkMode);
}

export default { applyFilters, initSettingsUI, syncControls, applyDarkMode };
