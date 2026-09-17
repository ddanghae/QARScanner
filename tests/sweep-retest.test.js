import { suite, test, assert, eq } from "./harness.js";
import { detectSweepRetest, findSweepBase, buildSweepResult } from "../js/core/sweep-retest.js";
import { expireResult } from "../js/core/signal-freshness.js";
import { buildDecisionGate } from "../js/core/decision-gate.js";
import { renderDetail } from "../js/ui/detail-panel.js";

const H = 3600000, M15 = 900000, M5 = 300000;
const START = 1700002800000;
const candle = (start, interval, open, high, low, close, volume = 20) => ({
  openTime: start, closeTime: start + interval - 1, open, high, low, close, volume,
});
const clone = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const now = START + 34 * H;
  const h1 = [];
  let open = 120;
  for (let i = 0; i < 6; i++) {
    const close = [116, 112, 108, 104, 100, 98][i];
    h1.push(candle(START + i * H, H, open, open + 0.5, close - 0.5, close, 100));
    open = close;
  }
  for (let i = 6; i < 30; i++) h1.push(candle(START + i * H, H, 100, 101.2, 99.5, i % 2 ? 100.2 : 100, 20));
  for (let i = 30; i < 34; i++) h1.push(candle(START + i * H, H, 100.4, 103, 98.8, 101.6, 35));

  const m15 = Array.from({ length: 136 }, (_, i) => candle(START + i * M15, M15, 100.2, 100.8, 100, 100.4, 20));
  m15[121] = candle(START + 121 * M15, M15, 100.2, 100.5, 99.5, 100, 20);
  m15[124].high = 101.5;
  m15[127] = candle(START + 127 * M15, M15, 100, 100.3, 99, 99.7, 20);
  m15[130] = candle(START + 130 * M15, M15, 100.6, 102.1, 100.5, 101.8, 40);
  m15[131] = candle(START + 131 * M15, M15, 101.8, 102.3, 101.65, 102, 20);
  m15[132] = candle(START + 132 * M15, M15, 101.8, 101.9, 101.35, 101.65, 20);
  for (let i = 133; i < 136; i++) m15[i] = candle(START + i * M15, M15, 101.6, 101.9, 101.4, 101.7, 20);

  const m5 = Array.from({ length: 408 }, (_, i) => candle(START + i * M5, M5, 100.2, 100.6, 100.1, 100.4, 20));
  for (let i = 384; i < 405; i++) m5[i] = candle(START + i * M5, M5, 101.3, 101.55, 101.2, 101.45, 20);
  m5[405] = candle(START + 405 * M5, M5, 101.45, 101.9, 101.4, 101.75, 40);
  for (let i = 406; i < 408; i++) m5[i] = candle(START + i * M5, M5, 101.6, 101.85, 101.4, 101.7, 20);

  const btc4h = Array.from({ length: 9 }, (_, i) => candle(START + i * 4 * H, 4 * H, 100, 101, 99, i === 7 ? 100.5 : 100, 100));
  return { h1, m15, m5, btc4h, now };
}

export function run() {
  suite("sweep retest");

  test("급락은 횡보 이전 6시간, 매집은 20~40시간으로 분리한다", () => {
    const f = fixture();
    const base = findSweepBase(f.h1, f.now, {}, f.m15[121].openTime);
    assert(base, "선행 베이스 탐지");
    eq(base.bars, 24, "매집 봉 수");
    assert(base.drop <= -15, "선행 급락");
    assert(base.volumeRatio <= 0.65, "거래량 감소");
  });

  test("급락→매집→W 스윕→회수→돌파→첫 눌림→5분 확인을 순서대로 확정", () => {
    const p = detectSweepRetest(fixture());
    eq(p.status, "confirmed", "최종 상태");
    eq(p.stage, 5, "진행 단계");
    eq(p.events.map(x => x.label).join("|"), "급락|매집 완료|W 첫 저점|저점 스윕|전저점 회수|넥라인 돌파·거래량 확대|첫 눌림 후보|5분 구조전환·거래량", "이벤트 순서");
    assert(p.expiresAt > fixture().now, "확인 TTL");
  });

  test("두 번째 저점 방어형 W도 허용한다", () => {
    const f = fixture();
    f.m15[127].low = 99.7;
    const p = detectSweepRetest(f);
    eq(p.status, "confirmed", "방어형 확정");
    assert(p.events.some(x => x.label === "저점 방어"), "방어 이벤트");
  });

  test("3개 15분봉 안에 회수하지 못하면 무효", () => {
    const f = fixture();
    for (const i of [127, 128, 129]) {
      f.m15[i].close = 99.3;
      f.m15[i].low = i === 127 ? 99 : 99.2;
    }
    const p = detectSweepRetest(f);
    eq(p.status, "invalid", "회수 실패 상태");
    eq(p.label, "회수 실패", "회수 실패 사유");
  });

  test("거래량 없는 넥라인 돌파는 무효", () => {
    const f = fixture();
    f.m15[130].volume = 20;
    const p = detectSweepRetest(f);
    eq(p.status, "invalid", "거래량 실패 상태");
    eq(p.label, "거래량 없는 돌파", "거래량 실패 사유");
  });

  test("재상승 뒤 두 번째 눌림을 첫 눌림으로 재사용하지 않는다", () => {
    const f = fixture();
    f.m15[133] = candle(START + 133 * M15, M15, 101.7, 102.6, 101.5, 102.4, 20);
    f.m15[134] = candle(START + 134 * M15, M15, 102.2, 102.3, 101.3, 101.7, 20);
    const p = detectSweepRetest(f);
    eq(p.status, "invalid", "두 번째 눌림 상태");
    eq(p.label, "두 번째 눌림", "첫 눌림 고정");
  });

  test("BTC 급락과 BTC 자료 누락은 최종 후보로 확정하지 않는다", () => {
    const drop = fixture();
    Object.assign(drop.btc4h[7], { open: 100, high: 100.5, low: 95.5, close: 96 });
    eq(detectSweepRetest(drop).status, "blocked", "BTC 급락 차단");
    const missing = fixture();
    missing.btc4h = [];
    eq(detectSweepRetest(missing).status, "unavailable", "BTC 누락 보류");
  });

  test("미래 진행 봉을 추가해도 마감봉 판정은 바뀌지 않는다", () => {
    const f = fixture();
    const before = detectSweepRetest(f);
    f.m15.push(candle(f.now, M15, 101, 999, 1, 2, 99999));
    f.m5.push(candle(f.now, M5, 101, 999, 1, 2, 99999));
    const after = detectSweepRetest(f);
    eq(after.status, before.status, "미래 봉 상태 불변");
    eq(after.events.map(x => x.time).join(","), before.events.map(x => x.time).join(","), "이벤트 시각 불변");
  });

  test("누락된 시간봉은 추측하지 않고 자료 보류", () => {
    const f = fixture();
    f.m15.splice(100, 1);
    eq(detectSweepRetest(f).status, "unavailable", "연속성 실패");
  });

  test("결과는 진입가를 꾸며내지 않고 TTL 뒤 확인 상태가 만료된다", () => {
    const f = fixture();
    const r = buildSweepResult({ symbol: "TESTUSDT", quoteVolume: 1e8 }, f);
    assert(r && r.sweepRetest.confirmed, "결과 조립");
    eq(r.plan.valid, false, "계획 미산출");
    eq(r.plan.entry, null, "진입가 미산출");
    eq(buildDecisionGate(r, f.now).status, "review", "무효 계획으로 오판하지 않음");
    const html = renderDetail(r);
    assert(html.includes("진행 5/5") && html.includes("스윕 후 첫 눌림 탐지"), "전용 상세 표시");
    assert(!html.includes("진입 후보") && !html.includes("예상 손익비"), "가짜 거래 계획 숨김");
    const expired = expireResult(r, r.sweepRetest.expiresAt);
    eq(expired.sweepRetest.status, "expired", "TTL 만료");
    eq(expired.stage.stage, 4, "확인 단계 회수");
    eq(buildDecisionGate(expired, r.sweepRetest.expiresAt).status, "wait", "만료 후 대기");
  });
}
