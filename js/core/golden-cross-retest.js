// core/golden-cross-retest.js — 골든크로스 리테스트 패턴 감지.
// 시나리오: 200선 아래 횡보 → 임펄스 돌파(50·200 위로) → 되돌림으로 50·200선 부근 리테스트
// → 리테스트 구간에서 살짝 위로 찔렀다가 훅 꺾이는 거부 캔들 → 그동안 종가는 200선을 잃지 않고 버팀
// (50선이 200선을 상향 돌파하는 골든크로스와 같은 구간에서 벌어짐).
// 입력은 마감 캔들 + 같은 길이의 EMA50/EMA200 배열(core/indicators.ema 결과). 순수 함수.

export function detectGoldenCrossRetest(candles, ema50, ema200, atrVal, cfg) {
  const n = candles.length;
  const gc = cfg.goldenCrossRetest;
  if (n < 10 || !atrVal) return { detected: false, reason: "데이터 부족" };

  // 1) 최근 crossLookback 안에서 가장 최근 골든크로스(50이 200을 상향 돌파) 지점
  let crossIdx = -1;
  for (let i = n - 1; i >= Math.max(1, n - gc.crossLookback); i--) {
    if (ema50[i] == null || ema200[i] == null || ema50[i - 1] == null || ema200[i - 1] == null) continue;
    if (ema50[i - 1] <= ema200[i - 1] && ema50[i] > ema200[i]) { crossIdx = i; break; }
  }
  if (crossIdx < 0) return { detected: false, reason: "최근 골든크로스 없음" };

  // 2) 크로스 직전 돌파 임펄스 확인 — 200선 대비 margin% 이상 위로 뚫은 적이 있어야 함
  const impulseStart = Math.max(0, crossIdx - gc.impulseLookback);
  let impulseFound = false;
  for (let i = impulseStart; i <= crossIdx; i++) {
    if (ema200[i] == null) continue;
    if (candles[i].close > ema200[i] * (1 + gc.impulseMarginPct / 100)) { impulseFound = true; break; }
  }
  if (!impulseFound) return { detected: false, reason: "돌파 임펄스 없음" };

  // 3) 크로스 이후 지금까지 종가가 200선 아래로 이탈한 적 없는지 ("버팀")
  let heldAbove200 = true;
  for (let i = crossIdx; i < n; i++) {
    if (ema200[i] == null) continue;
    if (candles[i].close < ema200[i]) { heldAbove200 = false; break; }
  }
  if (!heldAbove200) return { detected: false, reason: "200선 종가 이탈" };

  // 4) 리테스트 존 — 크로스 이후 50/200선 부근(±atr*zoneAtrRatio)까지 저가가 처음 되돌아온 지점
  //    (거부 캔들은 이 지점 이후에 나오므로 "처음" 지점이어야 뒤쪽을 탐색할 여지가 생김)
  let retestIdx = -1;
  for (let i = crossIdx; i < n; i++) {
    if (ema50[i] == null || ema200[i] == null) continue;
    const zoneLo = Math.min(ema50[i], ema200[i]) - atrVal * gc.zoneAtrRatio;
    const zoneHi = Math.max(ema50[i], ema200[i]) + atrVal * gc.zoneAtrRatio;
    if (candles[i].low <= zoneHi && candles[i].low >= zoneLo) { retestIdx = i; break; }
  }
  if (retestIdx < 0) return { detected: false, reason: "리테스트 없음" };

  // 5) 거부 캔들 — 위꼬리 비중 높고 종가가 몸통 하단에서 마감, 그런데도 종가는 200선 위
  let rejectIdx = -1;
  for (let i = retestIdx; i < n; i++) {
    const c = candles[i];
    const range = c.high - c.low || 1e-9;
    const upperWickRatio = (c.high - Math.max(c.open, c.close)) / range;
    const closePos = (c.close - c.low) / range;
    if (upperWickRatio >= gc.rejectionWickRatio && closePos <= gc.rejectionClosePos &&
        ema200[i] != null && c.close > ema200[i]) {
      rejectIdx = i;
    }
  }

  return {
    detected: true,
    hasRejection: rejectIdx >= 0,
    crossTime: candles[crossIdx].openTime,
    retestTime: candles[retestIdx].openTime,
    rejectTime: rejectIdx >= 0 ? candles[rejectIdx].openTime : null,
    zoneLow: Math.min(ema50[n - 1], ema200[n - 1]),
    zoneHigh: Math.max(ema50[n - 1], ema200[n - 1]),
  };
}

export default { detectGoldenCrossRetest };
