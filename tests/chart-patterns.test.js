// tests/chart-patterns.test.js — 대표적인 가격 패턴 합성 자료 검사.
import { assert, eq, suite, test } from "./harness.js";
import { detectChartPatterns, groupPatternsByTimeframe, patternCompletionPct } from "../js/core/chart-patterns.js";
import { assessSymbolDirection } from "../js/core/pattern-direction.js";

function flatCandles(count = 80, price = 100) {
  return Array.from({ length: count }, (_, i) => ({ openTime: i * 3600000, open: price, high: price + 0.25, low: price - 0.25, close: price, volume: 100 }));
}

function pivotSeries(points, barsPerLeg = 8, tailStep = 0.28) {
  const out = [];
  const push = (price, kind) => out.push({
    openTime: out.length * 3600000, open: price * 0.999, close: price,
    high: price + (kind === "H" ? 0.2 : 0.1), low: price - (kind === "L" ? 0.2 : 0.1), volume: 120,
  });
  const lead = points[0].kind === "L" ? 1 : -1;
  for (let j = 4; j >= 1; j--) push(points[0].price + lead * j, "");
  push(points[0].price, points[0].kind);
  for (let k = 0; k < points.length - 1; k++) {
    const a = points[k], b = points[k + 1];
    for (let j = 1; j <= barsPerLeg; j++) {
      const price = a.price + (b.price - a.price) * j / barsPerLeg;
      push(price, j === barsPerLeg ? b.kind : "");
    }
  }
  const d = points[points.length - 1].price;
  for (let j = 1; j <= 5; j++) push(d + j * tailStep, "");
  return out;
}

export function run() {
  suite("chart pattern scanner");
  test("flat prices do not create a chart formation", () => {
    eq(detectChartPatterns(flatCandles()).length, 0);
  });

  test("matches a bullish Gartley using XABCD ratios", () => {
    const bars = pivotSeries([
      { kind: "L", price: 100 }, { kind: "H", price: 120 },
      { kind: "L", price: 107.64 }, { kind: "H", price: 114.92 },
      { kind: "L", price: 104.28 },
    ]);
    const found = detectChartPatterns(bars, { pivotDepth: 2 });
    const gartley = found.find((p) => p.id === "harmonic-gartley-bull");
    assert(gartley, "expected ratio-matched Gartley");
    eq(gartley.detectedAt, bars.at(-1).openTime);
    eq(gartley.detectedPrice, bars.at(-1).close);
    for (const point of gartley.points) eq(point.time, bars[point.index].openTime);
  });

  test("harmonic pivot times use the detector's trimmed 240-bar window", () => {
    const prefix = flatCandles(220, 100);
    const tail = pivotSeries([
      { kind: "L", price: 100 }, { kind: "H", price: 120 },
      { kind: "L", price: 107.64 }, { kind: "H", price: 114.92 },
      { kind: "L", price: 104.28 },
    ]).map((bar, index) => ({ ...bar, openTime: (220 + index) * 3600000 }));
    const bars = [...prefix, ...tail];
    const gartley = detectChartPatterns(bars, { pivotDepth: 2 }).find((p) => p.id === "harmonic-gartley-bull");
    assert(gartley, "expected ratio-matched Gartley after a long history");
    const detectorWindow = bars.slice(-240);
    for (const point of gartley.points) eq(point.time, detectorWindow[point.index].openTime);
  });

  test("detects an impulse followed by a shallow bullish flag", () => {
    const bars = [];
    let price = 100;
    for (let i = 0; i < 8; i++) {
      const next = price + 1.7;
      bars.push({ openTime: i, open: price, high: next + 0.15, low: price - 0.15, close: next, volume: 180 });
      price = next;
    }
    for (let i = 0; i < 10; i++) {
      const next = price - 0.23;
      bars.push({ openTime: 100 + i, open: price, high: price + 0.16, low: next - 0.16, close: next, volume: 90 });
      price = next;
    }
    while (bars.length < 80) {
      const p = bars[0].close;
      bars.unshift({ openTime: -bars.length, open: p, high: p + 0.2, low: p - 0.2, close: p, volume: 100 });
    }
    const found = detectChartPatterns(bars, { pivotDepth: 2 });
    assert(found.some((p) => p.id === "bullish-flag" || p.id === "bullish-pennant"), "expected bull flag family");
  });

  test("classifies a converging ceiling and rising lows as an ascending triangle", () => {
    const bars = pivotSeries([
      { kind: "H", price: 100 }, { kind: "L", price: 90 },
      { kind: "H", price: 100.2 }, { kind: "L", price: 92 },
      { kind: "H", price: 100.1 }, { kind: "L", price: 94 },
      { kind: "H", price: 100.3 }, { kind: "L", price: 96 },
      { kind: "H", price: 100.2 },
    ]);
    const found = detectChartPatterns(bars, { pivotDepth: 2 });
    assert(found.some((p) => p.id === "triangle-ascending" && p.bias === "bullish"));
  });

  test("detects a forming double top before neckline breakdown", () => {
    const bars = pivotSeries([
      { kind: "H", price: 120 }, { kind: "L", price: 108 }, { kind: "H", price: 120.5 },
    ], 10, -0.28);
    const found = detectChartPatterns(bars, { pivotDepth: 2 });
    assert(found.some((p) => p.id === "top-double" && p.status === "forming"));
  });

  test("recognizes a head-and-shoulders structure", () => {
    const bars = pivotSeries([
      { kind: "H", price: 120 }, { kind: "L", price: 106 }, { kind: "H", price: 126 },
      { kind: "L", price: 107 }, { kind: "H", price: 120.5 },
    ], 9, -0.25);
    const found = detectChartPatterns(bars, { pivotDepth: 2 });
    assert(found.some((p) => p.id === "head-and-shoulders"));
  });

  test("detects a bearish engulfing candle on the latest bar", () => {
    const bars = flatCandles(40);
    bars[38] = { open: 100, high: 103, low: 99, close: 102, volume: 100 };
    bars[39] = { open: 103, high: 103.5, low: 98.5, close: 99, volume: 140 };
    assert(detectChartPatterns(bars).some((p) => p.id === "bearish-engulfing"));
  });

  test("fit score is not exposed as a probability", () => {
    const bars = flatCandles(40);
    bars[39] = { open: 100, high: 104, low: 99.8, close: 103.9, volume: 120 };
    const found = detectChartPatterns(bars);
    assert(found.every((p) => p.fitScore >= 0 && p.fitScore <= 100 && !("probability" in p)));
  });

  test("groups matching formations but preserves each timeframe fit independently", () => {
    const [pattern] = groupPatternsByTimeframe({
      "5m": [{ id: "triangle-ascending", name: "상승 삼각형", family: "continuation", bias: "bullish", status: "forming", fitScore: 71 }],
      "1h": [{ id: "triangle-ascending", name: "상승 삼각형", family: "continuation", bias: "bullish", status: "breakout", fitScore: 88 }],
    });
    eq(pattern.timeframes["5m"].fitScore, 71);
    eq(pattern.timeframes["1h"].fitScore, 88);
    eq(pattern.timeframes["1h"].status, "breakout");
    assert(!("fitScore" in pattern), "group must not average or replace timeframe scores");
  });

  test("completion percent tracks trigger proximity separately from fit", () => {
    const forming = { status: "forming", trigger: 120, invalidation: 100 };
    eq(patternCompletionPct(forming, 110), 50);
    eq(patternCompletionPct(forming, 120), 95);
    eq(patternCompletionPct({ ...forming, status: "breakout" }, 110), 100);
    eq(patternCompletionPct({ status: "forming" }, 110), null);
  });

  test("calculates per-symbol long/short mix from patterns and weighted EMA200 context", () => {
    const patterns = [
      { timeframes: { "5m": { bias: "bearish", fitScore: 70 }, "4h": { bias: "bullish", fitScore: 80 } } },
      { timeframes: { "4h": { bias: "neutral", fitScore: 90 } } },
    ];
    const ema200 = { "5m": { position: "above" }, "4h": { position: "below" } };
    const result = assessSymbolDirection(patterns, ema200, ["5m", "15m", "4h"]);
    eq(result.pattern.longPct, 75);
    eq(result.pattern.shortPct, 25);
    eq(result.pattern.bullishCount, 1);
    eq(result.pattern.bearishCount, 1);
    eq(result.pattern.neutralCount, 1);
    eq(result.ema200.longPct, 25);
    eq(result.ema200.shortPct, 75);
    eq(result.overall.longPct, 55);
    eq(result.overall.shortPct, 45);
    eq(result.timeframes[1].patternLongPct, null);
  });

  test("uses available directional evidence if EMA200 context is unavailable", () => {
    const result = assessSymbolDirection(
      [{ timeframes: { "1h": { bias: "bullish", fitScore: 88 } } }],
      { "1h": null }, ["1h"],
    );
    eq(result.overall.longPct, 100);
    eq(result.overall.shortPct, 0);
    eq(result.ema200, null);
  });
}
