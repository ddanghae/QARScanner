// Closed-candle CRT + Turtle Body Soup overlay. No score/probability mutation.
import { CONFIG } from "../config.js";
import { atr, last } from "./indicators.js";

const M5 = 300000;
const H4 = 48 * M5;
const labels = {
  unavailable: "산출 보류", range: "범위 관찰", sweep: "이탈 · 복귀 대기",
  reclaim: "복귀 · 전환 대기", confirmed: "전환 확인", expired: "신호 만료",
  invalidated: "무효화", ambiguous: "양쪽 이탈 · 제외", late: "목표 진행 · 추격 제외",
  risk: "손익비 부족 · 제외",
};

function validCandle(c, interval) {
  return c && [c.open, c.high, c.low, c.close, c.openTime, c.closeTime].every(Number.isFinite)
    && c.low > 0 && c.high > c.low && c.high >= Math.max(c.open, c.close)
    && c.low <= Math.min(c.open, c.close) && c.closeTime === c.openTime + interval - 1;
}

export function evaluateCrtTbs(raw4h, raw5m, { now = Date.now(), config = CONFIG } = {}) {
  const p = config.crtTbs;
  let context = { experimental: true, available: false, confirmed: false, direction: null, plan: null };
  const result = (status, reason, extra = {}) => ({ ...context, status, label: labels[status], reason, ...extra });
  if (!Number.isFinite(now) || !Array.isArray(raw4h) || !Array.isArray(raw5m)) {
    return result("unavailable", "캔들 데이터가 없습니다.");
  }
  // Do not slice off the last bar: cached responses may end in an already closed bar.
  const h4 = raw4h.filter((c) => c.closeTime < now);
  const m5 = raw5m.filter((c) => c.closeTime < now);
  const anchor = h4.at(-1);
  if (!validCandle(anchor, H4) || m5.length < 15 || m5.some((c) => !validCandle(c, M5))) {
    return result("unavailable", "마감 캔들 또는 ATR 계산 자료가 부족합니다.");
  }
  if (h4.some((c, i) => i && c.openTime <= h4[i - 1].openTime)
      || m5.some((c, i) => i && c.openTime !== m5[i - 1].openTime + M5)) {
    return result("unavailable", "캔들 순서 또는 5분봉 연속성이 맞지 않습니다.");
  }
  if (now - anchor.closeTime > H4 || now - m5.at(-1).closeTime > M5) {
    return result("unavailable", "시세가 오래되었습니다. 재스캔해 주세요.");
  }
  const range = { high: anchor.high, low: anchor.low, mid: (anchor.high + anchor.low) / 2,
    openTime: anchor.openTime, closeTime: anchor.closeTime, expiresAt: anchor.closeTime + H4 + 1 };
  context = { ...context, available: true, range, asOf: m5.at(-1).closeTime };
  const bars = m5.filter((c) => c.openTime > anchor.closeTime);
  if (!bars.length) return result("range", "새 4시간 범위의 5분봉 마감을 기다립니다.");
  if (bars[0].openTime !== anchor.closeTime + 1) return result("unavailable", "기준 봉 이후 5분봉이 누락되었습니다.", { available: false });

  let highSwept = false, lowSwept = false, sweepIndex = -1, reclaimIndex = -1;
  let extreme = null, trigger = null, confirmationIndex = -1, stop = null;
  for (let i = 0; i < bars.length; i++) {
    const c = bars[i];
    highSwept ||= c.high > range.high;
    lowSwept ||= c.low < range.low;
    if (highSwept && lowSwept) return result("ambiguous", "기준 범위 양쪽이 모두 이탈되어 방향을 정하지 않습니다.");
    if (sweepIndex < 0) {
      if (c.close < range.low) context.direction = "long";
      else if (c.close > range.high) context.direction = "short";
      else continue; // Wick-only sweeps are not Turtle BODY Soup.
      sweepIndex = i;
      context.sweepTime = c.closeTime;
      extreme = context.direction === "long" ? c.low : c.high;
      continue;
    }
    const long = context.direction === "long";
    if (confirmationIndex >= 0) {
      if (long ? c.low <= stop : c.high >= stop) return result("invalidated", "확인 이후 손절 경계를 건드렸습니다.");
      if (long ? c.high >= range.mid : c.low <= range.mid) return result("late", "확인 이후 첫 목표에 도달했습니다.");
      continue;
    }
    if (reclaimIndex < 0) {
      extreme = long ? Math.min(extreme, c.low) : Math.max(extreme, c.high);
      if (i - sweepIndex > p.reclaimBars) return result("expired", "이탈 후 30분 내 범위 복귀가 없었습니다.");
      if (c.close > range.low && c.close < range.high) {
        reclaimIndex = i;
        trigger = long ? c.high : c.low;
        context.reclaimTime = c.closeTime;
      }
      continue;
    }
    if (long ? c.low <= extreme || c.close <= range.low : c.high >= extreme || c.close >= range.high) {
      return result("invalidated", "복귀 후 이탈 경계 또는 스윕 극단을 다시 잃었습니다.");
    }
    if (i - reclaimIndex > p.confirmationBars) return result("expired", "복귀 후 30분 내 전환 확인이 없었습니다.");
    if (!(long ? c.close > trigger : c.close < trigger)) continue;
    // A target already touched before confirmation is no longer a fresh setup.
    if (bars.slice(sweepIndex, i + 1).some((b) => long ? b.high >= range.mid : b.low <= range.mid)) {
      return result("late", "전환 확인 전에 범위 중앙을 이미 건드렸습니다.");
    }
    confirmationIndex = i;
    context.confirmationTime = c.closeTime;
    const atrValue = last(atr(m5.filter((b) => b.closeTime <= c.closeTime), 14));
    if (!(atrValue > 0)) return result("unavailable", "5분봉 ATR 계산 불가", { available: false });
    stop = long
      ? Math.min(extreme - atrValue * p.stopAtrRatio, c.close * (1 - p.minStopPct / 100))
      : Math.max(extreme + atrValue * p.stopAtrRatio, c.close * (1 + p.minStopPct / 100));
  }
  if (sweepIndex < 0) return result("range", "5분봉 종가의 범위 이탈을 기다립니다. 꼬리만 넘는 경우는 제외합니다.");
  if (reclaimIndex < 0) return result("sweep", "이탈한 5분봉이 나왔습니다. 범위 안 마감을 기다립니다.");
  if (confirmationIndex < 0) return result("reclaim", "범위 복귀를 확인했습니다. 복귀 봉의 반대편 돌파 마감을 기다립니다.");
  if (now - context.confirmationTime > p.freshBars * M5) return result("expired", "전환 확인 후 15분이 지나 신호가 만료되었습니다.");
  const long = context.direction === "long";
  const entry = bars.at(-1).close;
  const risk = Math.abs(entry - stop);
  const tp2 = long ? range.high : range.low;
  const reward = Math.abs(tp2 - entry);
  const cost = entry * config.tradeCostRoundTripPct / 100;
  const stopPct = risk / entry * 100;
  const netRR = (reward - cost) / (risk + cost);
  if (!(stop > 0) || stopPct > p.maxStopPct || stopPct < p.minStopPct || netRR < p.minNetRR) {
    return result("risk", "현재 기준가의 손절 거리 또는 비용 반영 손익비가 기준에 미달합니다.");
  }
  return result("confirmed", "범위 이탈·복귀·5분 전환을 마감 봉으로 확인했습니다.", {
    confirmed: true,
    plan: { direction: context.direction, entry, invalidation: stop, tp1: range.mid, tp2,
      riskReward: reward / risk, netRR, lossPct: stopPct + config.tradeCostRoundTripPct,
      stopPct, costPct: config.tradeCostRoundTripPct },
  });
}

export function crtMatchesCandidate(r) {
  return r?.crtTbs?.confirmed === true && r.crtTbs.direction === r.direction;
}
