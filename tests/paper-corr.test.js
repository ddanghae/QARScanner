// tests/paper-corr.test.js — 후보 상관 판정 + 페이퍼 기록 결말 판정.

import { suite, test, assert, eq } from "./harness.js";
import { returnsFrom, pearson, correlationMap } from "../js/core/correlation.js";
import { buildPaperRecord, forwardSnapshots, netRFor, resolveTrade } from "../js/ui/paper.js";

const bar = (o, h, l, c, t) => ({ time: t, open: o, high: h, low: l, close: c, volume: 1 });
const fromCloses = (closes, t0 = 0) =>
  closes.map((c, i) => bar(c, c, c, c, t0 + i * 3600_000));

export function run() {
  suite("correlation");

  test("수익률 변환 — n+1 개 종가에서 n 개 수익률", () => {
    const r = returnsFrom(fromCloses([100, 110, 99]), 2);
    eq(r.length, 2);
    assert(Math.abs(r[0] - 0.1) < 1e-9, `첫 수익률 +10% (${r[0]})`);
    assert(Math.abs(r[1] + 0.1) < 1e-9, `둘째 수익률 -10% (${r[1]})`);
    eq(returnsFrom(fromCloses([100, 110]), 5), null, "표본 모자라면 null");
  });

  test("피어슨 — 같은 방향 +1, 반대 -1, 상수는 null", () => {
    assert(Math.abs(pearson([1, 2, 3], [2, 4, 6]) - 1) < 1e-9, "완전 양의 상관");
    assert(Math.abs(pearson([1, 2, 3], [6, 4, 2]) + 1) < 1e-9, "완전 음의 상관");
    eq(pearson([1, 1, 1], [1, 2, 3]), null, "분산 0 이면 상관 정의 안 됨");
    eq(pearson([1], [1]), null, "표본 1개는 null");
  });

  // 화면에 3개가 떠도 셋이 같이 움직이면 분산이 아니다 — 그걸 잡는 게 이 기능의 전부다.
  test("상관 맵 — 임계값 넘는 짝만, 양쪽 모두에 기록", () => {
    const up = [0.01, 0.02, -0.01, 0.03, -0.02];
    const same = up.map((x) => x * 1.5);            // 같은 방향
    const other = [0.02, -0.03, 0.01, -0.01, 0.02]; // 다른 방향
    const map = correlationMap([
      { symbol: "AUSDT", returns: up },
      { symbol: "BUSDT", returns: same },
      { symbol: "CUSDT", returns: other },
    ], 0.7);
    eq(map.get("AUSDT").length, 1, "A 는 B 하고만 짝");
    eq(map.get("AUSDT")[0].symbol, "BUSDT");
    eq(map.get("BUSDT")[0].symbol, "AUSDT", "양쪽 모두에 기록돼야 한 쪽만 배지가 붙는 일이 없다");
    eq(map.get("CUSDT").length, 0, "임계값 미만은 버린다");
  });

  suite("paper");

  // 기록 시각 이후 캔들만 봐야 한다 — 과거 캔들로 판정하면 즉시 승패가 찍힌다.
  test("결말 판정 — 기록 이전 캔들은 무시한다", () => {
    const rec = { at: 5000, entry: 100, stop: 90, tp2: 140 };
    const past = [bar(100, 200, 50, 100, 1000)];   // 기록 전: 손절·목표 둘 다 닿았지만 무시
    eq(resolveTrade(rec, past).status, "open", "기록 전 캔들로 판정하면 안 됨");
  });

  // 실제 앱 캔들은 time 이 아니라 openTime/closeTime 이다. 필드를 잘못 보면 필터가 전부를
  // 걸러내 모든 기록이 영원히 "진행 중" 으로 남는다 — 조용해서 눈치채기 어렵다.
  test("결말 판정 — api/binance.js 의 openTime/closeTime 필드를 읽는다", () => {
    const rec = { at: 1000, entry: 100, stop: 90, tp2: 140 };
    const real = [{ openTime: 2000, closeTime: 3000, open: 100, high: 145, low: 99, close: 143 }];
    eq(resolveTrade(rec, real).status, "win", "openTime 을 못 읽으면 open 으로 남는다");
    // 아직 안 닫힌 봉은 고·저가 안 굳었으므로 제외한다.
    const live = [{ openTime: 2000, closeTime: Date.now() + 3600_000, open: 100, high: 145, low: 99, close: 143 }];
    eq(resolveTrade(rec, live).status, "open", "진행 중인 봉으로 판정하면 안 됨");
  });

  test("결말 판정 — 손절/목표/진행 중", () => {
    const rec = { at: 0, entry: 100, stop: 90, tp2: 140 };
    eq(resolveTrade(rec, [bar(100, 105, 89, 92, 1000)]).status, "loss");
    eq(resolveTrade(rec, [bar(100, 145, 99, 143, 1000)]).status, "win");
    const open = resolveTrade(rec, [bar(100, 120, 95, 118, 1000)]);
    eq(open.status, "open");
    assert(Math.abs(open.r - 1.8) < 1e-9, `진행 중 평가손익도 R 로 (${open.r})`);
  });

  test("결말 판정 — 같은 봉에서 둘 다 닿으면 승패에서 제외", () => {
    const rec = { at: 0, entry: 100, stop: 90, tp2: 140 };
    const r = resolveTrade(rec, [bar(100, 150, 85, 145, 1000)]);
    eq(r.status, "ambiguous", "봉 내부 순서를 모르므로 모호 사례로 분리");
    eq(r.r, null);
  });

  test("결말 판정 — 먼저 닿은 봉이 이긴다", () => {
    const rec = { at: 0, entry: 100, stop: 90, tp2: 140 };
    const win = resolveTrade(rec, [bar(100, 145, 99, 143, 1000), bar(143, 150, 80, 85, 2000)]);
    eq(win.status, "win", "목표를 먼저 친 뒤의 폭락은 이미 청산된 뒤다");
    eq(win.r, 4);
  });

  test("SHORT 기록은 위 손절·아래 목표를 올바르게 판정", () => {
    const rec = { at: 0, direction: "short", entry: 100, stop: 110, tp2: 80 };
    const win = resolveTrade(rec, [bar(100, 101, 79, 82, 1000)]);
    eq(win.status, "win");
    eq(win.r, 2);
    const loss = resolveTrade(rec, [bar(100, 111, 95, 108, 1000)]);
    eq(loss.status, "loss");
    eq(loss.r, -1);
  });

  test("Forward snapshot은 1·3·6·24시간 가격 경로를 고정", () => {
    const hour = 3600_000;
    const rec = { at: 1000, direction: "long", entry: 100, stop: 90, tp2: 140 };
    const candles = Array.from({ length: 24 }, (_, i) => ({
      openTime: 1001 + i * hour,
      closeTime: 1000 + (i + 1) * hour,
      open: 100 + i,
      high: 101 + i,
      low: 99 + i,
      close: 101 + i,
    }));
    const snap = forwardSnapshots(rec, candles, [1, 3, 6, 24], 1000 + 25 * hour);
    eq(snap.length, 4);
    eq(snap[0].status, "ready");
    assert(Math.abs(snap[0].changePct - 1) < 1e-9, "1시간 수익률");
    assert(Math.abs(snap[3].changePct - 24) < 1e-9, "24시간 수익률");
  });

  test("새 기록은 계획·국면·확률을 복사하고 비용 후 R을 계산", () => {
    const rec = buildPaperRecord({
      symbol: "TESTUSDT", scanMode: "early", direction: "long", score: 70,
      plan: { valid: true, entry: 100, invalidation: 90, tp1: 110, tp2: 140 },
      stage: { stage: 2, label: "임박" }, grade: { key: "strong", label: "강한 후보" },
      forecast: { available: true, up: 55, down: 25, neutral: 20, lead: "up" },
      marketRegime: { available: true, key: "bull", label: "상승 국면", bias: "long" },
      regimeFit: { key: "aligned", label: "시장 흐름 우호" },
    }, { seedMoney: 1_000_000, leverage: 1 }, 1234);
    eq(rec.schemaVersion, 2);
    eq(rec.plannedRR, 4);
    eq(rec.marketRegime.key, "bull");
    assert(netRFor(rec, 4) < 4, "왕복비용만큼 순 R이 줄어야 함");
  });
}
