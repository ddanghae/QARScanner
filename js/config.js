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
    drop6hMax: -1.5,        // 최근 6시간 하락률 이 값보다 낮으면(더 큰 하락) 후보
    // 24시간 하락률. drop6hMax 와 같이 음수 = 하락. 예전엔 +8 이었는데 이름과 달리
    // "24h 가 +8% 이하면 통과" 라는 허용절로 작동해 71종목 중 60 을 그냥 들여보냈다.
    drop24hMax: -8,
    surge24hExclude: 45,    // 24시간 이 % 초과 = 이미 급등, 제외
    rsiOversold: 40,        // RSI 과매도 기준(회복 포함 위해 다소 완화)
    rsiLongMax: 60,         // 롱 후보 RSI 상한
    // 최근 저점 대비 이 % 이내면 "저점 근접". 18 이면 하루 18% 넘게 움직이는 코인이
    // 드물어 71종목 중 58 이 통과했다 = 필터 기능 상실. 실제 저점 근접만 잡는다.
    nearLowPct: 8,
    // 이미 반등(롱)·하락(숏)이 이만큼 진행됐으면 "초기" 가 아니다 → 추격 방지.
    // 이 가드가 없어서 6시간에 +18.9% 급등 중인 코인이 급락 반등 롱 후보로 들어왔다.
    maxCounterMove6h: 3,
    keepMax: 50,            // 정밀 분석 후보 상한
    // 숏 후보 (급등·과매수) — 롱과 대칭
    surge6hMin: 1.5,        // 최근 6시간 상승률 이 값 이상이면 숏 후보
    rsiShortMin: 40,        // 숏 후보 RSI 하한
    nearHighPct: 8,         // 최근 고점 대비 이 % 이내면 "고점 근접"
    crash24hExclude: -45,   // 24시간 이 % 초과 급락 = 이미 폭락, 숏 제외
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

  // ---- 조기 포착 모드 (early) ----
  // 큰 상승 이전 흔적: 변동성 압축 + 거래량 고갈 + 미결제약정 증가.
  // 기준 시간봉 4h. 임계값은 실사용하며 조정하는 것을 전제로 한다.
  earlyDetect: {
    // 계산 파라미터
    boxLookback: 60,        // 박스 판정 봉 수 (4h × 60 ≈ 10일)
    squeezeLookback: 100,   // 압축 백분위 계산 구간
    volRecentN: 20,         // 최근 거래량 평균 구간
    volPriorN: 60,          // 비교 대상 이전 구간
    oiPeriod: "1h",         // openInterestHist period
    oiLimit: 73,            // 72시간 변화율에는 기준점 1개가 더 필요 (now, now-72 → 73개)
    // 유니버스 (중형 중심)
    minQuoteVolume: 5_000_000,
    topByVolume: 200,
    excludeMajors: ["BTC", "ETH", "BNB", "SOL", "XRP", "DOGE"],
    keepMax: 50,
    // 1단계 매집
    // 1단계 개별 문턱은 "명백한 이탈" 만 걸러낸다. 실제 선별은 아래 earlyCore* 가 한다.
    // 이유: 2026-07-25 실측에서 하드 문턱이 아슬아슬한 차이로 좋은 후보를 잘랐다.
    // 핵심 소계 1위 EDGE 는 OI -0.3% 로, 유일하게 OI 가 붙던 UNI(+6.4%)는 volDry 0.86 으로
    // 탈락한 반면, 정작 통과한 ZEC 는 핵심 소계 꼴찌권(27%)이었다.
    boxWidthMaxPct: 25,     // 박스 폭 이 % 이하
    squeezePctMax: 30,      // 압축 백분위 이하 (실측상 값이 2~24 에 뭉쳐 변별력 없음 — 이탈 배제용)
    volDryMax: 1.0,         // 거래량이 늘고 있지만 않으면 통과 (선별은 volumeProfile 점수가)
    oiChangeMinPct: -5,     // 포지션이 대놓고 빠지는 것만 배제 (선별은 oiBuildUp 점수가)
    // 2단계 임박
    squeezePctTight: 15,    // 압축 극단
    rangePosMin: 0.95,      // 박스 상단 근접
    relVolMin: 1.0,         // 거래량 회복
    // 3단계 돌파
    breakoutRelVol: 2.0,    // 돌파 시 상대거래량
    breakoutMaxRunPct: 15,  // 돌파 후 상승폭 이 % 이하만 (초입)
    // 제외
    pumpedMaxPct: 40,       // 24h 이 % 초과 상승 = 이미 감
    oiDumpPct: -10,         // 72h OI 이 % 이하 = 포지션 이탈
    fundingMaxAbs: 0.001,   // |펀딩비| 이 값 초과 = 한쪽 과열
  },

  // ---- 조기 포착 선별: 핵심 3항목 소계 ----
  // "확실한 후보 소수" 를 위한 장치. 채점이 가중합이라 보조 항목(박스위치·장기선)만으로도
  // 총점이 올라가는 구멍이 있었다. 실측: ZEC 총점 35 중 15점이 장기선(200선 위 = 이진 0/15)
  // 에서 나왔고 핵심 3항목은 0.62/0.05/0.12 로 최하위권이었다.
  // 압축·OI증가·거래량고갈은 이 모드의 정의 그 자체이므로 소계로 하한을 건다.
  earlyCoreKeys: ["squeeze", "oiBuildUp", "volumeProfile"],
  earlyCoreMinPct: 40,   // 핵심 3항목 소계가 만점 대비 이 % 미만이면 후보에서 제외
  earlyKeepTop: 3,       // 표시 상한 — 어중이떠중이 10개보다 확실한 3개

  // ---- 조기 포착 채점 (합계 100) ----
  earlyScoreWeights: {
    squeeze: 25,          // 변동성 압축 정도
    oiBuildUp: 25,        // 미결제약정 증가
    volumeProfile: 20,    // 거래량 고갈
    rangePosition: 15,    // 박스 상단 근접
    trendReclaim: 15,     // 장기선 회복
  },

  // ---- 조기 포착 등급 경계 ----
  // reversal 과 점수대가 다르다. early 는 5항목(압축·OI·거래량고갈·박스위치·장기선)뿐이고
  // oiBuildUp 이 0~30% 스케일이라 실전에서 만점 근처가 거의 안 나온다.
  // 2026-07-25 라이브 표본 32종목: 최고 61, 중앙값 22, 상위 10% ≈ 33 이상.
  // reversal 밴드(85/75/65/55)를 그대로 쓰면 정상 후보가 "제외" 로 표시된다.
  // key 는 CSS(.score-*)와 맞물려 있으니 바꾸지 말 것.
  earlyGrades: [
    { min: 50, label: "강한 후보", key: "strong" },
    { min: 35, label: "관심 후보", key: "watch" },
    { min: 25, label: "관찰 후보", key: "observe" },
    { min: 15, label: "조건 부족", key: "weak" },
    { min: 0, label: "제외", key: "excluded" },
  ],
  // early 목록 표시 하한. "관찰 후보"(25) 이상만 보여준다 — 조건 부족/제외는 숨김.
  earlyMinScore: 25,

  // ---- 조기 포착 감점 ----
  earlyPenalties: {
    alreadyPumped: -20,      // 24h +25~40% (이미 어느 정도 감)
    oiDump: -15,             // OI 감소
    fundingOverheated: -10,  // 펀딩 한쪽 쏠림
    thinLiquidity: -10,      // 거래대금 10M 미만
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

  // ---- 진입/손절 계획 ----
  riskReward: {
    stopAtrRatio: 0.5,   // 손절 버퍼 = ATR × 이 배수
    minStopPct: 0.5,     // 단, 최소 이 % 는 확보 (저변동성 종목의 손익비 폭주 방지)
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

  // ---- 감점 그룹 ----
  // 같은 사실을 다른 각도로 보는 감점끼리는 겹쳐 차감되면 안 된다.
  // 실측(XPLUSDT): "위로 갈 공간이 없다" 하나로 -26 이 나갔다 —
  //   strongResistanceAbove(-8, eqHighs 1 ATR 이내)
  //   shortTargetDistance(-8, buySideTarget 1.5 ATR 이내)
  //   poorRiskReward(-10, majorHigh1h 기준 RR<1.5)
  // 보는 레벨만 다르고 조건은 같다. 핵심 4항목 만점(50/50)인 종목이 34점까지 밀렸다.
  // 그룹당 가장 센 것 하나만 적용한다. 그룹에 없는 감점은 그대로 누적.
  penaltyGroups: {
    upsideSpace: ["strongResistanceAbove", "shortTargetDistance", "poorRiskReward"],
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

  // ---- 급락 반등(reversal) 선별: 핵심 4항목 소계 ----
  // 이 전략을 정의하는 신호는 유동성 스윕과 구조전환이다. 그런데 실측에서
  // 저점 스윕은 50건 중 2건만 적중했고, 점수는 "급락 및 과매도"(39건)·"거래대금"(38건)
  // 같은 쉬운 보조 항목이 만들고 있었다. early 와 같은 가중합 구멍이라 같은 방식으로 막는다.
  reversalCoreKeys: ["lowLiquiditySweep", "sweepPriceRecovery", "structureShift1h", "fvgObOverlap"],
  reversalCoreMinPct: 40, // 핵심 4항목(합 50점) 소계가 만점 대비 이 % 미만이면 제외
  reversalKeepTop: 5,     // 표시 상한

  // ---- 등급 경계 (reversal 전용 — early 는 earlyGrades) ----
  // 2026-07-25 실측 46건: 최고 60, 상위 20% 35, 중앙값 22.
  // 예전 85/75/65/55 는 실전 최고점(60)보다 높아 "강한/관심/관찰 후보" 가 한 번도
  // 안 나왔고 50건 중 48건이 "제외" 로 표시됐다. key 는 CSS(.score-*)와 물려 있다.
  grades: [
    { min: 55, label: "강한 후보", key: "strong" },
    { min: 40, label: "관심 후보", key: "watch" },
    { min: 30, label: "관찰 후보", key: "observe" },
    { min: 20, label: "조건 부족", key: "weak" },
    { min: 0, label: "제외", key: "excluded" },
  ],

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
    // 4h 는 EMA200 기울기(20봉 전과 비교)까지 봐야 해서 200+20+여유 필요.
    // 220 이면 EMA200 이 마지막 20봉에서만 유효해 기울기가 항상 null 이었다.
    "4h": 240,
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
// minScore 는 위 grades 밴드에 맞춰 잡는다. 예전 30/40/55/65/75 는 실전 최고점(60)보다
// 높은 값이 섞여 있어 4·5단계는 항상 0건이었다. 이제 각 단계가 등급 경계와 1:1로 대응한다.
export const STRICTNESS_LEVELS = [
  { level: 1, label: "1 · 아주 널널하게 (코인 많이)", minScore: 20,
    penalties: { overExtended15m: -5, farFromLowAtr: -4, strongResistanceAbove: -3, shortTargetDistance: -3, tooLowVolume: -4, strongDowntrend4h: -3, newListingThin: -2, poorRiskReward: -4 } },
  { level: 2, label: "2 · 널널하게", minScore: 25,
    penalties: { overExtended15m: -7, farFromLowAtr: -6, strongResistanceAbove: -5, shortTargetDistance: -5, tooLowVolume: -6, strongDowntrend4h: -5, newListingThin: -4, poorRiskReward: -6 } },
  { level: 3, label: "3 · 기본 (권장)", minScore: 30,
    penalties: { overExtended15m: -12, farFromLowAtr: -10, strongResistanceAbove: -8, shortTargetDistance: -8, tooLowVolume: -10, strongDowntrend4h: -8, newListingThin: -6, poorRiskReward: -10 } },
  { level: 4, label: "4 · 엄격하게", minScore: 40,
    penalties: { overExtended15m: -16, farFromLowAtr: -13, strongResistanceAbove: -10, shortTargetDistance: -10, tooLowVolume: -13, strongDowntrend4h: -10, newListingThin: -8, poorRiskReward: -13 } },
  { level: 5, label: "5 · 아주 엄격하게 (확실한 것만)", minScore: 55,
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
