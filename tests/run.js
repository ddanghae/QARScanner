// tests/run.js — 모든 테스트 실행. Node: `node tests/run.js`. 브라우저: index.html.

import { report, reset } from "./harness.js";
import { run as indicators } from "./indicators.test.js";
import { run as structure } from "./structure.test.js";
import { run as liquidity } from "./liquidity.test.js";
import { run as scoring } from "./scoring.test.js";
import { run as goldenCross } from "./golden-cross.test.js";
import { run as noise } from "./noise.test.js";
import { run as repaint } from "./repaint.test.js";
import { run as refresh } from "./refresh.test.js";

export function runAll() {
  reset();
  indicators();
  structure();
  liquidity();
  scoring();
  goldenCross();
  noise();
  repaint();
  refresh();
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
