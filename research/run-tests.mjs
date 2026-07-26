// Node runner for QARScanner's browser test suite.
import { report, reset } from "../tests/harness.js";
const base = "../tests/";
const files = ["indicators.test.js", "liquidity.test.js", "golden-cross.test.js",
               "noise.test.js", "refresh.test.js", "early-detect.test.js"];
reset();
for (const f of files) {
  const m = await import(base + f);
  if (typeof m.run === "function") m.run();
}
const r = report();
for (const l of r.lines) if (!l.startsWith("PASS")) console.log(l);
console.log(r.summary);
process.exit(r.fail ? 1 : 0);
