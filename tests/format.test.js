import { eq, suite, test } from "./harness.js";
import { fmtPriceList, fmtPriceRange } from "../js/ui/format.js";

export function run() {
  suite("price range formatting");

  test("uses equal precision on both sides of a range crossing 100", () => {
    eq(fmtPriceRange(99.9, 100.1), "99.90 – 100.10");
  });

  test("shows distinct prices when default rounding would hide a narrow range", () => {
    eq(fmtPriceRange(100.001, 100.002), "100.001 – 100.002");
  });

  test("uses enough shared precision to distinguish all stop and profit levels", () => {
    eq(fmtPriceList([99.9, 100.1, 100.1001, 100.1002]).join(" | "),
      "99.9000 | 100.1000 | 100.1001 | 100.1002");
  });
}
