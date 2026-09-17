// tests/market-regime.test.js — BTC 시장국면은 마감봉만 입력받는 순수 계산이다.

import { suite, test, assert, eq } from "./harness.js";
import { analyzeMarketRegime, regimeAlignment } from "../js/core/market-regime.js";

const FOUR_HOURS = 4 * 60 * 60 * 1000;

function trendCandles(start, step, count = 120, now = Date.now()) {
  return Array.from({ length: count }, (_, i) => {
    const close = start + step * i;
    const open = close - step * 0.4;
    return {
      openTime: now - (count - i) * FOUR_HOURS,
      closeTime: now - (count - i - 1) * FOUR_HOURS - 1,
      open,
      high: Math.max(open, close) * 1.003,
      low: Math.min(open, close) * 0.997,
      close,
      volume: 1000,
    };
  });
}

export function run() {
  suite("market regime");

  test("상승 추세는 LONG 우호, SHORT 역행으로 분류", () => {
    const now = Date.now();
    const regime = analyzeMarketRegime(trendCandles(100, 1, 120, now), {}, now);
    assert(regime.available, regime.reason);
    eq(regime.key, "bull");
    eq(regime.bias, "long");
    eq(regimeAlignment(regime, "long").key, "aligned");
    eq(regimeAlignment(regime, "short").key, "counter");
  });

  test("하락 추세는 SHORT 우호로 분류", () => {
    const now = Date.now();
    const regime = analyzeMarketRegime(trendCandles(300, -1, 120, now), {}, now);
    assert(regime.available, regime.reason);
    eq(regime.key, "bear");
    eq(regime.bias, "short");
    eq(regimeAlignment(regime, "short").key, "aligned");
  });

  test("표본 부족과 오래된 데이터는 산출 보류", () => {
    const now = Date.now();
    eq(analyzeMarketRegime(trendCandles(100, 1, 30, now), {}, now).available, false);
    const stale = trendCandles(100, 1, 120, now - 24 * 60 * 60 * 1000);
    eq(analyzeMarketRegime(stale, {}, now).available, false);
  });
}
