// core/plan-validation.js — 표시·기록 전에 가격 계획의 기본 안전조건을 확인한다.
// 자동 주문 기능은 없지만, 음수 가격이나 방향이 뒤집힌 계획도 참고값으로 보여주면 안 된다.

const PRICE_KEYS = ["entry", "stop", "invalidation", "tp1", "tp2", "tp3"];

export function validatePlan(plan, direction = plan?.direction) {
  if (!plan || !["long", "short"].includes(direction)) {
    return { valid: false, reason: "방향을 확인할 수 없습니다." };
  }
  for (const key of PRICE_KEYS) {
    const value = Number(plan[key]);
    if (!Number.isFinite(value) || value <= 0) {
      return { valid: false, reason: `${key} 가격이 올바르지 않습니다.` };
    }
  }

  const { entry, stop, invalidation, tp1, tp2, tp3 } = plan;
  if (Number(stop) !== Number(invalidation)) {
    return { valid: false, reason: "손절가와 무효화 가격이 서로 다릅니다." };
  }
  const ordered = direction === "long"
    ? stop < entry && entry < tp1 && tp1 < tp2 && tp2 < tp3
    : stop > entry && entry > tp1 && tp1 > tp2 && tp2 > tp3;
  if (!ordered) {
    return { valid: false, reason: `${direction === "long" ? "LONG" : "SHORT"} 가격 순서가 맞지 않습니다.` };
  }
  if (!(Number(plan.riskReward) > 0)) {
    return { valid: false, reason: "손익비를 계산할 수 없습니다." };
  }
  return { valid: true, reason: null };
}

export function finalizePlan(plan) {
  const checked = validatePlan(plan, plan?.direction);
  const valid = plan?.valid !== false && checked.valid;
  return {
    ...plan,
    valid,
    validationError: valid ? null : (plan?.warning || checked.reason || "계획이 올바르지 않습니다."),
  };
}

export default { validatePlan, finalizePlan };
