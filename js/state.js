// state.js — 앱 전역 상태 + localStorage 설정 저장. 단순 pub/sub.

import { CONFIG } from "./config.js";

const SETTINGS_KEY = "qar-ict-settings";

const PATTERN_TIMEFRAMES = ["5m", "15m", "1h", "4h"];

// 기본값에 배열/객체가 들어가므로 매번 새로 만들어야 한다. 얕은 복사로
// 상태를 만들면 관심 종목을 토글할 때 기본값까지 함께 바뀌어 초기화가 깨진다.
function freshDefaultSettings() {
  return {
    version: CONFIG.version,
    minScore: 30,
    minQuoteVolume: CONFIG.prefilter.minQuoteVolume,
    direction: "long",
    scanMode: "patterns",
    scanProfile: "standard",
    patternTimeframes: [...PATTERN_TIMEFRAMES],
    patternScanLimit: CONFIG.patternScanner.maxSymbols,
    patternFamily: "all",
    stageFilter: "all",
    strictnessLevel: 3,
    penalties: { ...CONFIG.penalties },
    favorites: [],
    excluded: [],
    sort: "score",
    darkMode: false,
    includeRealtimeCandle: false,
    showFavoritesOnly: false,
    excludeChaseBan: false,
    excludeNewListing: false,
    goldenCrossOnly: false,
    near1hEma200Only: false,
    near1hEma200AtrRatio: CONFIG.near1hEma200AtrRatio,
    filterNoise: true,
    seedMoney: 1000000,
    leverage: 1,
    partialTake: true,
    autoRefresh: false,
    refreshIntervalMs: CONFIG.refresh.intervalMs,
  };
}

function uniqueSymbols(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter((symbol) => typeof symbol === "string" && symbol.trim()))]
    : [];
}

function numberOr(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function normaliseSettings(parsed) {
  const base = freshDefaultSettings();
  const merged = parsed && typeof parsed === "object" ? { ...base, ...parsed } : base;
  const selected = Array.isArray(merged.patternTimeframes)
    ? PATTERN_TIMEFRAMES.filter((tf) => merged.patternTimeframes.includes(tf))
    : [];
  return {
    ...merged,
    version: CONFIG.version,
    scanMode: "patterns",
    scanProfile: merged.scanProfile === "aggressive" ? "aggressive" : "standard",
    minScore: numberOr(merged.minScore, base.minScore, { min: 0, max: 100 }),
    minQuoteVolume: numberOr(merged.minQuoteVolume, base.minQuoteVolume, { min: 0 }),
    direction: ["long", "short", "both"].includes(merged.direction) ? merged.direction : base.direction,
    patternFamily: ["all", "continuation", "reversal", "harmonic", "candlestick"].includes(merged.patternFamily)
      ? merged.patternFamily : base.patternFamily,
    strictnessLevel: numberOr(merged.strictnessLevel, base.strictnessLevel, { min: 1, max: 5 }),
    near1hEma200AtrRatio: numberOr(merged.near1hEma200AtrRatio, base.near1hEma200AtrRatio, { min: 0.1, max: 3 }),
    seedMoney: numberOr(merged.seedMoney, base.seedMoney, { min: 0 }),
    leverage: numberOr(merged.leverage, base.leverage, { min: 1 }),
    refreshIntervalMs: numberOr(merged.refreshIntervalMs, base.refreshIntervalMs, { min: CONFIG.refresh.minIntervalMs }),
    patternScanLimit: CONFIG.patternScanner.scanLimits.includes(Number(merged.patternScanLimit))
      ? Number(merged.patternScanLimit) : base.patternScanLimit,
    patternTimeframes: selected.length ? selected : [...PATTERN_TIMEFRAMES],
    favorites: uniqueSymbols(merged.favorites),
    excluded: uniqueSymbols(merged.excluded),
    penalties: { ...base.penalties, ...(merged.penalties && typeof merged.penalties === "object" ? merged.penalties : {}) },
  };
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return normaliseSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return freshDefaultSettings();
  }
}

export const state = {
  settings: loadSettings(),

  // 런타임 데이터 (저장 안 함)
  universe: [],        // exchangeInfo 심볼 메타
  tickers: [],         // 24h 티커
  prefiltered: [],     // 1차 통과
  candidates: [],      // 2차 통과
  results: [],         // 최종 스코어링 결과
  patternResults: [],  // 패턴 모드 결과 — 매매 점수 결과와 별도
  patternScanMeta: { requestedTimeframes: [], candidateCount: 0, completedRequests: 0, failedRequests: 0 },
  newListings: [],     // 신규 상장 심볼
  scan: {
    running: false,
    phase: "idle",     // idle|universe|prefilter|candidate|deep|score|done|error
    progress: 0,       // 0~1
    total: 0,
    done: 0,
    startedAt: 0,
    lastUpdated: 0,
    error: null,
  },
  apiHealth: {
    connected: null,   // null=미확인 true/false
    lastError: null,
    weightUsed: 0,
  },
};

// ---- 간단 이벤트 버스 ----
const listeners = new Map(); // event -> Set<fn>
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event)?.delete(fn);
}
export function emit(event, payload) {
  listeners.get(event)?.forEach((fn) => {
    try { fn(payload); } catch (e) { console.error("listener error", event, e); }
  });
}

// ---- 설정 저장/초기화 ----
export function saveSettings() {
  state.settings.version = CONFIG.version;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  } catch (e) {
    console.warn("설정 저장 실패", e);
  }
  emit("settings:changed", state.settings);
}
export function resetSettings() {
  state.settings = freshDefaultSettings();
  saveSettings();
}
export function updateSettings(patch) {
  Object.assign(state.settings, patch);
  saveSettings();
}

// ---- 관심 종목 토글 ----
export function toggleFavorite(symbol) {
  const f = state.settings.favorites;
  const i = f.indexOf(symbol);
  if (i >= 0) f.splice(i, 1); else f.push(symbol);
  saveSettings();
}
export function isFavorite(symbol) {
  return state.settings.favorites.includes(symbol);
}

export default state;
