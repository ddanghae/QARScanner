// tests/paper-corr.test.js — 후보 상관 판정 + 페이퍼 기록 결말 판정.

import { suite, test, assert, eq } from "./harness.js";
import { returnsFrom, pearson, correlationMap } from "../js/core/correlation.js";
import { resolveTrade, signalStats } from "../js/ui/paper.js";

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

  test("결말 판정 — 같은 봉에서 둘 다 닿으면 손절 우선", () => {
    const rec = { at: 0, entry: 100, stop: 90, tp2: 140 };
    const r = resolveTrade(rec, [bar(100, 150, 85, 145, 1000)]);
    eq(r.status, "loss", "봉 내부 순서를 모르므로 보수적으로 손절");
    eq(r.r, -1);
  });

  test("결말 판정 — 먼저 닿은 봉이 이긴다", () => {
    const rec = { at: 0, entry: 100, stop: 90, tp2: 140 };
    const win = resolveTrade(rec, [bar(100, 145, 99, 143, 1000), bar(143, 150, 80, 85, 2000)]);
    eq(win.status, "win", "목표를 먼저 친 뒤의 폭락은 이미 청산된 뒤다");
    eq(win.r, 4);
  });

  // 신호별 승률이 틀리면 점수 가중치를 엉뚱하게 고친다 — 진행 중을 분모에 넣는 게 가장 흔한 실수다.
  test("신호별 집계 — 닫힌 기록만, 신호 3개면 3개 전부에 계상", () => {
    const rows = [
      { rec: { signals: ["골든크로스", "OB"] }, res: { status: "win", r: 3 } },
      { rec: { signals: ["골든크로스"] },       res: { status: "loss", r: -1 } },
      { rec: { signals: ["골든크로스"] },       res: { status: "open", r: 2 } },  // 분모 제외
    ];
    const s = signalStats(rows);
    eq(s.length, 2, "신호 종류만큼");
    eq(s[0].name, "골든크로스", "표본 많은 순");
    eq(s[0].n, 2, "진행 중은 세지 않는다");
    eq(s[0].wins, 1);
    eq(s[0].totalR, 2, "3R + (-1R)");
    eq(s[1].n, 1, "OB 는 1건");
    eq(signalStats([]).length, 0, "기록 없으면 빈 배열");
    eq(signalStats([{ rec: {}, res: { status: "win", r: 1 } }]).length, 0, "signals 없는 과거 기록은 건너뛴다");
  });
}
