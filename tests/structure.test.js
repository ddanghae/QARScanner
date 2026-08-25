// tests/structure.test.js — 시장구조(Pivot/BOS/CHoCH) 검증.

import { suite, test, assert, eq } from "./harness.js";
import { findPivots, labelSwings, detectStructureEvents, structureSummary } from "../js/core/market-structure.js";
import { detectOrderBlocks } from "../js/core/order-block.js";
import { candlesFromCloses, uptrend, zigzag } from "./fixtures.js";

export function run() {
  suite("structure");

  test("Pivot 탐지 — 명확한 고점/저점", () => {
    // 저점(idx4) 과 고점(idx8) 이 뚜렷한 V자
    const c = candlesFromCloses([10, 9, 8, 7, 6, 7, 8, 9, 10, 9, 8, 7, 6], { spread: 0.1 });
    const pv = findPivots(c, 2);
    assert(pv.length > 0, "피봇 존재");
    assert(pv.some((p) => p.kind === "low"), "저점 피봇");
    assert(pv.some((p) => p.kind === "high"), "고점 피봇");
  });

  test("상승추세 → HH/HL 라벨", () => {
    const pv = findPivots(uptrend, 2);
    const sw = labelSwings(pv);
    assert(sw.some((s) => s.label === "HH"), "HH 존재");
    assert(sw.some((s) => s.label === "HL"), "HL 존재");
  });

  test("상방 돌파 → Bullish BOS 발생", () => {
    const pv = findPivots(uptrend, 2);
    const ev = detectStructureEvents(uptrend, pv, "1h", false);
    assert(ev.length > 0, "구조 이벤트 존재");
    assert(ev.some((e) => e.type === "bullish_bos" || e.type === "bullish_choch"), "상방 이벤트");
  });

  test("하락→상승 전환 → CHoCH", () => {
    // LH/LL 하락 추세 후 강한 반등이 직전 스윙 고점 상방 돌파 → CHoCH
    const c = candlesFromCloses(
      zigzag([20, 14, 17, 11, 14, 9, 12, 20]), { spread: 0.3 }
    );
    const pv = findPivots(c, 2);
    const sum = structureSummary(c, pv, "1h", false);
    assert(sum.events.length > 0, "이벤트 존재");
    assert(sum.events.some((e) => e.type.startsWith("bearish")), "하락 구간 bearish 이벤트");
    assert(sum.events.some((e) => e.type === "bullish_choch"), "반등 시 bullish CHoCH");
  });

  test("이벤트 필드 형식 (§8)", () => {
    const pv = findPivots(uptrend, 2);
    const ev = detectStructureEvents(uptrend, pv, "1h", false);
    const e = ev[0];
    assert("type" in e && "timeframe" in e && "price" in e && "candleTime" in e && "confirmed" in e,
      "이벤트에 필수 필드 포함");
    eq(e.timeframe, "1h", "timeframe 전달");
    eq(e.confirmed, true, "마감 캔들 = confirmed");
  });

  test("피봇을 확인하기 전 시점으로 신호를 소급하지 않는다", () => {
    const pv = findPivots(uptrend, 2);
    const events = detectStructureEvents(uptrend, pv, "1h", false);
    assert(events.length > 0, "검사할 이벤트 존재");
    assert(events.every((event) => event.signalTime >= event.pivotConfirmedTime),
      "모든 신호는 피봇 확인 뒤에만 발생");
  });

  test("미래의 세 번째 피봇 때문에 과거 신호가 새로 생기지 않는다", () => {
    const candles = candlesFromCloses([90, 90, 90, 90, 110, 95]);
    const pivots = [
      { idx: 0, confirmedIdx: 1, time: candles[0].openTime, confirmedTime: candles[1].closeTime,
        price: 100, kind: "high" },
      { idx: 1, confirmedIdx: 2, time: candles[1].openTime, confirmedTime: candles[2].closeTime,
        price: 80, kind: "low" },
      { idx: 3, confirmedIdx: 5, time: candles[3].openTime, confirmedTime: candles[5].closeTime,
        price: 120, kind: "high" },
    ];
    const events = detectStructureEvents(candles, pivots, "1h", false);
    assert(!events.some((event) => event.signalTime === candles[4].closeTime),
      "피봇이 둘뿐인 과거 시점에는 신호 없음");
  });

  test("종료 시각으로 표시한 구조 신호도 오더블록과 연결된다", () => {
    const events = detectStructureEvents(uptrend, findPivots(uptrend, 2), "1h", false);
    const blocks = detectOrderBlocks(uptrend, events);
    assert(events.length > 0, "구조 신호 존재");
    assert(blocks.length > 0, "구조 신호에서 오더블록 생성");
  });

  test("호출자가 넘긴 마지막 마감봉의 돌파도 바로 사용한다", () => {
    const candles = candlesFromCloses([8, 8, 8, 11, 13]);
    const pivots = [
      { idx: 0, confirmedIdx: 1, time: candles[0].openTime, confirmedTime: candles[1].closeTime,
        price: 10, kind: "high" },
      { idx: 1, confirmedIdx: 2, time: candles[1].openTime, confirmedTime: candles[2].closeTime,
        price: 5, kind: "low" },
      { idx: 2, confirmedIdx: 3, time: candles[2].openTime, confirmedTime: candles[3].closeTime,
        price: 12, kind: "high" },
    ];
    const events = detectStructureEvents(candles, pivots, "1h", false);
    const last = events[events.length - 1];
    eq(last.signalTime, candles[candles.length - 1].closeTime, "마지막 마감봉 신호 사용");
    eq(last.confirmed, true, "마감봉 신호 확정");
  });
}
