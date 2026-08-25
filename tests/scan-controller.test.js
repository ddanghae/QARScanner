// tests/scan-controller.test.js — 늦은 응답·중단·재시작 겹침 방지.

import { suite, test, assert, eq } from "./harness.js";
import { CONFIG } from "../js/config.js";
import { state } from "../js/state.js";
import { resetApiRuntimeForTests } from "../js/api/binance.js";
import { runScan, abortScan, scanRuntimeSnapshot } from "../js/scanner/scan-controller.js";

function response(data) {
  return {
    status: 200,
    ok: true,
    headers: { get: () => null },
    text: async () => "",
    json: async () => data,
  };
}

const symbol = {
  symbol: "TESTUSDT",
  baseAsset: "TEST",
  quoteAsset: "USDT",
  contractType: "PERPETUAL",
  status: "TRADING",
  onboardDate: 0,
  pricePrecision: 4,
  filters: [],
};

function ticker(quoteVolume) {
  return [{
    symbol: "TESTUSDT",
    quoteVolume: String(quoteVolume),
    count: "100000",
    lastPrice: "100",
    priceChangePercent: "-10",
    highPrice: "110",
    lowPrice: "90",
    weightedAvgPrice: "100",
  }];
}

export function run() {
  suite("scan controller");

  test("모든 종목 자료 요청이 실패하면 후보 0개가 아니라 오류로 알린다", async () => {
    const originalFetch = globalThis.fetch;
    const originalConsoleError = console.error;
    const originalSettings = state.settings;
    const originalRetries = CONFIG.api.maxRetries;
    resetApiRuntimeForTests();
    CONFIG.api.maxRetries = 0;
    state.settings = {
      ...originalSettings, scanMode: "reversal", direction: "long", includeRealtimeCandle: false,
      penalties: { ...originalSettings.penalties }, favorites: [], excluded: [],
    };
    globalThis.fetch = async (url) => {
      if (url.includes("exchangeInfo")) return response({ symbols: [symbol] });
      if (url.includes("ticker/24hr")) return response(ticker(1_000_000_000));
      if (url.includes("/klines")) return {
        ...response(null), status: 500, ok: false, text: async () => "server error",
      };
      throw new Error("예상하지 못한 URL " + url);
    };
    console.error = () => {};
    try {
      await runScan();
      eq(state.scan.phase, "error", "오류 상태 표시");
      assert(state.scan.error?.includes("모든 종목"), "빈 결과와 구분되는 설명");
    } finally {
      globalThis.fetch = originalFetch;
      console.error = originalConsoleError;
      state.settings = originalSettings;
      CONFIG.api.maxRetries = originalRetries;
      resetApiRuntimeForTests();
    }
  });

  test("전체 검색에서 세 모드가 모두 실패하면 완료로 속이지 않는다", async () => {
    const originalFetch = globalThis.fetch;
    const originalConsoleError = console.error;
    const originalSettings = state.settings;
    const originalRetries = CONFIG.api.maxRetries;
    resetApiRuntimeForTests();
    CONFIG.api.maxRetries = 0;
    state.settings = {
      ...originalSettings, scanMode: "all", includeRealtimeCandle: false,
      penalties: { ...originalSettings.penalties }, favorites: [], excluded: [],
    };
    globalThis.fetch = async (url) => {
      if (url.includes("exchangeInfo")) return response({ symbols: [symbol] });
      if (url.includes("ticker/24hr")) return response(ticker(1_000_000_000));
      if (url.includes("premiumIndex")) return response([]);
      if (url.includes("/klines")) return {
        ...response(null), status: 500, ok: false, text: async () => "server error",
      };
      throw new Error("예상하지 못한 URL " + url);
    };
    console.error = () => {};
    try {
      await runScan();
      eq(state.scan.phase, "error", "전체 오류 상태");
      assert(state.scan.error?.includes("세 스캐너 모두"), "전체 실패 설명");
      eq(state.scan.modeStats.early.status, "failed", "조기 포착 실패");
      eq(state.scan.modeStats.reversal.status, "failed", "급락 반등 실패");
      eq(state.scan.modeStats.pump_fade.status, "failed", "급등 후 급락 실패");
      eq(state.results.length, 0, "이전 결과 제거");
    } finally {
      globalThis.fetch = originalFetch;
      console.error = originalConsoleError;
      state.settings = originalSettings;
      CONFIG.api.maxRetries = originalRetries;
      resetApiRuntimeForTests();
    }
  });

  test("전체 검색에서 한 모드만 실패하면 나머지는 완료하고 실패 모드 숫자를 비워 둔다", async () => {
    const originalFetch = globalThis.fetch;
    const originalSettings = state.settings;
    const originalRetries = CONFIG.api.maxRetries;
    resetApiRuntimeForTests();
    CONFIG.api.maxRetries = 0;
    state.settings = {
      ...originalSettings, scanMode: "all", includeRealtimeCandle: true,
      penalties: { ...originalSettings.penalties }, favorites: [], excluded: [],
    };
    globalThis.fetch = async (url) => {
      if (url.includes("exchangeInfo")) return response({ symbols: [symbol] });
      if (url.includes("ticker/24hr")) return response(ticker(1_000_000_000));
      if (url.includes("premiumIndex")) return response([]);
      if (url.includes("interval=4h")) return {
        ...response(null), status: 500, ok: false, text: async () => "server error",
      };
      if (url.includes("/klines")) return response([]);
      throw new Error("예상하지 못한 URL " + url);
    };
    try {
      await runScan();
      eq(state.scan.phase, "done", "나머지 모드 완료");
      eq(state.scan.modeStats.early.status, "failed", "한 모드 실패 표시");
      eq(state.scan.modeStats.early.candidates, null, "실패 숫자는 미확인 표시용 null");
      eq(state.scan.modeStats.reversal.status, "ok", "급락 반등 정상");
      eq(state.scan.modeStats.pump_fade.status, "ok", "급등 후 급락 정상");
      eq(state.scan.realtimeSuppressed, true, "전체 검색은 진행 중 봉 제외");
    } finally {
      globalThis.fetch = originalFetch;
      state.settings = originalSettings;
      CONFIG.api.maxRetries = originalRetries;
      resetApiRuntimeForTests();
    }
  });

  test("중단 뒤 늦게 온 응답은 결과를 덮지 못하고 정리 후 새 검색이 가능하다", async () => {
    const originalFetch = globalThis.fetch;
    const originalSettings = state.settings;
    let releaseKlines;
    let markKlinesStarted;
    const klinesStarted = new Promise((resolve) => { markKlinesStarted = resolve; });
    resetApiRuntimeForTests();
    state.settings = {
      ...originalSettings,
      scanMode: "reversal",
      direction: "long",
      includeRealtimeCandle: false,
      penalties: { ...originalSettings.penalties },
      favorites: [],
      excluded: [],
    };
    state.results = [{ symbol: "KEEPUSDT", scanMode: "reversal" }];

    globalThis.fetch = async (url) => {
      if (url.includes("exchangeInfo")) return response({ symbols: [symbol] });
      if (url.includes("ticker/24hr")) return response(ticker(1_000_000_000));
      if (url.includes("/klines")) {
        markKlinesStarted();
        return new Promise((resolve) => { releaseKlines = () => resolve(response([])); });
      }
      throw new Error("예상하지 못한 URL " + url);
    };

    try {
      const first = runScan();
      await klinesStarted;
      eq(state.results.length, 0, "새 검색 시작 시 이전 결과 제거");
      const firstId = scanRuntimeSnapshot()?.id;
      assert(firstId > 0, "첫 검색 번호");
      eq(abortScan(), true, "중단 요청");
      eq(state.scan.stopping, true, "중단하는 중 표시");

      const overlap = await runScan();
      eq(overlap.length, 0, "정리 전 겹친 새 검색 거부");
      releaseKlines();
      await first;
      eq(scanRuntimeSnapshot(), null, "중단 검색 완전 정리");
      eq(state.scan.running, false, "실행 상태 해제");
      eq(state.scan.phase, "idle", "대기 상태 복귀");
      eq(state.results.length, 0, "늦은 응답이 지운 결과를 되살리지 않음");

      resetApiRuntimeForTests();
      globalThis.fetch = async (url) => {
        if (url.includes("exchangeInfo")) return response({ symbols: [symbol] });
        if (url.includes("ticker/24hr")) return response(ticker(0));
        throw new Error("후속 검색은 캔들 요청이 없어야 함");
      };
      await runScan();
      assert(state.scan.runId > firstId, "정리 뒤 새 검색 번호 발급");
      eq(state.scan.phase, "done", "새 검색 정상 완료");
    } finally {
      globalThis.fetch = originalFetch;
      state.settings = originalSettings;
      resetApiRuntimeForTests();
    }
  });
}
