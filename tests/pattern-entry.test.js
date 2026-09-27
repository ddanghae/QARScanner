// Deterministic entry-candidate rules for chart-pattern mode.
import { assert, eq, suite, test } from "./harness.js";
import { derivePatternEntryCandidate } from "../js/core/pattern-entry.js";

const frame = (bias, overrides = {}) => ({
  bias, status: "breakout", fitScore: 80, completionPct: 100,
  trigger: 100, invalidation: bias === "bullish" ? 98 : 102,
  projection: bias === "bullish" ? 106 : 94,
  ...overrides,
});
const pattern = (bias, timeframes) => ({ id: `${bias}-setup`, name: `${bias} setup`, timeframes });

export function run() {
  suite("pattern entry candidates");

  test("selects a long breakout retest area and reports conservative risk", () => {
    const result = derivePatternEntryCandidate({
      patterns: [pattern("bullish", { "1h": frame("bullish") })],
      ema200ByTimeframe: { "1h": { position: "above" } },
      timeframes: ["1h"], atrByTimeframe: { "1h": 1 }, price: 101,
    });
    eq(result.direction, "long");
    eq(result.state, "wait-retest");
    eq(result.entryLow, 99.8);
    eq(result.entryHigh, 100.2);
    eq(result.stop, 98);
    eq(result.target, 106);
    assert(result.rr >= 1.5, "candidate must pass minimum R:R");
    assert(result.riskPct > 0, "candidate must expose estimated loss size");
  });

  test("short candidate uses mirrored levels and retest logic", () => {
    const result = derivePatternEntryCandidate({
      patterns: [pattern("bearish", { "15m": frame("bearish") })],
      ema200ByTimeframe: { "15m": { position: "below" } },
      timeframes: ["15m"], atrByTimeframe: { "15m": 1 }, price: 99,
    });
    eq(result.direction, "short");
    eq(result.state, "wait-retest");
    eq(result.entryLow, 99.8);
    eq(result.entryHigh, 100.2);
    eq(result.stop, 102);
    eq(result.target, 94);
  });

  test("forming structures wait for a close beyond the trigger", () => {
    const result = derivePatternEntryCandidate({
      patterns: [pattern("bullish", { "1h": frame("bullish", { status: "forming", completionPct: 70 }) })],
      timeframes: ["1h"], atrByTimeframe: { "1h": 1 }, price: 99,
    });
    eq(result.state, "wait-breakout");
  });

  test("reaction PRZ constrains the entry area", () => {
    const result = derivePatternEntryCandidate({
      patterns: [pattern("bullish", { "4h": frame("bullish", {
        status: "reaction", trigger: 100, zone: { low: 99.95, high: 100.05 },
      }) })],
      timeframes: ["4h"], atrByTimeframe: { "4h": 1 }, price: 101,
    });
    eq(result.state, "wait-pullback");
    eq(result.entryLow, 99.95);
    eq(result.entryHigh, 100.05);
  });

  test("labels a confirmed setup in its candidate area as needing another check", () => {
    const result = derivePatternEntryCandidate({
      patterns: [pattern("bullish", { "1h": frame("bullish", {
        status: "reaction", zone: { low: 99.7, high: 100.3 },
      }) })],
      timeframes: ["1h"], atrByTimeframe: { "1h": 1 }, price: 100,
    });
    eq(result.state, "zone-now");
    assert(result.title.includes("추가 확인"));
  });

  test("rejects weak direction and does not invent levels for candlestick-only structure", () => {
    const mixed = derivePatternEntryCandidate({
      patterns: [pattern("bullish", { "1h": frame("bullish") }), pattern("bearish", { "1h": frame("bearish") })],
      timeframes: ["1h"], atrByTimeframe: { "1h": 1 }, price: 100,
    });
    eq(mixed.state, "mixed");
    const candleOnly = derivePatternEntryCandidate({
      patterns: [{ timeframes: { "1h": { bias: "bullish", status: "reaction", fitScore: 90 } } }],
      timeframes: ["1h"], atrByTimeframe: { "1h": 1 }, price: 100,
    });
    eq(candleOnly.state, "structure-needed");
  });

  test("does not show levels when target projection fails the minimum reward-to-risk", () => {
    const result = derivePatternEntryCandidate({
      patterns: [pattern("bullish", { "1h": frame("bullish", { projection: 100.5 }) })],
      timeframes: ["1h"], atrByTimeframe: { "1h": 1 }, price: 99,
    });
    eq(result.state, "structure-needed");
    assert(result.reason.includes("손익비"));
  });
}
