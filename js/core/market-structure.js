// core/market-structure.js — 시장구조 엔진.
// Swing pivot → HH/HL/LH/LL → BOS/CHoCH/MSS.
// 마감 캔들만 사용. 미래 데이터 참조 없음. UI와 분리된 순수 함수.

// 좌우 length 봉 기준 pivot high/low 탐지.
// 반환: [{ idx, price, kind: "high"|"low", time }]
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
    if (isHigh) pivots.push({ idx: i, price: c.high, kind: "high", time: c.openTime });
    if (isLow) pivots.push({ idx: i, price: c.low, kind: "low", time: c.openTime });
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
// events: { type, timeframe, price, candleTime, confirmed }
export function detectStructureEvents(candles, pivots, timeframe, includeRealtime) {
  const events = [];
  const swings = labelSwings(pivots);
  if (swings.length < 3) return events;

  // 종가 배열 (진행 캔들 포함 여부에 따라 마지막 캔들 취급)
  const closeIdxMax = includeRealtime ? candles.length - 1 : candles.length - 2;
  if (closeIdxMax < 0) return events;

  // 순차적으로 bias 추적하며 돌파 감지
  let bias = null; // "bull" | "bear"
  let refHigh = null, refLow = null; // 직전 확정 스윙 하이/로우

  for (let s = 0; s < swings.length; s++) {
    const sw = swings[s];
    if (sw.kind === "high") refHigh = sw;
    else refLow = sw;

    // 다음 스윙까지의 캔들 구간에서 종가 돌파 확인
    const from = sw.idx + 1;
    const to = s + 1 < swings.length ? swings[s + 1].idx : closeIdxMax;
    for (let i = from; i <= to && i <= closeIdxMax; i++) {
      const close = candles[i].close;
      // 상방 돌파
      if (refHigh && close > refHigh.price) {
        const type = bias === "bear" ? "bullish_choch" : "bullish_bos";
        events.push(mkEvent(type, timeframe, refHigh.price, candles[i].openTime, true));
        bias = "bull";
        refHigh = null; // 소비
      }
      // 하방 돌파
      if (refLow && close < refLow.price) {
        const type = bias === "bull" ? "bearish_choch" : "bearish_bos";
        events.push(mkEvent(type, timeframe, refLow.price, candles[i].openTime, true));
        bias = "bear";
        refLow = null;
      }
    }
  }
  return dedupeEvents(events);
}

function mkEvent(type, timeframe, price, candleTime, confirmed) {
  return { type, timeframe, price, candleTime, confirmed };
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
