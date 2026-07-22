// tests/structure.test.js — 시장구조(Pivot/BOS/CHoCH) 검증.

import { suite, test, assert, eq } from "./harness.js";
import { findPivots, labelSwings, detectStructureEvents, structureSummary } from "../js/core/market-structure.js";
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
}
