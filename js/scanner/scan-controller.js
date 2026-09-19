// scanner/scan-controller.js — 전체 스캔 파이프라인 오케스트레이션.
// 순서(§18): 24h 데이터 → 유동성 상위 → 1h 빠른 분석 → 후보 축소 → 4H·15M·5M 정밀.
// 동시요청 제한은 api 계층 세마포어가 담당. 진행률/오류 이벤트 emit.

import { CONFIG } from "../config.js";
import { state, emit } from "../state.js";
import {
  getExchangeInfo, getTicker24h, getKlines, getOpenInterestHist, getPremiumIndexAll, closedOnly,
} from "../api/binance.js";
import { stage1Universe, stage2Liquidity, stage3Evaluate, capCandidates, excludeMajors, stage3EvaluateEarly } from "./prefilter.js";
import { deepAnalyze } from "./deep-scanner.js";
import { buildEarlyResult } from "../core/early-detect.js";
import { returnsFrom, correlationMap } from "../core/correlation.js";
import { buildPumpFadeResult, pumpFadePrefilter } from "../core/pump-fade.js";
import { forecastDirection } from "../core/direction-forecast.js";
import { modesForScan, resultMode } from "../scan-modes.js";
import { evaluateCrtTbs } from "../core/crt-tbs.js";
import { analyzeMarketRegime, regimeAlignment } from "../core/market-regime.js";
import { findSweepBase, buildSweepResult } from "../core/sweep-retest.js";

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
function setCurrentMode(mode, index, total) {
  state.scan.currentMode = mode;
  state.scan.modeIndex = index;
  state.scan.modeTotal = total;
  emit("scan:mode", { mode, index, total });
}
function recordModeStats(mode, results) {
  state.scan.modeStats[mode] = {
    prefiltered: state.prefiltered.length,
    candidates: state.candidates.length,
    results: results.filter((r) => r && !r.skipped && !r.error).length,
  };
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
    // early 파이프라인은 { item, k4h, res } 래퍼를 넘기므로 심볼을 양쪽에서 찾는다.
    catch (e) { r = { symbol: it.symbol ?? it.item?.symbol, error: e.message, skipped: true }; }
    done++;
    setProgress(done, total);
    if (onEach && r) onEach(r);
    return r;
  }));
  return results.filter(Boolean);
}

// ---- 조기 포착 모드 파이프라인 ----
// 반환: 기존과 동일 shape 결과 배열 (rank 는 호출부에서 부여)
async function runEarlyPipeline(universe, now, tickers, settings, market4h) {
  const e = CONFIG.earlyDetect;

  // 2단계: early 유니버스 기준으로 유동성 필터
  setPhase("prefilter");
  const { prefiltered, newListings } = stage2Liquidity(universe, tickers, now, {
    ...CONFIG.prefilter,
    minQuoteVolume: Math.max(e.minQuoteVolume, settings.minQuoteVolume ?? e.minQuoteVolume),
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
    const closed = closedOnly(k4h, settings.includeRealtimeCandle);
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
    const result = buildEarlyResult(item, k4h, oiSeries, funding, CONFIG, now);
    if (result) result.forecast = forecastDirection(k4h, market4h, {
      provisional: Boolean(settings.includeRealtimeCandle), now,
    });
    return result;
  });
  const results = analyzed.filter(Boolean);

  // 첫 눌림은 별도 스캐너가 아니라 최종 소수 후보의 추가 확인으로만 계산한다.
  // 모든 심볼에 1h/15m/5m를 요청하지 않아 API 예산을 지킨다.
  const confirmationTargets = [...results]
    .filter((r) => r.score >= CONFIG.earlyMinScore)
    .sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol))
    .slice(0, CONFIG.earlyKeepTop);
  if (confirmationTargets.length) {
    setPhase("confirmation");
    await mapWithProgress(confirmationTargets, async (result) => {
      try {
        const [h1, m15, m5] = await Promise.all([
          getKlines(result.symbol, "1h"), getKlines(result.symbol, "15m", 260), getKlines(result.symbol, "5m", 200),
        ]);
        const sweep = buildSweepResult(result, { h1, m15, m5, btc4h: market4h, now, config: CONFIG.sweepRetest });
        result.earlyConfirmation = {
          sweepRetest: sweep?.sweepRetest || { status: "none", confirmed: false, label: "첫 눌림 확인 없음", reason: "패턴의 시작 조건이 없습니다." },
        };
      } catch {
        result.earlyConfirmation = {
          sweepRetest: { status: "unavailable", confirmed: false, label: "첫 눌림 산출 보류", reason: "확인용 캔들 조회에 실패했습니다." },
        };
      }
      return result;
    });
  }

  // 후보끼리 같이 움직이는지 — k4h 가 아직 손에 있을 때 여기서 계산한다.
  // 화면에 3개가 떠도 셋이 같이 움직이면 분산이 아니라 한 종목에 3배 실은 것이다.
  const series = [];
  for (const { item, k4h } of candidates) {
    if (!results.some((r) => r.symbol === item.symbol)) continue;
    const ret = returnsFrom(k4h, CONFIG.correlation.bars);
    if (ret) series.push({ symbol: item.symbol, returns: ret });
  }
  const corr = correlationMap(series, CONFIG.correlation.threshold);
  for (const r of results) r.correlatedWith = corr.get(r.symbol) || [];
  return results;
}

// ---- 급등 후 급락 모드 파이프라인 (SHORT 전용) ----
// 1h 급등 통과 집합은 임의로 추가 절단하지 않고 모두 15m/5m 정밀 분석한다.
async function runPumpFadePipeline(universe, now, tickers, settings, market4h) {
  const includeRealtime = Boolean(settings.includeRealtimeCandle);

  setPhase("prefilter");
  const { prefiltered, newListings } = stage2Liquidity(universe, tickers, now, {
    ...CONFIG.prefilter,
    minQuoteVolume: settings.minQuoteVolume ?? CONFIG.prefilter.minQuoteVolume,
  });
  state.prefiltered = prefiltered;
  state.newListings = newListings;
  emit("scan:prefiltered", { count: prefiltered.length, newListings });
  if (abortToken.aborted) return null;

  setPhase("candidate");
  const evaluated = await mapWithProgress(prefiltered, async (item) => {
    const raw1h = await getKlines(item.symbol, "1h");
    const candles1h = closedOnly(raw1h, includeRealtime);
    return { item, candles1h, pre: pumpFadePrefilter(candles1h, CONFIG) };
  });
  const candidates = evaluated
    .filter((x) => x.pre?.pass)
    .sort((a, b) => {
      const strength = (b.pre.normalizedStrength ?? -Infinity) - (a.pre.normalizedStrength ?? -Infinity);
      return strength || String(a.item.symbol).localeCompare(String(b.item.symbol));
    });
  state.candidates = candidates.map((x) => x.item);
  emit("scan:candidates", { count: candidates.length });
  if (abortToken.aborted) return null;

  setPhase("deep");
  const analyzed = await mapWithProgress(candidates, async ({ item, candles1h }) => {
    // 방향 모델의 4h 확인은 급등 1차 후보에만 붙인다. 전체 종목 4h 추가 호출은 하지 않는다.
    const [raw4h, raw15m, raw5m] = await Promise.all([
      getKlines(item.symbol, "4h"),
      getKlines(item.symbol, "15m"),
      getKlines(item.symbol, "5m"),
    ]);
    const candles4h = closedOnly(raw4h, includeRealtime);
    const candles15m = closedOnly(raw15m, includeRealtime);
    const candles5m = closedOnly(raw5m, includeRealtime);
    const result = buildPumpFadeResult(item, candles1h, candles15m, candles5m, CONFIG, {
      provisional: includeRealtime,
    });
    if (result) result.forecast = forecastDirection(candles4h, market4h, { provisional: includeRealtime });
    return result;
  });
  return analyzed.filter(Boolean);
}

// ---- 급락 반등 모드 파이프라인 ----
async function runReversalPipeline(universe, now, tickers, settings, market4h) {
  setPhase("prefilter");
  const { prefiltered, newListings } = stage2Liquidity(universe, tickers, now, {
    ...CONFIG.prefilter,
    minQuoteVolume: settings.minQuoteVolume ?? CONFIG.prefilter.minQuoteVolume,
  });
  state.prefiltered = prefiltered;
  state.newListings = newListings;
  emit("scan:prefiltered", { count: prefiltered.length, newListings });
  if (abortToken.aborted) return null;

  setPhase("candidate");
  const dir = settings.direction || "long";
  const evaluated = await mapWithProgress(prefiltered, async (item) => {
    const k1h = await getKlines(item.symbol, "1h");
    const closed = closedOnly(k1h, settings.includeRealtimeCandle);
    const res = stage3Evaluate(item, closed, dir);
    return { item, res };
  });
  let candidates = evaluated
    .filter((e) => e.res?.pass)
    .sort((a, b) => Math.abs(b.res.change6h) - Math.abs(a.res.change6h))
    .map((e) => ({ ...e.item, pre: e.res }));
  candidates = capCandidates(candidates);
  state.candidates = candidates;
  emit("scan:candidates", { count: candidates.length });
  if (abortToken.aborted) return null;

  setPhase("deep");
  return mapWithProgress(candidates, (item) => deepAnalyze(item, settings, market4h));
}

async function runSweepPipeline(universe, now, tickers, settings, market4h) {
  setPhase("prefilter");
  const { prefiltered, newListings } = stage2Liquidity(universe, tickers, now, {
    ...CONFIG.prefilter, minQuoteVolume: settings.minQuoteVolume ?? CONFIG.prefilter.minQuoteVolume,
  });
  state.prefiltered = prefiltered;
  state.newListings = newListings;
  emit("scan:prefiltered", { count: prefiltered.length, newListings });
  setPhase("candidate");
  const evaluated = await mapWithProgress(prefiltered, async item => {
    const h1 = await getKlines(item.symbol, "1h");
    return { item, h1, base: findSweepBase(h1, now, CONFIG.sweepRetest) };
  });
  const candidates = evaluated.filter(x => x.base)
    .sort((a, b) => b.base.endTime - a.base.endTime || a.item.symbol.localeCompare(b.item.symbol))
    .slice(0, CONFIG.sweepRetest.keepMax);
  state.candidates = candidates.map(x => x.item);
  emit("scan:candidates", { count: candidates.length });
  if (abortToken.aborted) return null;
  setPhase("deep");
  return mapWithProgress(candidates, async ({ item, h1 }) => {
    const [m15, m5] = await Promise.all([getKlines(item.symbol, "15m", 260), getKlines(item.symbol, "5m", 200)]);
    return buildSweepResult(item, { h1, m15, m5, btc4h: market4h, now, config: CONFIG.sweepRetest });
  });
}

export function sortAndRankResults(results, requestedMode = "early") {
  return modesForScan(requestedMode).flatMap((mode) => {
    const comparator = mode === "pump_fade"
      ? pumpFadeComparator
      : (a, b) => b.score - a.score || String(a.symbol).localeCompare(String(b.symbol));
    return results
      .filter((r) => r && !r.skipped && !r.error && resultMode(r) === mode)
      .sort(comparator)
      .map((r, i) => ({ ...r, rank: i + 1 }));
  });
}

export async function runScan() {
  if (state.scan.running) return;
  abortToken = { aborted: false };
  state.scan.running = true;
  state.scan.error = null;
  state.scan.startedAt = Date.now();
  state.scan.currentMode = null;
  state.scan.modeIndex = 0;
  state.scan.modeTotal = 0;
  state.scan.modeStats = {};
  state.scan.modeErrors = {};
  emit("scan:start");

  try {
    const now = Date.now();
    // 실행 중 UI 설정을 바꿔도 세 파이프라인의 데이터 경계와 채점 조건은 시작 시점 기준으로 고정한다.
    const settings = { ...state.settings, penalties: { ...state.settings.penalties } };
    const requestedMode = settings.scanMode;

    // --- 1단계: 전체 종목 수집 ---
    setPhase("universe");
    const symbols = await getExchangeInfo();
    const universe = stage1Universe(symbols);
    state.universe = universe;
    if (abortToken.aborted) return finishAborted();

    // 공통 24h 데이터는 전체 스캔에서도 한 번만 요청한다.
    setPhase("prefilter");
    const tickers = await getTicker24h();
    state.tickers = tickers;
    if (abortToken.aborted) return finishAborted();

    // 방향 확률의 시장 국면 입력. 한 번만 요청하고 모든 모드가 재사용한다.
    // 실패해도 기존 세 스캐너는 정상 동작하고 확률만 "산출 보류"가 된다.
    let market4h = [];
    try {
      const rawBtc4h = await getKlines("BTCUSDT", "4h");
      // 시장국면은 항상 마감 봉 기준. 실시간 옵션이 켜져도 진행 중 BTC 봉은 사용하지 않는다.
      market4h = closedOnly(rawBtc4h, false, now);
    } catch (error) {
      console.warn("방향 모델 BTC 4시간봉 조회 실패", error);
    }
    state.marketRegime = analyzeMarketRegime(market4h, CONFIG.marketRegime, now);
    emit("market:regime", state.marketRegime);

    const modes = modesForScan(requestedMode);
    const combined = [];
    for (let i = 0; i < modes.length; i++) {
      const mode = modes[i];
      if (abortToken.aborted) return finishAborted();
      setCurrentMode(mode, i + 1, modes.length);
      try {
        const results = mode === "sweep_retest"
          ? await runSweepPipeline(universe, now, tickers, settings, market4h)
          : mode === "early"
          ? await runEarlyPipeline(universe, now, tickers, settings, market4h)
          : mode === "pump_fade"
            ? await runPumpFadePipeline(universe, now, tickers, settings, market4h)
            : await runReversalPipeline(universe, now, tickers, settings, market4h);
        if (results === null) return finishAborted();
        recordModeStats(mode, results);
        combined.push(...results);
      } catch (e) {
        if (modes.length === 1) throw e;
        state.scan.modeErrors[mode] = e.message;
        state.scan.modeStats[mode] = { prefiltered: 0, candidates: 0, results: 0 };
        emit("scan:mode-error", { mode, message: e.message });
      }
    }
    // 국면은 아직 검증된 가중치가 아니므로 점수를 바꾸지 않는다. 화면과 페이퍼 기록에만 고정한다.
    for (const result of combined) {
      if (!result || result.skipped || result.error) continue;
      result.marketRegime = state.marketRegime;
      result.regimeFit = regimeAlignment(state.marketRegime, result.direction);
    }
    // 후보만 추가 확인. 중복 심볼은 1회 분석하고 기존 캔들 캐시를 재사용한다.
    if (abortToken.aborted) return finishAborted();
    const symbolsToConfirm = [...new Set(combined
      .filter((r) => r && !r.skipped && !r.error && r.score >= CONFIG.earlyMinScore)
      .sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol))
      .slice(0, CONFIG.earlyKeepTop)
      .map((r) => r.symbol))];
    const confirmations = new Map();
    if (symbolsToConfirm.length) {
      setPhase("confirmation");
      await mapWithProgress(symbolsToConfirm.map((symbol) => ({ symbol })), async ({ symbol }) => {
        try {
          const [h4, m5] = await Promise.all([getKlines(symbol, "4h"), getKlines(symbol, "5m")]);
          confirmations.set(symbol, evaluateCrtTbs(h4, m5));
        } catch {
          confirmations.set(symbol, { available: false, confirmed: false, status: "unavailable", label: "산출 보류", reason: "CRT 캔들 조회 실패" });
        }
        return { symbol };
      });
    }
    if (abortToken.aborted) return finishAborted();
    for (const r of combined) if (r && !r.skipped && !r.error) r.crtTbs = confirmations.get(r.symbol);
    return finishScan(combined, requestedMode);
  } catch (e) {
    console.error("스캔 실패", e);
    state.scan.error = e.message;
    state.scan.running = false;
    setPhase("error");
    emit("scan:error", e.message);
    return [];
  }
}

// 스캔 마무리 — 정렬 후 state 에 저장하고 done 이벤트 발행. 두 모드 공용.
// 점수 하한(minScore)은 여기서 자르지 않는다. 잘라 버리면 UI 에서 "최소 점수"를
// 낮춰도 되살릴 데이터가 없어 재스캔해야만 반영됐다. 최종 필터는 ui/settings.applyFilters.
function pumpFadeComparator(a, b) {
  return b.stage.stage - a.stage.stage || b.score - a.score || a.symbol.localeCompare(b.symbol);
}

function finishScan(analyzed, requestedMode) {
  setPhase("score");
  const results = sortAndRankResults(analyzed, requestedMode);
  state.results = results;

  setPhase("done");
  state.scan.running = false;
  state.scan.lastUpdated = Date.now();
  state.scan.currentMode = null;
  // payload 없음 — 표시용 개수는 목록과 같은 필터를 거쳐야 맞으므로 main.js 가 직접 센다.
  emit("scan:done");
  return results;
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
