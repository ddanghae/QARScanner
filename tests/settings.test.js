// tests/settings.test.js — 결과 목록 필터 계약 검증.

import { suite, test, assert, eq } from "./harness.js";
import { state } from "../js/state.js";
import { applyFilters, initSettingsUI, scoreControlModel } from "../js/ui/settings.js";

function result(symbol, stage) {
  return {
    symbol,
    score: 70,
    direction: "long",
    stage: { stage },
    newListing: false,
    goldenCrossRetest: null,
    near1hEma200: false,
    noise: { noisy: false },
  };
}

function withSettings(patch, fn) {
  const previous = state.settings;
  state.settings = {
    ...previous,
    scanMode: "reversal",
    direction: "both",
    minScore: 0,
    showFavoritesOnly: false,
    favorites: [],
    excluded: [],
    excludeChaseBan: true,
    excludeNewListing: false,
    goldenCrossOnly: false,
    near1hEma200Only: false,
    filterNoise: false,
    stageFilter: "all",
    sort: "score",
    ...patch,
  };
  try {
    fn();
  } finally {
    state.settings = previous;
  }
}

export function run() {
  suite("settings filters");

  test("5단계는 기본 목록에서 숨김", () => {
    withSettings({}, () => {
      const view = applyFilters([result("STAGE0", 0), result("STAGE4", 4), result("STAGE5", 5)]);
      eq(view.map((r) => r.symbol).join(","), "STAGE0,STAGE4", "5단계만 제외");
    });
  });

  test("5단계를 직접 선택하면 기본 숨김보다 조회 선택이 우선", () => {
    withSettings({ stageFilter: "5" }, () => {
      const view = applyFilters([result("STAGE4", 4), result("STAGE5", 5)]);
      eq(view.length, 1, "5단계 한 건");
      eq(view[0].symbol, "STAGE5", "5단계 조회");
    });
  });

  test("레거시 추격 금지 설정이 false여도 5단계는 기본 숨김", () => {
    withSettings({ excludeChaseBan: false }, () => {
      const view = applyFilters([result("STAGE4", 4), result("STAGE5", 5)]);
      eq(view.length, 1, "5단계 제외");
      eq(view[0].symbol, "STAGE4", "4단계만 조회");
    });
  });

  test("근거 부족 0단계를 직접 필터링 가능", () => {
    withSettings({ stageFilter: "0" }, () => {
      const view = applyFilters([result("STAGE0", 0), result("STAGE1", 1)]);
      eq(view.length, 1, "0단계 한 건");
      eq(view[0].symbol, "STAGE0", "0단계 조회");
    });
  });

  test("early 모드의 기존 방향·노이즈 예외와 1~3단계 필터 유지", () => {
    withSettings({ scanMode: "early", direction: "short", filterNoise: true, stageFilter: "2" }, () => {
      const early = { ...result("EARLY2", 2), direction: "long", noise: { noisy: true } };
      const view = applyFilters([early, result("EARLY1", 1)]);
      eq(view.length, 1, "early 2단계 한 건");
      eq(view[0].symbol, "EARLY2", "early 예외 유지");
    });
  });

  test("pump_fade는 reversal 전용 방향·노이즈·골든크로스 필터를 적용하지 않음", () => {
    withSettings({
      scanMode: "pump_fade", direction: "long", filterNoise: true,
      goldenCrossOnly: true, near1hEma200Only: true, stageFilter: "3",
    }, () => {
      const pump = {
        ...result("PUMP3", 3), direction: "short", score: 70,
        noise: { noisy: true }, goldenCrossRetest: { detected: false }, near1hEma200: false,
      };
      const view = applyFilters([pump, { ...pump, symbol: "PUMP2", stage: { stage: 2 } }]);
      eq(view.length, 1, "pump 3단계 한 건");
      eq(view[0].symbol, "PUMP3", "전용 파이프라인 결과 유지");
    });
  });

  test("pump_fade 기본 점수 정렬은 단계 3을 우선", () => {
    withSettings({ scanMode: "pump_fade", sort: "score" }, () => {
      const stage2 = { ...result("HIGH_SCORE_STAGE2", 2), direction: "short", score: 90 };
      const stage3 = { ...result("STAGE3", 3), direction: "short", score: 50 };
      const view = applyFilters([stage2, stage3]);
      eq(view[0].symbol, "STAGE3", "단계 우선");
    });
  });

  test("early 모드는 죽은 최소 점수 선택기 대신 실제 품질 컷을 표시", () => {
    const early = scoreControlModel({ scanMode: "early", strictnessLevel: 3, minScore: 85 });
    eq(early.manualMinScoreVisible, false, "수동 최소 점수 숨김");
    eq(early.effectiveCut, 40, "기본 early 품질 컷");
    const reversal = scoreControlModel({ scanMode: "reversal", strictnessLevel: 1, minScore: 85 });
    eq(reversal.manualMinScoreVisible, true, "reversal 수동 최소 점수 표시");
    eq(reversal.effectiveCut, 85, "reversal 최소 점수 적용");
    const pumpFade = scoreControlModel({ scanMode: "pump_fade", minScore: 85 });
    eq(pumpFade.manualMinScoreVisible, false, "pump_fade 수동 최소 점수 숨김");
    eq(pumpFade.effectiveCut, 45, "pump_fade 실험 컷");
    eq(pumpFade.cutLabel, "급등 후 급락 실험 컷", "실험 컷 라벨");
    eq(pumpFade.strictnessEnabled, false, "pump_fade 강도 선택 비활성");
  });

  test("scan mode change 이벤트가 점수 UI와 단계 필터를 즉시 동기화", () => {
    const previousDocument = globalThis.document;
    const previousLocalStorage = globalThis.localStorage;
    const previousSettings = state.settings;
    const fake = (value = "") => {
      const listeners = new Map();
      return {
        value, checked: false, hidden: false, disabled: false, textContent: "", innerHTML: "",
        addEventListener(type, fn) { listeners.set(type, fn); },
        fire(type) { listeners.get(type)?.(); },
      };
    };
    const mode = fake("reversal");
    const manualWrap = fake();
    const manualSelect = fake("55");
    const modeCut = fake();
    const modeCutLabel = fake();
    const modeCutValue = fake();
    const modeCutHelp = fake();
    const strictness = fake("3");
    const strictnessNote = fake();
    const stageSelect = fake("5");
    const elements = new Map([
      ["filter-scanmode", mode],
      ["filter-minscore-wrap", manualWrap],
      ["filter-minscore", manualSelect],
      ["filter-mode-cut", modeCut],
      ["filter-mode-cut-label", modeCutLabel],
      ["filter-mode-cut-value", modeCutValue],
      ["filter-mode-cut-help", modeCutHelp],
      ["filter-strictness", strictness],
      ["filter-strictness-note", strictnessNote],
      ["filter-stage", stageSelect],
    ]);

    state.settings = { ...previousSettings, scanMode: "reversal", stageFilter: "5", minScore: 55, strictnessLevel: 3 };
    globalThis.document = {
      getElementById(id) { return elements.get(id) || null; },
      documentElement: { classList: { toggle() {} } },
    };
    globalThis.localStorage = { setItem() {} };

    try {
      initSettingsUI();
      mode.value = "early";
      mode.fire("change");
      eq(state.settings.scanMode, "early", "상태 모드 전환");
      eq(state.settings.stageFilter, "all", "reversal 전용 5단계 필터 정상화");
      eq(manualWrap.hidden, true, "수동 최소 점수 숨김");
      eq(manualSelect.disabled, true, "숨은 입력 비활성화");
      eq(modeCut.hidden, false, "early 품질 컷 표시");
      eq(modeCutValue.textContent, "40+", "실제 early 컷 표시");
      assert(!stageSelect.innerHTML.includes('value="5"'), "early 단계 목록에서 5 제외");
    } finally {
      state.settings = previousSettings;
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
      if (previousLocalStorage === undefined) delete globalThis.localStorage;
      else globalThis.localStorage = previousLocalStorage;
    }
  });

  test("pump_fade 전환은 저장된 reversal 방향을 보존하고 UI만 SHORT로 잠금", () => {
    const previousDocument = globalThis.document;
    const previousLocalStorage = globalThis.localStorage;
    const previousSettings = state.settings;
    const fake = (value = "") => {
      const listeners = new Map();
      return {
        value, checked: false, hidden: false, disabled: false, textContent: "", innerHTML: "",
        addEventListener(type, fn) { listeners.set(type, fn); },
        fire(type) { listeners.get(type)?.(); },
      };
    };
    const mode = fake("reversal");
    const direction = fake("long");
    const directionNote = fake();
    const manualWrap = fake();
    const manualSelect = fake("55");
    const modeCut = fake();
    const modeCutLabel = fake();
    const modeCutValue = fake();
    const modeCutHelp = fake();
    const strictness = fake("3");
    const strictnessNote = fake();
    const stageSelect = fake("5");
    const elements = new Map([
      ["filter-scanmode", mode],
      ["filter-direction", direction],
      ["filter-direction-note", directionNote],
      ["filter-minscore-wrap", manualWrap],
      ["filter-minscore", manualSelect],
      ["filter-mode-cut", modeCut],
      ["filter-mode-cut-label", modeCutLabel],
      ["filter-mode-cut-value", modeCutValue],
      ["filter-mode-cut-help", modeCutHelp],
      ["filter-strictness", strictness],
      ["filter-strictness-note", strictnessNote],
      ["filter-stage", stageSelect],
    ]);

    state.settings = { ...previousSettings, scanMode: "reversal", direction: "long", stageFilter: "5", minScore: 55 };
    globalThis.document = {
      getElementById(id) { return elements.get(id) || null; },
      documentElement: { classList: { toggle() {} } },
    };
    globalThis.localStorage = { setItem() {} };

    try {
      initSettingsUI();
      mode.value = "pump_fade";
      mode.fire("change");
      eq(state.settings.scanMode, "pump_fade", "상태 모드 전환");
      eq(state.settings.direction, "long", "기존 reversal 방향 보존");
      eq(direction.value, "short", "표시 방향 SHORT");
      eq(direction.disabled, true, "방향 선택 비활성화");
      eq(directionNote.hidden, false, "SHORT 전용 설명 표시");
      eq(state.settings.stageFilter, "all", "5단계 필터 정상화");
      assert(!stageSelect.innerHTML.includes('value="4"') && !stageSelect.innerHTML.includes('value="5"'), "pump 단계 1~3만");
      eq(modeCutValue.textContent, "45+", "pump 실험 컷 표시");
      eq(modeCutLabel.textContent, "급등 후 급락 실험 컷", "pump 컷 라벨");
      eq(strictness.disabled, true, "고정 컷 모드에서 강도 선택 잠금");
      eq(strictnessNote.hidden, false, "고정 컷 설명 표시");
    } finally {
      state.settings = previousSettings;
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
      if (previousLocalStorage === undefined) delete globalThis.localStorage;
      else globalThis.localStorage = previousLocalStorage;
    }
  });
}
