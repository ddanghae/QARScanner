import { assert, eq, suite, test } from "./harness.js";
import { buildPatternTvSnapshot } from "../js/ui/pattern-tv-export.js";

const frame = (overrides = {}) => ({
  bias: "bullish", status: "reaction", fitScore: 86, completionPct: 100,
  detectedAt: 1700000000000, detectedPrice: 100,
  trigger: 100, invalidation: 98, projection: 106,
  zone: { low: 99.8, high: 100.2 },
  points: [
    { label: "X", time: 1699996400000, price: 98 },
    { label: "A", time: 1699998200000, price: 104 },
  ],
  ...overrides,
});
const row = () => ({
  symbol: "BTCUSDT", price: 100,
  patterns: [{ id: "harmonic-gartley-bull", name: "가틀리", timeframes: { "1h": frame() } },
    { id: "hammer", name: "망치형", timeframes: { "5m": frame({ trigger: null, invalidation: null, projection: null, points: [], detectedAt: 1700000300000 }) } }],
  entryCandidate: { patternId: "harmonic-gartley-bull", timeframe: "1h",
    entryLow: 99.9, entryHigh: 100.1, stop: 98, tp1: 102.2, tp2: 104.1, tp3: 106 },
});

export function run() {
  suite("TradingView pattern snapshot");

  test("exports exact scanner detections, timeframes, harmonic pivots and the selected plan", () => {
    const snapshot = buildPatternTvSnapshot(row(), { exportedAt: 1700000000000 });
    eq(snapshot.count, 2);
    eq(snapshot.omitted, 0);
    const lines = snapshot.text.split("\n");
    assert(lines[0].startsWith("QAR1|BINANCE:BTCUSDT.P|"));
    assert(lines[0].endsWith("|C"));
    const harmonic = lines[1].split("|");
    eq(harmonic.length, 30);
    eq(harmonic[1], "60");
    eq(harmonic[2], "1700000000000");
    eq(harmonic[3], "가틀리");
    eq(harmonic[14], "99.9");
    eq(harmonic[16], "98");
    eq(harmonic[19], "106");
    eq(harmonic[20], "1699996400000");
    eq(harmonic[21], "98");
    const candle = lines[2].split("|");
    eq(candle[1], "5");
    eq(candle[9], "na");
    eq(candle[14], "na");
  });

  test("marks provisional candles and sanitizes delimiters in pattern names", () => {
    const data = row();
    data.patterns[0].name = "가틀리|위험\n문자";
    const snapshot = buildPatternTvSnapshot(data, { exportedAt: 1700000000000, includeRealtimeCandle: true });
    eq(snapshot.text.split("\n")[0].split("|")[3], "R");
    eq(snapshot.text.split("\n")[1].split("|")[3], "가틀리 위험 문자");
  });

  test("limits payload size without silently dropping scan results", () => {
    const data = row();
    data.patterns = Array.from({ length: 85 }, (_, index) => ({
      id: `p${index}`, name: `패턴${index}`, timeframes: { "1h": frame({ fitScore: 80 - index / 100 }) },
    }));
    data.entryCandidate = null;
    const snapshot = buildPatternTvSnapshot(data, { exportedAt: 1700000000000 });
    eq(snapshot.count, 80);
    eq(snapshot.omitted, 5);
    assert(snapshot.text.length < 40000);
  });

  test("skips detections without a chart anchor instead of placing them on the wrong bar", () => {
    const data = row();
    data.patterns[0].timeframes["1h"].detectedAt = null;
    const snapshot = buildPatternTvSnapshot(data, { exportedAt: 1700000000000 });
    eq(snapshot.count, 1);
    eq(snapshot.omitted, 1);
  });
}
