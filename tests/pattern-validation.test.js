import { suite, test, assert, eq } from "./harness.js";
import { evaluatePatternOutcome, signalFreshness, replayPatternHistory } from "../js/core/pattern-validation.js";
import { assessSymbolDirection } from "../js/core/pattern-direction.js";

const bullish = { bias: "bullish", trigger: 100, invalidation: 95, projection: 110 };
const bearish = { bias: "bearish", trigger: 100, invalidation: 105, projection: 90 };
const bar = (high, low, close = (high + low) / 2) => ({ open: 100, high, low, close, openTime: 1, closeTime: 2 });

export function run() {
  suite("pattern validation");
  test("long/short outcome is directional and conservative", () => {
    eq(evaluatePatternOutcome(bullish, [bar(111, 99)]).status, "win");
    eq(evaluatePatternOutcome(bearish, [bar(101, 89)]).status, "win");
    eq(evaluatePatternOutcome(bullish, [bar(112, 94)]).status, "loss", "same candle stop first");
    eq(evaluatePatternOutcome({ bias: "bullish", trigger: 100 }, [bar(110, 99)]).status, "insufficient");
  });
  test("freshness separates current, delayed, and stale bars", () => {
    const now = 1_000_000;
    eq(signalFreshness(now - 5 * 60_000, "5m", now).status, "fresh");
    eq(signalFreshness(now - 12 * 60_000, "5m", now).status, "delayed");
    eq(signalFreshness(now - 20 * 60_000, "5m", now).status, "stale");
  });
  test("same family and direction does not inflate the direction share", () => {
    const patterns = [
      { family: "continuation", timeframes: { "1h": { bias: "bullish", fitScore: 90 } } },
      { family: "continuation", timeframes: { "1h": { bias: "bullish", fitScore: 60 } } },
      { family: "reversal", timeframes: { "1h": { bias: "bearish", fitScore: 60 } } },
    ];
    const result = assessSymbolDirection(patterns, {}, ["1h"]);
    eq(result.pattern.bullishCount, 1);
    eq(result.pattern.bearishCount, 1);
    eq(result.pattern.longPct, 60);
  });
  test("short history returns explicit insufficient validation", () => {
    const result = replayPatternHistory(Array.from({ length: 20 }, (_, i) => ({ open: 100, high: 101, low: 99, close: 100, volume: 1, openTime: i, closeTime: i + 1 })));
    eq(result.sampleCount, 0);
    eq(result.label, "표본 부족");
  });
}
