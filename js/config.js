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
  // 완화 방향: 후보 진입 문턱을 넓혀 더 많은 종목이 정밀 분석에 들어오게 함.
  // 대신 늘어난 노이즈는 아래 noiseFilter(촙 구간·저거래량)에서 걸러냄.
  candidateFilter: {
    drop6hMax: -1.5,        // 최근 6시간 하락률 이 값보다 낮으면(더 큰 하락) 후보 (완화 -3→-1.5)
    drop24hMax: 8,          // 24시간 급등한 종목 컷 (완화 5→8)
    surge24hExclude: 45,    // 24시간 이 % 초과 = 이미 급등, 제외 (완화 35→45)
    rsiOversold: 40,        // RSI 과매도 기준(회복 포함 위해 다소 완화)
    rsiLongMax: 60,         // 롱 후보 RSI 상한 (완화 55→60, prefilter stage3)
    nearLowPct: 18,         // 최근 저점 대비 이 % 이내면 "저점 근접" (완화 12→18)
    keepMax: 50,            // 정밀 분석 후보 상한 (완화 40→50)
    // 숏 후보 (급등·과매수) — 롱과 대칭
    surge6hMin: 1.5,        // 최근 6시간 상승률 이 값 이상이면 숏 후보 (완화 3→1.5)
    rsiShortMin: 40,        // 숏 후보 RSI 하한 (완화 45→40, prefilter stage3)
    nearHighPct: 18,        // 최근 고점 대비 이 % 이내면 "고점 근접" (완화 12→18)
    crash24hExclude: -45,   // 24시간 이 % 초과 급락 = 이미 폭락, 숏 제외 (완화 -35→-45)
  },

  // ---- 신호 노이즈 필터 ----
  // 후보 문턱을 완화한 만큼 늘어나는 잡신호 제거. Choppiness Index(횡보 강도) + 저거래량.
  noiseFilter: {
    enabled: true,
    tf: "15m",              // 노이즈 판정 시간봉
    choppinessPeriod: 14,   // Choppiness Index 계산 기간
    choppinessMax: 61.8,    // 이 값 초과 = 횡보/촙 구간 → 잡신호로 제외 (0~100, 높을수록 횡보)
    minRelVol: 0.6,         // 상대 거래량 이 값 미만 = 거래 죽은 코인 → 제외
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

  // ---- 골든크로스 리테스트 (4시간봉 기준) ----
  // 200선 아래 횡보 → 임펄스 돌파 → 되돌림으로 50·200선 부근 리테스트 →
  // 리테스트 구간에서 살짝 찔렀다 훅 꺾이는 거부 캔들, 종가는 200선 안 잃음.
  goldenCrossRetest: {
    crossLookback: 60,        // 골든크로스(50이 200 상향 돌파)를 찾을 최근 캔들 범위
    impulseLookback: 30,      // 크로스 이전 돌파 임펄스를 찾을 범위
    impulseMarginPct: 5,      // 200선 대비 이 %+ 위로 뚫어야 "돌파 임펄스"로 인정
    zoneAtrRatio: 1.5,        // 50/200 리테스트 존 허용 오차 (ATR 배수)
    rejectionWickRatio: 0.3,  // 거부 캔들 위꼬리 최소 비중
    rejectionClosePos: 0.5,   // 거부 캔들 종가가 몸통 하단 50% 안에서 마감
  },

  // ---- 1시간봉 EMA200 밀착 판정 ----
  // 1h 종가가 200일선에서 ATR * 이 배수 이내면 "200선 밀착"으로 표시.
  near1hEma200AtrRatio: 0.5,

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

// ---- 채점 강도 5단계 (§13 사용자 조정 — 가중치는 그대로 두고 감점 세기 + 최소 점수만 단계별로 스케일) ----
// 3단계 = CONFIG.penalties/minListScore 원본값. 1단계로 갈수록 덜 걸러냄(코인 더 많이 나옴).
export const STRICTNESS_LEVELS = [
  { level: 1, label: "1 · 아주 널널하게 (코인 많이)", minScore: 30,
    penalties: { overExtended15m: -5, farFromLowAtr: -4, strongResistanceAbove: -3, shortTargetDistance: -3, tooLowVolume: -4, strongDowntrend4h: -3, newListingThin: -2, poorRiskReward: -4 } },
  { level: 2, label: "2 · 널널하게", minScore: 40,
    penalties: { overExtended15m: -7, farFromLowAtr: -6, strongResistanceAbove: -5, shortTargetDistance: -5, tooLowVolume: -6, strongDowntrend4h: -5, newListingThin: -4, poorRiskReward: -6 } },
  { level: 3, label: "3 · 기본 (권장)", minScore: 55,
    penalties: { overExtended15m: -12, farFromLowAtr: -10, strongResistanceAbove: -8, shortTargetDistance: -8, tooLowVolume: -10, strongDowntrend4h: -8, newListingThin: -6, poorRiskReward: -10 } },
  { level: 4, label: "4 · 엄격하게", minScore: 65,
    penalties: { overExtended15m: -16, farFromLowAtr: -13, strongResistanceAbove: -10, shortTargetDistance: -10, tooLowVolume: -13, strongDowntrend4h: -10, newListingThin: -8, poorRiskReward: -13 } },
  { level: 5, label: "5 · 아주 엄격하게 (확실한 것만)", minScore: 75,
    penalties: { overExtended15m: -19, farFromLowAtr: -16, strongResistanceAbove: -13, shortTargetDistance: -13, tooLowVolume: -16, strongDowntrend4h: -13, newListingThin: -10, poorRiskReward: -16 } },
];
export function strictnessPreset(level) {
  return STRICTNESS_LEVELS.find((s) => s.level === level) || STRICTNESS_LEVELS[2];
}

// 스테이블/레버리지 판별용 패턴
export const STABLE_BASES = new Set([
  "USDT","USDC","BUSD","TUSD","DAI","FDUSD","USDP","UST","USTC","EUR","GBP","AEUR",
]);
export const LEVERAGED_RE = /(UP|DOWN|BULL|BEAR)USDT$/;

export default CONFIG;
