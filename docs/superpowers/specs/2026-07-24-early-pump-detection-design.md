# 조기 포착 모드 (Early Pump Detection) — 설계

작성일: 2026-07-24
대상 저장소: QARScanner (https://github.com/ddanghae/QARScanner)

## 배경

현재 스캐너의 후보 깔때기(`js/scanner/prefilter.js` `stage3Evaluate`)는 **급락 + RSI 과매도 + 저점 근접**을 조건으로 한다. 즉 "떨어진 것의 반등"을 노리는 설계다.

사용자가 실제로 찾는 것은 **한 번씩 50~150% 상승하는 알트를 오르기 전에 잡는 것**이다. 이런 종목은 보통 급락도 과매도도 아닌 **조용한 횡보 구간**에 있다가 변동성이 터진다. 따라서 기존 문턱을 아무리 완화해도 후보에 들어오지 않는다. 수치 조정이 아니라 **별도 탐지 로직**이 필요하다.

## 목표 / 비목표

**목표**
- 큰 상승 이전에 자주 나타나는 흔적(변동성 압축, 거래량 고갈 후 회복, 미결제약정 증가)으로 후보를 좁힌다.
- 매집 → 임박 → 돌파 3단계로 구분해 표시한다.
- 기존 반등 스캐너를 손상시키지 않는다.

**비목표**
- 폭등 **예측**이 아니다. 확률적 후보 좁히기이며, 맞지 않는 경우가 정상이다.
- 자동 주문 없음. 기존 설계 원칙 유지(백엔드 없음, 공개 API만, 개인 키 없음, 마감 캔들 기준).

## 접근 방식

**스캔 모드 전환.** 기존 파이프라인(API 계층, 캔들 파싱, 지표, 결과표, 상세 패널, 필터)을 그대로 재사용하고 **후보 깔때기와 채점만 교체**한다. `settings.scanMode`가 `"reversal"`(기존) 또는 `"early"`(신규)를 가리킨다.

대안으로 검토했으나 채택하지 않은 것:
- **완전 분리(별도 탭·별도 결과표)**: 격리는 최상이나 UI·상태·렌더 코드를 2벌 유지해야 한다. 현재 규모에 과함.
- **기존 스캐너에 흡수**: 100점 가중치 불변식이 깨지고, 성격이 다른 두 셋업이 한 점수로 섞여 해석이 불가능해진다. 기존 스캐너 회귀 위험도 있다.

## 결과 객체 호환 (핵심 제약)

early 모드는 `deepAnalyze`와 **동일한 결과 shape**을 반환한다. 이것이 UI를 건드리지 않는 이유다.

```
{ symbol, baseAsset, price, change6h, change24h, quoteVolume, newListing,
  direction: "long", score, grade, stage: { stage, key, label, badge },
  breakdown, penalties, topSignals, plan, noise, near1hEma200, goldenCrossRetest,
  timeframes }
```

- `grade`는 기존 `gradeFor(score, CONFIG)` 재사용.
- `stage.badge`는 기존 CSS 클래스(`blue`/`green`/`yellow`/`purple`/`danger`)만 사용.
- `plan`은 기존 필드명(`entry`, `stop`, `tp1`, `tp2`, `tp3`, `invalidation`, `riskReward`, `rrText`, `valid`)을 그대로 채운다.
- early 모드에서 의미 없는 필드(`goldenCrossRetest`, `near1hEma200`)는 기존대로 계산해 채운다(이미 4h·1h 캔들을 받으므로 추가 비용 없음).

### 기존 필터와의 상호작용 (반드시 처리)

`js/ui/settings.js`의 `applyFilters`가 early 결과를 걸러버리는 두 지점이 있다. 둘 다 early 모드에서 우회한다.

1. **노이즈 필터** — 매집 구간은 정의상 횡보이므로 Choppiness Index가 높다. `filterNoise`가 켜져 있으면 early 후보가 전부 제거된다. → **early 모드에서는 노이즈 필터를 적용하지 않는다.** (`noise` 필드는 참고용으로 채우되 필터링에는 쓰지 않음)
2. **방향 필터** — early 모드는 **롱 전용**(`direction: "long"`)이다. 사용자 설정이 `short`면 결과가 전부 사라진다. → **early 모드에서는 방향 필터를 건너뛴다.**

단계 필터(`stageFilter`)의 선택지 라벨은 reversal 기준(1 매집/2 유동성 회수/3 구조전환/4 진입/5 추격금지)이라 early의 1 매집/2 임박/3 돌파와 문구가 어긋난다. 기능상 문제는 없으므로(숫자 매칭) 이번 범위에서는 라벨만 모드에 따라 바꾼다.

## 탐색 대상 (유니버스)

중형 중심. 대형 코인은 50~150% 상승이 드물어 제외한다.

- `minQuoteVolume`: 5,000,000 USDT (기존 20M → 완화)
- `topByVolume`: 200 (기존 130 → 확대)
- 제외 목록: `BTC`, `ETH`, `BNB`, `SOL`, `XRP`, `DOGE` (config에서 편집 가능)
- 기존 stage1(무기한·USDT·스테이블/레버리지 제외), stage2(유동성·상위 N) 로직을 그대로 재사용하되 위 값만 early 모드 값으로 덮어쓴다.

## 데이터 소스

기존 캔들에 더해 공개 엔드포인트 2개를 추가한다. 개인 API 키 불필요.

| 용도 | 엔드포인트 | 호출 수 |
|---|---|---|
| 미결제약정 추이 | `/futures/data/openInterestHist?symbol=&period=1h&limit=72` | 후보당 1회 |
| 펀딩비(전 종목) | `/fapi/v1/premiumIndex` (심볼 미지정 → 전체 배열) | 스캔당 **1회** |

- `openInterestHist`는 최근 30일치만 제공한다. `period=1h, limit=72`(72시간)로 충분하다.
- `premiumIndex`를 심볼 없이 호출하면 전 종목 배열이 오므로 후보당 호출이 필요 없다. `lastFundingRate` 필드 사용.

## 탐지 로직

모두 **마감 캔들** 기준(리페인트 방지). 임계값은 전부 `config.js`에 두며 실사용하며 조정하는 것을 전제로 한다.

기준 시간봉: **4시간봉** (박스·압축·거래량), 보조로 1시간봉(돌파 확인).

### 공통 계산

- **박스**: 최근 60봉(4h × 60 ≈ 10일)의 최고가/최저가. `boxWidthPct = (boxHigh - boxLow) / ((boxHigh + boxLow) / 2) * 100`
- **압축 백분위**: 기존 `bollinger(closes, 20, 2).width` 재사용. 최근 100봉 중 **현재 width보다 작은 값의 개수 ÷ 100 × 100**. 0에 가까울수록 압축.
- **거래량 프로파일**: 최근 20봉 평균 거래량 ÷ 그 이전 60봉 평균 거래량 = `volDryRatio`
- **OI 변화**: 72시간 OI 시계열에서
  - `oiChange72h = (oi[now] - oi[now-72]) / oi[now-72] * 100`
  - `oiChange12h = (oi[now] - oi[now-12]) / oi[now-12] * 100`
  - `oiChangePrev12h = (oi[now-12] - oi[now-24]) / oi[now-24] * 100`
- **박스 내 위치**: `rangePos = (price - boxLow) / (boxHigh - boxLow)` (0~1)

### 1단계 · 매집

모두 충족:
- `boxWidthPct <= 25`
- 압축 백분위 `<= 30`
- `volDryRatio <= 0.8`
- `oiChange72h >= 5` (%) — **OI 데이터가 없으면(null) 이 조건은 통과로 간주**한다(점수는 0점). 그래야 신규 상장 등 OI 미제공 종목이 후보에서 통째로 사라지지 않는다.
- 하락 추세 종료: 4h 종가가 EMA200 위 **또는** `ema200[now] >= ema200[now-20]`(기울기 비하락)

### 2단계 · 임박

1단계 충족 + 모두:
- 압축 백분위 `<= 15`
- `rangePos >= 0.95` (박스 상단 -5% 이내)
- 최근 3봉 평균 상대거래량 `>= 1.0`
- OI 가속: `oiChange12h > oiChangePrev12h`

### 3단계 · 돌파

- 4h 또는 1h 종가가 `boxHigh` 상향 돌파
- 상대거래량 `>= 2.0`
- ATR(14) 상승 전환 (현재 > 5봉 전)
- **아직 초입**: 돌파 지점 대비 상승폭 `<= 15%`

### 제외 (후보에서 제거)

- 24시간 변동 `> +40%` (이미 감)
- `oiChange72h <= -10` (포지션 이탈) — OI가 null이면 이 조건은 건너뛴다
- `|lastFundingRate| > 0.001` (0.1%, 한쪽 과열 → 상승 여력 소진) — 펀딩비가 null이면 건너뛴다

단계에 하나도 해당하지 않으면 결과에 넣지 않는다.

## 채점

early 전용 가중치(합계 100). 기존 `scoreWeights`와 별개이며 `earlyScoreWeights`로 둔다.

| 항목 | 가중치 | 환산식 (0~가중치) |
|---|---|---|
| `squeeze` | 25 | `25 * (1 - min(압축백분위, 50) / 50)` — 백분위 0이면 25점, 50 이상이면 0점 |
| `oiBuildUp` | 25 | `25 * min(max(oiChange72h, 0), 30) / 30` — +30% 이상이면 만점. OI 없으면 0점 |
| `volumeProfile` | 20 | `20 * (1 - min(volDryRatio, 1)) `— 고갈일수록 높음(`volDryRatio` 0.8 → 4점, 0.4 → 12점) |
| `rangePosition` | 15 | `15 * clamp(rangePos, 0, 1)` — 박스 상단에 가까울수록 |
| `trendReclaim` | 15 | 종가 > EMA200 이면 15, 기울기만 비하락이면 7, 둘 다 아니면 0 |

감점:
- `alreadyPumped` -20 (24h +25~40% 구간)
- `oiDump` -15 (`oiChange72h < 0`)
- `fundingOverheated` -10 (`|lastFundingRate| > 0.0005`)
- `thinLiquidity` -10 (`quoteVolume < 10M`)

점수는 기존과 동일하게 0~100으로 클램프하고 `gradeFor`로 등급을 매긴다.

## 진입 계획 (plan)

박스 기반으로 계산해 기존 필드명에 채운다.

- `entry` = 현재가
- `stop` = `boxLow - ATR(4h) * 0.5`
- `tp1` = `boxHigh + 박스폭 * 1.0`
- `tp2` = `boxHigh + 박스폭 * 1.5`
- `tp3` = `boxHigh + 박스폭 * 2.0`
- `riskReward` = `(tp2 - entry) / (entry - stop)`, `rrText` = `1:x.xx`
- `stop`은 반드시 `entry` 아래로 clamp (기존 `risk-reward.js`가 고친 RR 폭발 버그와 동일한 방어)

## 파일 구성

```
config.js                     + earlyDetect 블록, earlyScoreWeights, earlyPenalties
js/api/binance.js             + getOpenInterestHist(), getPremiumIndexAll()
js/core/early-detect.js       (신규) 박스·압축백분위·OI분석·3단계분류·채점·plan
js/scanner/prefilter.js       + stage3EvaluateEarly() (기존 stage3Evaluate 옆)
js/scanner/scan-controller.js settings.scanMode 분기
js/state.js                   + scanMode 기본값 "reversal"
js/ui/settings.js, index.html + 스캔 모드 select (기존 bindSelect 재사용)
tests/early-detect.test.js    (신규)
tests/run.js                  + early 스위트 등록
```

새 core 모듈은 **1개**다. 압축 지표는 기존 `bollinger().width`를 재사용하므로 신규 지표 구현이 없다.

## 데이터 흐름

```
exchangeInfo → stage1Universe (기존)
  → getTicker24h → stage2Liquidity (early 유니버스 값 적용)
  → getPremiumIndexAll (스캔당 1회, 전 종목 펀딩비)
  → 후보별 4h 캔들 → stage3EvaluateEarly (박스·압축·거래량 1차 선별)
  → capCandidates (상한 50)
  → 후보별: 1h 캔들 + getOpenInterestHist
  → early-detect: 3단계 분류 + 채점 + plan
  → 기존 결과 shape 으로 반환 → 기존 applyFilters/dashboard 그대로
```

예상 호출 수: 4h 캔들 약 200 + OI 약 50 + 펀딩 1 ≈ 250회. 현재 reversal 모드(1h 캔들 130 + 정밀 4TF×50)와 같은 자릿수이며, 기존 세마포어(`maxConcurrent: 5`)와 재시도 로직을 그대로 탄다.

## 오류 처리

- `openInterestHist`가 404이거나 빈 배열(신규 상장 등) → `oi = null`. `oiBuildUp` 점수 0점 처리하고 **후보는 유지**한다. OI 관련 제외 조건도 건너뛴다.
- `premiumIndex` 실패 → 펀딩비 `null`. 펀딩 감점·제외 조건만 건너뛴다.
- 4h 캔들이 60봉 미만 → 박스 계산 불가 → 후보에서 제외(사유 `데이터 부족`).
- 레이트리밋·타임아웃 → 기존 `request()` 재시도/백오프가 처리. 개별 종목 실패는 기존 `mapWithProgress`가 잡아 스캔 전체를 중단시키지 않는다.

## 테스트

`tests/early-detect.test.js`, 기존 하네스 사용(프레임워크 없음).

- 압축 백분위: 폭이 좁아지는 합성 데이터에서 백분위가 낮게 나오는지
- 박스 계산: 알려진 고/저에서 `boxWidthPct`, `rangePos` 고정값 검증
- OI 분석: 증가/감소/가속 케이스별 `oiChange*` 값
- 3단계 분류: 1·2·3단계 각각 성립하는 픽스처 + 어디에도 안 걸리는 케이스
- 제외 조건: 이미 급등 / OI 급감 / 펀딩 과열
- 채점: 가중치 합 100 검증, 조건 좋아질수록 점수 증가(단조성)
- 리페인트: 압축 백분위·박스가 `prefix == full` (미래 캔들 추가로 과거 값이 바뀌지 않음) — 기존 `repaint.test.js` 패턴

## 설계 원칙 준수 (README·PROGRESS 기준)

- 백엔드 없음, GitHub Pages 정적 실행 유지
- Binance 공개 API만, 개인 키 없음, 자동 주문 없음
- 모든 계산은 마감 캔들 기준(리페인트 방지)
- 임계값·가중치는 `config.js`에서만 조정, 하드코딩 금지
- 새 기능이므로 `tests/`에 계산 검증 추가

## 후속 (이번 범위 아님)

- TradingView Pine 지표에 early 모드 포팅(현재 지표는 reversal 로직 기준)
- 단계 전환 알림(1단계 → 2단계로 올라온 종목 표시)
