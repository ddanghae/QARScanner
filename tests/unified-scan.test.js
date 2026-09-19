// tests/unified-scan.test.js — 조기포착 단일 실행/표시 계약 회귀.

import { suite, test, assert, eq } from "./harness.js";
import { modesForScan, resultKey, resultMode } from "../js/scan-modes.js";
import { sortAndRankResults } from "../js/scanner/scan-controller.js";
import { applyFilters, modeControlModel } from "../js/ui/settings.js";
import { state } from "../js/state.js";

function row(symbol, score, stage = 2) {
  return {
    scanMode: "early", symbol, score, direction: "long",
    stage: { stage, label: `${stage} 테스트`, badge: "blue" },
    change6h: 0, quoteVolume: 100_000_000, newListing: false,
    noise: { noisy: false },
  };
}

function withSettings(patch, fn) {
  const previous = state.settings;
  state.settings = {
    ...previous, scanMode: "early", minScore: 40, favorites: [], excluded: [],
    showFavoritesOnly: false, excludeNewListing: false, excludeChaseBan: false,
    stageFilter: "all", sort: "score", ...patch,
  };
  try { fn(); } finally { state.settings = previous; }
}

export function run() {
  suite("single early scan");

  test("제거된 모드 저장값도 조기포착 하나만 실행한다", () => {
    for (const old of ["all", "reversal", "pump_fade", "sweep_retest", undefined]) {
      eq(modesForScan(old).join(","), "early", `${old} 마이그레이션`);
    }
  });

  test("모드 없는 옛 결과도 조기포착으로 읽는다", () => {
    eq(resultMode({ symbol: "SAMEUSDT" }), "early");
    eq(resultKey({ symbol: "SAMEUSDT" }), "early:SAMEUSDT");
  });

  test("결과는 잠재력 점수 순으로 한 번만 순위를 매긴다", () => {
    const ranked = sortAndRankResults([row("B", 50), row("A", 70), row("C", 60)], "all");
    eq(ranked.map((r) => r.symbol).join(","), "A,C,B");
    eq(ranked.map((r) => r.rank).join(","), "1,2,3");
  });

  test("추격 금지 후보를 선택적으로 숨긴다", () => {
    withSettings({ excludeChaseBan: true }, () => {
      const view = applyFilters([row("SAFE", 70, 3), row("CHASE", 80, 5)]);
      eq(view.map((r) => r.symbol).join(","), "SAFE");
    });
  });

  test("단일 모드 UI는 LONG과 검증 컷을 고정한다", () => {
    const model = modeControlModel({ scanMode: "reversal", direction: "short", minScore: 99 });
    eq(model.mode, "early");
    eq(model.direction, "long");
    eq(model.dedicated, true);
    eq(model.effectiveCut, 40);
    assert(model.moneyControlsEnabled, "후보 계획의 손실 크기 표시는 유지");
  });
}
