// tests/decision-gate.test.js — 기존 점수를 건드리지 않는 후보 검토 체크리스트.

import { suite, test, assert, eq } from "./harness.js";
import { buildDecisionGate } from "../js/core/decision-gate.js";

const base = (overrides = {}) => ({
  symbol: "TESTUSDT",
  scanMode: "reversal",
  direction: "long",
  score: 77,
  plan: { valid: true, entry: 100, invalidation: 90, tp2: 120 },
  stage: { stage: 3, label: "구조 전환" },
  marketRegime: { available: true, label: "상승 국면" },
  regimeFit: { key: "aligned", label: "시장 흐름 우호" },
  forecast: { available: true, lead: "up", up: 55, down: 25, neutral: 20, confidence: 30 },
  ...overrides,
});

export function run() {
  suite("decision gate");

  test("조기포착은 우호적 전망과 높은 단계에도 관찰 전용으로 유지", () => {
    const result = base({ scanMode: "early", stage: { stage: 4, label: "4 돌파 관찰" } });
    const gate = buildDecisionGate(result, 1000);
    eq(gate.status, "wait");
    eq(gate.label, "관찰 전용");
    eq(gate.checks.find(x => x.key === "early-evidence").level, "warn");
    eq(result.score, 77);
    const blocked = buildDecisionGate({ ...result, plan: { valid: false } }, 1000);
    eq(blocked.status, "risk", "연구 경고가 무효 계획 차단을 덮으면 안 됨");
  });

  test("정합 후보는 점수 변경 없이 검토 후보로 설명", () => {
    const result = base();
    const gate = buildDecisionGate(result, 1000);
    eq(gate.status, "review");
    eq(gate.label, "검토 후보");
    eq(result.score, 77, "체크리스트가 기존 점수를 바꾸면 안 됨");
    assert(gate.passes >= 4, "계획·단계·국면·전망이 통과해야 함");
  });

  test("무효 계획과 반등 5단계는 리스크 높음으로 차단", () => {
    const gate = buildDecisionGate(base({
      plan: { valid: false, entry: 100, invalidation: 110, tp2: 120 },
      stage: { stage: 5, label: "추격 금지" },
    }), 1000);
    eq(gate.status, "risk");
    eq(gate.blockers, 2);
  });

  test("시장 역행·전망 충돌·상관 후보는 확인 대기", () => {
    const gate = buildDecisionGate(base({
      regimeFit: { key: "counter", label: "시장 흐름 역행" },
      forecast: { available: true, lead: "down", up: 20, down: 60, neutral: 20, confidence: 40 },
      correlatedWith: [{ symbol: "PAIRUSDT", corr: 0.9 }],
    }), 1000);
    eq(gate.status, "wait");
    eq(gate.warnings, 3);
  });

  test("SHORT 계획은 위 손절·아래 목표를 유효하게 판정", () => {
    const gate = buildDecisionGate(base({
      direction: "short",
      plan: { valid: true, entry: 100, invalidation: 110, tp2: 80 },
      marketRegime: { available: true, label: "하락 국면" },
      forecast: { available: true, lead: "down", up: 20, down: 60, neutral: 20, confidence: 40 },
    }), 1000);
    eq(gate.checks.find((x) => x.key === "plan").level, "pass");
    eq(gate.checks.find((x) => x.key === "forecast").level, "pass");
  });
}
