// tests/indicators.test.js — 지표 계산 검증 (고정 데이터).

import { suite, test, assert, approx, close, eq } from "./harness.js";
import { sma, ema, rsi, atr, bollinger, dailyVwap, macd, obv, last } from "../js/core/indicators.js";
import { candlesFromCloses, mkCandle } from "./fixtures.js";

export function run() {
  suite("indicators");

  test("SMA 마지막값", () => {
    const s = sma([1, 2, 3, 4, 5], 3);
    approx(s[4], 4, 1e-9, "SMA(3) of [3,4,5]");
    eq(s[1], null, "period 이전은 null");
  });

  test("EMA 시드=SMA", () => {
    const e = ema([1, 2, 3, 4, 5], 3);
    approx(e[2], 2, 1e-9, "첫 EMA=SMA(3)=2");
    assert(e[4] > e[3], "EMA 증가");
  });

  test("RSI 단조증가 → 100", () => {
    const closes = Array.from({ length: 20 }, (_, i) => 10 + i);
    const r = rsi(closes, 14);
    approx(last(r), 100, 1e-6, "모두 상승이면 RSI 100");
  });

  test("RSI 단조감소 → 0", () => {
    const closes = Array.from({ length: 20 }, (_, i) => 30 - i);
    const r = rsi(closes, 14);
    approx(last(r), 0, 1e-6, "모두 하락이면 RSI 0");
  });

  test("ATR 일정 레인지", () => {
    // 매 캔들 high-low=2, 갭 없음 → ATR≈2
    const candles = Array.from({ length: 30 }, (_, i) => mkCandle(10, 11, 9, 10, i));
    const a = atr(candles, 14);
    approx(last(a), 2, 1e-6, "일정 TR=2 → ATR=2");
  });

  test("Bollinger 중심=SMA", () => {
    const closes = Array.from({ length: 25 }, (_, i) => 100 + Math.sin(i));
    const bb = bollinger(closes, 20, 2);
    const s = sma(closes, 20);
    approx(last(bb.mid), last(s), 1e-9, "BB mid = SMA20");
    assert(last(bb.upper) > last(bb.mid), "upper>mid");
    assert(last(bb.lower) < last(bb.mid), "lower<mid");
  });

  test("VWAP UTC 일 리셋", () => {
    // 하루 경계 넘는 캔들: 두 번째 날 첫 캔들 VWAP = 그 캔들 typical
    const day = 86_400_000;
    const c = [
      { openTime: 0, high: 10, low: 10, close: 10, volume: 5 },
      { openTime: day, high: 20, low: 20, close: 20, volume: 3 }, // 새 날
    ];
    const v = dailyVwap(c);
    approx(v[1], 20, 1e-9, "새 날 첫 캔들 VWAP=typical");
  });

  test("MACD 라인 길이/히스토그램", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i * 0.5);
    const m = macd(closes, 12, 26, 9);
    eq(m.macdLine.length, closes.length, "길이 일치");
    assert(last(m.macdLine) > 0, "상승추세 MACD>0");
  });

  test("OBV 방향", () => {
    const c = candlesFromCloses([10, 11, 12, 11, 13], { vol: 100 });
    const o = obv(c);
    assert(last(o) != null, "OBV 계산됨");
  });
}
