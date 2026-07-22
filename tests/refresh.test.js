// tests/refresh.test.js — 자동 갱신 지연 계산 검증 (순수 함수).

import { suite, test, eq } from "./harness.js";
import { CONFIG } from "../js/config.js";
import { nextRefreshDelay } from "../js/scanner/scan-controller.js";

export function run() {
  suite("refresh");
  const min = CONFIG.refresh.minIntervalMs;
  const mult = CONFIG.refresh.backgroundMultiplier;

  test("포그라운드 = 설정 주기", () => {
    eq(nextRefreshDelay(90_000, false), 90_000, "그대로");
  });

  test("백그라운드 = 주기 × 배수", () => {
    eq(nextRefreshDelay(90_000, true), 90_000 * mult, "배수 적용");
  });

  test("하한 클램프 (과호출 방지)", () => {
    eq(nextRefreshDelay(1_000, false), min, "min 으로 클램프");
    eq(nextRefreshDelay(1_000, true), min * mult, "클램프 후 배수");
  });
}
