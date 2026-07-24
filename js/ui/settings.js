// ui/settings.js — 필터 영역(§15) + 설정 관리(§17).
// localStorage 저장은 state.js 가 담당. 여기선 UI 바인딩 + 필터 적용 로직.

import { state, updateSettings, resetSettings, emit } from "../state.js";
import { CONFIG, strictnessPreset } from "../config.js";
import { toast } from "./notifications.js";

// 체크박스 설정 — 하나의 설정이 필터 바 + 설정 탭 양쪽에 있을 수 있어 id 를 배열로 둔다(twin).
const CHECK_BINDINGS = [
  { key: "showFavoritesOnly", ids: ["filter-favorites-only"] },
  { key: "excludeChaseBan", ids: ["filter-exclude-chase", "set-exclude-chase"] },
  { key: "excludeNewListing", ids: ["filter-exclude-new", "set-exclude-new"] },
  { key: "goldenCrossOnly", ids: ["filter-golden-cross", "set-golden-cross"] },
  { key: "near1hEma200Only", ids: ["filter-near-ema200", "set-near-ema200"] },
  { key: "filterNoise", ids: ["set-filter-noise"] },
];
const AUTOREFRESH_IDS = ["filter-autorefresh", "set-autorefresh"];
const REALTIME_IDS = ["set-realtime-candle"];

// 결과 목록에 현재 설정(필터/정렬) 적용
export function applyFilters(results) {
  const s = state.settings;
  const early = s.scanMode === "early";
  let list = results.slice();

  // 방향 — early 모드는 롱 전용이라 방향 필터를 건너뛴다(안 그러면 결과가 전부 사라짐)
  if (!early && s.direction !== "both") list = list.filter((r) => r.direction === s.direction);
  // 최소 점수
  list = list.filter((r) => r.score >= s.minScore);
  // 관심 종목만
  if (s.showFavoritesOnly) list = list.filter((r) => s.favorites.includes(r.symbol));
  // 추격 금지(5단계) 제외
  if (s.excludeChaseBan) list = list.filter((r) => r.stage.stage !== 5);
  // 신규 종목 제외
  if (s.excludeNewListing) list = list.filter((r) => !r.newListing);
  // 골든크로스 리테스트(거부 캔들까지 확인된 것)만
  if (s.goldenCrossOnly) list = list.filter((r) => r.goldenCrossRetest?.detected && r.goldenCrossRetest?.hasRejection);
  // 1시간봉 200일선 밀착만
  if (s.near1hEma200Only) list = list.filter((r) => r.near1hEma200);
  // 노이즈(촙 구간·저거래량) 제외
  // early 모드의 매집 구간은 정의상 횡보(=촙)라 이 필터를 적용하면 후보가 전멸한다.
  if (!early && s.filterNoise) list = list.filter((r) => !r.noise?.noisy);
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

// 필터 바 + 설정 탭 초기화
export function initSettingsUI() {
  bindSelect("filter-scanmode", "scanMode");
  bindSelect("filter-direction", "direction");
  bindSelect("filter-minscore", "minScore", Number);
  bindSelect("filter-dropbasis", "dropBasis");
  bindSelect("filter-timeframe", "timeframeFocus");
  bindSelect("filter-stage", "stageFilter");
  bindSelect("filter-sort", "sort");

  // 체크박스 — twin id 지원 (한 설정이 여러 위치에 있을 수 있음)
  for (const { key, ids } of CHECK_BINDINGS) bindCheckGroup(ids, key, true);

  // 자동 갱신 — 시작/중지 신호 (필터 재적용 아님)
  bindCheckGroup(AUTOREFRESH_IDS, "autoRefresh", false, (checked) => emit("autorefresh:toggle", checked));
  // 실시간 캔들 — 다음 스캔에 반영
  bindCheckGroup(REALTIME_IDS, "includeRealtimeCandle", false);

  const minVol = document.getElementById("filter-minvolume");
  if (minVol) minVol.addEventListener("change", () => {
    updateSettings({ minQuoteVolume: Number(minVol.value) });
    emit("filters:apply");
  });

  const applyBtn = document.getElementById("filter-apply");
  if (applyBtn) applyBtn.addEventListener("click", () => emit("filters:apply"));

  const strictness = document.getElementById("filter-strictness");
  if (strictness) strictness.addEventListener("change", () => {
    const preset = strictnessPreset(Number(strictness.value));
    updateSettings({ strictnessLevel: preset.level, minScore: preset.minScore, penalties: { ...preset.penalties } });
    syncControls();
    toast("다음 스캔부터 적용됩니다.", "info");
  });

  // 설정 탭 숫자 조정
  const emaRatio = document.getElementById("set-ema200-ratio");
  if (emaRatio) emaRatio.addEventListener("change", () => {
    const v = Math.min(3, Math.max(0.1, Number(emaRatio.value) || CONFIG.near1hEma200AtrRatio));
    updateSettings({ near1hEma200AtrRatio: v });
    syncControls();
    toast("다음 스캔부터 적용됩니다.", "info");
  });
  const refreshSec = document.getElementById("set-refresh-sec");
  if (refreshSec) refreshSec.addEventListener("change", () => {
    const ms = Math.max(CONFIG.refresh.minIntervalMs, (Number(refreshSec.value) || 90) * 1000);
    updateSettings({ refreshIntervalMs: ms });
    syncControls();
    toast("자동 갱신 주기를 바꿨습니다.", "info");
  });

  // 초기화 버튼 — 사이드바 + 설정 탭 양쪽
  for (const id of ["settings-reset", "settings-reset-2"]) {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener("click", () => {
      resetSettings();
      syncControls();
      applyDarkMode();
      emit("filters:apply");
      toast("설정을 초기화했습니다.", "success");
    });
  }

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

// 같은 설정을 가리키는 여러 체크박스를 묶어 바인딩. 하나 바뀌면 상태 갱신 + 나머지 동기화.
function bindCheckGroup(ids, key, applyFilter, after) {
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener("change", () => {
      updateSettings({ [key]: el.checked });
      for (const other of ids) setChk(other, el.checked);
      if (applyFilter) emit("filters:apply");
      if (after) after(el.checked);
    });
  }
}

// 설정값 → 컨트롤 반영
export function syncControls() {
  const s = state.settings;
  setVal("filter-scanmode", s.scanMode);
  syncStageLabels(s.scanMode);
  setVal("filter-direction", s.direction);
  setVal("filter-minscore", s.minScore);
  setVal("filter-dropbasis", s.dropBasis);
  setVal("filter-timeframe", s.timeframeFocus);
  setVal("filter-stage", s.stageFilter);
  setVal("filter-sort", s.sort);
  for (const { key, ids } of CHECK_BINDINGS) for (const id of ids) setChk(id, s[key]);
  for (const id of AUTOREFRESH_IDS) setChk(id, s.autoRefresh);
  for (const id of REALTIME_IDS) setChk(id, s.includeRealtimeCandle);
  setVal("filter-minvolume", s.minQuoteVolume);
  setVal("filter-strictness", s.strictnessLevel);
  setVal("set-ema200-ratio", s.near1hEma200AtrRatio);
  setVal("set-refresh-sec", Math.round(s.refreshIntervalMs / 1000));
}
function setVal(id, v) { const el = document.getElementById(id); if (el) el.value = String(v); }
function setChk(id, v) { const el = document.getElementById(id); if (el) el.checked = !!v; }

// 단계 필터의 선택지 문구를 모드에 맞게 바꾼다(값은 그대로 1~5).
const STAGE_LABELS = {
  reversal: ["전체", "1 매집", "2 유동성 회수", "3 구조전환", "4 진입 구간", "5 추격 금지"],
  early: ["전체", "1 매집", "2 임박", "3 돌파", "—", "—"],
};
function syncStageLabels(mode) {
  const el = document.getElementById("filter-stage");
  if (!el) return;
  const labels = STAGE_LABELS[mode] || STAGE_LABELS.reversal;
  for (let i = 0; i < el.options.length && i < labels.length; i++) {
    el.options[i].textContent = labels[i];
  }
}

export function applyDarkMode() {
  document.documentElement.classList.toggle("dark", !!state.settings.darkMode);
}

export default { applyFilters, initSettingsUI, syncControls, applyDarkMode };
