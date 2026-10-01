// tests/run.js — 모든 테스트 실행. Node: `node tests/run.js`. 브라우저: index.html.

import { report, reset } from "./harness.js";
import { suites } from "./suites.js";

export function runAll() {
  reset();
  for (const suite of suites) suite.run();
  return report();
}

// Node 환경이면 자동 실행 + 종료코드
const isNode = typeof process !== "undefined" && process.versions?.node;
if (isNode) {
  const r = runAll();
  console.log(r.lines.join("\n"));
  console.log(r.summary);
  process.exit(r.fail ? 1 : 0);
}
