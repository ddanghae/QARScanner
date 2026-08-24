import { suite, test, assert, eq, approx } from "./harness.js";
import {
  EPISODE_GAP_MS,
  FIVE_MIN_MS,
  HOUR_MS,
  createHistoryEvent,
  evaluateHistoryEvent,
  filterHistoryEvents,
  historyEventStatus,
  historyToCsv,
  mergeScanResults,
  nextFiveMinuteBoundary,
  outcomeRefreshDue,
  summarizeHistory,
} from "../js/core/signal-history.js";
import { buildKlineRangePath } from "../js/api/binance.js";

function scanResult(symbol = "TESTUSDT", direction = "long", overrides = {}) {
  const long = direction === "long";
  return {
    scanMode: "reversal",
    symbol,
    baseAsset: symbol.replace("USDT", ""),
    direction,
    price: 100,
    score: 70,
    stage: { stage: 3, label: "구조 전환", badge: "green" },
    grade: { key: "watch", label: "관심 후보" },
    change6h: -3,
    change24h: -8,
    quoteVolume: 50_000_000,
    plan: {
      entry: 100,
      stop: long ? 95 : 105,
      invalidation: long ? 95 : 105,
      tp1: long ? 105 : 95,
      tp2: long ? 110 : 90,
      tp3: long ? 115 : 85,
      valid: true,
      rrText: "1:2.00",
    },
    ...overrides,
  };
}

function bar(openTime, { open = 100, high = 101, low = 99, close = 100 } = {}) {
  return { openTime, closeTime: openTime + FIVE_MIN_MS - 1, open, high, low, close };
}

function flatBars(startTime, count, last = {}) {
  return Array.from({ length: count }, (_, i) => bar(startTime + i * FIVE_MIN_MS, i === count - 1 ? last : {}));
}

export function run() {
  suite("scan history");

  test("가상 진입은 포착 시각보다 엄격히 뒤인 다음 5분 경계", () => {
    eq(nextFiveMinuteBoundary(FIVE_MIN_MS - 1), FIVE_MIN_MS, "경계 직전");
    eq(nextFiveMinuteBoundary(FIVE_MIN_MS), 2 * FIVE_MIN_MS, "경계 정각도 다음 봉");
  });

  test("최초 신호 스냅샷은 반복 스캔으로 바뀌지 않는다", () => {
    const firstAt = 10_000;
    const first = mergeScanResults([], [scanResult()], firstAt);
    const second = mergeScanResults(first.events, [scanResult("TESTUSDT", "long", { price: 150, score: 99 })], firstAt + HOUR_MS);
    eq(second.events.length, 1, "한 사건");
    eq(second.events[0].seenCount, 2, "반복 횟수");
    eq(second.events[0].signal.price, 100, "최초 가격 보존");
    eq(second.events[0].signal.score, 70, "최초 점수 보존");
  });

  test("6시간 이내 반복은 합치고 그보다 긴 공백은 새 사건", () => {
    const firstAt = 10_000;
    let merged = mergeScanResults([], [scanResult()], firstAt);
    merged = mergeScanResults(merged.events, [scanResult()], firstAt + EPISODE_GAP_MS);
    eq(merged.events.length, 1, "6시간 경계 포함");
    merged = mergeScanResults(merged.events, [scanResult()], firstAt + 2 * EPISODE_GAP_MS + 1);
    eq(merged.events.length, 2, "6시간 초과는 새 사건");
  });

  test("임시 신호와 마감 확인 신호는 서로 다른 사건", () => {
    const firstAt = 10_000;
    const provisional = mergeScanResults([], [scanResult()], firstAt, { provisional: true });
    const confirmed = mergeScanResults(provisional.events, [scanResult()], firstAt + HOUR_MS, { provisional: false });
    eq(confirmed.events.length, 2, "상태별 분리");
    eq(confirmed.events.filter((event) => event.provisional).length, 1, "임시 1건");
  });

  test("보관 상한을 넘으면 가장 오래된 사건부터 제외", () => {
    const merged = mergeScanResults([], [scanResult("AUSDT"), scanResult("BUSDT"), scanResult("CUSDT")], 10_000, { maxEvents: 2 });
    eq(merged.events.length, 2, "상한 2건");
    eq(merged.events.map((event) => event.symbol).join(","), "AUSDT,BUSDT", "동률에서도 결정적 보관");
  });

  test("LONG 1시간 방향 수익률은 포착 후 캔들만 사용", () => {
    const event = createHistoryEvent(scanResult(), 12_345);
    const entry = event.paper.entryTime;
    const future = flatBars(entry, 12, { open: 100, high: 111, low: 99, close: 110 });
    const preDetection = bar(entry - FIVE_MIN_MS, { open: 1, high: 1000, low: 0.5, close: 500 });
    const evaluated = evaluateHistoryEvent(event, [preDetection, ...future], entry + HOUR_MS);
    eq(evaluated.paper.entryPrice, 100, "다음 5분봉 시가");
    eq(evaluated.paper.checkpoints["1h"].status, "COMPLETE", "1h 완료");
    approx(evaluated.paper.checkpoints["1h"].returnPct, 10, 1e-9, "LONG +10%");
    eq(evaluated.paper.checkpoints["6h"].status, "PENDING", "6h 대기");
  });

  test("SHORT 방향 수익률은 LONG과 대칭 공식", () => {
    const event = createHistoryEvent(scanResult("TESTUSDT", "short"), 12_345);
    const entry = event.paper.entryTime;
    const close = 100 / 1.1;
    const future = flatBars(entry, 12, { open: 100, high: 101, low: 90, close });
    const evaluated = evaluateHistoryEvent(event, future, entry + HOUR_MS);
    approx(evaluated.paper.checkpoints["1h"].returnPct, 10, 1e-6, "SHORT +10%");
  });

  test("미래 5분봉을 붙여도 1시간 성과는 prefix 계산과 동일", () => {
    const event = createHistoryEvent(scanResult(), 12_345);
    const entry = event.paper.entryTime;
    const prefix = flatBars(entry, 12, { open: 100, high: 111, low: 99, close: 110 });
    const future = flatBars(entry + HOUR_MS, 276, { open: 100, high: 1000, low: 1, close: 500 });
    const prefixResult = evaluateHistoryEvent(event, prefix, entry + HOUR_MS);
    const fullResult = evaluateHistoryEvent(event, [...prefix, ...future], entry + HOUR_MS);
    approx(fullResult.paper.checkpoints["1h"].returnPct, prefixResult.paper.checkpoints["1h"].returnPct, 1e-12, "미래 봉 무영향");
  });

  test("확정된 1시간 성과는 이후 원시 데이터 변화에도 다시 쓰지 않는다", () => {
    const event = createHistoryEvent(scanResult(), 12_345);
    const entry = event.paper.entryTime;
    const original = flatBars(entry, 12, { open: 100, high: 111, low: 99, close: 110 });
    const first = evaluateHistoryEvent(event, original, entry + HOUR_MS);
    const changed = flatBars(entry, 12, { open: 100, high: 101, low: 79, close: 80 });
    const second = evaluateHistoryEvent(first, changed, entry + HOUR_MS + FIVE_MIN_MS);
    approx(second.paper.checkpoints["1h"].returnPct, 10, 1e-12, "확정값 불변");
  });

  test("성숙한 구간에 5분봉 공백이 있으면 INCOMPLETE", () => {
    const event = createHistoryEvent(scanResult(), 12_345);
    const entry = event.paper.entryTime;
    const future = flatBars(entry, 12).filter((_, index) => index !== 5);
    const evaluated = evaluateHistoryEvent(event, future, entry + HOUR_MS);
    eq(evaluated.paper.checkpoints["1h"].status, "INCOMPLETE", "공백 fail closed");
  });

  test("같은 5분봉에서 TP1과 손절을 모두 건드리면 AMBIGUOUS", () => {
    const event = createHistoryEvent(scanResult(), 12_345);
    const entry = event.paper.entryTime;
    const future = flatBars(entry, 12);
    future[0] = bar(entry, { open: 100, high: 106, low: 94, close: 100 });
    const evaluated = evaluateHistoryEvent(event, future, entry + HOUR_MS);
    eq(evaluated.paper.planOutcome.status, "AMBIGUOUS", "봉내 순서 추정 금지");
  });

  test("TP1이 먼저 확정되면 이후 손절 접촉으로 결과가 바뀌지 않는다", () => {
    const event = createHistoryEvent(scanResult(), 12_345);
    const entry = event.paper.entryTime;
    const future = flatBars(entry, 12);
    future[0] = bar(entry, { open: 100, high: 106, low: 99, close: 104 });
    future[1] = bar(entry + FIVE_MIN_MS, { open: 104, high: 105, low: 94, close: 96 });
    const first = evaluateHistoryEvent(event, future, entry + HOUR_MS);
    eq(first.paper.planOutcome.status, "HIT", "TP1 선도달");
    const changed = future.map((candle, index) => index === 0 ? { ...candle, high: 104 } : candle);
    const second = evaluateHistoryEvent(first, changed, entry + HOUR_MS);
    eq(second.paper.planOutcome.status, "HIT", "확정 결과 불변");
  });

  test("24시간 완전 구간에서 MFE와 MAE를 방향별 계산", () => {
    const event = createHistoryEvent(scanResult(), 12_345);
    const entry = event.paper.entryTime;
    const future = flatBars(entry, 288, { open: 100, high: 120, low: 90, close: 110 });
    const evaluated = evaluateHistoryEvent(event, future, entry + 24 * HOUR_MS);
    eq(historyEventStatus(evaluated), "COMPLETE", "24h 완료");
    approx(evaluated.paper.mfePct, 20, 1e-9, "MFE");
    approx(evaluated.paper.maePct, 10, 1e-9, "MAE");
  });

  test("임시 신호는 헤드라인 성과 분모에서 제외", () => {
    const confirmed = createHistoryEvent(scanResult("AUSDT"), 12_345);
    const provisional = createHistoryEvent(scanResult("BUSDT"), 12_345, { provisional: true });
    const entry = confirmed.paper.entryTime;
    const candles = flatBars(entry, 288, { open: 100, high: 111, low: 99, close: 110 });
    const summary = summarizeHistory([
      evaluateHistoryEvent(confirmed, candles, entry + 24 * HOUR_MS),
      evaluateHistoryEvent(provisional, candles, entry + 24 * HOUR_MS),
    ]);
    eq(summary.recordedCount, 2, "전체 기록");
    eq(summary.completedCount, 1, "확인 신호만 완료 분모");
    eq(summary.provisionalCount, 1, "임시 별도");
  });

  test("완료 표본이 없으면 비율과 평균은 null", () => {
    const summary = summarizeHistory([createHistoryEvent(scanResult(), 12_345)]);
    eq(summary.positive24hRate, null, "양수 비율 미정");
    eq(summary.average24hReturnPct, null, "평균 미정");
    eq(summary.tp1BeforeStopRate, null, "TP1 비율 미정");
  });

  test("기간·모드·방향·임시 상태 필터를 함께 적용", () => {
    const now = 100 * 24 * HOUR_MS;
    const current = createHistoryEvent(scanResult("AUSDT", "short", { scanMode: "pump_fade" }), now - HOUR_MS, { provisional: true });
    const old = createHistoryEvent(scanResult("BUSDT"), now - 10 * 24 * HOUR_MS);
    const filtered = filterHistoryEvents([current, old], { period: "7d", mode: "pump_fade", direction: "short", status: "provisional" }, now);
    eq(filtered.length, 1, "복합 필터");
    eq(filtered[0].symbol, "AUSDT", "현재 임시 SHORT");
  });

  test("진입 봉 마감 전에는 성과 갱신 대상이 아니다", () => {
    const event = createHistoryEvent(scanResult(), 12_345);
    eq(outcomeRefreshDue(event, event.paper.entryTime + FIVE_MIN_MS - 1), false, "마감 전");
    eq(outcomeRefreshDue(event, event.paper.entryTime + FIVE_MIN_MS), true, "마감 후");
  });

  test("Binance 범위 조회는 정확한 시작·종료 시각과 상한을 사용", () => {
    const path = buildKlineRangePath("btcusdt", "5m", 1_000, 2_000, 9_999);
    assert(path.includes("symbol=BTCUSDT"), "심볼 정규화");
    assert(path.includes("startTime=1000&endTime=2000&limit=1500"), "범위와 API 상한");
  });

  test("CSV는 음수 포함 유한 숫자를 숫자 셀로 보존하고 문자열 수식만 이스케이프", () => {
    const event = createHistoryEvent(scanResult("CSVUSDT"), 12_345);
    event.paper.entryPrice = 100;
    event.paper.checkpoints["1h"] = { status: "COMPLETE", returnPct: -2.5 };
    event.paper.mfePct = 3.25;
    event.paper.maePct = -1.75;
    const csv = historyToCsv([event]);
    const row = csv.split("\r\n")[1];
    assert(row.includes(",100,"), "진입 가격 숫자 셀");
    assert(row.includes(",-2.5,"), "음수 수익률 숫자 셀");
    assert(row.includes(",3.25,-1.75,"), "MFE/MAE 숫자 셀");
    assert(!row.includes("'-2.5"), "음수 숫자에 수식 이스케이프 없음");
  });
}
