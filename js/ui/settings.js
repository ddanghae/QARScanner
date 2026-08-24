// ui/settings.js — 필터 영역(§15) + 설정 관리(§17).
// localStorage 저장은 state.js 가 담당. 여기선 UI 바인딩 + 필터 적용 로직.

import { state, updateSettings, resetSettings, emit } from "../state.js";
import { CONFIG, strictnessPreset, minScoreFor } from "../config.js";
import { toast } from "./notifications.js";

// 체크박스 설정 — 하나의 설정이 필터 바 + 설정 탭 양쪽에 있을 수 있어 id 를 배열로 둔다(twin).
const CHECK_BINDINGS = [
  { key: "showFavoritesOnly", ids: ["filter-favorites-only"] },
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
  const reversal = s.scanMode === "reversal";
  const pumpFade = s.scanMode === "pump_fade";
  const stage5Explicit = reversal && String(s.stageFilter) === "5";
  let list = results.slice();

  // 방향 — early/pump_fade는 각각 LONG/SHORT 전용 파이프라인이라 저장된 reversal 방향을 적용하지 않는다.
  if (reversal && s.direction !== "both") list = list.filter((r) => r.direction === s.direction);
  // 최소 점수 — 모드별 점수 척도가 달라 각 전용 컷 사용
  const cut = minScoreFor(s);
  list = list.filter((r) => r.score >= cut);
  // 관심 종목만
  if (s.showFavoritesOnly) list = list.filter((r) => s.favorites.includes(r.symbol));
  // 추격 금지(5단계)는 직접 고른 경우에만 노출한다. 레거시 체크 설정과 무관한 고정 계약이다.
  if (reversal && !stage5Explicit) list = list.filter((r) => r.stage.stage !== 5);
  // 신규 종목 제외
  if (s.excludeNewListing) list = list.filter((r) => !r.newListing);
  // 골든크로스 리테스트(거부 캔들까지 확인된 것)만
  if (reversal && s.goldenCrossOnly) list = list.filter((r) => r.goldenCrossRetest?.detected && r.goldenCrossRetest?.hasRejection);
  // 1시간봉 200일선 밀착만
  if (reversal && s.near1hEma200Only) list = list.filter((r) => r.near1hEma200);
  // 노이즈(촙 구간·저거래량) 제외
  // early 모드의 매집 구간은 정의상 횡보(=촙)라 이 필터를 적용하면 후보가 전멸한다.
  if (reversal && s.filterNoise) list = list.filter((r) => !r.noise?.noisy);
  // 제외 종목
  if (s.excluded.length) list = list.filter((r) => !s.excluded.includes(r.symbol));
  // 단계 필터
  if (s.stageFilter !== "all") list = list.filter((r) => String(r.stage.stage) === String(s.stageFilter));

  // 정렬
  const sortFns = {
    score: pumpFade
      ? (a, b) => b.stage.stage - a.stage.stage || b.score - a.score
      : (a, b) => b.score - a.score,
    change: pumpFade ? (a, b) => b.change6h - a.change6h : (a, b) => a.change6h - b.change6h,
    volume: (a, b) => b.quoteVolume - a.quoteVolume,
  };
  list.sort(sortFns[s.sort] || sortFns.score);
  return list.map((r, i) => ({ ...r, rank: i + 1 }));
}

export function scoreControlModel(settings) {
  const early = settings?.scanMode === "early";
  const pumpFade = settings?.scanMode === "pump_fade";
  return {
    early,
    pumpFade,
    dedicated: early || pumpFade,
    strictnessEnabled: !pumpFade,
    manualMinScoreVisible: !early && !pumpFade,
    effectiveCut: minScoreFor(settings),
    cutLabel: pumpFade ? "급등 후 급락 실험 컷" : "조기 포착 품질 컷",
    cutHelp: pumpFade ? "초기 실험값 · 확률 아님" : "설정의 채점 강도에서 조정",
  };
}

export function modeFilterModel(settings) {
  const early = settings?.scanMode === "early";
  const reversal = !early && settings?.scanMode !== "pump_fade";
  return {
    early,
    minVolumeVisible: !early,
    earlyFixedVolumeVisible: early,
    reversalOnlyVisible: reversal,
  };
}

// 필터 바 + 설정 탭 초기화
export function initSettingsUI() {
  // 모드 전환은 점수 컨트롤과 단계 선택지를 즉시 다시 그려야 한다.
  // dashboard의 filters:apply 구독 여부에 의존하면 독립 초기화/테스트에서 UI가 뒤처진다.
  bindSelect("filter-scanmode", "scanMode", null, () => syncControls());
  bindSelect("filter-direction", "direction");
  bindSelect("filter-minscore", "minScore", Number);
  bindSelect("filter-dropbasis", "dropBasis");
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

function bindSelect(id, key, cast, after) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("change", () => {
    updateSettings({ [key]: cast ? cast(el.value) : el.value });
    if (after) after(el.value);
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
  syncStageOptions(s.scanMode);
  syncDirectionControl(s);
  syncModeFilters(s);
  setVal("filter-minscore", s.minScore);
  syncScoreControls(s);
  setVal("filter-dropbasis", s.dropBasis);
  setVal("filter-sort", s.sort);
  for (const { key, ids } of CHECK_BINDINGS) for (const id of ids) setChk(id, s[key]);
  for (const id of AUTOREFRESH_IDS) setChk(id, s.autoRefresh);
  for (const id of REALTIME_IDS) setChk(id, s.includeRealtimeCandle);
  setVal("filter-minvolume", s.minQuoteVolume);
  setVal("filter-strictness", s.strictnessLevel);
  setVal("set-ema200-ratio", s.near1hEma200AtrRatio);
  setVal("set-refresh-sec", Math.round(s.refreshIntervalMs / 1000));
}

function syncModeFilters(settings) {
  const model = modeFilterModel(settings);
  const visibility = [
    ["filter-minvolume-wrap", model.minVolumeVisible],
    ["filter-early-volume", model.earlyFixedVolumeVisible],
    ["filter-dropbasis-wrap", model.reversalOnlyVisible],
    ["filter-golden-cross-wrap", model.reversalOnlyVisible],
    ["filter-near-ema200-wrap", model.reversalOnlyVisible],
    ["set-golden-cross-wrap", model.reversalOnlyVisible],
    ["set-near-ema200-wrap", model.reversalOnlyVisible],
    ["set-ema200-ratio-wrap", model.reversalOnlyVisible],
  ];
  for (const [id, visible] of visibility) {
    const element = document.getElementById(id);
    if (element) element.hidden = !visible;
  }
  for (const id of ["filter-dropbasis", "filter-golden-cross", "filter-near-ema200", "set-golden-cross", "set-near-ema200", "set-ema200-ratio"]) {
    const element = document.getElementById(id);
    if (element) element.disabled = !model.reversalOnlyVisible;
  }
  const minVolume = document.getElementById("filter-minvolume");
  if (minVolume) minVolume.disabled = !model.minVolumeVisible;
}
function setVal(id, v) { const el = document.getElementById(id); if (el) el.value = String(v); }
function setChk(id, v) { const el = document.getElementById(id); if (el) el.checked = !!v; }

function syncScoreControls(settings) {
  const model = scoreControlModel(settings);
  const manualWrap = document.getElementById("filter-minscore-wrap");
  const manualSelect = document.getElementById("filter-minscore");
  const modeCut = document.getElementById("filter-mode-cut");
  const modeCutLabel = document.getElementById("filter-mode-cut-label");
  const modeCutValue = document.getElementById("filter-mode-cut-value");
  const modeCutHelp = document.getElementById("filter-mode-cut-help");
  const strictness = document.getElementById("filter-strictness");
  const strictnessNote = document.getElementById("filter-strictness-note");
  if (manualWrap) manualWrap.hidden = !model.manualMinScoreVisible;
  if (manualSelect) manualSelect.disabled = !model.manualMinScoreVisible;
  if (modeCut) modeCut.hidden = !model.dedicated;
  if (modeCutLabel) modeCutLabel.textContent = model.cutLabel;
  if (modeCutValue) modeCutValue.textContent = `${model.effectiveCut}+`;
  if (modeCutHelp) modeCutHelp.textContent = model.cutHelp;
  if (strictness) strictness.disabled = !model.strictnessEnabled;
  if (strictnessNote) strictnessNote.hidden = model.strictnessEnabled;
}

function syncDirectionControl(settings) {
  const direction = document.getElementById("filter-direction");
  const note = document.getElementById("filter-direction-note");
  const pumpFade = settings?.scanMode === "pump_fade";
  if (direction) {
    direction.disabled = pumpFade;
    direction.value = pumpFade ? "short" : String(settings.direction);
  }
  if (note) note.hidden = !pumpFade;
}

// 진행 단계 필터는 모드별 실제 단계만 노출한다. early의 기존 1~3단계 의미는 유지한다.
const STAGE_OPTIONS = {
  reversal: [
    ["all", "전체"],
    ["0", "0 근거 부족"],
    ["1", "1 관찰 초기"],
    ["2", "2 유동성 회수"],
    ["3", "3 구조전환"],
    ["4", "4 진입 구간"],
    ["5", "5 늦음·추격 금지"],
  ],
  early: [
    ["all", "전체"],
    ["1", "1 매집"],
    ["2", "2 임박"],
    ["3", "3 돌파"],
  ],
  pump_fade: [
    ["all", "전체"],
    ["1", "1 과열 감시"],
    ["2", "2 고점 거절"],
    ["3", "3 급락 확인"],
  ],
};
function syncStageOptions(mode) {
  const el = document.getElementById("filter-stage");
  if (!el) return;
  const options = STAGE_OPTIONS[mode] || STAGE_OPTIONS.reversal;
  const requested = String(state.settings.stageFilter);
  const selected = options.some(([value]) => value === requested) ? requested : "all";

  el.innerHTML = options
    .map(([value, label]) => `<option value="${value}">${label}</option>`)
    .join("");
  el.value = selected;

  // 다른 모드에서만 존재하는 단계를 들고 전환하면 빈 목록이 되므로 전체로 정상화한다.
  if (selected !== requested) {
    updateSettings({ stageFilter: selected });
  }
}

export function applyDarkMode() {
  document.documentElement.classList.toggle("dark", !!state.settings.darkMode);
}

export default { applyFilters, initSettingsUI, syncControls, applyDarkMode, modeFilterModel };
