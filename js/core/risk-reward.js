// core/risk-reward.js — 예상 진입/손절/목표가 + 손익비 계산.
// 자동 주문 아님. 기술적 참고 구간만 계산.

import { CONFIG } from "../config.js";

// 손절이 진입에 붙으면 손익비가 폭주한다(실측 1:30.1, 리스크 폭 0.16%).
// 저변동성 종목에서 0.5×ATR(15m) 이 지나치게 좁아 생기는 현상이고,
// 스프레드·슬리피지를 감안하면 그런 손절은 실제로 성립하지 않는다. 최소 폭을 강제한다.
function stopBuffer(atr, price) {
  const rr = CONFIG.riskReward;
  return Math.max((atr || 0) * rr.stopAtrRatio, price * (rr.minStopPct / 100));
}

// 진입 = 현재가 기준 가장 가까운 반대편 레벨. 예전엔 FVG·OB·VWAP·EMA 를 단순 평균했는데
// 서로 무관한 레벨이 섞여 실제 지지가 아닌 허공 가격이 나왔고, 롱인데 진입가가 현재가보다
// 위인 경우가 50건 중 20건이었다(최대 +4.49%). 실행 불가한 계획이라 방향에 맞는 쪽만 쓴다.
function nearestEntry(zones, price, side) {
  const valid = zones.filter((z) => z != null && isFinite(z));
  const usable = side === "short" ? valid.filter((z) => z >= price) : valid.filter((z) => z <= price);
  if (!usable.length) return price;
  // 롱이면 현재가 바로 아래(최대), 숏이면 현재가 바로 위(최소)
  return side === "short" ? Math.min(...usable) : Math.max(...usable);
}

// long 기준. entry zone, SL(무효화), TP1/2/3, 예상 손익비.
export function computeLongPlan(ctx) {
  const { price, fvg15, ob15, vwap1h, ema20_15, internalHigh, majorHigh1h, buySideTarget, swingLow, atr } = ctx;

  // 진입 후보 = 현재가 아래에서 가장 가까운 지지(FVG/OB/VWAP/EMA). 없으면 현재가.
  const entry = nearestEntry([fvg15?.mid, ob15?.mid, vwap1h, ema20_15], price, "long");

  // 손절 = 스윙 저점 또는 구조 무효화 가격 아래 (버퍼).
  // 신저점/신고가 갱신 중엔 마지막 확정 스윙이 진입 위에 있을 수 있어, 반드시 진입 아래로 clamp.
  const buffer = stopBuffer(atr, price);
  const rawStop = swingLow != null ? swingLow : price - (atr || price * 0.01) * 2;
  const stop = Math.min(rawStop, entry) - buffer;

  // 목표 — 손익비와 기준을 맞추기 위해 폴백도 price 가 아니라 entry 기준으로 잡는다.
  const tp1 = internalHigh != null ? internalHigh : entry + (entry - stop) * 1.5;
  const tp2 = majorHigh1h != null ? majorHigh1h : entry + (entry - stop) * 2.5;
  const tp3 = buySideTarget != null ? buySideTarget : entry + (entry - stop) * 3.5;

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
  // 진입 = 현재가 위에서 가장 가까운 저항. 없으면 현재가.
  const entry = nearestEntry([fvg15?.mid, ob15?.mid, vwap1h, ema20_15], price, "short");

  // 손절은 반드시 진입 위로 clamp (신고가 갱신 중 마지막 스윙고점이 진입 아래일 수 있음).
  const buffer = stopBuffer(atr, price);
  const rawStop = swingHigh != null ? swingHigh : price + (atr || price * 0.01) * 2;
  const stop = Math.max(rawStop, entry) + buffer;
  const tp1 = internalLow != null ? internalLow : entry - (stop - entry) * 1.5;
  const tp2 = majorLow1h != null ? majorLow1h : entry - (stop - entry) * 2.5;
  const tp3 = sellSideTarget != null ? sellSideTarget : entry - (stop - entry) * 3.5;

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
