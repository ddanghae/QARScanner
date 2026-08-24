// scanner/scan-controller.js — 전체 스캔 파이프라인 오케스트레이션.
// 순서(§18): 24h 데이터 → 유동성 상위 → 1h 빠른 분석 → 후보 축소 → 4H·15M·5M 정밀.
// 동시요청 제한은 api 계층 세마포어가 담당. 진행률/오류 이벤트 emit.

import { CONFIG, minScoreFor } from "../config.js";
import { state, emit } from "../state.js";
import {
  getExchangeInfo, getTicker24h, getKlines, getOpenInterestHist, getPremiumIndexAll, closedOnly,
} from "../api/binance.js";
import {
  stage1Universe, stage2Liquidity, stage3Evaluate, capCandidates,
  excludeMajors, stage3EvaluateEarly, prioritizeEarlyCandidates,
} from "./prefilter.js";
import { deepAnalyze } from "./deep-scanner.js";
import { buildEarlyResult } from "../core/early-detect.js";
import { buildPumpFadeResult, pumpFadePrefilter } from "../core/pump-fade.js";

let activeRun = null;
let nextRunId = 0;

function abortError() {
  if (typeof DOMException === "function") return new DOMException("사용자가 스캔을 중단했습니다.", "AbortError");
  const error = new Error("사용자가 스캔을 중단했습니다.");
  error.name = "AbortError";
  return error;
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

function createRunContext() {
  return { id: ++nextRunId, controller: new AbortController(), abortedEmitted: false };
}

function isCurrentRun(run) {
  return activeRun === run && !run.controller.signal.aborted;
}

function requireCurrentRun(run) {
  if (!isCurrentRun(run)) throw abortError();
}

export function abortScan() {
  const run = activeRun;
  if (!run) return;
  activeRun = null;
  run.controller.abort();
  state.scan.phase = "idle";
  state.scan.running = false;
  run.abortedEmitted = true;
  emit("scan:phase", "idle");
  emit("scan:aborted");
}

function setPhase(phase, run) {
  if (run) requireCurrentRun(run);
  state.scan.phase = phase;
  emit("scan:phase", phase);
}
function setProgress(done, total, run) {
  if (run) requireCurrentRun(run);
  state.scan.done = done;
  state.scan.total = total;
  state.scan.progress = total > 0 ? done / total : 0;
  state.scan.lastUpdated = Date.now();
  emit("scan:progress", { done, total, progress: state.scan.progress });
}

// 미리 전부 시작하지 않는 제한 큐. 중단 시 새 작업을 꺼내지 않는다.
export async function mapWithConcurrency(items, fn, { concurrency = CONFIG.api.maxConcurrent, signal, onProgress } = {}) {
  if (signal?.aborted) throw abortError();
  const results = new Array(items.length);
  let nextIndex = 0;
  let done = 0;
  const workerCount = Math.min(items.length, Math.max(1, Math.floor(concurrency) || 1));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      if (signal?.aborted) throw abortError();
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
      if (signal?.aborted) throw abortError();
      done++;
      onProgress?.(done, items.length);
    }
  });
  await Promise.all(workers);
  return results;
}

async function mapWithProgress(items, fn, onEach, run) {
  const total = items.length;
  setProgress(0, total, run);
  const results = await mapWithConcurrency(items, async (it) => {
    requireCurrentRun(run);
    let r = null;
    try { r = await fn(it); }
    catch (e) {
      if (isAbortError(e) || run.controller.signal.aborted) throw abortError();
      r = { symbol: it.symbol, error: e.message, skipped: true };
    }
    requireCurrentRun(run);
    if (onEach && r) onEach(r);
    return r;
  }, {
    signal: run.controller.signal,
    onProgress(done) { setProgress(done, total, run); },
  });
  return results.filter(Boolean);
}

// ---- 조기 포착 모드 파이프라인 ----
// 반환: 기존과 동일 shape 결과 배열 (rank 는 호출부에서 부여)
async function runEarlyPipeline(universe, now, run) {
  const e = CONFIG.earlyDetect;

  // 2단계: early 유니버스 기준으로 유동성 필터
  setPhase("prefilter", run);
  const tickers = await getTicker24h(run.controller.signal);
  requireCurrentRun(run);
  state.tickers = tickers;
  const { prefiltered, newListings } = stage2Liquidity(universe, tickers, now, {
    ...CONFIG.prefilter,
    minQuoteVolume: e.minQuoteVolume,
    topByVolume: e.topByVolume,
  });
  const midCaps = excludeMajors(prefiltered, e.excludeMajors);
  state.prefiltered = midCaps;
  state.newListings = newListings;
  emit("scan:prefiltered", { count: midCaps.length, newListings });
  requireCurrentRun(run);

  // 펀딩비는 스캔당 1회 (전 종목)
  const fundingMap = await getPremiumIndexAll(run.controller.signal);
  requireCurrentRun(run);

  // 3단계: 4시간봉으로 1차 선별
  setPhase("candidate", run);
  const evaluated = await mapWithProgress(midCaps, async (item) => {
    const k4h = await getKlines(item.symbol, "4h", undefined, run.controller.signal);
    const closed = k4h.slice(0, state.settings.includeRealtimeCandle ? k4h.length : -1);
    return { item, k4h: closed, res: stage3EvaluateEarly(item, closed, CONFIG) };
  }, null, run);
  const candidates = prioritizeEarlyCandidates(evaluated, e.keepMax);
  state.candidates = candidates.map((x) => x.item);
  emit("scan:candidates", { count: candidates.length });
  requireCurrentRun(run);

  // 4단계: 후보만 OI 조회 후 정밀 판정
  setPhase("deep", run);
  const analyzed = await mapWithProgress(candidates, async ({ item, k4h }) => {
    const oiSeries = await getOpenInterestHist(item.symbol, e.oiPeriod, e.oiLimit, run.controller.signal);
    const funding = fundingMap.get(item.symbol) ?? null;
    return buildEarlyResult(item, k4h, oiSeries, funding, CONFIG);
  }, null, run);
  return analyzed.filter(Boolean);
}

// ---- 급등 후 급락 모드 파이프라인 (SHORT 전용) ----
// 1h 급등 필터를 먼저 적용하되 통과 집합을 추가로 자르지 않는다.
async function runPumpFadePipeline(universe, now, run) {
  const includeRealtime = Boolean(state.settings.includeRealtimeCandle);

  setPhase("prefilter", run);
  const tickers = await getTicker24h(run.controller.signal);
  requireCurrentRun(run);
  state.tickers = tickers;
  const { prefiltered, newListings } = stage2Liquidity(universe, tickers, now, {
    ...CONFIG.prefilter,
    minQuoteVolume: state.settings.minQuoteVolume,
  });
  state.prefiltered = prefiltered;
  state.newListings = newListings;
  emit("scan:prefiltered", { count: prefiltered.length, newListings });
  requireCurrentRun(run);

  setPhase("candidate", run);
  const evaluated = await mapWithProgress(prefiltered, async (item) => {
    const raw1h = await getKlines(item.symbol, "1h", undefined, run.controller.signal);
    const candles1h = closedOnly(raw1h, includeRealtime);
    return { item, candles1h, pre: pumpFadePrefilter(candles1h, CONFIG) };
  }, null, run);
  const candidates = evaluated
    .filter((x) => x.pre?.pass)
    .sort((a, b) => {
      const strength = (b.pre.normalizedStrength ?? -Infinity) - (a.pre.normalizedStrength ?? -Infinity);
      if (strength) return strength;
      return String(a.item.symbol).localeCompare(String(b.item.symbol));
    });
  state.candidates = candidates.map((x) => x.item);
  emit("scan:candidates", { count: candidates.length });
  requireCurrentRun(run);

  setPhase("deep", run);
  const analyzed = await mapWithProgress(candidates, async ({ item, candles1h }) => {
    const [raw15m, raw5m] = await Promise.all([
      getKlines(item.symbol, "15m", undefined, run.controller.signal),
      getKlines(item.symbol, "5m", undefined, run.controller.signal),
    ]);
    const candles15m = closedOnly(raw15m, includeRealtime);
    const candles5m = closedOnly(raw5m, includeRealtime);
    return buildPumpFadeResult(item, candles1h, candles15m, candles5m, CONFIG, {
      provisional: includeRealtime,
    });
  }, null, run);
  return analyzed.filter(Boolean);
}

export async function runScan() {
  if (state.scan.running) return;
  const run = createRunContext();
  activeRun = run;
  state.scan.running = true;
  state.scan.error = null;
  state.scan.startedAt = Date.now();
  const scanProvisional = Boolean(state.settings.includeRealtimeCandle);
  emit("scan:start");

  try {
    const now = Date.now();

    // --- 1단계: 전체 종목 수집 ---
    setPhase("universe", run);
    const symbols = await getExchangeInfo(run.controller.signal);
    requireCurrentRun(run);
    const universe = stage1Universe(symbols);
    state.universe = universe;

    // --- 급등 후 급락 모드면 별도 SHORT 파이프라인 ---
    if (state.settings.scanMode === "pump_fade") {
      const pumpFadeResults = await runPumpFadePipeline(universe, now, run);
      setPhase("score", run);
      const results = pumpFadeResults
        .filter((r) => !r.skipped && !r.error && r.score >= minScoreFor(state.settings))
        .sort((a, b) => b.stage.stage - a.stage.stage || b.score - a.score || a.symbol.localeCompare(b.symbol))
        .slice(0, CONFIG.pumpFade.keepMax)
        .map((r, i) => ({ ...r, rank: i + 1 }));
      state.results = results;
      return finishCompleted(run, results, pumpFadeResults.length, scanProvisional);
    }

    // --- 조기 포착 모드면 별도 파이프라인 ---
    if (state.settings.scanMode === "early") {
      const earlyResults = await runEarlyPipeline(universe, now, run);
      setPhase("score", run);
      const results = earlyResults
        .filter((r) => !r.skipped && !r.error && r.score >= minScoreFor(state.settings))
        .sort((a, b) => b.score - a.score)
        .map((r, i) => ({ ...r, rank: i + 1 }));
      state.results = results;
      return finishCompleted(run, results, earlyResults.length, scanProvisional);
    }

    // --- 2단계: 24h 유동성 필터 ---
    setPhase("prefilter", run);
    const tickers = await getTicker24h(run.controller.signal);
    requireCurrentRun(run);
    state.tickers = tickers;
    const { prefiltered, newListings } = stage2Liquidity(universe, tickers, now, {
      ...CONFIG.prefilter,
      minQuoteVolume: state.settings.minQuoteVolume,
    });
    state.prefiltered = prefiltered;
    state.newListings = newListings;
    emit("scan:prefiltered", { count: prefiltered.length, newListings });

    // --- 3단계: 1h 빠른 분석 → 급락·초기 후보 ---
    setPhase("candidate", run);
    const dir = state.settings.direction || "long";
    const dropBasis = state.settings.dropBasis === "24h" ? "24h" : "6h";
    const evaluated = await mapWithProgress(prefiltered, async (item) => {
      const k1h = await getKlines(item.symbol, "1h", undefined, run.controller.signal);
      const closed = k1h.slice(0, state.settings.includeRealtimeCandle ? k1h.length : -1);
      const res = stage3Evaluate(item, closed, dir, dropBasis);
      return { item, res };
    }, null, run);
    let candidates = evaluated
      .filter((e) => e.res?.pass)
      .sort((a, b) => Math.abs(b.res.basisChange) - Math.abs(a.res.basisChange))
      .map((e) => ({ ...e.item, pre: e.res }));
    candidates = capCandidates(candidates);
    state.candidates = candidates;
    emit("scan:candidates", { count: candidates.length });

    // --- 4·5단계: 정밀 분석 + 점수 ---
    setPhase("deep", run);
    const analyzed = await mapWithProgress(
      candidates,
      (item) => deepAnalyze(item, state.settings, run.controller.signal),
      null,
      run,
    );

    // --- 점수 필터 + 정렬 ---
    setPhase("score", run);
    const results = analyzed
      .filter((r) => !r.skipped && !r.error && r.score >= state.settings.minScore)
      .sort((a, b) => b.score - a.score)
      .map((r, i) => ({ ...r, rank: i + 1 }));
    state.results = results;
    return finishCompleted(run, results, analyzed.length, scanProvisional);
  } catch (e) {
    if (isAbortError(e) || !isCurrentRun(run)) return [];
    console.error("스캔 실패", e);
    state.scan.error = e.message;
    state.scan.running = false;
    setPhase("error", run);
    activeRun = null;
    emit("scan:error", e.message);
    return [];
  }
}

function finishCompleted(run, results, analyzed, provisional) {
  requireCurrentRun(run);
  setPhase("done", run);
  state.scan.running = false;
  const completedAt = Date.now();
  state.scan.lastUpdated = completedAt;
  activeRun = null;
  emit("scan:done", { count: results.length, analyzed, completedAt, provisional });
  return results;
}

// ---- 자동 갱신 (§15 카운트다운 · §18 백그라운드 빈도 감소) ----
let refreshTimer = null;
let tickTimer = null;
let nextRefreshAt = 0;

// 순수 함수 — 다음 갱신까지 지연(ms). 백그라운드면 배수 적용. 테스트 대상.
export function nextRefreshDelay(intervalMs, backgrounded) {
  const base = Math.max(intervalMs, CONFIG.refresh.minIntervalMs);
  return backgrounded ? base * CONFIG.refresh.backgroundMultiplier : base;
}

export function startAutoRefresh() {
  stopAutoRefresh();
  scheduleNext();
  // 카운트다운 틱
  tickTimer = setInterval(() => {
    const sec = Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000));
    emit("refresh:tick", { secondsRemaining: sec, active: true });
  }, CONFIG.refresh.tickMs);
  emit("refresh:state", { active: true });
}

export function stopAutoRefresh() {
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  nextRefreshAt = 0;
  emit("refresh:tick", { secondsRemaining: 0, active: false });
  emit("refresh:state", { active: false });
}

export function isAutoRefreshOn() { return !!refreshTimer || !!tickTimer; }

function scheduleNext() {
  const delay = nextRefreshDelay(state.settings.refreshIntervalMs, !!state.backgrounded);
  nextRefreshAt = Date.now() + delay;
  refreshTimer = setTimeout(async () => {
    if (!state.scan.running) {
      try { await runScan(); } catch (e) { console.warn("자동 갱신 실패", e); }
    }
    if (tickTimer || refreshTimer) scheduleNext(); // 여전히 활성일 때만 재예약
  }, delay);
}

export default {
  runScan, abortScan, startAutoRefresh, stopAutoRefresh, isAutoRefreshOn, nextRefreshDelay,
};
