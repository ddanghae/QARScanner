// tests/repaint.test.js — 리페인트 방지 검증 (§21).
// 각 시점에서 사용 가능한 과거 데이터만 잘라 계산 → 새 캔들 추가 전/후
// 과거 인덱스의 신호가 부당하게 바뀌지 않아야 한다(미래 참조 없음).

import { suite, test, approx, assert, eq } from "./harness.js";
import { closedOnly, crossedCandleClose } from "../js/api/binance.js";
import { ema, rsi, atr, sma } from "../js/core/indicators.js";
import { findPivots, detectStructureEvents } from "../js/core/market-structure.js";
import { candlesFromCloses, uptrend } from "./fixtures.js";

export function run() {
  suite("repaint");
  test("시각 기반 마감 판정은 이미 닫힌 마지막 봉을 보존", () => {
    const bars = [{openTime:0,closeTime:9}, {openTime:10,closeTime:19}];
    eq(closedOnly(bars, false, 20).length, 2);
    eq(closedOnly(bars, false, 15).length, 1);
    eq(closedOnly(bars, false, 19).length, 1);
    eq(closedOnly(bars, true, 15).length, 2);
    eq(closedOnly(bars, true, 5).length, 1);
  });
  test("시각 없는 자료를 마감으로 추측하지 않는다", () => {
    eq(closedOnly([{},null,{openTime:5,closeTime:4}], false, 10).length, 0);
  });
  test("캐시 속 진행 중 봉이 마감 경계를 넘으면 새 OHLC 필요", () => {
    const raw = [[0,1,1,1,1,1,9]];
    eq(crossedCandleClose(raw, 5, 9), false);
    eq(crossedCandleClose(raw, 5, 10), true);
    eq(crossedCandleClose(raw, 10, 11), false);
    eq(crossedCandleClose([], 5, 10), false);
  });

  const closes = uptrend.map((c) => c.close);

  test("EMA — prefix 계산이 full 계산과 동일 (미래 참조 없음)", () => {
    const full = ema(closes, 20);
    for (let cut = 25; cut < closes.length; cut++) {
      const prefix = ema(closes.slice(0, cut), 20);
      approx(prefix[cut - 1], full[cut - 1], 1e-9, `EMA idx ${cut - 1} 불변`);
    }
  });

  test("RSI — prefix == full at each index", () => {
    const full = rsi(closes, 14);
    for (let cut = 20; cut < closes.length; cut++) {
      const prefix = rsi(closes.slice(0, cut), 14);
      approx(prefix[cut - 1], full[cut - 1], 1e-9, `RSI idx ${cut - 1} 불변`);
    }
  });

  test("ATR — prefix == full at each index", () => {
    const full = atr(uptrend, 14);
    for (let cut = 20; cut < uptrend.length; cut++) {
      const prefix = atr(uptrend.slice(0, cut), 14);
      approx(prefix[cut - 1], full[cut - 1], 1e-9, `ATR idx ${cut - 1} 불변`);
    }
  });

  test("SMA — prefix == full at each index", () => {
    const full = sma(closes, 20);
    for (let cut = 25; cut < closes.length; cut++) {
      const prefix = sma(closes.slice(0, cut), 20);
      approx(prefix[cut - 1], full[cut - 1], 1e-12, `SMA idx ${cut - 1} 불변`);
    }
  });

  test("구조 이벤트 — 과거 확정 이벤트는 캔들 추가 후에도 유지", () => {
    // 마감 캔들만 사용(includeRealtime=false). 앞부분 이벤트가 뒤 캔들 추가로 사라지지 않아야.
    const cutA = uptrend.slice(0, 30);
    const cutB = uptrend.slice(0, 36);
    const evA = detectStructureEvents(cutA, findPivots(cutA, 2), "1h", false);
    const evB = detectStructureEvents(cutB, findPivots(cutB, 2), "1h", false);
    // A 의 확정 이벤트(마지막 제외한 확정 구간)는 B 에도 존재해야 함
    const stable = evA.filter((e) => e.candleTime <= cutA[cutA.length - 4].openTime);
    for (const e of stable) {
      const found = evB.some((x) => x.type === e.type && x.candleTime === e.candleTime);
      assert(found, `과거 이벤트 유지: ${e.type}@${e.candleTime}`);
    }
  });
}
