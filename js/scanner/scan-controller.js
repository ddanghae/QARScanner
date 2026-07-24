// scanner/scan-controller.js — 전체 스캔 파이프라인 오케스트레이션.
// 순서(§18): 24h 데이터 → 유동성 상위 → 1h 빠른 분석 → 후보 축소 → 4H·15M·5M 정밀.
// 동시요청 제한은 api 계층 세마포어가 담당. 진행률/오류 이벤트 emit.

import { CONFIG } from "../config.js";
import { state, emit } from "../state.js";
import { getExchangeInfo, getTicker24h, getKlines, getOpenInterestHist, getPremiumIndexAll } from "../api/binance.js";
import { stage1Universe, stage2Liquidity, stage3Evaluate, capCandidates, excludeMajors, stage3EvaluateEarly } from "./prefilter.js";
import { deepAnalyze } from "./deep-scanner.js";
import { buildEarlyResult } from "../core/early-detect.js";

let abortToken = { aborted: false };

export function abortScan() {
  abortToken.aborted = true;
  setPhase("idle");
  state.scan.running = false;
  emit("scan:aborted");
}

function setPhase(phase) {
  state.scan.phase = phase;
  emit("scan:phase", phase);
}
function setProgress(done, total) {
  state.scan.done = done;
  state.scan.total = total;
  state.scan.progress = total > 0 ? done / total : 0;
  state.scan.lastUpdated = Date.now();
  emit("scan:progress", { done, total, progress: state.scan.progress });
}

// 동시성 있는 map — 세마포어가 실제 병렬 수를 제한하므로 전부 시작해도 안전.
async function mapWithProgress(items, fn, onEach) {
  let done = 0;
  const total = items.length;
  setProgress(0, total);
  const results = await Promise.all(items.map(async (it) => {
    if (abortToken.aborted) return null;
    let r = null;
    try { r = await fn(it); }
    catch (e) { r = { symbol: it.symbol, error: e.message, skipped: true }; }
    done++;
    setProgress(done, total);
    if (onEach && r) onEach(r);
    return r;
  }));
  return results.filter(Boolean);
}

// ---- 조기 포착 모드 파이프라인 ----
// 반환: 기존과 동일 shape 결과 배열 (rank 는 호출부에서 부여)
async function runEarlyPipeline(universe, now) {
  const e = CONFIG.earlyDetect;

  // 2단계: early 유니버스 기준으로 유동성 필터
  setPhase("prefilter");
  const tickers = await getTicker24h();
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
  if (abortToken.aborted) return null;

  // 펀딩비는 스캔당 1회 (전 종목)
  const fundingMap = await getPremiumIndexAll();

  // 3단계: 4시간봉으로 1차 선별
  setPhase("candidate");
  const evaluated = await mapWithProgress(midCaps, async (item) => {
    const k4h = await getKlines(item.symbol, "4h");
    const closed = k4h.slice(0, state.settings.includeRealtimeCandle ? k4h.length : -1);
    return { item, k4h: closed, res: stage3EvaluateEarly(item, closed, CONFIG) };
  });
  let candidates = evaluated
    .filter((x) => x.res?.pass)
    .sort((a, b) => (a.res.squeezePct ?? 100) - (b.res.squeezePct ?? 100)) // 압축 강한 순
    .slice(0, e.keepMax);
  state.candidates = candidates.map((x) => x.item);
  emit("scan:candidates", { count: candidates.length });
  if (abortToken.aborted) return null;

  // 4단계: 후보만 OI 조회 후 정밀 판정
  setPhase("deep");
  const analyzed = await mapWithProgress(candidates, async ({ item, k4h }) => {
    const oiSeries = await getOpenInterestHist(item.symbol, e.oiPeriod, e.oiLimit);
    const funding = fundingMap.get(item.symbol) ?? null;
    return buildEarlyResult(item, k4h, oiSeries, funding, CONFIG);
  });
  return analyzed.filter(Boolean);
}

export async function runScan() {
  if (state.scan.running) return;
  abortToken = { aborted: false };
  state.scan.running = true;
  state.scan.error = null;
  state.scan.startedAt = Date.now();
  emit("scan:start");

  try {
    const now = Date.now();

    // --- 1단계: 전체 종목 수집 ---
    setPhase("universe");
    const symbols = await getExchangeInfo();
    const universe = stage1Universe(symbols);
    state.universe = universe;
    if (abortToken.aborted) return finishAborted();

    // --- 조기 포착 모드면 별도 파이프라인 ---
    if (state.settings.scanMode === "early") {
      const earlyResults = await runEarlyPipeline(universe, now);
      if (earlyResults === null) return finishAborted();
      setPhase("score");
      const results = earlyResults
        .filter((r) => !r.skipped && !r.error && r.score >= state.settings.minScore)
        .sort((a, b) => b.score - a.score)
        .map((r, i) => ({ ...r, rank: i + 1 }));
      state.results = results;
      setPhase("done");
      state.scan.running = false;
      state.scan.lastUpdated = Date.now();
      emit("scan:done", { count: results.length, analyzed: earlyResults.length });
      return results;
    }

    // --- 2단계: 24h 유동성 필터 ---
    setPhase("prefilter");
    const tickers = await getTicker24h();
    state.tickers = tickers;
    const { prefiltered, newListings } = stage2Liquidity(universe, tickers, now);
    state.prefiltered = prefiltered;
    state.newListings = newListings;
    emit("scan:prefiltered", { count: prefiltered.length, newListings });
    if (abortToken.aborted) return finishAborted();

    // --- 3단계: 1h 빠른 분석 → 급락·초기 후보 ---
    setPhase("candidate");
    const dir = state.settings.direction || "long";
    const evaluated = await mapWithProgress(prefiltered, async (item) => {
      const k1h = await getKlines(item.symbol, "1h");
      const closed = k1h.slice(0, state.settings.includeRealtimeCandle ? k1h.length : -1);
      const res = stage3Evaluate(item, closed, dir);
      return { item, res };
    });
    let candidates = evaluated
      .filter((e) => e.res?.pass)
      .sort((a, b) => Math.abs(b.res.change6h) - Math.abs(a.res.change6h)) // 더 크게 움직인 순(롱=급락/숏=급등)
      .map((e) => ({ ...e.item, pre: e.res }));
    candidates = capCandidates(candidates);
    state.candidates = candidates;
    emit("scan:candidates", { count: candidates.length });
    if (abortToken.aborted) return finishAborted();

    // --- 4·5단계: 정밀 분석 + 점수 ---
    setPhase("deep");
    const analyzed = await mapWithProgress(candidates, (item) => deepAnalyze(item, state.settings));

    // --- 점수 필터 + 정렬 ---
    setPhase("score");
    const results = analyzed
      .filter((r) => !r.skipped && !r.error && r.score >= state.settings.minScore)
      .sort((a, b) => b.score - a.score)
      .map((r, i) => ({ ...r, rank: i + 1 }));
    state.results = results;

    setPhase("done");
    state.scan.running = false;
    state.scan.lastUpdated = Date.now();
    emit("scan:done", { count: results.length, analyzed: analyzed.length });
    return results;
  } catch (e) {
    console.error("스캔 실패", e);
    state.scan.error = e.message;
    state.scan.running = false;
    setPhase("error");
    emit("scan:error", e.message);
    return [];
  }
}

function finishAborted() {
  state.scan.running = false;
  setPhase("idle");
  emit("scan:aborted");
  return [];
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
