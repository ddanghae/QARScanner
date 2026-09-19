import { currentCrtStatus } from "./crt-tbs.js";

// Preserve identity until a deadline changes the display state.
export function expireResult(r, now = Date.now()) {
  const crtTbs = currentCrtStatus(r.crtTbs, now);
  let forecast = r.forecast;
  if (forecast?.available && (!Number.isFinite(forecast.expiresAt) || now >= forecast.expiresAt)) {
    forecast = { ...forecast, available: false, reason: "새 4시간 봉이 마감되었습니다. 재스캔 후 확률을 확인하세요." };
  }
  let sweepRetest = r.sweepRetest;
  let stage = r.stage;
  let grade = r.grade;
  let plan = r.plan;
  let signalExpired = Boolean(r.signalExpired);
  // 조기포착의 점수·ATR는 마지막 4시간 마감봉에서 계산한다. 다음 4시간 봉이
  // 마감되면 새 정보가 빠진 옛 가격 계획을 그대로 쓰지 않고 재스캔을 요구한다.
  const signalExpiresAt = Number(r?.signalExpiresAt);
  if (r?.scanMode === "early" && Number.isFinite(signalExpiresAt) && now >= signalExpiresAt && !signalExpired) {
    signalExpired = true;
    plan = plan ? {
      ...plan,
      valid: false,
      rrText: "계획 만료",
      warning: "4시간 신호 기준이 만료되었습니다. 새 마감봉 뒤 재스캔해 주세요.",
    } : plan;
  }
  if (sweepRetest?.confirmed && (!Number.isFinite(sweepRetest.expiresAt) || now >= sweepRetest.expiresAt)) {
    sweepRetest = { ...sweepRetest, confirmed: false, status: "expired", label: "확인 신호 만료",
      reason: "최초 5분봉 확인 후 15분이 지나 새 스캔이 필요합니다." };
    stage = { ...stage, stage: 4, label: "확인 신호 만료", badge: "yellow" };
    grade = { key: "watch", label: "확인 신호 만료" };
  }
  return crtTbs === r.crtTbs && forecast === r.forecast && sweepRetest === r.sweepRetest
    && plan === r.plan && signalExpired === Boolean(r.signalExpired)
    ? r : { ...r, crtTbs, forecast, sweepRetest, stage, grade, plan, signalExpired,
      score: sweepRetest ? stage.stage * 20 : r.score };
}
