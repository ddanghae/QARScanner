// core/risk-reward.js — 예상 진입/손절/목표가 + 손익비 계산.
// 자동 주문 아님. 기술적 참고 구간만 계산.

// long 기준. entry zone, SL(무효화), TP1/2/3, 예상 손익비.
export function computeLongPlan(ctx) {
  const { price, fvg15, ob15, vwap1h, ema20_15, internalHigh, majorHigh1h, buySideTarget, swingLow, atr } = ctx;

  // 진입 후보 = FVG/OB/VWAP/EMA 중 현재가에 가장 가까운 지지 구간의 상단~하단 평균
  const zones = [];
  if (fvg15) zones.push(fvg15.mid);
  if (ob15) zones.push(ob15.mid);
  if (vwap1h) zones.push(vwap1h);
  if (ema20_15) zones.push(ema20_15);
  const entry = zones.length
    ? zones.reduce((a, b) => a + b, 0) / zones.length
    : price;

  // 손절 = 스윙 저점 또는 구조 무효화 가격 아래 (ATR 버퍼).
  // 신저점/신고가 갱신 중엔 마지막 확정 스윙이 진입 위에 있을 수 있어, 반드시 진입 아래로 clamp.
  const buffer = (atr || 0) * 0.5;
  const rawStop = swingLow != null ? swingLow : price - (atr || price * 0.01) * 2;
  const stop = Math.min(rawStop, entry) - buffer;

  // 목표
  const tp1 = internalHigh != null ? internalHigh : price + (price - stop) * 1.5;
  const tp2 = majorHigh1h != null ? majorHigh1h : price + (price - stop) * 2.5;
  const tp3 = buySideTarget != null ? buySideTarget : price + (price - stop) * 3.5;

  const risk = Math.max(entry - stop, 1e-9);
  const reward = Math.max(tp2 - entry, 0); // 대표 손익비는 TP2 기준
  const rr = reward / risk;

  return {
    direction: "long",
    entry, stop,
    tp1, tp2, tp3,
    invalidation: stop,
    riskReward: rr,
    rrText: `1:${rr.toFixed(2)}`,
    valid: rr > 0 && entry > stop,
  };
}

// short 기준 (반대)
export function computeShortPlan(ctx) {
  const { price, fvg15, ob15, vwap1h, ema20_15, internalLow, majorLow1h, sellSideTarget, swingHigh, atr } = ctx;
  const zones = [];
  if (fvg15) zones.push(fvg15.mid);
  if (ob15) zones.push(ob15.mid);
  if (vwap1h) zones.push(vwap1h);
  if (ema20_15) zones.push(ema20_15);
  const entry = zones.length ? zones.reduce((a, b) => a + b, 0) / zones.length : price;

  // 손절은 반드시 진입 위로 clamp (신고가 갱신 중 마지막 스윙고점이 진입 아래일 수 있음).
  const buffer = (atr || 0) * 0.5;
  const rawStop = swingHigh != null ? swingHigh : price + (atr || price * 0.01) * 2;
  const stop = Math.max(rawStop, entry) + buffer;
  const tp1 = internalLow != null ? internalLow : price - (stop - price) * 1.5;
  const tp2 = majorLow1h != null ? majorLow1h : price - (stop - price) * 2.5;
  const tp3 = sellSideTarget != null ? sellSideTarget : price - (stop - price) * 3.5;

  const risk = Math.max(stop - entry, 1e-9);
  const reward = Math.max(entry - tp2, 0);
  const rr = reward / risk;
  return {
    direction: "short",
    entry, stop, tp1, tp2, tp3,
    invalidation: stop,
    riskReward: rr,
    rrText: `1:${rr.toFixed(2)}`,
    valid: rr > 0 && stop > entry,
  };
}

export default { computeLongPlan, computeShortPlan };
