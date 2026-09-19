// tests/paper-corr.test.js — 후보 상관 판정 + 페이퍼 기록 결말 판정.

import { suite, test, assert, eq } from "./harness.js";
import { returnsFrom, pearson, correlationMap } from "../js/core/correlation.js";
import {
  buildPaperRecord, computePaperMetrics, forwardSnapshots, netRFor, paperCsv, resolveTrade,
} from "../js/ui/paper.js";

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
    eq(rec.schemaVersion, 3);
    eq(rec.plannedRR, 4);
    eq(rec.marketRegime.key, "bull");
    assert(netRFor(rec, 4) < 4, "왕복비용만큼 순 R이 줄어야 함");
  });

  test("저널은 신호 출처·3축·CRT/TBS 확인 상태를 기록 시점에 고정", () => {
    const now = 10_000_000;
    const result = {
      symbol: "SOURCEUSDT", scanMode: "early", direction: "long", score: 72,
      price: 102, signalPrice: 100, signalTime: now - 20 * 60_000, marketPriceAt: now - 30_000,
      plan: { valid: true, entry: 102, invalidation: 96, tp1: 108, tp2: 126 },
      stage: { stage: 3, label: "임박" },
      earlyAxes: {
        potential: { score: 72, label: "강함" },
        readiness: { score: 65, label: "준비", reasons: ["24시간 상승", "거래량 확인"] },
        risk: { score: 80, label: "낮음", reasons: ["위험 조건 없음"] },
      },
      early: { mom14: 20, relVol3: 1.8, rangePos: 0.7, closeAboveEma200: true,
        ema200SlopeOk: true, breakoutClose: false, oi: { change72h: 3, change12h: 1, prev12h: 0.5 } },
      breakdown: [{ key: "momentum", label: "14일 추세 강도", weight: 45, got: 20, hit: true }],
      topSignals: ["14일 추세 강도"],
      crtTbs: {
        available: true, confirmed: true, status: "confirmed", label: "전환 확인", direction: "long",
        asOf: now - 60_000, confirmationTime: now - 60_000,
        range: { high: 110, low: 90, mid: 100, expiresAt: now + 60 * 60_000 },
      },
      earlyConfirmation: { sweepRetest: {
        available: true, confirmed: true, status: "confirmed", label: "첫 눌림 검토 후보",
        expiresAt: now + 60_000, stage: 5, base: { startTime: 1, endTime: 2, crashTime: 0, drop: -20 },
      } },
    };
    const rec = buildPaperRecord(result, { seedMoney: 1_000_000, leverage: 1 }, now);
    eq(rec.schemaVersion, 3);
    eq(rec.signalSources.price.signalPrice, 100);
    eq(rec.signalSources.price.marketPrice, 102);
    eq(rec.signalSources.price.signalFresh, true);
    eq(rec.earlyAxes.readiness.score, 65);
    eq(rec.earlyAxes.readiness.reasons.join("|"), "24시간 상승|거래량 확인");
    eq(rec.confirmationSources.crtTbs.status, "confirmed");
    eq(rec.confirmationSources.crtTbs.freshness.fresh, true);
    eq(rec.confirmationSources.sweepRetest.status, "confirmed");
    // 기록 뒤 원본 결과가 재스캔으로 바뀌어도 저널 레코드는 과거 상태를 유지한다.
    result.earlyAxes.readiness.reasons.push("나중 변경");
    result.early.relVol3 = 99;
    eq(rec.earlyAxes.readiness.reasons.includes("나중 변경"), false);
    eq(rec.signalSources.earlyMetrics.relVol3, 1.8);
  });

  test("만료된 확인 출처는 기록에 남기되, 게이트에서 현재 확인으로 쓰지 않는다", () => {
    const now = 20_000_000;
    const result = {
      symbol: "STALEUSDT", scanMode: "early", direction: "long", score: 60,
      plan: { valid: true, entry: 100, invalidation: 90, tp1: 110, tp2: 120 },
      stage: { stage: 3, label: "임박" },
      crtTbs: {
        available: true, confirmed: true, status: "confirmed", label: "전환 확인", direction: "long",
        // CRT는 5분 최신성도 만족해야 한다. 오래된 asOf는 재스캔 전에는 확인으로 쓰면 안 된다.
        asOf: now - 5 * 60_000 - 1, confirmationTime: now - 60_000,
        range: { expiresAt: now + 60 * 60_000 },
      },
      earlyConfirmation: { sweepRetest: {
        available: true, confirmed: true, status: "confirmed", label: "첫 눌림 검토 후보", expiresAt: now - 1,
      } },
    };
    const rec = buildPaperRecord(result, { seedMoney: 1_000_000, leverage: 1 }, now);
    eq(rec.confirmationSources.crtTbs.status, "expired");
    eq(rec.confirmationSources.crtTbs.originalConfirmed, true);
    eq(rec.confirmationSources.crtTbs.freshness.fresh, false);
    eq(rec.confirmationSources.sweepRetest.status, "expired");
    eq(rec.confirmationSources.sweepRetest.originalConfirmed, true);
    eq(rec.confirmationSources.sweepRetest.freshness.fresh, false);
    const crtGate = rec.decisionGate.checks.find((check) => check.key === "crt");
    eq(crtGate.level, "info", "만료 CRT를 통과로 저장하면 안 된다");
    const sweepGate = rec.decisionGate.checks.find((check) => check.key === "sweep-retest");
    eq(sweepGate.level, "info", "만료된 첫 눌림도 현재 확인으로 쓰면 안 된다");
    eq(result.crtTbs.confirmed, true, "원본 스캔 결과는 저널 기록 때문에 바뀌면 안 된다");
    eq(result.earlyConfirmation.sweepRetest.confirmed, true);
  });

  test("4시간 신호 기준이 만료되면 기록 버튼 경로도 계획을 거부한다", () => {
    const now = 30_000_000;
    const rec = buildPaperRecord({
      symbol: "EXPIREDUSDT", scanMode: "early", direction: "long", score: 70,
      signalExpiresAt: now - 1,
      plan: { valid: true, entry: 100, invalidation: 90, tp1: 110, tp2: 140 },
      stage: { stage: 3, label: "임박" },
    }, { seedMoney: 1_000_000, leverage: 1 }, now);
    eq(rec, null, "화면 만료 타이머 직전에도 오래된 가격 계획은 기록하지 않음");
  });

  test("저널 요약은 종료된 승패만 성과에 포함하고 최대 낙폭을 계산", () => {
    const rows = [
      { rec: { at: 1, closeTs: 10, plannedRR: 2 }, res: { status: "win", netR: 2 } },
      { rec: { at: 2, closeTs: 20, plannedRR: 4 }, res: { status: "loss", netR: -1 } },
      { rec: { at: 3, closeTs: 30, plannedRR: null }, res: { status: "loss", netR: -1 } },
      { rec: { at: 4, plannedRR: null }, res: { status: "open", netR: 9 } },
      { rec: { at: 5, plannedRR: null }, res: { status: "ambiguous", netR: 9 } },
    ];
    const metrics = computePaperMetrics(rows);
    eq(metrics.decided, 3);
    eq(metrics.open, 1);
    eq(metrics.ambiguous, 1);
    eq(metrics.netR, 0);
    eq(metrics.maxDrawdownR, -2);
    eq(metrics.avgPlannedRR, 3, "계획값이 없는 기존 기록을 0R로 세면 안 됨");
  });

  test("CSV 내보내기는 핵심 필드와 쉼표가 든 값을 안전하게 보존", () => {
    const csv = paperCsv([{
      id: "one", symbol: "TESTUSDT", at: 0, direction: "long", entry: 100, stop: 90, tp2: 120,
      decisionGate: { label: "확인, 대기" }, settlement: { status: "win", netR: 2 },
    }]);
    assert(csv.startsWith("id,symbol,recordedAt"), "헤더가 있어야 함");
    assert(csv.includes("signalAt,signalExpiresAt,signalPrice"), "신호 기준가·만료 시각을 내보낼 수 있어야 함");
    assert(csv.includes('"확인, 대기"'), "쉼표가 든 셀은 따옴표로 감싸야 함");
    assert(csv.includes("TESTUSDT"), "종목이 포함돼야 함");
  });
}
