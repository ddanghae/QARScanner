// scanner/scan-controller.js — 세 스캐너의 공통 실행·중단·결과 합치기.
// 한 번의 스캔은 하나의 기준 시각(cutoff)을 공유한다.

import { CONFIG } from "../config.js";
import { state, emit } from "../state.js";
import {
  getExchangeInfo, getTicker24h, getKlines, getOpenInterestHist, getPremiumIndexAll, closedOnly,
} from "../api/binance.js";
import {
  stage1Universe, stage2Liquidity, stage3Evaluate, capCandidates, excludeMajors, stage3EvaluateEarly,
} from "./prefilter.js";
import { deepAnalyze } from "./deep-scanner.js";
import { buildEarlyResult } from "../core/early-detect.js";
import { returnsFrom, correlationMap } from "../core/correlation.js";
import { buildPumpFadeResult, pumpFadePrefilter } from "../core/pump-fade.js";
import { modesForScan, resultMode } from "../scan-modes.js";

let activeRun = null;
let nextRunId = 0;

function abortError(message = "검색이 중단되었습니다") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

function ensureActive(context) {
  if (!context || activeRun?.id !== context.id || context.signal.aborted) throw abortError();
}

function requestOptions(context) {
  return { signal: context.signal, endTime: context.cutoff };
}

export function scanRuntimeSnapshot() {
  return activeRun
    ? { id: activeRun.id, cutoff: activeRun.cutoff, aborted: activeRun.signal.aborted }
    : null;
}

export function abortScan() {
  if (!activeRun || !state.scan.running || activeRun.signal.aborted) return false;
  state.scan.stopping = true;
  state.scan.phase = "stopping";
  emit("scan:phase", "stopping");
  emit("scan:stopping", { runId: activeRun.id });
  activeRun.controller.abort();
  return true;
}

function setPhase(context, phase) {
  ensureActive(context);
  state.scan.phase = phase;
  emit("scan:phase", phase);
}

function setCurrentMode(context, mode, index, total) {
  ensureActive(context);
  state.scan.currentMode = mode;
  state.scan.modeIndex = index;
  state.scan.modeTotal = total;
  emit("scan:mode", { mode, index, total });
}

function recordModeStats(context, mode, outcome) {
  ensureActive(context);
  const results = outcome.results || [];
  const failed = outcome.requestStats?.failed || 0;
  state.scan.modeStats[mode] = {
    prefiltered: state.prefiltered.length,
    candidates: state.candidates.length,
    results: results.filter((result) => result && !result.skipped && !result.error).length,
    failed,
    status: failed > 0 ? "degraded" : "ok",
  };
}

function setProgress(context, done, total) {
  ensureActive(context);
  state.scan.done = done;
  state.scan.total = total;
  state.scan.progress = total > 0 ? done / total : 0;
  state.scan.lastUpdated = Date.now();
  emit("scan:progress", { done, total, progress: state.scan.progress });
}

async function mapWithProgress(context, items, fn, onEach) {
  let done = 0;
  let success = 0;
  let failed = 0;
  const total = items.length;
  setProgress(context, 0, total);

  let fatalError = null;
  const tasks = items.map(async (item) => {
    ensureActive(context);
    let result = null;
    try {
      result = await fn(item);
      ensureActive(context);
      success++;
    } catch (error) {
      if (error?.rateLimited || error?.status === 418 || error?.status === 429) {
        fatalError ||= error;
        if (!context.signal.aborted) context.controller.abort();
        throw error;
      }
      if (isAbortError(error) || context.signal.aborted) throw abortError();
      failed++;
      result = {
        symbol: item.symbol ?? item.item?.symbol,
        error: error?.message || "자료 요청 실패",
        requestFailed: true,
        skipped: true,
      };
    } finally {
      done++;
      if (activeRun?.id === context.id && !context.signal.aborted) {
        setProgress(context, done, total);
      }
    }
    if (onEach && result) onEach(result);
    return result;
  });

  // 한 요청이 먼저 끝나도 나머지 fetch/대기열의 취소 정리가 끝날 때까지 기다린다.
  // 그래야 중단 직후 새 검색이 이전 요청과 겹치지 않는다.
  const settled = await Promise.allSettled(tasks);
  if (fatalError) throw fatalError;
  const rejected = settled.find((item) => item.status === "rejected");
  if (rejected) throw rejected.reason;
  const results = settled.map((item) => item.value);

  ensureActive(context);
  if (total > 0 && failed === total) {
    throw new Error("모든 종목의 자료를 불러오지 못했습니다");
  }
  return { items: results.filter(Boolean), requestStats: { total, success, failed } };
}

function mergeRequestStats(...stats) {
  return stats.reduce((sum, value) => ({
    total: sum.total + (value?.total || 0),
    success: sum.success + (value?.success || 0),
    failed: sum.failed + (value?.failed || 0),
  }), { total: 0, success: 0, failed: 0 });
}

function candleChange(candles, barsAgo) {
  if (!Array.isArray(candles) || candles.length < barsAgo + 1) return null;
  const from = candles[candles.length - 1 - barsAgo]?.close;
  const to = candles[candles.length - 1]?.close;
  return Number.isFinite(from) && from > 0 && Number.isFinite(to) ? ((to - from) / from) * 100 : null;
}

// ---- 조기 포착 모드 ----
async function runEarlyPipeline(context, universe, now, tickers, settings) {
  const early = CONFIG.earlyDetect;
  setPhase(context, "prefilter");
  const { prefiltered, newListings } = stage2Liquidity(universe, tickers, now, {
    ...CONFIG.prefilter,
    minQuoteVolume: early.minQuoteVolume,
    topByVolume: early.topByVolume,
  });
  const midCaps = excludeMajors(prefiltered, early.excludeMajors);
  state.prefiltered = midCaps;
  state.newListings = newListings;
  emit("scan:prefiltered", { count: midCaps.length, newListings });
  ensureActive(context);

  let optionalFailed = 0;
  const markOptionalFailure = () => { optionalFailed++; };
  const fundingMap = await getPremiumIndexAll({
    signal: context.signal,
    onDegraded: markOptionalFailure,
  });
  ensureActive(context);

  setPhase(context, "candidate");
  const evaluated = await mapWithProgress(context, midCaps, async (item) => {
    const raw = await getKlines(item.symbol, "4h", undefined, requestOptions(context));
    const candles = closedOnly(raw, settings.includeRealtimeCandle, context.cutoff);
    const candleItem = { ...item, change24h: candleChange(candles, 6) };
    return { item: candleItem, k4h: candles, res: stage3EvaluateEarly(candleItem, candles, CONFIG) };
  });
  const candidates = evaluated.items
    .filter((value) => value.res?.pass)
    .sort((a, b) => (a.res.squeezePct ?? 100) - (b.res.squeezePct ?? 100))
    .slice(0, early.keepMax);
  state.candidates = candidates.map((value) => value.item);
  emit("scan:candidates", { count: candidates.length });
  ensureActive(context);

  setPhase(context, "deep");
  const analyzed = await mapWithProgress(context, candidates, async ({ item, k4h }) => {
    const oiSeries = await getOpenInterestHist(
      item.symbol, early.oiPeriod, early.oiLimit,
      { signal: context.signal, onDegraded: markOptionalFailure },
    );
    const funding = fundingMap.get(item.symbol) ?? null;
    const result = buildEarlyResult(item, k4h, oiSeries, funding, CONFIG);
    return result ? {
      ...result,
      asOf: context.cutoff,
      provisional: Boolean(settings.includeRealtimeCandle),
    } : null;
  });
  const results = analyzed.items.filter(Boolean);

  const series = [];
  for (const { item, k4h } of candidates) {
    if (!results.some((result) => result.symbol === item.symbol)) continue;
    const returns = returnsFrom(k4h, CONFIG.correlation.bars);
    if (returns) series.push({ symbol: item.symbol, returns });
  }
  const correlations = correlationMap(series, CONFIG.correlation.threshold);
  for (const result of results) result.correlatedWith = correlations.get(result.symbol) || [];

  return {
    results,
    requestStats: mergeRequestStats(
      evaluated.requestStats,
      analyzed.requestStats,
      { total: 1 + candidates.length, success: 1 + candidates.length - optionalFailed, failed: optionalFailed },
    ),
  };
}

// ---- 급등 후 급락 모드(SHORT 전용) ----
async function runPumpFadePipeline(context, universe, now, tickers, settings) {
  const includeRealtime = Boolean(settings.includeRealtimeCandle);
  setPhase(context, "prefilter");
  const { prefiltered, newListings } = stage2Liquidity(universe, tickers, now, {
    ...CONFIG.prefilter,
    minQuoteVolume: settings.minQuoteVolume ?? CONFIG.prefilter.minQuoteVolume,
  });
  state.prefiltered = prefiltered;
  state.newListings = newListings;
  emit("scan:prefiltered", { count: prefiltered.length, newListings });
  ensureActive(context);

  setPhase(context, "candidate");
  const evaluated = await mapWithProgress(context, prefiltered, async (item) => {
    const raw = await getKlines(item.symbol, "1h", undefined, requestOptions(context));
    const candles1h = closedOnly(raw, includeRealtime, context.cutoff);
    return { item, candles1h, pre: pumpFadePrefilter(candles1h, CONFIG) };
  });
  const candidates = evaluated.items
    .filter((value) => value.pre?.pass)
    .sort((a, b) => {
      const strength = (b.pre.normalizedStrength ?? -Infinity) - (a.pre.normalizedStrength ?? -Infinity);
      return strength || String(a.item.symbol).localeCompare(String(b.item.symbol));
    });
  state.candidates = candidates.map((value) => value.item);
  emit("scan:candidates", { count: candidates.length });
  ensureActive(context);

  setPhase(context, "deep");
  const analyzed = await mapWithProgress(context, candidates, async ({ item, candles1h }) => {
    const [raw15m, raw5m] = await Promise.all([
      getKlines(item.symbol, "15m", undefined, requestOptions(context)),
      getKlines(item.symbol, "5m", undefined, requestOptions(context)),
    ]);
    const candles15m = closedOnly(raw15m, includeRealtime, context.cutoff);
    const candles5m = closedOnly(raw5m, includeRealtime, context.cutoff);
    return buildPumpFadeResult(item, candles1h, candles15m, candles5m, CONFIG, {
      provisional: includeRealtime,
      asOf: context.cutoff,
    });
  });
  return {
    results: analyzed.items.filter(Boolean),
    requestStats: mergeRequestStats(evaluated.requestStats, analyzed.requestStats),
  };
}

// ---- 급락 반등 모드 ----
async function runReversalPipeline(context, universe, now, tickers, settings) {
  setPhase(context, "prefilter");
  const { prefiltered, newListings } = stage2Liquidity(universe, tickers, now, {
    ...CONFIG.prefilter,
    minQuoteVolume: settings.minQuoteVolume ?? CONFIG.prefilter.minQuoteVolume,
  });
  state.prefiltered = prefiltered;
  state.newListings = newListings;
  emit("scan:prefiltered", { count: prefiltered.length, newListings });
  ensureActive(context);

  setPhase(context, "candidate");
  const direction = settings.direction || "long";
  const evaluated = await mapWithProgress(context, prefiltered, async (item) => {
    const raw = await getKlines(item.symbol, "1h", undefined, requestOptions(context));
    const candles = closedOnly(raw, settings.includeRealtimeCandle, context.cutoff);
    return { item, res: stage3Evaluate(item, candles, direction) };
  });
  let candidates = evaluated.items
    .filter((value) => value.res?.pass)
    .sort((a, b) => Math.abs(b.res.change6h) - Math.abs(a.res.change6h))
    .map((value) => ({ ...value.item, change24h: value.res.change24h, pre: value.res }));
  candidates = capCandidates(candidates);
  state.candidates = candidates;
  emit("scan:candidates", { count: candidates.length });
  ensureActive(context);

  setPhase(context, "deep");
  const analyzed = await mapWithProgress(
    context,
    candidates,
    (item) => deepAnalyze(item, settings, {
      signal: context.signal,
      cutoff: context.cutoff,
      cacheBucket: context.cutoff,
    }),
  );
  return {
    results: analyzed.items,
    requestStats: mergeRequestStats(evaluated.requestStats, analyzed.requestStats),
  };
}

export function sortAndRankResults(results, requestedMode = "all") {
  return modesForScan(requestedMode).flatMap((mode) => {
    const comparator = mode === "pump_fade"
      ? pumpFadeComparator
      : (a, b) => b.score - a.score || String(a.symbol).localeCompare(String(b.symbol));
    return results
      .filter((result) => result && !result.skipped && !result.error && resultMode(result) === mode)
      .sort(comparator)
      .map((result, index) => ({ ...result, rank: index + 1 }));
  });
}

export async function runScan() {
  if (state.scan.running || activeRun) return [];

  const controller = new AbortController();
  const context = {
    id: ++nextRunId,
    cutoff: Date.now(),
    controller,
    signal: controller.signal,
  };
  activeRun = context;
  state.scan.running = true;
  state.scan.stopping = false;
  state.scan.runId = context.id;
  state.scan.cutoff = context.cutoff;
  state.scan.error = null;
  state.scan.startedAt = context.cutoff;
  state.scan.currentMode = null;
  state.scan.modeIndex = 0;
  state.scan.modeTotal = 0;
  state.scan.modeStats = {};
  state.scan.modeErrors = {};
  state.scan.realtimeSuppressed = false;
  state.results = [];
  emit("scan:start", { runId: context.id, cutoff: context.cutoff });

  try {
    const settings = {
      ...state.settings,
      penalties: { ...state.settings.penalties },
      favorites: [...(state.settings.favorites || [])],
      excluded: [...(state.settings.excluded || [])],
    };
    const requestedMode = settings.scanMode;
    if (requestedMode === "all" && settings.includeRealtimeCandle) {
      settings.includeRealtimeCandle = false;
      state.scan.realtimeSuppressed = true;
      emit("scan:notice", "전체 검색은 같은 시각을 맞추기 위해 진행 중 봉을 제외했습니다.");
    }

    setPhase(context, "universe");
    const symbols = await getExchangeInfo({ signal: context.signal });
    ensureActive(context);
    const universe = stage1Universe(symbols);
    state.universe = universe;

    setPhase(context, "prefilter");
    const tickers = await getTicker24h({ signal: context.signal });
    ensureActive(context);
    state.tickers = tickers;

    const modes = modesForScan(requestedMode);
    const combined = [];
    let successfulModes = 0;
    for (let index = 0; index < modes.length; index++) {
      ensureActive(context);
      const mode = modes[index];
      state.prefiltered = [];
      state.candidates = [];
      state.newListings = [];
      setCurrentMode(context, mode, index + 1, modes.length);
      try {
        const outcome = mode === "early"
          ? await runEarlyPipeline(context, universe, context.cutoff, tickers, settings)
          : mode === "pump_fade"
            ? await runPumpFadePipeline(context, universe, context.cutoff, tickers, settings)
            : await runReversalPipeline(context, universe, context.cutoff, tickers, settings);
        ensureActive(context);
        recordModeStats(context, mode, outcome);
        combined.push(...outcome.results);
        successfulModes++;
      } catch (error) {
        if (isAbortError(error) || context.signal.aborted) throw abortError();
        if (error?.rateLimited || error?.status === 418 || error?.status === 429) throw error;
        ensureActive(context);
        state.scan.modeErrors[mode] = error?.message || "검색 실패";
        state.scan.modeStats[mode] = {
          prefiltered: null,
          candidates: null,
          results: 0,
          failed: 1,
          status: "failed",
        };
        emit("scan:mode-error", { mode, message: state.scan.modeErrors[mode] });
        if (modes.length === 1) throw error;
      }
    }
    if (successfulModes === 0) throw new Error("세 스캐너 모두 자료를 불러오지 못했습니다");
    return finishScan(context, combined, requestedMode);
  } catch (error) {
    if (isAbortError(error) || (context.signal.aborted && !error?.rateLimited)) return finishAborted(context);
    console.error("스캔 실패", error);
    if (activeRun?.id === context.id) {
      state.scan.error = error?.message || "검색 실패";
      state.scan.running = false;
      state.scan.stopping = false;
      state.scan.phase = "error";
      emit("scan:phase", "error");
      emit("scan:error", state.scan.error);
      context.controller.abort();
    }
    return [];
  } finally {
    if (activeRun?.id === context.id) {
      activeRun = null;
      state.scan.running = false;
      state.scan.stopping = false;
    }
  }
}

function pumpFadeComparator(a, b) {
  return b.stage.stage - a.stage.stage || b.score - a.score || a.symbol.localeCompare(b.symbol);
}

function finishScan(context, analyzed, requestedMode) {
  setPhase(context, "score");
  const results = sortAndRankResults(analyzed, requestedMode);
  state.results = results;
  setPhase(context, "done");
  state.scan.running = false;
  state.scan.lastUpdated = Date.now();
  state.scan.currentMode = null;
  emit("scan:done");
  return results;
}

function finishAborted(context) {
  if (activeRun?.id !== context.id) return [];
  state.scan.running = false;
  state.scan.stopping = false;
  state.scan.phase = "idle";
  state.scan.currentMode = null;
  emit("scan:phase", "idle");
  emit("scan:aborted", { runId: context.id });
  return [];
}

// ---- 자동 갱신 ----
let refreshTimer = null;
let tickTimer = null;
let nextRefreshAt = 0;

export function nextRefreshDelay(intervalMs, backgrounded) {
  const base = Math.max(intervalMs, CONFIG.refresh.minIntervalMs);
  return backgrounded ? base * CONFIG.refresh.backgroundMultiplier : base;
}

export function startAutoRefresh() {
  stopAutoRefresh();
  scheduleNext();
  tickTimer = setInterval(() => {
    const secondsRemaining = Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000));
    emit("refresh:tick", { secondsRemaining, active: true });
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
      try { await runScan(); } catch (error) { console.warn("자동 갱신 실패", error); }
    }
    if (tickTimer || refreshTimer) scheduleNext();
  }, delay);
}

export default {
  runScan, abortScan, startAutoRefresh, stopAutoRefresh, isAutoRefreshOn, nextRefreshDelay,
  scanRuntimeSnapshot,
};
