// tests/signal-freshness.test.js — 4시간 기준 조기포착 신호의 재스캔 기한.

import { suite, test, assert, eq } from "./harness.js";
import { expireResult } from "../js/core/signal-freshness.js";
import { buildDecisionGate } from "../js/core/decision-gate.js";

function earlyRow(expiresAt) {
  return {
    scanMode: "early",
    direction: "long",
    signalExpiresAt: expiresAt,
    plan: { valid: true, entry: 100, invalidation: 95, tp2: 120, rrText: "1:4.00" },
    stage: { stage: 3, label: "3 임박", badge: "purple" },
    grade: { key: "watch", label: "관심 후보" },
    marketRegime: { available: false, reason: "테스트" },
    forecast: { available: false, reason: "테스트" },
    earlyAxes: { risk: { score: 80, reasons: [] } },
  };
}

export function run() {
  suite("signal freshness");

  test("다음 4시간 마감 전에는 같은 객체와 유효 계획을 유지한다", () => {
    const row = earlyRow(1_000);
    eq(expireResult(row, 999), row, "아직 유효하면 객체를 바꾸지 않음");
    eq(buildDecisionGate(row, 999).blockers, 0, "만료 전에는 가격 계획을 차단하지 않음");
    eq(buildDecisionGate(row, 999).status, "wait", "성과 검증 전까지 관찰 전용");
  });

  test("다음 4시간 마감 뒤에는 가격 계획과 기록을 보류한다", () => {
    const row = earlyRow(1_000);
    const expired = expireResult(row, 1_000);
    eq(expired.signalExpired, true, "신호 만료 상태");
    eq(expired.plan.valid, false, "기존 손절·목표를 거래 계획으로 쓰지 않음");
    eq(expired.plan.rrText, "계획 만료", "화면 표기");
    assert(expired.plan.warning.includes("재스캔"), "재스캔 안내");
    eq(buildDecisionGate(row, 1_000).status, "risk", "타이머 전 직접 검토해도 차단");
    eq(expireResult(expired, 1_001), expired, "만료 처리를 반복하지 않음");
  });
}
