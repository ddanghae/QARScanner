import { suite, test, eq, assert } from "./harness.js";
import { selectLatestFrame } from "../js/scanner/scan-controller.js";

export function run() {
  suite("scanner orchestration");
  test("pattern price uses the most recently closed timeframe", () => {
    const selected = selectLatestFrame([
      { timeframe: "4h", bars: [{ openTime: 400, closeTime: 499, close: 40 }] },
      { timeframe: "5m", bars: [{ openTime: 900, closeTime: 999, close: 90 }] },
    ]);
    eq(selected.timeframe, "5m");
    eq(selected.bars.at(-1).close, 90);
  });
  test("empty timeframe responses do not invent a price", () => {
    assert(selectLatestFrame([{ timeframe: "1h", bars: [] }]) === null);
  });
}
