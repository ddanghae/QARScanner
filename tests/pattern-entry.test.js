// Deterministic entry-candidate rules for chart-pattern mode.
import { approx, assert, eq, suite, test } from "./harness.js";
import { derivePatternEntryCandidate } from "../js/core/pattern-entry.js";
import { patternEntryCandidateHtml } from "../js/ui/pattern-results.js";

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
    eq(result.entryLow, 99.9);
    eq(result.entryHigh, 100.1);
    eq(result.stop, 98);
    eq(result.target, 106);
    approx(result.tp1, 102.2);
    approx(result.tp2, 104.1);
    eq(result.tp3, 106);
    assert(result.stop < result.entryLow && result.entryHigh < result.tp1
      && result.tp1 < result.tp2 && result.tp2 < result.tp3);
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
    eq(result.entryLow, 99.9);
    eq(result.entryHigh, 100.1);
    eq(result.stop, 102);
    eq(result.target, 94);
    approx(result.tp1, 97.8);
    approx(result.tp2, 95.9);
    eq(result.tp3, 94);
    assert(result.stop > result.entryHigh && result.entryLow > result.tp1
      && result.tp1 > result.tp2 && result.tp2 > result.tp3);
    eq(result.rr, 2.81);
  });

  test("keeps all take-profit levels inside a minimum-reward pattern projection", () => {
    const result = derivePatternEntryCandidate({
      patterns: [pattern("bullish", { "1h": frame("bullish", { projection: 103.3 }) })],
      timeframes: ["1h"], atrByTimeframe: { "1h": 1 }, price: 99,
    });
    approx(result.tp1, 102.2);
    approx(result.tp2, 102.75);
    eq(result.tp3, 103.3);
    assert(result.rr >= 1.5);
  });

  test("shows SL and three take-profit prices on a candidate card", () => {
    const candidate = derivePatternEntryCandidate({
      patterns: [pattern("bullish", { "1h": frame("bullish") })],
      timeframes: ["1h"], atrByTimeframe: { "1h": 1 }, price: 101,
    });
    const html = patternEntryCandidateHtml({ symbol: "BTCUSDT", entryCandidate: candidate });
    for (const label of ["SL · 구조 무효화", "TP1 · 1R", "TP2 · 중간 목표", "TP3 · 패턴 투영"]) {
      assert(html.includes(label), `${label} must appear on candidate card`);
    }
    assert(html.includes("TP3 기준 손익비"));
  });

  test("caps the entry width at 0.3 percent of trigger in a volatile timeframe", () => {
    const result = derivePatternEntryCandidate({
      patterns: [pattern("bullish", { "4h": frame("bullish") })],
      timeframes: ["4h"], atrByTimeframe: { "4h": 10 }, price: 101,
    });
    approx(result.entryLow, 99.85);
    approx(result.entryHigh, 100.15);
    approx(result.entryHigh - result.entryLow, 0.3);
    eq(result.rr, 2.72);
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

  test("reaction PRZ uses only the overlap with the tighter entry area", () => {
    const result = derivePatternEntryCandidate({
      patterns: [pattern("bullish", { "4h": frame("bullish", {
        status: "reaction", zone: { low: 100.05, high: 100.3 },
      }) })],
      timeframes: ["4h"], atrByTimeframe: { "4h": 1 }, price: 101,
    });
    eq(result.entryLow, 100.05);
    eq(result.entryHigh, 100.1);
  });

  test("does not show a reaction entry when PRZ misses the tighter area", () => {
    const result = derivePatternEntryCandidate({
      patterns: [pattern("bullish", { "4h": frame("bullish", {
        status: "reaction", zone: { low: 100.2, high: 100.3 },
      }) })],
      timeframes: ["4h"], atrByTimeframe: { "4h": 1 }, price: 101,
    });
    eq(result.state, "structure-needed");
    eq(result.entryLow, undefined);
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

  test("does not invent take-profit levels from a nonpositive projection", () => {
    const result = derivePatternEntryCandidate({
      patterns: [pattern("bearish", { "1h": frame("bearish", { projection: 0 }) })],
      timeframes: ["1h"], atrByTimeframe: { "1h": 1 }, price: 99,
    });
    eq(result.state, "structure-needed");
    eq(result.tp3, undefined);
  });
}
