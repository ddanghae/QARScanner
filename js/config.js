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
  // 큰 상승 이전 흔적: 큰 14일 추세(방향 무관) + 큰 24시간 변동 + 최근 상장.
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
    // ---- 선행조건 문턱 (2026-07-26 실측 재보정) ----
    // 근거: USDT 무기한 약 520 종목 × 3개 시간창(현재/-42일/-84일), 1시간봉.
    // "급등" = 어떤 시점 이후 24시간 +40% 이상. 급등 시작 24시간 전에 끝나는 48시간 창에서
    // 지표를 재서 표본 외 검증(급등 시작 이후 데이터를 안 보게 창을 앞으로 민 것).
    // 예전 문턱(박스폭·압축·거래량 고갈)은 이 검증에서 리프트 0.64~1.72x 로 흩어졌다.
    // 기준선 미만인 창이 있다 = 신호가 아니다. 그래서 게이트에서 뺐다.
    momentumBars: 84,       // 14일 = 4시간봉 84봉
    deadZonePct: 15,        // |14일 수익률| 이 % 미만 = 0점 (리프트 0.54~1.01x)
    momentumFullPct: 60,    // 이 % 이상이면 momentum 만점 (재적합에서 40 → 60)
    chg24MinPct: 5,         // |24시간 변동| 이 % 이상부터 가점
    chg24FullPct: 20,       // 이 % 이상이면 change24h 만점
    freshFullDays: 200,     // 상장 이 일수 이하 = freshness 만점 (재적합에서 300 → 200)
    freshZeroDays: 800,     // 이 일수 이상 = 0점 (800일 초과 리프트 0.30~0.51x)
    // 2026-07-29 청산 규칙 격자 탐색(research/sweep-exits.mjs, 전체 529종목 · 신호 5,111건).
    // 박스 하단 기준 손절을 버리고 순수 ATR 배수로 바꾼 것만으로 +0.017R → +0.084R 이 됐다.
    // 박스 손절은 둘 중 좁은 쪽이 채택돼 목표 도달 전에 먼저 맞았다.
    // 격자 최고 효율: ATR×4 · 4R · 90봉 = 평균 +0.155R · PF 1.34 · MDD -22.8R · 승률 36%.
    // (평균만 보면 ATR×2 · 6R 이 +0.171R 로 위지만 승률 27% 의 소수 대박 의존형이라 뺐다)
    stopAtr: 4,             // 손절 = 진입 - ATR × 이 배수
    targetR: 4,             // 주 목표(tp2) = 리스크 × 이 배수
    holdBars: 90,           // 측정에 쓴 보유 상한(4시간봉). 표시용 참고값 — 자동 청산은 없다.
    // 3단계 돌파
    breakoutRelVol: 2.0,    // 돌파 시 상대거래량
    breakoutMaxRunPct: 15,  // 돌파 후 상승폭 이 % 이하만 (초입)
    // 제외
    pumpedMaxPct: 40,       // 24h 이 % 초과 상승 = 이미 감 (신호가 아니라 진입 타이밍 문제)
    // 1차 선별 (prefilter)
    prefilterDeadZonePct: 15, // |14일 수익률| 이 % 미만이면 정밀 분석 안 감
  },

  // 핵심 소계 하한(earlyCoreKeys/earlyCoreMinPct)은 제거했다. 보조 항목만으로 총점이
  // 부푸는 걸 막는 장치였는데, 채점이 3항목 전부 검증된 요인으로 바뀌어 막을 구멍이 없다.
  // 단독 최대인 freshness 23점도 표시 하한 25 를 못 넘는다.
  earlyKeepTop: 3,       // 표시 상한 — 어중이떠중이 10개보다 확실한 3개

  // ---- 조기 포착 채점 (합계 100) ----
  // 2026-07-26 재적합. 57,720행(529종목 × 일별) 을 시간순 70/30 으로 나눠 학습셋에서만
  // 변형을 고르고 검증셋에서 한 번 확인했다. 라벨 = 이후 7일 내 24시간 +40% 이상.
  // 다변량 로지스틱에서 |펀딩|(-0.135)·거래량확장(+0.030) 이 죽었다 — 단변량 리프트
  // 2.1~3.2x 는 모멘텀의 대리변수였다. 셋을 빼고 3요인만 남긴 쪽이 검증셋 상위3 기준
  // 10.71x 로 기존 5요인(6.04x)을 이겼다. 원자료·재현 스크립트는 research/ 에 있다.
  earlyScoreWeights: {
    momentum: 45,         // |14일 수익률| (U자 — 크게 오르거나 크게 빠진 쪽)
    change24h: 32,        // |24시간 변동|
    freshness: 23,        // 신규 상장일수록 가점
  },

  // ---- 조기 포착 등급 경계 ----
  // reversal 과 점수대가 다르다. 검증셋 구간별 적중률(기준선 3.57%):
  // 25-39 2.03x / 40-54 3.35x / 55-69 4.57x / 70+ 8.25x — 경계가 리프트 계단과 맞는다.
  // reversal 밴드(85/75/65/55)를 그대로 쓰면 정상 후보가 "제외" 로 표시된다.
  // key 는 CSS(.score-*)와 맞물려 있으니 바꾸지 말 것.
  // hitRate = 검증셋(17,597행) 실측 적중률 %. "이후 7일 안에 24시간 +40% 이상" 이 일어난 비율.
  // 기준선 3.57% — 이 도구가 파는 건 손익비가 아니라 이 확률이므로 화면에 그대로 노출한다.
  earlyGrades: [
    { min: 70, label: "강한 후보", key: "strong", hitRate: 29 },   // 8.25x
    { min: 55, label: "관심 후보", key: "watch", hitRate: 16 },    // 4.57x
    { min: 40, label: "관찰 후보", key: "observe", hitRate: 12 },  // 3.35x
    { min: 25, label: "조건 부족", key: "weak", hitRate: 7 },      // 2.03x
    { min: 0, label: "제외", key: "excluded", hitRate: 2 },        // 0.58x
  ],
  earlyHitBaseline: 3.57,   // 무작위 종목의 같은 기간 적중률. 확률만 보면 크기를 못 느낀다.
  earlyHitLabel: "7일 내 24h +40%",

  // 손익 금액 표시에 빼는 왕복 비용 %. 백테스트와 같은 값(테이커 0.05% + 슬리피지 0.05%, 양쪽).
  // 빼지 않으면 화면 금액이 백테스트보다 좋게 나와 두 숫자가 서로 안 맞는다.
  tradeCostRoundTripPct: 0.2,
  // early 목록 표시 하한. "관찰 후보"(40) 이상만 보여준다 — 조건 부족/제외는 숨김.
  // 재적합 전 밴드(50/35/25/15)를 그대로 두면 라이브 34종목 중 15개가 "강한 후보" 다.
  earlyMinScore: 40,

  // ---- 조기 포착 감점 ----
  // deadZone(-25)·fundingFlat(-15) 도 제거했다. 죽은 구간은 momentum 램프가 이미 0점을
  // 주고, 펀딩 중립 감점은 재적합에서 성능을 깎았다(학습셋 변형 C vs D).
  earlyPenalties: {
    thinLiquidity: -10,      // 거래대금 earlyDetect.minQuoteVolume 미만
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
    minTouchPx: 44,
    tradingViewSuffix: ".P", // BINANCE:${symbol}.P
  },
};

// ---- 채점 강도 5단계 (§13 사용자 조정 — 가중치는 그대로 두고 감점 세기 + 최소 점수만 단계별로 스케일) ----
// 3단계 = CONFIG.penalties 원본값. 1단계로 갈수록 덜 걸러냄(코인 더 많이 나옴).
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
