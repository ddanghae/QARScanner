import { assert, eq, suite, test } from "./harness.js";
import { assessFractalContinuation, confirmedFractalTrend, highestActionablePattern } from "../js/core/fractal-continuation.js";
import { renderPatternResults } from "../js/ui/pattern-results.js";
import { state } from "../js/state.js";

function risingFractalBars() {
  const anchors = [[0, 100], [4, 90], [10, 110], [16, 94], [22, 116], [28, 98], [34, 122], [40, 110]];
  const bars = [];
  for (let i = 0; i <= 40; i++) {
    const right = anchors.findIndex(([index]) => index >= i);
    const [end, endPrice] = anchors[right];
    const [begin, beginPrice] = anchors[Math.max(0, right - 1)];
    const price = begin === end ? beginPrice : beginPrice + (endPrice - beginPrice) * (i - begin) / (end - begin);
    bars.push({ openTime: i * 300_000, closeTime: i * 300_000 + 299_999, open: price, high: price + 0.1, low: price - 0.1, close: price, volume: 100 });
  }
  return bars;
}

const bullContinuation = { id: "bullish-flag", name: "상승 플래그", family: "continuation", bias: "bullish", status: "forming", fitScore: 72, trigger: 115, invalidation: 100, projection: 125 };

export function run() {
  suite("5m fractal continuation");
  test("a pivot needs three closed bars on the right before it can change structure", () => {
    const bars = risingFractalBars();
    eq(confirmedFractalTrend(bars.slice(0, 25)), "insufficient");
    eq(confirmedFractalTrend(bars.slice(0, 26)), "up");
  });

  test("only the highest-fit actionable pattern determines eligibility", () => {
    const bars = risingFractalBars();
    const higherReversal = { ...bullContinuation, id: "top-double", family: "reversal", fitScore: 83 };
    eq(highestActionablePattern([bullContinuation, higherReversal]), higherReversal);
    const result = assessFractalContinuation(bars, [bullContinuation, higherReversal], { asOf: bars.at(-1).closeTime });
    eq(result.matched, false);
    eq(result.reason, "not-continuation");
  });

  test("bullish and bearish continuation both require matching confirmed fractal structure", () => {
    const bars = risingFractalBars();
    const bull = assessFractalContinuation(bars, [bullContinuation], { asOf: bars.at(-1).closeTime });
    eq(bull.matched, true);
    eq(bull.fractalAlignment, "aligned");
    const falling = bars.map((bar) => ({ ...bar, open: 200 - bar.open, close: 200 - bar.close, high: 200 - bar.low, low: 200 - bar.high }));
    const bearPattern = { ...bullContinuation, id: "bearish-flag", bias: "bearish", trigger: 90, invalidation: 100, projection: 80 };
    const bear = assessFractalContinuation(falling, [bearPattern], { asOf: falling.at(-1).closeTime });
    eq(bear.matched, true);
    eq(bear.fractalTrend, "down");
    eq(assessFractalContinuation(bars, [bearPattern], { asOf: bars.at(-1).closeTime }).matched, false);
  });

  test("an unfinished last candle cannot create a signal", () => {
    const bars = risingFractalBars();
    const result = assessFractalContinuation(bars, [bullContinuation], { asOf: bars.at(-1).closeTime - 1 });
    eq(result.matched, false);
    eq(result.reason, "unfinished-candle");
  });

  test("pattern results expose a separate fractal tab and its matching card", () => {
    const previous = { patternResults: state.patternResults, patternScanMeta: state.patternScanMeta, phase: state.scan.phase, settings: state.settings };
    const handlers = new Map();
    const element = {
      innerHTML: "",
      querySelectorAll(selector) {
        if (selector !== "[data-pattern-scan-side]") return [];
        return ["long", "short", "fractal"].map((side) => ({
          dataset: { patternScanSide: side }, addEventListener(_event, callback) { handlers.set(side, callback); },
        }));
      },
    };
    try {
      state.settings = { ...state.settings, patternFamily: "reversal", showFavoritesOnly: false, excludeNewListing: false, favorites: [], excluded: [] };
      state.scan.phase = "done";
      state.patternScanMeta = { requestedTimeframes: ["5m"], candidateCount: 1, completedRequests: 1, failedRequests: 0 };
      state.patternResults = [{ symbol: "BTCUSDT", quoteVolume: 1_000_000, patterns: [], scannedTimeframes: ["5m"], fractalContinuation: {
        matched: true, pattern: bullContinuation, fractalTrend: "up", fractalAlignment: "aligned",
        price: 110, closedAt: 12_299_999, freshness: { status: "fresh" },
      } }];
      renderPatternResults(element);
      assert(element.innerHTML.includes("프랙탈 후보 <b>1</b>"));
      handlers.get("fractal")();
      assert(element.innerHTML.includes("BTCUSDT"));
      assert(element.innerHTML.includes("프랙탈 고점·저점 상승"));
      assert(element.innerHTML.includes("패턴 기준선"));
    } finally {
      handlers.get("long")?.();
      state.patternResults = previous.patternResults;
      state.patternScanMeta = previous.patternScanMeta;
      state.scan.phase = previous.phase;
      state.settings = previous.settings;
    }
  });
}
