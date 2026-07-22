// core/order-block.js — 오더블록 탐지.
// 복잡한 상용 지표 방식 아님. 명확한 자체 규칙:
//  - Bullish OB = Bullish BOS/CHoCH 직전 마지막 하락 캔들
//  - Bearish OB = Bearish BOS/CHoCH 직전 마지막 상승 캔들
//  - 거래량이 평균 이상인 구간 우선
//  - 구조가 무효화(가격이 OB를 종가로 관통)되면 OB도 무효 처리

import { avgVolume } from "./volume-analysis.js";

// events: market-structure.detectStructureEvents 결과
export function detectOrderBlocks(candles, events, avgVolPeriod = 20) {
  const av = avgVolume(candles, avgVolPeriod);
  const blocks = [];
  for (const ev of events) {
    // 이벤트 캔들 인덱스 찾기
    const evIdx = candles.findIndex((c) => c.openTime === ev.candleTime);
    if (evIdx < 1) continue;
    const bullish = ev.type.startsWith("bullish");
    // 직전으로 거슬러 올라가 반대색 마지막 캔들
    let obIdx = -1;
    for (let i = evIdx - 1; i >= Math.max(0, evIdx - 12); i--) {
      const c = candles[i];
      const isDown = c.close < c.open;
      const isUp = c.close > c.open;
      if (bullish && isDown) { obIdx = i; break; }
      if (!bullish && isUp) { obIdx = i; break; }
    }
    if (obIdx < 0) continue;
    const ob = candles[obIdx];
    const top = Math.max(ob.open, ob.close, ob.high);
    const bottom = Math.min(ob.open, ob.close, ob.low);
    const strongVol = av[obIdx] ? ob.volume >= av[obIdx] : false;

    // 무효화 판정: 이후 종가가 OB를 완전히 관통했는지
    let invalidated = false;
    for (let i = obIdx + 1; i < candles.length; i++) {
      if (bullish && candles[i].close < bottom) { invalidated = true; break; }
      if (!bullish && candles[i].close > top) { invalidated = true; break; }
    }

    blocks.push({
      dir: bullish ? "bullish" : "bearish",
      idx: obIdx, top, bottom,
      mid: (top + bottom) / 2,
      strongVol, invalidated,
      time: ob.openTime,
      fromEvent: ev.type,
    });
  }
  return dedupe(blocks);
}

function dedupe(blocks) {
  const seen = new Set();
  return blocks.filter((b) => {
    const key = `${b.dir}:${b.idx}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

// 현재가가 위치한 유효 OB (재진입 구간)
export function activeObAt(blocks, price, dir) {
  return blocks
    .filter((b) => b.dir === dir && !b.invalidated)
    .filter((b) => price >= b.bottom && price <= b.top)
    .sort((a, b) => b.time - a.time)[0] || null;
}

export function latestValidOb(blocks, dir) {
  return blocks.filter((b) => b.dir === dir && !b.invalidated)
    .sort((a, b) => b.time - a.time)[0] || null;
}

export default { detectOrderBlocks, activeObAt, latestValidOb };
