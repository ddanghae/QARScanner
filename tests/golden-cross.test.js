// tests/golden-cross.test.js — 골든크로스 리테스트 감지 검증.
// 시나리오: 급락 → 장기 횡보(EMA200 시드 안정화) → 임펄스 돌파 → 골든크로스 →
// 되돌림(50·200선 리테스트) → (거부 캔들 유무) → 버팀.

import { suite, test, eq, assert } from "./harness.js";
import { ema, atr } from "../js/core/indicators.js";
import { detectGoldenCrossRetest } from "../js/core/golden-cross-retest.js";
import { CONFIG } from "../js/config.js";

// spread 작게 → 캔들 몸통 위주(꼬리 거의 없음). 거부 캔들만 별도로 큰 위꼬리를 주입해 구분.
function candlesFromCloses(closes, spread = 0.02) {
  let prev = closes[0];
  return closes.map((c, i) => {
    const open = i === 0 ? c : prev;
    prev = c;
    return { openTime: i, open, high: Math.max(open, c) + spread, low: Math.min(open, c) - spread, close: c, volume: 100 };
  });
}

// 급락(30) → 장기 횡보(250, EMA200 시드가 횡보 구간에 안착) → 임펄스 돌파(3) →
// 고점 유지(20) → 얕은 되돌림(15, 200선 안 잃는 정도) → 거부 캔들 자리(1) → 버팀+반등(15)
function buildBaseCloses() {
  const closes = [];
  for (let i = 0; i < 30; i++) closes.push(20 - (10 * i) / 29);
  for (let i = 0; i < 250; i++) closes.push(10 + Math.sin(i / 7) * 0.15);
  for (let i = 1; i <= 3; i++) closes.push(10 + (6 * i) / 3);
  for (let i = 0; i < 20; i++) closes.push(16 - i * 0.05);
  for (let i = 0; i < 15; i++) closes.push(15 - (2.8 * i) / 14);
  closes.push(12.4);
  for (let i = 1; i <= 15; i++) closes.push(12.4 + i * 0.1);
  return closes;
}
const REJECT_IDX = 30 + 250 + 3 + 20 + 15; // "거부 캔들 자리" 인덱스

function analyze(candles) {
  const closes = candles.map((c) => c.close);
  const e50 = ema(closes, 50), e200 = ema(closes, 200);
  const atrArr = atr(candles, 14);
  return detectGoldenCrossRetest(candles, e50, e200, atrArr[atrArr.length - 1], CONFIG);
}

export function run() {
  suite("golden-cross");

  test("완전한 패턴(거부 캔들 포함) → detected + hasRejection", () => {
    const candles = candlesFromCloses(buildBaseCloses());
    // 거부 캔들 주입: 위로 크게 찔렀다가 종가는 몸통 하단, 그래도 200선 위
    candles[REJECT_IDX].open = candles[REJECT_IDX].close + 1.0;
    candles[REJECT_IDX].high = candles[REJECT_IDX].open + 2.0;
    candles[REJECT_IDX].low = candles[REJECT_IDX].close - 0.1;
    const res = analyze(candles);
    eq(res.detected, true, "패턴 감지");
    eq(res.hasRejection, true, "거부 캔들 감지");
    eq(res.rejectTime, REJECT_IDX, "거부 캔들 위치 정확히 매칭");
  });

  test("거부 캔들 없음 → detected true, hasRejection false", () => {
    const candles = candlesFromCloses(buildBaseCloses()); // 주입 없음
    const res = analyze(candles);
    eq(res.detected, true, "리테스트 자체는 감지됨");
    eq(res.hasRejection, false, "거부 캔들은 없음");
    eq(res.rejectTime, null, "거부 캔들 시각 없음");
  });

  test("돌파 임펄스 없는 순수 횡보 → detected false", () => {
    const closes = [];
    for (let i = 0; i < 300; i++) closes.push(10 + Math.sin(i / 9) * 0.1);
    const res = analyze(candlesFromCloses(closes));
    eq(res.detected, false, "임펄스 없으면 감지 안 됨");
  });

  test("리테스트가 200선 아래로 종가 이탈 → detected false", () => {
    const closes = buildBaseCloses();
    // 되돌림 구간을 훨씬 깊게(11.5까지) 눌러 200선을 잃게 만듦
    const retestStart = 30 + 250 + 3 + 20;
    for (let i = 0; i < 15; i++) closes[retestStart + i] = 15 - (3.5 * i) / 14;
    const res = analyze(candlesFromCloses(closes));
    eq(res.detected, false, "종가가 200선 아래로 이탈하면 감지 안 됨");
    assert(res.reason.includes("이탈"), `이탈 사유 반환 (실제: ${res.reason})`);
  });
}
