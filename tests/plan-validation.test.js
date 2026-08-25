// tests/plan-validation.test.js — 잘못된 가격 계획을 화면·기록 전에 차단한다.

import { suite, test, assert, eq } from "./harness.js";
import { validatePlan, finalizePlan } from "../js/core/plan-validation.js";

function plan(direction) {
  return direction === "long"
    ? { direction, stop: 90, invalidation: 90, entry: 100, tp1: 110, tp2: 120, tp3: 130, riskReward: 2 }
    : { direction, stop: 110, invalidation: 110, entry: 100, tp1: 90, tp2: 80, tp3: 70, riskReward: 2 };
}

export function run() {
  suite("plan validation");

  test("LONG과 SHORT의 정상 가격 순서를 허용한다", () => {
    assert(validatePlan(plan("long")).valid, "LONG 허용");
    assert(validatePlan(plan("short")).valid, "SHORT 허용");
  });

  test("방향이 뒤집힌 목표가는 차단한다", () => {
    const wrong = { ...plan("short"), tp2: 95 };
    eq(validatePlan(wrong).valid, false, "SHORT 목표 순서 거부");
  });

  test("실제 손절가가 방향과 다르거나 무효화 가격과 다르면 차단한다", () => {
    eq(validatePlan({ ...plan("long"), stop: 110, invalidation: 110 }).valid, false, "LONG 손절 방향 거부");
    eq(validatePlan({ ...plan("short"), stop: 90, invalidation: 90 }).valid, false, "SHORT 손절 방향 거부");
    eq(validatePlan({ ...plan("long"), stop: 91 }).valid, false, "손절/무효화 불일치 거부");
  });

  test("0 이하 가격과 손익비는 차단한다", () => {
    eq(validatePlan({ ...plan("long"), tp3: 0 }).valid, false, "0 가격 거부");
    eq(validatePlan({ ...plan("long"), riskReward: 0 }).valid, false, "0 손익비 거부");
  });

  test("기존 계산이 무효라고 표시한 계획은 다시 허용하지 않는다", () => {
    const checked = finalizePlan({ ...plan("long"), valid: false, warning: "자료 부족" });
    eq(checked.valid, false, "기존 무효 유지");
    eq(checked.validationError, "자료 부족", "이유 유지");
  });
}
