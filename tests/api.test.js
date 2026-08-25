// tests/api.test.js — 요청 중단·과호출 보호 회귀 테스트.

import { suite, test, assert, eq } from "./harness.js";
import { CONFIG } from "../js/config.js";
import { state, on } from "../js/state.js";
import {
  getKlines, getTicker24h, getOpenInterestHist, getPremiumIndexAll, shouldRetryError, retryDelayFor,
  apiRuntimeSnapshot, resetApiRuntimeForTests, closedOnly,
} from "../js/api/binance.js";

function response(status, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (key) => headers[key] ?? headers[key.toLowerCase()] ?? null },
    text: async () => "",
    json: async () => [],
  };
}

function rawKline(close, openTime = 0, step = 60 * 60 * 1000) {
  return [openTime, String(close), String(close), String(close), String(close), "1",
    openTime + step - 1, String(close), 1, "0.5", String(close / 2), "0"];
}

export function run() {
  suite("api");

  test("중단·차단·일반 오류를 서로 다르게 재시도한다", () => {
    eq(shouldRetryError({ name: "AbortError" }), false, "사용자 중단은 재시도 안 함");
    eq(shouldRetryError({ status: 418 }), false, "거래소 차단은 재시도 안 함");
    eq(shouldRetryError({ status: 429 }), true, "요청 제한은 대기 후 재시도");
    eq(shouldRetryError({ status: 500 }), true, "서버 오류는 재시도");
    eq(shouldRetryError({ status: 400 }), false, "잘못된 요청은 재시도 안 함");
    eq(shouldRetryError(new Error("network")), true, "네트워크 오류는 재시도");
    eq(retryDelayFor({ retryAfterMs: 1234 }, 2), 1234, "거래소 대기 시간 우선");
  });

  test("공통 기준 시각 뒤의 캔들은 사용하지 않는다", () => {
    const candles = [
      { openTime: 0, closeTime: 99 },
      { openTime: 100, closeTime: 199 },
      { openTime: 200, closeTime: 299 },
    ];
    eq(closedOnly(candles, false, 199).length, 2, "마감봉 경계");
    eq(closedOnly(candles, true, 150).length, 2, "실시간봉은 시작 시각 경계");
  });

  test("자료 요청 중 중단하면 실제 요청도 끝난다", async () => {
    const originalFetch = globalThis.fetch;
    resetApiRuntimeForTests();
    const controller = new AbortController();
    globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    });
    try {
      const pending = getKlines("TESTUSDT", "1h", 30, {
        signal: controller.signal,
        cacheBucket: "abort-test",
      });
      controller.abort();
      let error = null;
      try { await pending; } catch (caught) { error = caught; }
      eq(error?.name, "AbortError", "중단 오류 전달");
      eq(apiRuntimeSnapshot().active, 0, "요청 자리 반환");
    } finally {
      globalThis.fetch = originalFetch;
      resetApiRuntimeForTests();
    }
  });

  test("중단된 옛 응답은 새 임시 자료를 덮어쓰지 않는다", async () => {
    const originalFetch = globalThis.fetch;
    resetApiRuntimeForTests();
    let calls = 0;
    let releaseOld;
    let markOldJsonStarted;
    const oldJsonStarted = new Promise((resolve) => { markOldJsonStarted = resolve; });
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) {
        return {
          ...response(200),
          json: async () => {
            markOldJsonStarted();
            await new Promise((resolve) => { releaseOld = resolve; });
            return [rawKline(100)];
          },
        };
      }
      return { ...response(200), json: async () => [rawKline(200)] };
    };
    const oldController = new AbortController();
    try {
      const oldRequest = getKlines("RACEUSDT", "1h", 30, {
        signal: oldController.signal, cacheBucket: "same-hour",
      });
      await oldJsonStarted;
      oldController.abort();
      const fresh = await getKlines("RACEUSDT", "1h", 30, {
        signal: new AbortController().signal, cacheBucket: "same-hour",
      });
      eq(fresh[0].close, 200, "새 응답 저장");
      releaseOld();
      let oldError = null;
      try { await oldRequest; } catch (error) { oldError = error; }
      eq(oldError?.name, "AbortError", "옛 응답 중단 유지");
      const cached = await getKlines("RACEUSDT", "1h", 30, {
        signal: new AbortController().signal, cacheBucket: "same-hour",
      });
      eq(cached[0].close, 200, "새 임시 자료 보존");
      eq(calls, 2, "세 번째 조회는 새 자료 재사용");
    } finally {
      globalThis.fetch = originalFetch;
      resetApiRuntimeForTests();
    }
  });

  test("같은 시간봉 안의 검색은 자료를 재사용하고 임시 저장 개수를 제한한다", async () => {
    const originalFetch = globalThis.fetch;
    const originalMax = CONFIG.api.maxCacheEntries;
    resetApiRuntimeForTests();
    CONFIG.api.maxCacheEntries = 2;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return { ...response(200), json: async () => [rawKline(calls)] };
    };
    try {
      const base = Date.UTC(2026, 7, 25, 10, 10);
      await getKlines("AUSDT", "1h", 30, { endTime: base });
      await getKlines("AUSDT", "1h", 30, { endTime: base + 60_000 });
      eq(calls, 1, "같은 1시간 구간 재사용");
      await getKlines("BUSDT", "1h", 30, { endTime: base });
      await getKlines("CUSDT", "1h", 30, { endTime: base });
      assert(apiRuntimeSnapshot().cacheEntries <= 2, "임시 저장 상한 유지");
    } finally {
      CONFIG.api.maxCacheEntries = originalMax;
      globalThis.fetch = originalFetch;
      resetApiRuntimeForTests();
    }
  });

  test("조기 포착 보조 자료 실패는 빈 자료와 함께 실패 표시를 남긴다", async () => {
    const originalFetch = globalThis.fetch;
    const originalWarn = console.warn;
    const originalRetries = CONFIG.api.maxRetries;
    resetApiRuntimeForTests();
    CONFIG.api.maxRetries = 0;
    let degraded = 0;
    globalThis.fetch = async () => ({
      ...response(400), text: async () => "bad request",
    });
    console.warn = () => {};
    try {
      const oi = await getOpenInterestHist("TESTUSDT", "1h", 30, {
        onDegraded: () => { degraded++; },
      });
      const funding = await getPremiumIndexAll({ onDegraded: () => { degraded++; } });
      eq(oi.length, 0, "OI 빈 자료로 계속");
      eq(funding.size, 0, "펀딩 빈 자료로 계속");
      eq(degraded, 2, "두 실패를 화면 집계용으로 전달");
    } finally {
      CONFIG.api.maxRetries = originalRetries;
      console.warn = originalWarn;
      globalThis.fetch = originalFetch;
      resetApiRuntimeForTests();
    }
  });

  test("거래소 418 응답은 즉시 차단 상태로 바꾼다", async () => {
    const originalFetch = globalThis.fetch;
    resetApiRuntimeForTests();
    let blockedEvent = null;
    const off = on("api:blocked", (event) => { blockedEvent = event; });
    globalThis.fetch = async () => response(418, { "Retry-After": "1" });
    try {
      let error = null;
      try { await getTicker24h({ signal: new AbortController().signal }); }
      catch (caught) { error = caught; }
      eq(error?.status, 418, "418 오류 유지");
      assert(state.apiHealth.blockedUntil > Date.now(), "차단 종료 시각 저장");
      eq(blockedEvent?.reason, "418", "화면 알림 이벤트");
    } finally {
      off();
      globalThis.fetch = originalFetch;
      resetApiRuntimeForTests();
    }
  });
}
