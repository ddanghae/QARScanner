// scanner/scan-controller.js — 전체 스캔 파이프라인 오케스트레이션.
// 순서(§18): 24h 데이터 → 유동성 상위 → 1h 빠른 분석 → 후보 축소 → 4H·15M·5M 정밀.
// 동시요청 제한은 api 계층 세마포어가 담당. 진행률/오류 이벤트 emit.

import { CONFIG } from "../config.js";
import { state, emit } from "../state.js";
import { getExchangeInfo, getTicker24h, getKlines, getOpenInterestHist, getPremiumIndexAll, closedOnly } from "../api/binance.js";
import { stage1Universe, stage2Liquidity, stage3Evaluate, capCandidates, excludeMajors, stage3EvaluateEarly } from "./prefilter.js";
import { deepAnalyze } from "./deep-scanner.js";
import { buildEarlyResult, buildEarlyMetrics, earlyPlan } from "../core/early-detect.js";
import { buildTrendResult } from "../core/strategies.js";
import { gradeFor, topSignals } from "../core/scoring.js";
import { returnsFrom, correlationMap } from "../core/correlation.js";
import { detectChartPatterns, groupPatternsByTimeframe, patternCompletionPct } from "../core/chart-patterns.js";
import { assessFractalContinuation } from "../core/fractal-continuation.js";
import { assessTrendRetest, observeSupply } from "../core/trend-retest.js";
import { replayPatternHistory, signalFreshness } from "../core/pattern-validation.js";
import { atr, ema } from "../core/indicators.js";
import { scanProfile, selectPatternCandidates, earlyObservation, barActivity } from "../core/scan-profile.js";

let activeRun = null;
let runSequence = 0;

function snapshotSettings() {
  return {
    ...state.settings,
    patternTimeframes: Array.isArray(state.settings.patternTimeframes) ? [...state.settings.patternTimeframes] : [],
    favorites: Array.isArray(state.settings.favorites) ? [...state.settings.favorites] : [],
    excluded: Array.isArray(state.settings.excluded) ? [...state.settings.excluded] : [],
    penalties: state.settings.penalties ? { ...state.settings.penalties } : {},
  };
}

function isCurrentRun(token) {
  return activeRun === token;
}

function canContinue(token) {
  return isCurrentRun(token) && !token.aborted;
}

// 시간봉 배열의 순서가 5m·15m·1h·4h 로 고정되어 있다는 보장은 없다.
// 타점 계산에 쓸 가격은 배열의 마지막 원소가 아니라 가장 최근 마감 시각으로 고른다.
export function selectLatestFrame(frames) {
  return (frames || [])
    .filter((frame) => frame?.bars?.length)
    .sort((a, b) => (b.bars.at(-1)?.closeTime ?? b.bars.at(-1)?.openTime ?? 0)
      - (a.bars.at(-1)?.closeTime ?? a.bars.at(-1)?.openTime ?? 0))[0] || null;
}

export function abortScan() {
  if (!activeRun || activeRun.aborted) return;
  activeRun.aborted = true;
  activeRun.controller.abort();
  state.scan.running = false;
  state.scan.phase = "idle";
  emit("scan:phase", "idle");
  emit("scan:aborted");
  activeRun = null;
}

function setPhase(phase, token = activeRun) {
  if (token && !isCurrentRun(token)) return;
  state.scan.phase = phase;
  emit("scan:phase", phase);
}
function setProgress(done, total, token = activeRun) {
  if (token && !isCurrentRun(token)) return;
  state.scan.done = done;
  state.scan.total = total;
  state.scan.progress = total > 0 ? done / total : 0;
  state.scan.lastUpdated = Date.now();
  emit("scan:progress", { done, total, progress: state.scan.progress });
}

// 동시성 있는 map — 세마포어가 실제 병렬 수를 제한하므로 전부 시작해도 안전.
async function mapWithProgress(items, fn, onEach, token) {
  let done = 0;
  const total = items.length;
  setProgress(0, total, token);
  const results = await Promise.all(items.map(async (it) => {
    if (!canContinue(token)) return null;
    let r = null;
    try { r = await fn(it); }
    // early 파이프라인은 { item, k4h, res } 래퍼를 넘기므로 심볼을 양쪽에서 찾는다.
    catch (e) { r = { symbol: it.symbol ?? it.item?.symbol, error: e.message, skipped: true }; }
    done++;
    setProgress(done, total, token);
    if (onEach && r && canContinue(token)) onEach(r);
    return r;
  }));
  return results.filter(Boolean);
}

// ---- 조기 포착 모드 파이프라인 ----
// 반환: 기존과 동일 shape 결과 배열 (rank 는 호출부에서 부여)
// 추세 추종 파이프라인. early 와 뼈대가 같아 보이지만 1차 선별 기준이 반대다:
// early 는 압축(squeezePct) 강한 순으로 남기고, 여기는 상승률 큰 순으로 남긴다.
// OI 는 안 부른다 — 채점에 안 쓰이므로 후보당 1회 호출을 통째로 아낀다.
async function runTrendPipeline(universe, now, token) {
  const t = CONFIG.trendFollow;

  setPhase("prefilter", token);
  const tickers = await getTicker24h();
  if (!canContinue(token)) return null;
  state.tickers = tickers;
  const { prefiltered, newListings } = stage2Liquidity(universe, tickers, now, {
    ...CONFIG.prefilter,
    minQuoteVolume: token.settings.minQuoteVolume ?? t.minQuoteVolume,
  });
  state.prefiltered = prefiltered;
  state.newListings = newListings;
  emit("scan:prefiltered", { count: prefiltered.length, newListings });
  if (!canContinue(token)) return null;

  const fundingMap = await getPremiumIndexAll();
  if (!canContinue(token)) return null;

  // 1차 선별: 24시간 상승률로 자른다. 티커는 이미 손에 있으므로 API 호출이 0이다
  // — 4시간봉을 500종목 전부에 받으면 그게 스캔 시간의 대부분이 된다.
  setPhase("candidate", token);
  const byTicker = new Map(tickers.map((x) => [x.symbol, x]));
  const shortlist = prefiltered
    .map((item) => ({ item, chg: +(byTicker.get(item.symbol)?.priceChangePercent ?? 0) }))
    .filter((x) => x.chg >= t.prefilterMinMomPct)
    .sort((a, b) => b.chg - a.chg)
    .slice(0, t.keepMax)
    .map((x) => x.item);
  state.candidates = shortlist;
  emit("scan:candidates", { count: shortlist.length });
  if (!canContinue(token)) return null;

  setPhase("deep", token);
  const analyzed = await mapWithProgress(shortlist, async (item) => {
    const k4h = await getKlines(item.symbol, "4h");
    const closed = k4h.slice(0, token.settings.includeRealtimeCandle ? k4h.length : -1);
    const funding = fundingMap.get(item.symbol) ?? null;
    const res = buildTrendResult(item, closed, funding, CONFIG,
      { buildEarlyMetrics, earlyPlan, gradeFor, topSignals });
    return res ? { res, k4h: closed } : null;
  }, null, token);
  if (!canContinue(token)) return null;
  const kept = analyzed.filter(Boolean);
  const results = kept.map((x) => x.res);

  // 상승장에서는 후보가 죄다 같이 오르기 쉽다 — 분산이 아니라는 걸 여기서 알려야 한다.
  const series = [];
  for (const { res, k4h } of kept) {
    const ret = returnsFrom(k4h, CONFIG.correlation.bars);
    if (ret) series.push({ symbol: res.symbol, returns: ret });
  }
  const corr = correlationMap(series, CONFIG.correlation.threshold);
  for (const r of results) r.correlatedWith = corr.get(r.symbol) || [];
  return results;
}

// ---- 차트 패턴 모드 ----
const PATTERN_TIMEFRAMES = ["5m", "15m", "1h", "4h"];

// 거래대금 상위 심볼만 검사하고, 선택한 시간봉별 결과는 합치지 않고 나란히 보존한다.
async function runPatternPipeline(universe, now, token, focusSymbols = null) {
  const profile = scanProfile(token.settings.scanProfile);
  const configured = Array.isArray(token.settings.patternTimeframes)
    ? token.settings.patternTimeframes : [];
  const timeframes = PATTERN_TIMEFRAMES.filter((tf) => configured.includes(tf));
  if (!timeframes.length) timeframes.push(...PATTERN_TIMEFRAMES);
  state.patternScanMeta = { requestedTimeframes: timeframes, candidateCount: 0, completedRequests: 0, failedRequests: 0 };
  setPhase("prefilter", token);
  const tickers = await getTicker24h({ signal: token.controller.signal });
  if (!canContinue(token)) return null;
  state.tickers = tickers;
  const { prefiltered, newListings } = stage2Liquidity(universe, tickers, now, {
    ...CONFIG.prefilter,
    minQuoteVolume: token.settings.minQuoteVolume ?? CONFIG.prefilter.minQuoteVolume,
    topByVolume: profile === scanProfile("aggressive") ? universe.length
      : Math.max(CONFIG.prefilter.topByVolume, Number(token.settings.patternScanLimit) || profile.limit),
  });
  state.prefiltered = prefiltered;
  state.newListings = newListings;
  emit("scan:prefiltered", { count: prefiltered.length, newListings });
  if (!canContinue(token)) return null;

  setPhase("candidate", token);
  const requestedLimit = Number(token.settings.patternScanLimit) || CONFIG.patternScanner.maxSymbols;
  const scanLimit = CONFIG.patternScanner.scanLimits.includes(requestedLimit)
    ? requestedLimit : CONFIG.patternScanner.maxSymbols;
  const candidates = focusSymbols
    ? prefiltered.filter(item => focusSymbols.includes(item.symbol))
    : selectPatternCandidates(prefiltered, token.settings, scanLimit);
  state.candidates = candidates;
  const patternStats = {
    scanProfile: token.settings.scanProfile || "standard",
    requestedTimeframes: timeframes,
    candidateCount: candidates.length,
    completedRequests: 0,
    failedRequests: 0,
  };
  emit("scan:candidates", { count: candidates.length });
  if (!canContinue(token)) return null;

  setPhase("deep", token);
  const analyzed = await mapWithProgress(candidates, async (item) => {
    const frameResults = await Promise.all(timeframes.map(async (timeframe) => {
      try {
        const raw = await getKlines(item.symbol, timeframe, CONFIG.klinesLimit[timeframe], {
          signal: token.controller.signal, force: !!focusSymbols && ["5m", "15m"].includes(timeframe),
        });
        const confirmedAt = Date.now();
        const confirmedBars = raw.filter((bar) => Number.isFinite(Number(bar.closeTime)) && Number(bar.closeTime) < confirmedAt);
        const realtime = token.settings.scanProfile !== "aggressive" && token.settings.includeRealtimeCandle;
        const bars = realtime ? raw : confirmedBars;
        const closes = bars.map((bar) => bar.close);
        const ema200 = ema(closes, 200).at(-1);
        const atr14 = atr(bars, 14).at(-1);
        const lastClose = closes.at(-1);
        const ema200Context = Number.isFinite(ema200) && Number.isFinite(lastClose)
          ? {
            position: lastClose > ema200 ? "above" : lastClose < ema200 ? "below" : "equal",
            value: ema200,
            distancePct: (lastClose / ema200 - 1) * 100,
          }
          : null;
        const patterns = detectChartPatterns(bars, { pivotDepth: profile.pivotDepth })
          .map((pattern) => ({
            ...pattern,
            provisional: realtime && bars.at(-1)?.closeTime >= confirmedAt,
            completionPct: realtime && bars.at(-1)?.closeTime >= confirmedAt ? null : patternCompletionPct(pattern, bars.at(-1)?.close),
          }));
        // The backtested 5m rule always reads closed candles, even when the
        // general pattern view is configured to show a provisional candle.
        const fractalContinuation = timeframe === "5m" ? {
          ...assessFractalContinuation(confirmedBars,
            detectChartPatterns(confirmedBars, { pivotDepth: CONFIG.patternScanner.pivotDepth }),
            { pivotDepth: CONFIG.patternScanner.pivotDepth, asOf: confirmedAt }),
          closedAt: confirmedBars.at(-1)?.closeTime ?? null,
          price: confirmedBars.at(-1)?.close ?? null,
          freshness: signalFreshness(confirmedBars.at(-1)?.closeTime, "5m", Date.now(), false),
        } : null;
        const latestCandleTime = bars.at(-1)?.closeTime ?? bars.at(-1)?.openTime ?? null;
        return {
          timeframe,
          bars,
          confirmedBars,
          atr14: Number.isFinite(atr14) ? atr14 : null,
          ema200: ema200Context,
          latestCandleTime,
          freshness: signalFreshness(latestCandleTime, timeframe, Date.now(), realtime),
          activity: barActivity(confirmedBars),
          validation: token.settings.scanProfile !== "aggressive" && patterns.length ? replayPatternHistory(confirmedBars, {
            pivotDepth: CONFIG.patternScanner.pivotDepth,
            horizonBars: timeframe === "4h" ? 8 : 12,
            warmup: timeframe === "4h" ? 80 : 60,
            step: 8,
            maxSamples: 10,
          }) : null,
          fractalContinuation,
          patterns,
        };
      } catch (error) {
        return { timeframe, bars: [], patterns: [], error: error?.message || "요청 실패" };
      }
    }));
    patternStats.completedRequests += frameResults.length;
    patternStats.failedRequests += frameResults.filter((frame) => frame.error).length;
    if (frameResults.every(frame => frame.error)) token.failedSymbols.add(item.symbol);
    const patterns = groupPatternsByTimeframe(Object.fromEntries(
      frameResults.map(({ timeframe, patterns: found }) => [timeframe, found]),
    ));
    const fractalContinuation = frameResults.find((frame) => frame.timeframe === "5m")?.fractalContinuation || null;
    const failedTimeframes = frameResults.filter((frame) => frame.error).map((frame) => frame.timeframe);
    const latestFrame = selectLatestFrame(frameResults);
    const trendRetest = assessTrendRetest(Object.fromEntries(frameResults.map(frame => [frame.timeframe, frame.confirmedBars || []])), { asOf: Date.now() });
    const row = {
      scanProfile: token.settings.scanProfile || "standard",
      explorationReason: item.explorationReason,
      symbol: item.symbol,
      baseAsset: item.baseAsset,
      price: latestFrame?.bars.at(-1)?.close ?? item.lastPrice,
      quoteVolume: item.quoteVolume,
      newListing: item.newListing,
      latestCandleTime: latestFrame?.bars.at(-1)?.closeTime ?? latestFrame?.bars.at(-1)?.openTime ?? null,
      candleTimeByTimeframe: Object.fromEntries(frameResults.map((frame) => [frame.timeframe, frame.latestCandleTime ?? null])),
      freshnessByTimeframe: Object.fromEntries(frameResults.map((frame) => [frame.timeframe, frame.freshness || null])),
      validationByTimeframe: Object.fromEntries(frameResults.map((frame) => [frame.timeframe, frame.validation || null])),
      scannedTimeframes: timeframes,
      failedTimeframes,
      atrByTimeframe: Object.fromEntries(frameResults.map((frame) => [frame.timeframe, frame.atr14 ?? null])),
      ema200ByTimeframe: Object.fromEntries(frameResults.map((frame) => [frame.timeframe, frame.ema200 || null])),
      fractalContinuation,
      trendRetest,
      patterns,
      activityByTimeframe: Object.fromEntries(frameResults.map(frame => [frame.timeframe, frame.activity || null])),
    };
    row.earlyObservation = row.scanProfile === "aggressive" ? earlyObservation(row) : null;
    // Keep closed bars only until candidate-limited supply enrichment completes.
    row.supplyBars = frameResults.find(frame => frame.timeframe === "5m")?.confirmedBars || [];
    return patterns.length || fractalContinuation?.matched || row.earlyObservation || trendRetest.pattern ? row : null;
  }, null, token);
  if (!canContinue(token)) return null;
  state.patternScanMeta = patternStats;
  const rows = analyzed.filter((r) => r && !r.skipped && !r.error);
  const supplyCandidates = rows.filter(row => row.trendRetest?.pattern && ["ready", "retest", "breakout"].includes(row.trendRetest.status))
    .sort((a,b) => Number(b.trendRetest.status === "ready") - Number(a.trendRetest.status === "ready") || b.quoteVolume-a.quoteVolume)
    .slice(0, CONFIG.trendRetest.supplyMaxSymbols);
  if (supplyCandidates.length && canContinue(token)) {
    const funding = await getPremiumIndexAll({ signal: token.controller.signal });
    if (!canContinue(token)) return null;
    const fundingAt = Date.now();
    await Promise.all(supplyCandidates.map(async row => {
      const oi = await getOpenInterestHist(row.symbol, "5m", 6, { signal: token.controller.signal, ttl: 60000 });
      if (!canContinue(token)) return;
      row.trendRetest.supply = observeSupply(row.supplyBars, Date.now(), { oi, funding: funding.get(row.symbol), fundingAt });
    }));
    if (!canContinue(token)) return null;
  }
  for (const row of rows) delete row.supplyBars;
  return rows;
}

async function runEarlyPipeline(universe, now, token) {
  const e = CONFIG.earlyDetect;

  // 2단계: early 유니버스 기준으로 유동성 필터
  setPhase("prefilter", token);
  const tickers = await getTicker24h();
  if (!canContinue(token)) return null;
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
  if (!canContinue(token)) return null;

  // 펀딩비는 스캔당 1회 (전 종목)
  const fundingMap = await getPremiumIndexAll();
  if (!canContinue(token)) return null;

  // 3단계: 4시간봉으로 1차 선별
  setPhase("candidate", token);
  const evaluated = await mapWithProgress(midCaps, async (item) => {
    const k4h = await getKlines(item.symbol, "4h");
    const closed = k4h.slice(0, token.settings.includeRealtimeCandle ? k4h.length : -1);
    return { item, k4h: closed, res: stage3EvaluateEarly(item, closed, CONFIG) };
  }, null, token);
  if (!canContinue(token)) return null;
  let candidates = evaluated
    .filter((x) => x.res?.pass)
    .sort((a, b) => (a.res.squeezePct ?? 100) - (b.res.squeezePct ?? 100)) // 압축 강한 순
    .slice(0, e.keepMax);
  state.candidates = candidates.map((x) => x.item);
  emit("scan:candidates", { count: candidates.length });
  if (!canContinue(token)) return null;

  // 4단계: 후보만 OI 조회 후 정밀 판정
  setPhase("deep", token);
  const analyzed = await mapWithProgress(candidates, async ({ item, k4h }) => {
    const oiSeries = await getOpenInterestHist(item.symbol, e.oiPeriod, e.oiLimit);
    const funding = fundingMap.get(item.symbol) ?? null;
    return buildEarlyResult(item, k4h, oiSeries, funding, CONFIG);
  }, null, token);
  if (!canContinue(token)) return null;
  const results = analyzed.filter(Boolean);

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

export async function runScan({ focus = false } = {}) {
  if (state.scan.running) return;
  const token = { id: ++runSequence, aborted: false, settings: snapshotSettings(), controller: new AbortController(), failedSymbols: new Set() };
  const focusSymbols = focus && token.settings.scanProfile === "aggressive"
    && state.patternScanMeta.settingsKey === patternSettingsKey(token.settings)
    ? state.patternResults.slice(0, 20).map(row => row.symbol) : null;
  token.focusSymbols = focusSymbols?.length ? focusSymbols : null;
  const previousRows = state.patternResults.slice();
  const previousMeta = { ...state.patternScanMeta };
  activeRun = token;
  state.scan.running = true;
  state.scan.error = null;
  state.scan.startedAt = Date.now();
  emit("scan:start");

  try {
    const now = Date.now();

    // --- 1단계: 전체 종목 수집 ---
    setPhase("universe", token);
    const symbols = await getExchangeInfo({ signal: token.controller.signal });
    if (!canContinue(token)) return finishAborted(token);
    const universe = stage1Universe(symbols);
    state.universe = universe;
    if (!canContinue(token)) return finishAborted(token);

    // --- 조기 포착 모드면 별도 파이프라인 ---
    if (token.settings.scanMode === "early") {
      const earlyResults = await runEarlyPipeline(universe, now, token);
      if (earlyResults === null) return finishAborted(token);
      return finishScan(earlyResults, token);
    }

    if (token.settings.scanMode === "patterns") {
      const patternResults = await runPatternPipeline(universe, now, token, token.focusSymbols);
      if (patternResults === null) return finishAborted(token);
      if (token.focusSymbols) {
        const changed = new Map(patternResults.map(row => [row.symbol, row]));
        const merged = previousRows.flatMap(row => !token.focusSymbols.includes(row.symbol) || token.failedSymbols.has(row.symbol)
          ? [row] : changed.has(row.symbol) ? [changed.get(row.symbol)] : []);
        const partialFailed = state.patternScanMeta.failedRequests;
        state.patternScanMeta = { ...previousMeta, focusUpdatedAt: Date.now(), focusFailedRequests: partialFailed };
        emit("scan:focus-done", { failedRequests: partialFailed });
        return finishPatternScan(merged, token);
      }
      state.patternScanMeta.settingsKey = patternSettingsKey(token.settings);
      state.patternScanMeta.fullUpdatedAt = Date.now();
      return finishPatternScan(patternResults, token);
    }

    // --- 추세 추종 모드 ---
    if (token.settings.scanMode === "trend") {
      const trendResults = await runTrendPipeline(universe, now, token);
      if (trendResults === null) return finishAborted(token);
      return finishScan(trendResults, token);
    }

    // --- 2단계: 24h 유동성 필터 ---
    setPhase("prefilter", token);
    const tickers = await getTicker24h();
    if (!canContinue(token)) return finishAborted(token);
    state.tickers = tickers;
    // 최소 거래대금은 사용자 설정 우선 (필터 바의 "최소 거래대금").
    // early 모드는 중형 중심 유니버스라 자체 기준(earlyDetect.minQuoteVolume)을 그대로 쓴다.
    const { prefiltered, newListings } = stage2Liquidity(universe, tickers, now, {
      ...CONFIG.prefilter,
      minQuoteVolume: token.settings.minQuoteVolume ?? CONFIG.prefilter.minQuoteVolume,
    });
    state.prefiltered = prefiltered;
    state.newListings = newListings;
    emit("scan:prefiltered", { count: prefiltered.length, newListings });
    if (!canContinue(token)) return finishAborted(token);

    // --- 3단계: 1h 빠른 분석 → 급락·초기 후보 ---
    setPhase("candidate", token);
    const dir = token.settings.direction || "long";
    const evaluated = await mapWithProgress(prefiltered, async (item) => {
      const k1h = await getKlines(item.symbol, "1h");
      const closed = k1h.slice(0, token.settings.includeRealtimeCandle ? k1h.length : -1);
      const res = stage3Evaluate(item, closed, dir);
      return { item, res };
    }, null, token);
    if (!canContinue(token)) return finishAborted(token);
    let candidates = evaluated
      .filter((e) => e.res?.pass)
      .sort((a, b) => Math.abs(b.res.change6h) - Math.abs(a.res.change6h)) // 더 크게 움직인 순(롱=급락/숏=급등)
      .map((e) => ({ ...e.item, pre: e.res }));
    candidates = capCandidates(candidates);
    state.candidates = candidates;
    emit("scan:candidates", { count: candidates.length });
    if (!canContinue(token)) return finishAborted(token);

    // --- 4·5단계: 정밀 분석 + 점수 ---
    setPhase("deep", token);
    const analyzed = await mapWithProgress(candidates, (item) => deepAnalyze(item, token.settings), null, token);
    if (!canContinue(token)) return finishAborted(token);
    return finishScan(analyzed, token);
  } catch (e) {
    if (!isCurrentRun(token)) return [];
    if (token.aborted) return finishAborted(token);
    console.error("스캔 실패", e);
    state.scan.error = e.message;
    state.scan.running = false;
    setPhase("error", token);
    emit("scan:error", e.message);
    activeRun = null;
    return [];
  }
}

// 스캔 마무리 — 정렬 후 state 에 저장하고 done 이벤트 발행. 두 모드 공용.
// 점수 하한(minScore)은 여기서 자르지 않는다. 잘라 버리면 UI 에서 "최소 점수"를
// 낮춰도 되살릴 데이터가 없어 재스캔해야만 반영됐다. 최종 필터는 ui/settings.applyFilters.
function finishScan(analyzed, token) {
  if (!canContinue(token)) return finishAborted(token);
  setPhase("score", token);
  const results = analyzed
    .filter((r) => !r.skipped && !r.error)
    .sort((a, b) => b.score - a.score)
    .map((r, i) => ({ ...r, rank: i + 1 }));
  state.results = results;

  setPhase("done", token);
  state.scan.running = false;
  state.scan.lastUpdated = Date.now();
  // payload 없음 — 표시용 개수는 목록과 같은 필터를 거쳐야 맞으므로 main.js 가 직접 센다.
  emit("scan:done");
  activeRun = null;
  return results;
}

function finishPatternScan(analyzed, token) {
  if (!canContinue(token)) return finishAborted(token);
  setPhase("score", token);
  state.patternResults = analyzed
    .sort((a, b) => maxPatternFit(b) - maxPatternFit(a)
      || b.quoteVolume - a.quoteVolume)
    .map((r, i) => ({ ...r, rank: i + 1 }));
  setPhase("done", token);
  state.scan.running = false;
  state.scan.lastUpdated = Date.now();
  emit("scan:done");
  activeRun = null;
  return state.patternResults;
}

function maxPatternFit(row) {
  return Math.max(row.earlyObservation?.fitScore || 0, ...row.patterns.flatMap((pattern) =>
    Object.values(pattern.timeframes || {}).map((frame) => Number(frame.fitScore) || 0)));
}

function finishAborted(token) {
  if (!isCurrentRun(token)) return [];
  state.scan.running = false;
  state.scan.phase = "idle";
  emit("scan:phase", "idle");
  emit("scan:aborted");
  activeRun = null;
  return [];
}

// ---- 자동 갱신 (§15 카운트다운 · §18 백그라운드 빈도 감소) ----
let refreshTimer = null;
let tickTimer = null;
let nextRefreshAt = 0;
function patternSettingsKey(settings) {
  return JSON.stringify([settings.scanProfile, settings.patternScanLimit, settings.minQuoteVolume,
    settings.patternTimeframes, settings.favorites, settings.excluded, settings.includeRealtimeCandle]);
}

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
  const aggressive = state.settings.scanProfile === "aggressive";
  const delay = nextRefreshDelay(aggressive ? 30_000 : state.settings.refreshIntervalMs, !!state.backgrounded);
  nextRefreshAt = Date.now() + delay;
  refreshTimer = setTimeout(async () => {
    if (!state.scan.running) {
      const fullInterval = Math.max(90_000, state.settings.refreshIntervalMs);
      const focus = aggressive && !state.backgrounded
        && Date.now() - (state.patternScanMeta.fullUpdatedAt || 0) < fullInterval;
      try { await runScan({ focus }); } catch (e) { console.warn("자동 갱신 실패", e); }
    }
    if (tickTimer || refreshTimer) scheduleNext(); // 여전히 활성일 때만 재예약
  }, delay);
}

export default {
  runScan, abortScan, startAutoRefresh, stopAutoRefresh, isAutoRefreshOn, nextRefreshDelay,
};
