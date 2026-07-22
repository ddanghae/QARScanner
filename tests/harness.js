// tests/harness.js — 의존성 없는 초소형 테스트 하네스. Node + 브라우저 겸용.

const results = [];
let curSuite = "";

export function suite(name) { curSuite = name; }

export function test(name, fn) {
  try {
    fn();
    results.push({ suite: curSuite, name, ok: true });
  } catch (e) {
    results.push({ suite: curSuite, name, ok: false, err: e.message });
  }
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assert 실패");
}
export function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || "eq 실패"}: ${a} !== ${b}`);
}
export function approx(a, b, tol = 1e-6, msg) {
  if (a == null || b == null || Math.abs(a - b) > tol)
    throw new Error(`${msg || "approx 실패"}: ${a} ≉ ${b} (tol ${tol})`);
}
export function close(a, b, relTol = 0.02, msg) {
  const d = Math.abs(a - b) / (Math.abs(b) || 1);
  if (d > relTol) throw new Error(`${msg || "close 실패"}: ${a} vs ${b} (${(d * 100).toFixed(2)}%)`);
}

export function report() {
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  const lines = results.map((r) =>
    `${r.ok ? "PASS" : "FAIL"} [${r.suite}] ${r.name}${r.ok ? "" : "  ->  " + r.err}`
  );
  const summary = `\n${pass}/${results.length} 통과${fail ? `, ${fail} 실패` : ""}`;
  return { pass, fail, total: results.length, lines, summary, results };
}

export function reset() { results.length = 0; }
