// tests/liquidity.test.js — 유동성/스윕/FVG 검증.

import { suite, test, assert } from "./harness.js";
import { swingLevels, detectLowSweep, targetLiquidity } from "../js/core/liquidity.js";
import { detectFvgs } from "../js/core/fvg.js";
import { atr, last } from "../js/core/indicators.js";
import { candlesFromCloses, mkCandle } from "./fixtures.js";
import { CONFIG } from "../js/config.js";

export function run() {
  suite("liquidity");

  test("저점 스윕 후 회복 감지", () => {
    // 이전 스윙 저점 형성 → 그 아래로 잠깐 이탈 → 종가 회복 → 추가 저점 없음
    const closes = [
      20, 19, 18, 17, 16, 15, 16, 17, 16, 15.2, // swing low ~ 15 부근
      16, 17, 18, 17, 16, 15.1, // 두번째 저점
      16, 17, 18, 19, // 상승
    ];
    const c = candlesFromCloses(closes, { spread: 0.3 });
    // 마지막 근처에 스윙 저점 아래 이탈 캔들 삽입
    const lows = swingLevels(c, 5).lows;
    assert(lows.length >= 1, "스윙 저점 존재");
    // 인위적 스윕 캔들: 이전 저점보다 낮은 low, 회복 close
    const priorLow = lows[lows.length - 1].price;
    c.push(mkCandle(c.at(-1).close, c.at(-1).close + 0.5, priorLow - 1, priorLow + 0.8, c.length, 300, 120));
    c.push(mkCandle(priorLow + 0.8, priorLow + 2, priorLow + 0.5, priorLow + 1.8, c.length, 200, 130));
    const sweep = detectLowSweep(c, swingLevels(c, 5).lows, { avgVol: 100 });
    assert(sweep, "스윕 객체 반환");
    assert(sweep.type === "low_sweep", "저점 스윕 타입");
  });

  test("목표 유동성 위/아래 분리", () => {
    const c = candlesFromCloses([10, 12, 9, 13, 8, 14, 7, 15, 11], { spread: 0.2 });
    const { highs, lows } = swingLevels(c, 2);
    const price = 11;
    const t = targetLiquidity(price, highs, lows);
    if (t.buySideTarget != null) assert(t.buySideTarget > price, "buy-side 는 현재가 위");
    if (t.sellSideTarget != null) assert(t.sellSideTarget < price, "sell-side 는 현재가 아래");
  });

  test("Bullish FVG 탐지 (3캔들 갭)", () => {
    // candle[i-2].high < candle[i].low 인 명확한 임펄스
    const c = [
      mkCandle(10, 10.5, 9.8, 10.2, 0),
      mkCandle(10.2, 12.5, 10.1, 12.3, 1),  // 큰 상승 임펄스
      mkCandle(12.3, 13, 11.0, 12.8, 2),    // low(11) > candle0.high(10.5) → gap
    ];
    // ATR 필요
    const a = last(atr(c.concat(Array.from({length:20},(_,i)=>mkCandle(12,13,11,12,3+i))), 14)) || 1;
    const fvgs = detectFvgs(c, 0.1, CONFIG); // 작은 atr 로 필터 통과
    assert(fvgs.some((f) => f.dir === "bullish"), "Bullish FVG 존재");
  });

  test("작은 FVG 크기 필터 제외", () => {
    const c = [
      mkCandle(100, 100.05, 99.95, 100.02, 0),
      mkCandle(100.02, 100.1, 100.0, 100.06, 1),
      mkCandle(100.06, 100.12, 100.055, 100.1, 2), // 극소 갭
    ];
    const fvgs = detectFvgs(c, 5, CONFIG); // 큰 ATR → 작은 갭 제외
    assert(!fvgs.length, "너무 작은 FVG 는 제외");
  });
}
