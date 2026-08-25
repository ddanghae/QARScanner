// core/market-structure.js — 시장구조 엔진.
// Swing pivot → HH/HL/LH/LL → BOS/CHoCH/MSS.
// 마감 캔들만 사용. 미래 데이터 참조 없음. UI와 분리된 순수 함수.

// 좌우 length 봉 기준 pivot high/low 탐지.
// pivot 은 오른쪽 length개 봉이 생긴 뒤에야 알 수 있다.
// confirmedIdx/confirmedTime을 따로 보존해 과거 시점에 신호를 소급하지 않는다.
export function findPivots(candles, length) {
  const pivots = [];
  for (let i = length; i < candles.length - length; i++) {
    const c = candles[i];
    let isHigh = true, isLow = true;
    for (let j = i - length; j <= i + length; j++) {
      if (j === i) continue;
      if (candles[j].high >= c.high) isHigh = false;
      if (candles[j].low <= c.low) isLow = false;
    }
    const confirmedIdx = i + length;
    const confirmedCandle = candles[confirmedIdx];
    const base = {
      idx: i,
      time: c.openTime,
      confirmedIdx,
      confirmedTime: confirmedCandle?.closeTime ?? confirmedCandle?.openTime ?? null,
    };
    if (isHigh) pivots.push({ ...base, price: c.high, kind: "high" });
    if (isLow) pivots.push({ ...base, price: c.low, kind: "low" });
  }
  return pivots.sort((a, b) => a.idx - b.idx);
}

// pivot 시퀀스를 HH/HL/LH/LL 로 라벨링.
export function labelSwings(pivots) {
  let lastHigh = null, lastLow = null;
  return pivots.map((p) => {
    let label = null;
    if (p.kind === "high") {
      if (lastHigh != null) label = p.price > lastHigh ? "HH" : "LH";
      lastHigh = p.price;
    } else {
      if (lastLow != null) label = p.price > lastLow ? "HL" : "LL";
      lastLow = p.price;
    }
    return { ...p, label };
  });
}

// 마지막 확정 스윙 하이/로우
export function lastSwing(pivots, kind) {
  for (let i = pivots.length - 1; i >= 0; i--) if (pivots[i].kind === kind) return pivots[i];
  return null;
}

// BOS / CHoCH 판별.
// 추세 방향(bias)을 스윙 순서로 추정한 뒤, 종가가 직전 스윙을 돌파하면 이벤트 생성.
// events: candleTime/breakTime = 실제 돌파를 인식한 봉, signalTime = 사용 가능한 시점.
export function detectStructureEvents(candles, pivots, timeframe, includeRealtime) {
  const events = [];
  const swings = labelSwings(pivots);

  // 호출자가 이미 마감봉/실시간봉 경계를 정한다. 여기서 마지막 봉을 또 빼면
  // 정상 마감 신호가 한 봉 늦어지므로 전달받은 배열 전체를 사용한다.
  const closeIdxMax = candles.length - 1;
  if (closeIdxMax < 0) return events;

  // 확인 시점별 pivot 목록. pivot 위치가 아니라 확인봉부터 참조 레벨로 쓴다.
  const confirmedAt = new Map();
  for (const sw of swings) {
    const idx = Number.isInteger(sw.confirmedIdx) ? sw.confirmedIdx : sw.idx;
    if (idx > closeIdxMax) continue;
    if (!confirmedAt.has(idx)) confirmedAt.set(idx, []);
    confirmedAt.get(idx).push(sw);
  }

  let bias = null; // "bull" | "bear"
  let refHigh = null, refLow = null; // 직전 확정 스윙 하이/로우
  let confirmedSwingCount = 0;

  for (let i = 0; i <= closeIdxMax; i++) {
    for (const sw of confirmedAt.get(i) || []) {
      confirmedSwingCount++;
      if (sw.kind === "high") refHigh = sw;
      else refLow = sw;
    }
    // 미래에 세 번째 피봇이 생겼다는 이유로, 피봇이 둘뿐이던 과거 시점에
    // 구조 신호를 뒤늦게 소급하지 않는다.
    if (confirmedSwingCount < 3) continue;
    const close = candles[i]?.close;
    if (!Number.isFinite(close)) continue;
    const confirmed = !(includeRealtime && i === closeIdxMax);
    if (refHigh && close > refHigh.price) {
      const type = bias === "bear" ? "bullish_choch" : "bullish_bos";
      events.push(mkEvent(type, timeframe, refHigh, candles[i], confirmed));
      bias = "bull";
      refHigh = null;
    }
    if (refLow && close < refLow.price) {
      const type = bias === "bull" ? "bearish_choch" : "bearish_bos";
      events.push(mkEvent(type, timeframe, refLow, candles[i], confirmed));
      bias = "bear";
      refLow = null;
    }
  }
  return dedupeEvents(events);
}

function mkEvent(type, timeframe, pivot, candle, confirmed) {
  // 종가 돌파는 봉이 닫힌 뒤에만 확정되므로 신호 시각도 closeTime 이어야 한다.
  const signalTime = candle?.closeTime ?? candle?.openTime ?? null;
  return {
    type,
    timeframe,
    price: pivot.price,
    candleTime: signalTime,
    breakTime: signalTime,
    signalTime,
    pivotTime: pivot.time,
    pivotConfirmedTime: pivot.confirmedTime ?? null,
    confirmed,
  };
}

function dedupeEvents(events) {
  const seen = new Set();
  const out = [];
  for (const e of events) {
    const key = `${e.type}:${e.candleTime}:${e.price}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

// MSS = 추세 전환 첫 신호 (CHoCH 계열)
export function isMss(event) {
  return event.type === "bullish_choch" || event.type === "bearish_choch";
}

// 최근 구조 요약: 마지막 이벤트 + 첫 HH/HL 여부
export function structureSummary(candles, pivots, timeframe, includeRealtime) {
  const events = detectStructureEvents(candles, pivots, timeframe, includeRealtime);
  const swings = labelSwings(pivots);
  const lastEvent = events[events.length - 1] || null;
  const firstHigherHigh = swings.some((s) => s.label === "HH");
  const firstHigherLow = swings.some((s) => s.label === "HL");
  const lastLabel = swings.length ? swings[swings.length - 1].label : null;
  return {
    timeframe,
    events,
    lastEvent,
    firstHigherHigh,
    firstHigherLow,
    lastLabel,
    swings,
    bullishShift: !!lastEvent && lastEvent.type.startsWith("bullish"),
    choch: !!lastEvent && isMss(lastEvent),
  };
}

export default {
  findPivots, labelSwings, lastSwing, detectStructureEvents,
  isMss, structureSummary,
};
