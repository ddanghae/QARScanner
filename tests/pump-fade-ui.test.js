// tests/pump-fade-ui.test.js — pump_fade 모드 필터와 UI 계약 회귀.

import { suite, test, assert, eq } from "./harness.js";
import { CONFIG, minScoreFor } from "../js/config.js";
import { state } from "../js/state.js";
import { applyFilters, modeControlModel } from "../js/ui/settings.js";

function result(symbol, stage, score, change6h = 12) {
  return {
    symbol,
    scanMode: "pump_fade",
    direction: "short",
    stage: { stage, label: `${stage} 테스트`, badge: "blue" },
    score,
    change6h,
    quoteVolume: 50_000_000,
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
    favorites: [],
    excluded: [],
    showFavoritesOnly: false,
    excludeNewListing: false,
    excludeChaseBan: true,
    stageFilter: "all",
    sort: "score",
    ...patch,
  };
  try { fn(); } finally { state.settings = previous; }
}

export function run() {
  suite("pump fade ui");

  test("모드별 점수 컷은 서로 섞이지 않는다", () => {
    eq(minScoreFor({ scanMode: "reversal", minScore: 30 }), 30, "reversal 사용자 컷");
    eq(minScoreFor({ scanMode: "early", minScore: 30 }), CONFIG.earlyMinScore, "early 검증 컷");
    eq(minScoreFor({ scanMode: "pump_fade", minScore: 99 }), CONFIG.pumpFade.minScore, "pump 실험 컷");
  });

  test("pump_fade UI는 SHORT와 고정 컷을 사용하고 금액 기능을 잠근다", () => {
    const model = modeControlModel({ scanMode: "pump_fade", direction: "long", minScore: 99 });
    eq(model.direction, "short", "SHORT 표시");
    eq(model.effectiveCut, 45, "고정 컷");
    eq(model.strictnessEnabled, false, "강도 잠금");
    eq(model.moneyControlsEnabled, false, "금액·레버리지 잠금");
  });

  test("pump_fade에는 reversal 전용 방향·노이즈·골든크로스 필터를 적용하지 않는다", () => {
    withSettings({
      scanMode: "pump_fade",
      direction: "long",
      filterNoise: true,
      goldenCrossOnly: true,
      near1hEma200Only: true,
      stageFilter: "3",
    }, () => {
      const view = applyFilters([result("STAGE3", 3, 60), result("STAGE2", 2, 90)]);
      eq(view.length, 1, "선택한 단계 한 건");
      eq(view[0].symbol, "STAGE3", "SHORT 전용 결과 유지");
    });
  });

  test("기본 정렬은 점수보다 급락 확인 단계를 우선하고 상위 5개만 남긴다", () => {
    withSettings({ scanMode: "pump_fade", direction: "long" }, () => {
      const rows = [
        result("HIGH_STAGE2", 2, 95),
        result("STAGE3_A", 3, 55),
        result("STAGE3_B", 3, 70),
        result("STAGE1_A", 1, 100),
        result("STAGE1_B", 1, 90),
        result("STAGE1_C", 1, 80),
      ];
      const view = applyFilters(rows);
      eq(view.length, CONFIG.pumpFade.keepMax, "상위 5개");
      eq(view[0].symbol, "STAGE3_B", "3단계 내 점수 우선");
      eq(view[1].symbol, "STAGE3_A", "3단계가 2단계보다 우선");
      assert(!view.some((r) => r.symbol === "STAGE1_C"), "낮은 우선순위 제외");
    });
  });
}
