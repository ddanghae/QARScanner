// tests/noise.test.js — Choppiness Index + 노이즈 판정 검증.

import { suite, test, assert } from "./harness.js";
import { choppinessIndex, evaluateNoise } from "../js/core/noise-filter.js";
import { CONFIG } from "../js/config.js";

// 캔들 생성기: closes → OHLC (촙 여부를 high/low 폭으로 조절)
function mk(closes, wick = 0.2) {
  let prev = closes[0];
  return closes.map((c, i) => {
    const open = i === 0 ? c : prev;
    prev = c;
    return { openTime: i, open, high: Math.max(open, c) + wick, low: Math.min(open, c) - wick, close: c, volume: 100 };
  });
}

export function run() {
  suite("noise");

  test("강한 추세 → CI 낮음, 횡보 → CI 높음", () => {
    // 추세: 한 방향으로 꾸준히 (누적 이동 >> TR 합) → CI 낮음
    const trendCloses = Array.from({ length: 30 }, (_, i) => 10 + i * 0.5);
    const ciTrend = choppinessIndex(mk(trendCloses), 14);
    // 횡보: 좁은 범위 톱니 (누적 이동 ≈ TR 합, 범위 좁음) → CI 높음
    const chopCloses = Array.from({ length: 30 }, (_, i) => 10 + (i % 2 === 0 ? 0 : 0.4));
    const ciChop = choppinessIndex(mk(chopCloses), 14);
    assert(ciTrend != null && ciChop != null, "CI 계산됨");
    assert(ciChop > ciTrend, `횡보 CI(${ciChop.toFixed(1)}) > 추세 CI(${ciTrend.toFixed(1)})`);
    assert(ciTrend < 50, `추세는 CI 낮아야 (실제 ${ciTrend.toFixed(1)})`);
  });

  test("데이터 부족 → CI null", () => {
    assert(choppinessIndex(mk([1, 2, 3]), 14) === null, "기간 미만이면 null");
  });

  test("횡보 구간 → noisy=true (촙 사유)", () => {
    const chopCloses = Array.from({ length: 30 }, (_, i) => 10 + (i % 2 === 0 ? 0 : 0.3));
    const a = { candles: mk(chopCloses), volTrend: { avgRel: 1.0 }, relVolNow: 1.0 };
    const res = evaluateNoise(a, CONFIG);
    assert(res.noisy, `횡보는 노이즈 (CI ${res.ci?.toFixed(1)})`);
    assert(res.reasons.includes("횡보(촙)"), "촙 사유 포함");
  });

  test("추세 + 정상 거래량 → noisy=false", () => {
    const trendCloses = Array.from({ length: 30 }, (_, i) => 10 + i * 0.5);
    const a = { candles: mk(trendCloses), volTrend: { avgRel: 1.2 }, relVolNow: 1.2 };
    const res = evaluateNoise(a, CONFIG);
    assert(!res.noisy, `추세+정상거래량은 통과 (CI ${res.ci?.toFixed(1)}, relVol ${res.relVol})`);
  });

  test("저거래량 → noisy=true (거래량 사유)", () => {
    const trendCloses = Array.from({ length: 30 }, (_, i) => 10 + i * 0.5);
    const a = { candles: mk(trendCloses), volTrend: { avgRel: 0.3 }, relVolNow: 0.3 };
    const res = evaluateNoise(a, CONFIG);
    assert(res.noisy, "저거래량은 노이즈");
    assert(res.reasons.includes("거래량 부족"), "거래량 사유 포함");
  });
}
