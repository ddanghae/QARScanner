// tests/unified-scan.test.js — 3개 모드 통합 실행/표시 계약 회귀.

import { suite, test, assert, eq } from "./harness.js";
import { modesForScan, resultKey, resultMode, resultModeCounts } from "../js/scan-modes.js";
import { sortAndRankResults } from "../js/scanner/scan-controller.js";
import { applyFilters, modeControlModel } from "../js/ui/settings.js";
import { state } from "../js/state.js";

function row(mode, symbol, score, stage = 2, direction = mode === "pump_fade" ? "short" : "long") {
  return {
    scanMode: mode,
    symbol,
    score,
    direction,
    stage: { stage, label: `${stage} 테스트`, badge: "blue" },
    change6h: mode === "pump_fade" ? 20 : -10,
    quoteVolume: 100_000_000,
    newListing: false,
    noise: { noisy: true },
    goldenCrossRetest: { detected: false, hasRejection: false },
    near1hEma200: false,
  };
}

function withSettings(patch, fn) {
  const previous = state.settings;
  state.settings = {
    ...previous,
    scanMode: "all",
    direction: "long",
    minScore: 30,
    favorites: [],
    excluded: [],
    showFavoritesOnly: false,
    excludeNewListing: false,
    excludeChaseBan: false,
    goldenCrossOnly: false,
    near1hEma200Only: false,
    filterNoise: false,
    stageFilter: "all",
    sort: "volume",
    ...patch,
  };
  try { fn(); } finally { state.settings = previous; }
}

export function run() {
  suite("unified scan");

  test("전체 스캔은 세 모드를 고정 순서로 정확히 한 번 포함한다", () => {
    const modes = modesForScan("all");
    eq(modes.join(","), "reversal,early,pump_fade", "실행 순서");
    eq(new Set(modes).size, 3, "중복 실행 없음");
  });

  test("기존 결과의 모드 기본값은 reversal이고 키는 모드+심볼이다", () => {
    eq(resultMode({ symbol: "SAMEUSDT" }), "reversal", "레거시 결과 호환");
    assert(resultKey(row("early", "SAMEUSDT", 50)) !== resultKey(row("pump_fade", "SAMEUSDT", 60)), "중복 심볼 키 분리");
  });

  test("결과 탭 숫자는 전체와 세 스캐너를 따로 센다", () => {
    const counts = resultModeCounts([
      row("reversal", "R1", 50),
      row("early", "E1", 50),
      row("early", "E2", 45),
      row("pump_fade", "P1", 60),
    ]);
    eq(counts.all, 4, "전체 숫자");
    eq(counts.reversal, 1, "반등 숫자");
    eq(counts.early, 2, "조기 숫자");
    eq(counts.pump_fade, 1, "급락 숫자");
  });

  test("통합 결과는 모드별 순서와 모드 내부 순위를 유지한다", () => {
    const ranked = sortAndRankResults([
      row("pump_fade", "P2", 90, 2),
      row("early", "E1", 50, 1),
      row("reversal", "R1", 40, 2),
      row("pump_fade", "P3", 50, 3),
      row("reversal", "R2", 60, 2),
    ], "all");
    eq(ranked.map((r) => r.symbol).join(","), "R2,R1,E1,P3,P2", "모드 그룹과 pump 단계 우선");
    eq(ranked.map((r) => r.rank).join(","), "1,2,1,1,2", "모드별 순위 재시작");
  });

  test("전체 필터는 모드별 점수 컷과 reversal 전용 조건을 분리한다", () => {
    withSettings({ filterNoise: true }, () => {
      const view = applyFilters([
        row("reversal", "SAMEUSDT", 55, 2, "long"),
        row("reversal", "NOISY", 55, 2, "long"),
        row("early", "SAMEUSDT", 50),
        row("early", "EARLY_LOW", 39),
        row("pump_fade", "SAMEUSDT", 60, 3),
        row("pump_fade", "PUMP_LOW", 44, 3),
      ].map((r) => r.symbol === "NOISY" || r.symbol === "SAMEUSDT" && r.scanMode === "reversal"
        ? r : { ...r, noise: { noisy: false } }));
      // reversal SAMEUSDT는 noisy라 제외되지만 전용 필터가 early/pump 결과를 죽이면 안 된다.
      eq(view.map((r) => resultKey(r)).join(","), "early:SAMEUSDT,pump_fade:SAMEUSDT", "모드별 필터 분리");
    });
  });

  test("전체 모드 UI는 reversal 조정은 허용하고 공통 정렬은 잠근다", () => {
    const model = modeControlModel({ scanMode: "all", direction: "both", minScore: 40 });
    eq(model.all, true, "전체 모드");
    eq(model.direction, "both", "reversal 방향 유지");
    eq(model.strictnessEnabled, true, "reversal 강도 사용 가능");
    eq(model.moneyControlsEnabled, true, "일반 모드 금액 표시 유지");
  });
}
