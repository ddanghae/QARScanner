// ui/settings.js — 필터 영역(§15) + 설정 관리(§17).
// localStorage 저장은 state.js 가 담당. 여기선 UI 바인딩 + 필터 적용 로직.

import { state, updateSettings, resetSettings, emit } from "../state.js";
import { CONFIG, minScoreFor, strictnessPreset } from "../config.js";
import { modesForScan, resultMode } from "../scan-modes.js";
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
  const selectedMode = s.scanMode || "reversal";
  return modesForScan(selectedMode).flatMap((mode) => applyModeFilters(results, mode, s, selectedMode === "all"));
}

function applyModeFilters(results, mode, s, unified) {
  const reversal = mode === "reversal";
  const early = mode === "early";
  const pumpFade = mode === "pump_fade";
  let list = results.filter((r) => resultMode(r) === mode);

  // early/pump_fade는 각각 LONG/SHORT 전용이므로 저장된 reversal 방향을 적용하지 않는다.
  if (reversal && s.direction !== "both") list = list.filter((r) => r.direction === s.direction);
  list = list.filter((r) => r.score >= minScoreFor({ ...s, scanMode: mode }));
  // 관심 종목만
  if (s.showFavoritesOnly) list = list.filter((r) => s.favorites.includes(r.symbol));
  // 추격 금지(5단계) 제외
  if (reversal && s.excludeChaseBan) list = list.filter((r) => r.stage.stage !== 5);
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
  if (!unified && s.stageFilter !== "all") list = list.filter((r) => String(r.stage.stage) === String(s.stageFilter));

  const sortFns = {
    score: pumpFade
      ? (a, b) => b.stage.stage - a.stage.stage || b.score - a.score
      : (a, b) => b.score - a.score,
    change: pumpFade ? (a, b) => b.change6h - a.change6h : (a, b) => a.change6h - b.change6h,
    volume: (a, b) => b.quoteVolume - a.quoteVolume,
  };
  // 두 모드 모두 "확실한 소수" 를 노리므로 상위 N 만 남긴다 — 반드시 점수 기준으로,
  // 사용자 정렬보다 먼저. 정렬 뒤에 자르면 "거래대금" 정렬이 순서가 아니라 보이는
  // 집합 자체를 바꿔(점수 최하위 5개만 남음) 정렬이 필터로 변한다.
  list.sort(sortFns.score);
  const keepMax = pumpFade ? CONFIG.pumpFade.keepMax : early ? CONFIG.earlyKeepTop : CONFIG.reversalKeepTop;
  list = list.slice(0, keepMax);

  // 정렬
  // 통합 화면에서는 서로 의미가 다른 점수를 섞지 않고 각 스캐너의 기본 순위를 유지한다.
  list.sort(unified ? sortFns.score : (sortFns[s.sort] || sortFns.score));
  return list.map((r, i) => ({ ...r, rank: i + 1 }));
}

// 모드 UI가 실제 필터 계약과 같은지 테스트 가능한 순수 모델.
export function modeControlModel(settings) {
  const mode = settings?.scanMode || "reversal";
  const all = mode === "all";
  const early = mode === "early";
  const pumpFade = mode === "pump_fade";
  return {
    mode,
    all,
    early,
    pumpFade,
    dedicated: early || pumpFade,
    direction: pumpFade ? "short" : early ? "long" : String(settings?.direction || "long"),
    effectiveCut: minScoreFor(settings),
    strictnessEnabled: all || (!early && !pumpFade),
    moneyControlsEnabled: !pumpFade,
  };
}

// 필터 바 + 설정 탭 초기화
export function initSettingsUI() {
  bindSelect("filter-scanmode", "scanMode");
  bindSelect("filter-direction", "direction");
  bindSelect("filter-minscore", "minScore", Number);
  bindSelect("filter-stage", "stageFilter");
  bindSelect("filter-sort", "sort");

  // 체크박스 — twin id 지원 (한 설정이 여러 위치에 있을 수 있음)
  for (const { key, ids } of CHECK_BINDINGS) bindCheckGroup(ids, key, true);

  // 자동 갱신 — 시작/중지 신호 (필터 재적용 아님)
  bindCheckGroup(AUTOREFRESH_IDS, "autoRefresh", false, (checked) => emit("autorefresh:toggle", checked));
  // 실시간 캔들 — 다음 스캔에 반영
  bindCheckGroup(REALTIME_IDS, "includeRealtimeCandle", false);

  // 최소 거래대금은 후처리 필터가 아니라 1차 유동성 필터라 재스캔해야 반영된다.
  const minVol = document.getElementById("filter-minvolume");
  if (minVol) minVol.addEventListener("change", () => {
    updateSettings({ minQuoteVolume: Number(minVol.value) });
    toast("다음 스캔부터 적용됩니다.", "info");
  });

  // 시드머니 — 표시 전용이라 재스캔 없이 즉시 다시 그린다.
  const seed = document.getElementById("filter-seed");
  if (seed) seed.addEventListener("input", () => {
    updateSettings({ seedMoney: Math.max(0, Number(seed.value) || 0) });
    emit("filters:apply");
  });

  // 레버리지 — 선택지는 config 가 갖는다. 표시 전용이라 재스캔 없이 즉시 다시 그린다.
  const lev = document.getElementById("filter-leverage");
  if (lev) {
    lev.innerHTML = CONFIG.leverageOptions
      .map((x) => `<option value="${x}">${x}배${x === 1 ? " (현물)" : ""}</option>`).join("");
    lev.addEventListener("change", () => {
      updateSettings({ leverage: Number(lev.value) || 1 });
      emit("filters:apply");
    });
  }

  // 파는 방식 — 계획은 그대로 두고 표시만 갈린다. 재스캔 없이 즉시 다시 그린다.
  const partial = document.getElementById("filter-partial");
  if (partial) partial.addEventListener("change", () => {
    updateSettings({ partialTake: partial.value === "1" });
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
  setVal("filter-direction", s.direction);
  setVal("filter-minscore", s.minScore);
  setVal("filter-stage", s.stageFilter);
  setVal("filter-sort", s.sort);
  for (const { key, ids } of CHECK_BINDINGS) for (const id of ids) setChk(id, s[key]);
  for (const id of AUTOREFRESH_IDS) setChk(id, s.autoRefresh);
  for (const id of REALTIME_IDS) setChk(id, s.includeRealtimeCandle);
  setVal("filter-minvolume", s.minQuoteVolume);
  setVal("filter-seed", s.seedMoney);
  setVal("filter-leverage", s.leverage);
  setVal("filter-partial", s.partialTake ? "1" : "0");
  setVal("filter-strictness", s.strictnessLevel);
  setVal("set-ema200-ratio", s.near1hEma200AtrRatio);
  setVal("set-refresh-sec", Math.round(s.refreshIntervalMs / 1000));
  syncModeControls(s);
}
function setVal(id, v) { const el = document.getElementById(id); if (el) el.value = String(v); }
function setChk(id, v) { const el = document.getElementById(id); if (el) el.checked = !!v; }

// 스캔 모드에 따라 필터 컨트롤을 맞춘다 — 단계, 방향, 정렬, 점수/강도, 금액 표시.
const STAGE_OPTIONS = {
  all: [["all", "전체 모드 단계"]],
  reversal: [["all", "전체"], ["1", "1 매집"], ["2", "2 유동성 회수"], ["3", "3 구조전환"], ["4", "4 진입 구간"], ["5", "5 추격 금지"]],
  early: [["all", "전체"], ["1", "1 관찰"], ["2", "2 조건 2개 충족"], ["3", "3 돌파"]],
  pump_fade: [["all", "전체"], ["1", "1 과열 감시"], ["2", "2 고점 거절"], ["3", "3 급락 확인"]],
};
function syncModeControls(settings) {
  const model = modeControlModel(settings);
  const stageEl = document.getElementById("filter-stage");
  if (stageEl) {
    const options = STAGE_OPTIONS[model.mode] || STAGE_OPTIONS.reversal;
    stageEl.innerHTML = options.map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
    const wanted = options.some(([value]) => value === String(settings.stageFilter))
      ? String(settings.stageFilter) : "all";
    stageEl.value = wanted;
    if (wanted !== String(settings.stageFilter)) updateSettings({ stageFilter: "all" });
  }

  const direction = document.getElementById("filter-direction");
  if (direction) {
    direction.disabled = model.dedicated;
    direction.value = model.direction;
    direction.title = model.pumpFade ? "급등 후 급락은 SHORT 전용입니다."
      : model.early ? "조기 포착은 LONG 전용입니다." : "";
  }
  const directionNote = document.getElementById("filter-direction-note");
  if (directionNote) {
    directionNote.hidden = !model.dedicated && !model.all;
    directionNote.textContent = model.all ? "급락 반등 결과에만 적용"
      : model.pumpFade ? "SHORT 전용" : "LONG 전용";
  }

  const sortEl = document.getElementById("filter-sort");
  const changeOpt = sortEl && [...sortEl.options].find((o) => o.value === "change");
  if (changeOpt) {
    changeOpt.disabled = model.early || model.all;
    changeOpt.textContent = model.all ? "모드별 기본 순위" : model.pumpFade ? "급등률" : "하락률";
    if (model.early && sortEl.value === "change") {
      sortEl.value = "score";
      updateSettings({ sort: "score" });
    }
  }
  if (sortEl) {
    sortEl.disabled = model.all;
    sortEl.title = model.all ? "전체 스캔은 각 모드의 기본 순위를 유지합니다." : "";
  }

  const msEl = document.getElementById("filter-minscore");
  if (msEl) {
    msEl.disabled = model.dedicated;
    msEl.title = model.dedicated ? `${model.mode} 전용 하한 ${model.effectiveCut}점을 씁니다.` : "";
  }
  const msLabel = msEl?.closest("label");
  if (msLabel) {
    msLabel.childNodes[0].nodeValue = model.all ? "급락 반등 최소 점수"
      : model.dedicated
      ? `최소 점수 (${model.effectiveCut} 고정)` : "최소 점수";
  }

  const strictness = document.getElementById("filter-strictness");
  if (strictness) {
    strictness.disabled = !model.strictnessEnabled;
    strictness.title = model.strictnessEnabled ? "" : `${model.mode}는 검증된 고정 컷을 사용합니다.`;
  }
  const strictnessNote = document.getElementById("filter-strictness-note");
  if (strictnessNote) {
    strictnessNote.hidden = model.strictnessEnabled;
    strictnessNote.textContent = model.pumpFade
      ? "급등 후 급락은 실험 컷 45점을 고정 사용합니다."
      : "조기 포착은 검증 컷 40점을 고정 사용합니다.";
  }

  for (const id of ["filter-seed", "filter-leverage", "filter-partial"]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.disabled = !model.moneyControlsEnabled;
    el.title = model.moneyControlsEnabled ? "" : "pump_fade는 실험 신호만 제공하며 금액·레버리지 계산을 사용하지 않습니다.";
  }

  for (const id of [
    "filter-exclude-chase", "filter-golden-cross", "filter-near-ema200",
    "set-exclude-chase", "set-golden-cross", "set-near-ema200", "set-filter-noise",
  ]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.disabled = model.dedicated;
    el.title = model.dedicated ? "급락 반등 전용 조건입니다."
      : model.all ? "전체 스캔에서는 급락 반등 결과에만 적용됩니다." : "";
  }
}

export function applyDarkMode() {
  const dark = !!state.settings.darkMode;
  document.documentElement.classList.toggle("dark", dark);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0b0d13" : "#ffffff");
}

export default { applyFilters, initSettingsUI, syncControls, applyDarkMode };
