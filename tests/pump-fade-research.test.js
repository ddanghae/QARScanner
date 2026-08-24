// tests/pump-fade-research.test.js — 연구 라벨과 시간순 분할의 순수 함수 검증.

import { suite, test, assert, eq, approx } from "./harness.js";
import {
  chronologicalBoundaries,
  labelPumpFadeOutcome,
  liftFrom,
  splitChronologically,
  summarizeOutcomes,
} from "../research/pump-fade-research-core.mjs";

const MIN5 = 5 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const bar = (closeTime, high, low, close) => ({ closeTime, high, low, close });

export function run() {
  suite("pump fade research");

  test("-8%가 +5%보다 먼저 도달하면 HIT", () => {
    const result = labelPumpFadeOutcome([
      bar(MIN5, 102, 91, 93),
      bar(2 * MIN5, 94, 90, 91),
    ], 0, 100);
    eq(result.status, "HIT", "목표 우선");
    eq(result.returnPct, 8, "SHORT 목표 수익률");
  });

  test("+5%가 -8%보다 먼저 도달하면 STOP", () => {
    const result = labelPumpFadeOutcome([
      bar(MIN5, 106, 98, 104),
      bar(2 * MIN5, 104, 90, 92),
    ], 0, 100);
    eq(result.status, "STOP", "손절 우선");
    eq(result.returnPct, -5, "손절 수익률");
  });

  test("같은 5분봉에서 목표와 손절을 모두 건드리면 AMBIGUOUS", () => {
    const result = labelPumpFadeOutcome([bar(MIN5, 106, 91, 100)], 0, 100);
    eq(result.status, "AMBIGUOUS", "봉내 순서 미확정");
    eq(result.returnPct, null, "수익률 강제 추정 금지");
  });

  test("6시간 결과 구간이 끝까지 없으면 INCOMPLETE", () => {
    const result = labelPumpFadeOutcome([bar(MIN5, 101, 99, 100)], 0, 100);
    eq(result.status, "INCOMPLETE", "미완성 라벨");
  });

  test("종료 직전 마지막 5분봉 하나가 없어도 INCOMPLETE", () => {
    const candles = Array.from({ length: 71 }, (_, i) => bar((i + 1) * MIN5, 101, 99, 100));
    const result = labelPumpFadeOutcome(candles, 0, 100);
    eq(result.status, "INCOMPLETE", "마지막 한 봉 누락을 MISS로 확정하지 않음");
  });

  test("6시간 전체 5분봉이 연속일 때만 MISS 확정", () => {
    const candles = Array.from({ length: 72 }, (_, i) => bar((i + 1) * MIN5, 101, 99, 100));
    const result = labelPumpFadeOutcome(candles, 0, 100);
    eq(result.status, "MISS", "완전한 관찰 구간");
  });

  test("중간 5분봉 공백은 사후 경로 순서를 알 수 없어 INCOMPLETE", () => {
    const candles = Array.from({ length: 72 }, (_, i) => bar((i + 1) * MIN5, 101, 99, 100))
      .filter((c) => c.closeTime !== 20 * MIN5);
    const result = labelPumpFadeOutcome(candles, 0, 100);
    eq(result.status, "INCOMPLETE", "중간 공백 fail closed");
  });

  test("요약은 ambiguous/incomplete를 분모에서 분리", () => {
    const samples = [
      { signalTime: 1, outcome: { status: "HIT", returnPct: 8, mfePct: 9, maePct: 2 } },
      { signalTime: 2, outcome: { status: "STOP", returnPct: -5, mfePct: 1, maePct: 6 } },
      { signalTime: 3, outcome: { status: "AMBIGUOUS", returnPct: null, mfePct: 8, maePct: 5 } },
      { signalTime: 4, outcome: { status: "INCOMPLETE", returnPct: null, mfePct: null, maePct: null } },
    ];
    const summary = summarizeOutcomes(samples);
    eq(summary.sampleCount, 4, "전체 표본");
    eq(summary.evaluableCount, 2, "평가 가능 표본");
    approx(summary.hitRate, 0.5, 1e-9, "hit rate");
    approx(summary.profitFactor, 1.6, 1e-9, "PF");
    eq(summary.ambiguousCount, 1, "동시 장벽 수");
    eq(summary.incompleteCount, 1, "미완성 수");
  });

  test("시간순 60/20/20 분리에서 경계 직전 6시간은 purge", () => {
    const boundaries = chronologicalBoundaries(0, 100, 0.6, 0.2);
    const samples = [
      { signalTime: 40 },
      { signalTime: 55 },
      { signalTime: 65 },
      { signalTime: 75 },
      { signalTime: 85 },
      { signalTime: 95 },
    ];
    const split = splitChronologically(samples, boundaries, 10);
    eq(split.train.length, 1, "train");
    eq(split.validation.length, 1, "validation");
    eq(split.test.length, 1, "test");
    eq(split.purged.length, 3, "경계 purge");
  });

  test("lift는 signal hit rate / base rate", () => {
    approx(liftFrom({ hitRate: 0.4 }, { hitRate: 0.2 }), 2, 1e-9, "2배 lift");
    eq(liftFrom({ hitRate: 0.4 }, { hitRate: 0 }), null, "0 base rate는 미정");
  });
}
