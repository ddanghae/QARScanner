// config.js — 모든 튜닝 값 한 곳에서 관리. UI/스캐너가 여기서 읽는다.
// GitHub Pages 정적 실행. 빌드 과정 없음. ES Module.

export const CONFIG = {
  version: 1,

  // ---- Binance 공개 REST API ----
  api: {
    fapiBase: "https://fapi.binance.com",
    // 동시 요청 수 (브라우저 과부하 방지). 4~6 권장.
    maxConcurrent: 5,
    requestTimeoutMs: 12000,
    maxRetries: 2,
    retryBackoffMs: 800,
  },

  // ---- 캔들 데이터 캐시 TTL (시간봉별 다르게) ----
  cacheTtlMs: {
    "5m": 45 * 1000,    // 30~60초
    "15m": 90 * 1000,   // 1~3분
    "1h": 240 * 1000,   // 3~5분
    "4h": 900 * 1000,   // 10~20분
    ticker24h: 60 * 1000,
    exchangeInfo: 60 * 60 * 1000,
  },

  // ---- 1차 유동성 필터 (24시간 데이터 기반) ----
  prefilter: {
    minQuoteVolume: 20_000_000,   // 최소 24시간 거래대금 (USDT)
    minTradeCount: 50_000,        // 최소 거래 횟수
    minPrice: 0.0001,             // 지나치게 낮은 가격 제외
    excludeStable: true,          // 스테이블코인 제외
    excludeLeveraged: true,       // UP/DOWN/BULL/BEAR 등 레버리지 토큰 제외
    newListingDays: 14,           // 이 일수 미만 = 신규 상장으로 별도 표시
    topByVolume: 130,             // 거래대금 상위 N개만 정밀 분석 (100~150)
  },

  // ---- 급락·초기 후보 필터 (2차) ----
  candidateFilter: {
    drop6hMax: -3,          // 최근 6시간 하락률 이 값보다 낮으면(더 큰 하락) 후보
    drop24hMax: 5,          // 24시간 급등한 종목 컷 (이미 급등 제외)
    surge24hExclude: 35,    // 24시간 +35% 초과 = 이미 급등, 제외
    rsiOversold: 40,        // RSI 과매도 기준(회복 포함 위해 다소 완화)
    nearLowPct: 12,         // 최근 저점 대비 이 % 이내면 "저점 근접"
    keepMax: 40,            // 정밀 분석 후보 상한 (20~40)
    // 숏 후보 (급등·과매수) — 롱과 대칭
    surge6hMin: 3,          // 최근 6시간 상승률 이 값 이상이면 숏 후보
    nearHighPct: 12,        // 최근 고점 대비 이 % 이내면 "고점 근접"
    crash24hExclude: -35,   // 24시간 -35% 초과 급락 = 이미 폭락, 숏 제외
  },

  // ---- 시장구조 엔진 ----
  structure: {
    internalPivot: 2,   // 좌우 2~3 봉
    swingPivot: 5,      // 좌우 5~10 봉
    equalTolAtrRatio: 0.1, // Equal High/Low 허용 오차 = ATR * 이 비율
  },

  // ---- FVG ----
  fvg: {
    minSizeAtrRatio: 0.05,  // 너무 작은 FVG 제외 (ATR 대비)
    minSizePct: 0.15,       // 또는 퍼센트 기준
  },

  // ---- 점수 가중치 (합계 100) ----
  scoreWeights: {
    dropAndOversold: 10,    // 급락 및 과매도 상태
    volumeLiquidity: 10,    // 거래대금과 유동성
    lowLiquiditySweep: 15,  // 저점 유동성 스윕
    sweepPriceRecovery: 10, // 스윕 후 가격 회복
    sellAbsorption: 10,     // 매도 흡수 추정
    structureShift1h: 15,   // 1시간봉 구조전환
    fvgObOverlap: 10,       // 15분봉 FVG·OB 중첩
    volumeDeltaShift: 10,   // 거래량 및 Delta 전환
    entryTrigger5m: 5,      // 5분봉 진입 트리거
    riskReward: 5,          // 예상 손익비 1:2 이상
  },

  // ---- 감점 조건 ----
  penalties: {
    overExtended15m: -12,   // 이미 15분봉 기준 과도 상승
    farFromLowAtr: -10,     // 저점에서 ATR 기준 지나치게 멀어짐
    strongResistanceAbove: -8, // 바로 위 강한 저항
    shortTargetDistance: -8, // 목표 유동성까지 거리 짧음
    tooLowVolume: -10,      // 거래량 지나치게 낮음
    strongDowntrend4h: -8,  // 4시간봉 강한 하락 추세
    newListingThin: -6,     // 신규 상장 직후 데이터 부족
    poorRiskReward: -10,    // 손익비 1:1.5 미만
  },

  // ---- 등급 경계 ----
  grades: [
    { min: 85, label: "강한 후보", key: "strong" },
    { min: 75, label: "관심 후보", key: "watch" },
    { min: 65, label: "관찰 후보", key: "observe" },
    { min: 55, label: "조건 부족", key: "weak" },
    { min: 0, label: "제외", key: "excluded" },
  ],
  minListScore: 55, // 55 미만 기본 목록 제외

  // ---- 지표 파라미터 ----
  indicators: {
    emaPeriods: [20, 50, 100, 200],
    smaPeriod: 20,
    rsiPeriod: 14,
    macd: { fast: 12, slow: 26, signal: 9 },
    bb: { period: 20, mult: 2 },
    atrPeriod: 14,
    stochRsi: { rsi: 14, stoch: 14, k: 3, d: 3 },
    obvEnabled: true,
  },

  // ---- 멀티타임프레임 캔들 요청 수 ----
  klinesLimit: {
    "4h": 220,
    "1h": 260,
    "15m": 200,
    "5m": 160,
  },

  // ---- 자동 갱신 (§15 다음 갱신까지 남은 시간 · §18 백그라운드 빈도 감소) ----
  refresh: {
    intervalMs: 90_000,        // 자동 재스캔 주기
    minIntervalMs: 30_000,     // 사용자 설정 하한 (API 과호출 방지)
    backgroundMultiplier: 4,   // 탭 백그라운드면 주기 4배 (느리게)
    tickMs: 1000,              // 카운트다운 갱신 간격
  },

  // ---- UI ----
  ui: {
    resultMin: 5,
    resultMax: 20,
    minTouchPx: 44,
    tradingViewSuffix: ".P", // BINANCE:${symbol}.P
  },
};

// 스테이블/레버리지 판별용 패턴
export const STABLE_BASES = new Set([
  "USDT","USDC","BUSD","TUSD","DAI","FDUSD","USDP","UST","USTC","EUR","GBP","AEUR",
]);
export const LEVERAGED_RE = /(UP|DOWN|BULL|BEAR)USDT$/;

export default CONFIG;
