// tests/settings.test.js — 결과 목록 필터 계약 검증.

import { suite, test, eq } from "./harness.js";
import { state } from "../js/state.js";
import { applyFilters } from "../js/ui/settings.js";

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
}
