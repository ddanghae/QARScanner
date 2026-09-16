import { currentCrtStatus } from "./crt-tbs.js";

// Preserve identity until a deadline changes the display state.
export function expireResult(r, now = Date.now()) {
  const crtTbs = currentCrtStatus(r.crtTbs, now);
  let forecast = r.forecast;
  if (forecast?.available && (!Number.isFinite(forecast.expiresAt) || now >= forecast.expiresAt)) {
    forecast = { ...forecast, available: false, reason: "새 4시간 봉이 마감되었습니다. 재스캔 후 확률을 확인하세요." };
  }
  return crtTbs === r.crtTbs && forecast === r.forecast ? r : { ...r, crtTbs, forecast };
}
