// state.js — 앱 전역 상태 + localStorage 설정 저장. 단순 pub/sub.

import { CONFIG } from "./config.js";

const SETTINGS_KEY = "qar-ict-settings";

const defaultSettings = {
  version: CONFIG.version,
  minScore: CONFIG.earlyMinScore, // 조기포착 검증 하한. UI에서는 고정값으로 설명한다.
  minQuoteVolume: CONFIG.earlyDetect.minQuoteVolume,
  direction: "long",         // 조기포착 LONG 후보 전용
  scanMode: "early",         // 단일 제품 모드. 이전 저장값은 loadSettings 에서 마이그레이션한다.
  stageFilter: "all",        // 모드별 단계 또는 all
  strictnessLevel: 3,        // 채점 강도 1(널널)~5(엄격), §13 STRICTNESS_LEVELS
  penalties: { ...CONFIG.penalties }, // strictnessLevel 선택 시 프리셋으로 교체됨
  favorites: [],             // 관심 종목 심볼 배열
  excluded: [],              // 제외 종목
  sort: "score",             // "score" | "change" | "volume"
  darkMode: true,
  themeRevision: 1,
  includeRealtimeCandle: false, // 리페인트 방지: 기본은 마감 캔들만
  showFavoritesOnly: false,
  excludeChaseBan: false,       // "추격 금지(5단계)" 제외
  excludeNewListing: false,
  goldenCrossOnly: false,       // 골든크로스 리테스트(거부 캔들 확인)만 보기
  crtTbsOnly: false,            // 기존 후보와 방향이 같은 CRT + TBS 확인 신호만
  near1hEma200Only: false,      // 1시간봉 200일선 밀착만 보기
  near1hEma200AtrRatio: CONFIG.near1hEma200AtrRatio, // 200선 밀착 민감도 (ATR 배수)
  filterNoise: true,            // 노이즈(촙 구간·저거래량) 신호 제외
  seedMoney: 1000000,           // 한 종목에 넣을 금액(원). 손익 금액 표시에만 쓰인다 — 주문 없음
  leverage: 1,                  // 표시용 배수. 1 = 현물/1배 (청산 없음)
  // true = TP1 에서 절반 익절 + 손절을 본전으로(덜 벌고 덜 아픔),
  // false = 목표까지 통째로 버팀(더 벌고 더 아픔). 근거는 config.earlyDetect 주석.
  partialTake: true,
  autoRefresh: false,           // 자동 재스캔
  refreshIntervalMs: CONFIG.refresh.intervalMs,
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...defaultSettings };
    const parsed = JSON.parse(raw);
    // 버전 마이그레이션: 필드 누락 시 기본값 병합
    const migrating = parsed.version !== CONFIG.version;
    const merged = migrating
      ? { ...defaultSettings, ...parsed, version: CONFIG.version }
      : { ...defaultSettings, ...parsed };
    // 제거된 all/reversal/pump_fade/sweep_retest 저장값이 단일 스캐너를 되살리지 않게 한다.
    merged.scanMode = "early";
    if (parsed.themeRevision !== 1) {
      merged.darkMode = true;
      merged.themeRevision = 1;
    }
    merged.direction = "long";
    if (migrating) merged.minQuoteVolume = CONFIG.earlyDetect.minQuoteVolume;
    return merged;
  } catch {
    return { ...defaultSettings };
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
  newListings: [],     // 신규 상장 심볼
  marketRegime: null,  // BTC 4h 기준 시장국면. 점수 보정 없이 후보 설명/기록에 사용
  scan: {
    running: false,
    phase: "idle",     // idle|universe|prefilter|candidate|deep|score|done|error
    progress: 0,       // 0~1
    total: 0,
    done: 0,
    startedAt: 0,
    lastUpdated: 0,
    error: null,
    currentMode: null,  // 전체 스캔에서 현재 실행 중인 모드
    modeIndex: 0,
    modeTotal: 0,
    modeStats: {},      // mode -> { prefiltered, candidates, results }
    modeErrors: {},     // mode -> 오류 문구 (다른 모드는 계속 실행)
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
  state.settings = { ...defaultSettings };
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
