// Node runner for QARScanner's browser test suite.
import { report, reset } from "../tests/harness.js";
const base = "../tests/";
// tests/run.js 와 같은 목록이어야 한다. 여기서 빠지면 브라우저에서만 돌고 CI/터미널에서는
// 조용히 안 돈다 — 통과했다고 착각하기 딱 좋다(실제로 paper-corr·scoring·structure·repaint 가
// 빠져 있었다). 테스트 파일을 추가하면 양쪽 다 고칠 것.
const files = ["indicators.test.js", "structure.test.js", "liquidity.test.js",
               "scoring.test.js", "golden-cross.test.js", "noise.test.js",
               "early-detect.test.js", "repaint.test.js", "refresh.test.js",
               "paper-corr.test.js", "strategies.test.js"];
reset();
for (const f of files) {
  const m = await import(base + f);
  if (typeof m.run === "function") m.run();
}
const r = report();
for (const l of r.lines) if (!l.startsWith("PASS")) console.log(l);
console.log(r.summary);
process.exit(r.fail ? 1 : 0);
