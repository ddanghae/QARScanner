# 진행 상황 (다른 컴퓨터에서 이어받기용)

이 문서는 세션이 끊겨도 구현 배경, 현재 계약, 검증 상태를 이어받기 위한 핸드오프다.
다음 작업 전에 삭제하지 말고 `README.md`와 함께 읽는다.

## 저장소 / 배포

- 저장소: https://github.com/ddanghae/QARScanner (public)
- 라이브: https://ddanghae.github.io/QARScanner/ (GitHub Pages, `main`/root; 현재 통합 브랜치는 아직 미배포)
- 현재 통합 브랜치: `codex/integrate-claude-early`
- 정적 GitHub Pages 앱이며 Binance 공개 REST만 사용한다. 개인 API 키와 자동 주문은 없다.

## 구현 이력

### 1. 최초 구현

- Vanilla HTML/CSS/JS ES Modules 기반 QAR+ICT Early Coin Scanner를 구현했다.
- EMA·RSI·MACD·ATR·Bollinger, 시장구조, 유동성, FVG, 오더블록, 거래량 추정,
  진입·손절·목표 구간과 점수 계산을 순수 모듈로 분리했다.
- 멀티타임프레임 후보 선별, 상세 패널, 설정 저장, PWA와 리페인트 회귀 테스트를 추가했다.

### 2. 자동 갱신과 숏 방향

- 주기 재스캔과 백그라운드 감속을 추가했다.
- 롱 편향이던 후보 깔때기를 방향 인지로 바꾸고 숏·양방향을 지원했다.
- 스윙이 진입 반대편에 있을 때 손익비가 폭발하던 버그를 손절 clamp로 수정했다.

### 3. UI 리스킨

- 사이드바·톱바·카드 중심 레이아웃으로 리스킨했다. 계산 계약은 유지했다.

### 4. 조기 포착 모드

- `scanMode: reversal | early`를 추가했다.
- early는 4시간봉 변동성 압축, 거래량 고갈, OI와 장기 추세를 이용해
  `1 매집 → 2 임박 → 3 돌파`로 분류한다.
- early는 롱 전용이고, 중형 중심 유니버스를 사용하며 방향·노이즈 필터를 우회한다.
- 설계 기록:
  - `docs/superpowers/specs/2026-07-24-early-pump-detection-design.md`
  - `docs/superpowers/plans/2026-07-24-early-pump-detection.md`

### 5. early 데이터 창과 OI 수정

- `oiLimit: 72`로는 현재 표본을 포함한 72시간 전 값이 부족해 72시간 변화가 null이던
  문제를 해결하기 위해 OI 요청을 80개로 늘렸다.
- 4시간봉 220개에서 EMA200 기울기 비교 표본이 부족하던 문제를 250개 요청으로 해결했다.
- OI 공통 게이트는 비감소(`oiChangeMinPct: 0`)로 두고 증가폭은 설정 기반 점수로 반영한다.
- early 최소 컷은 reversal 최소 점수와 분리해 채점 강도별 `earlyMinScore`를 사용한다.

### 6. early 압축 역할 분리와 fail-closed

- OI 조회 전 후보 선별은 압축 백분위 60 이하까지 허용한다.
- `1 매집`은 30 이하, `2 임박`은 15 이하로 분리한다. 확인된 돌파는 압축이 풀리는
  특성을 고려하되 박스·거래량·OI 공통 게이트와 추격 방지 상한을 유지한다.
  장기 추세 회복은 매집·임박 단계 조건이며 돌파 단계의 공통 게이트는 아니다.
- OI 변화는 배열 위치가 아니라 최신 표본 기준 72/24/12시간 목표 timestamp에 가장
  가까운 표본으로 계산하며 허용오차 밖이면 자료 부족으로 처리한다.
- OI 또는 EMA200·ATR 등 필수 자료가 부족하거나 비정상이면 early 후보를 만들지 않는다.
  펀딩비는 보조 과열 정보이므로 누락만으로 제외하지 않는다.
- 후보 50개 상한 전 확인된 돌파를 우선하고, 이후 압축 강도와 심볼로 안정 정렬한다.

### 7. early 품질 점수와 UI 정합

- early 점수는 `매집 → 임박 → 돌파` 진행도가 아니라 압축·OI·거래량·박스 위치·추세의
  근거 품질이다. 단계와 점수를 서로 환산하지 않는다.
- early 전용 중립 등급(`초기 관찰`, `관찰 후보`, `근거 양호`, `근거 많음`)을 사용한다.
- early 모드에서는 수동 `최소 셋업 점수`를 숨기고, 채점 강도에 따른 실제
  `조기 포착 품질 컷`을 읽기 전용으로 표시한다. reversal에서는 기존 입력을 복원한다.

### 8. QAR/Pine 판정 정합성 v3.4

- reversal의 무근거 후보를 `0 근거 부족`으로 분리하고 초기 근거가 2개 이상일 때만
  `1 관찰 초기`를 부여한다.
- 보통 흡수와 강한 흡수의 가점을 분리하고, `5 늦음·추격 금지`는 사용자가 5단계를
  명시적으로 선택한 경우에만 표시한다.
- UI 용어를 `셋업 점수`와 `진행 단계`로 통일했다.
- Pine v3.3은 보존하고 v3.4 사본을 추가했다. QAR 링크는 심볼과 15분봉만 전달한다.
  reversal은 독립 차트 정합 확인, early는 별도 관찰이며 점수·단계는 Pine으로 전달하지 않는다.
- 정합 PRD: `docs/superpowers/specs/2026-07-27-qar-pine-alignment-prd.md`

### 9. 분기 통합

- `origin/main`의 early 튜닝과 로컬 `main`의 QAR/Pine v3.4 이력을 별도 브랜치에서
  두 부모 병합으로 통합한다.
- 승인 PRD: `docs/superpowers/specs/2026-07-27-claude-early-integration-prd.md`
- Pine v3.3/v3.4 소스 로직은 통합 중 변경하지 않는다.
- 원격 push와 로그인된 TradingView 저장본 수정은 이 작업의 범위가 아니다.

## 검증 상태

- 통합 전 `origin/main`은 `90/90`, 로컬 QAR/Pine `deecc31`은 `100/100`이었고,
  중복을 제외한 병합 기초 기대치는 `104`개였다.
- 현재 통합본 자동 테스트는 `118/118` 통과했다. 전체 JavaScript `node --check`와
  reversal/early 순수 함수 스모크, 충돌 마커 검사도 통과했다. byte-preserved Pine 두 파일을
  제외한 staged `git diff --check`도 통과했다. 전체 staged 검사는 Pine 원본의 기존 공백
  주석 6줄을 보고하지만 `deecc31` Git blob 보존을 위해 해당 줄은 정규화하지 않았다.
- 1280×760 headless Chromium에서 reversal stage 5 상태에서 early로 전환해 단계 필터가
  `전체`로 정상화되고 수동 점수 입력이 숨겨지며 품질 컷 `40+`가 표시됨을 확인했다.
  페이지 오류와 4xx 응답은 0건이었다.
- Pine v3.3/v3.4는 로컬 QAR/Pine 커밋 `deecc31`의 Git blob과 동일함을 확인했다.
- TradingView 실차트에서 새 롱·숏 후보와 실제 알림 전달을 관찰하는 검증은 아직 남아 있다.

## 과거 실측 스냅샷 주의

아래 수치는 **2026-07-27 통합 전 코드와 당시 시장에서 얻은 일회성 관찰값**이다.
현재 후보 수·성과·병목을 보장하지 않으며, 통합본에서는 고정 기간·유니버스로 다시 측정해야 한다.

- OI/EMA 데이터 창 수정 전후 관찰에서 early 표시 후보가 0개에서 4개로 바뀐 적이 있다.
- 압축 선별 상한 스윕에서 30/40/50/60/70/100에 대해 표시 수가 3/3/4/5/6/6이었던 적이 있다.
- 해당 관찰은 임계값의 성과 우위를 증명하지 않으며 승률·상승 확률 자료가 아니다.

## 재개 방법

```bash
git clone https://github.com/ddanghae/QARScanner.git
cd QARScanner
node tests/run.js
python -m http.server 8123
# 브라우저에서 http://localhost:8123/ 접속
```

`main`에 push하면 GitHub Pages가 자동 재배포된다. 별도 빌드 단계는 없다.

## 주요 파일

```text
index.html, manifest.webmanifest, sw.js, README.md, PROGRESS.md
css/style.css
js/
  main.js, config.js, state.js
  api/binance.js
  core/ indicators.js volume-analysis.js market-structure.js liquidity.js
        fvg.js order-block.js risk-reward.js scoring.js
        golden-cross-retest.js noise-filter.js early-detect.js
  scanner/ prefilter.js deep-scanner.js scan-controller.js
  ui/ dashboard.js detail-panel.js settings.js notifications.js tradingview.js format.js
tests/
  harness.js fixtures.js run.js index.html
  indicators.test.js structure.test.js liquidity.test.js scoring.test.js
  golden-cross.test.js noise.test.js early-detect.test.js
  repaint.test.js refresh.test.js settings.test.js tradingview.test.js
tradingview/
  easy_market_flow_v3_3.pine easy_market_flow_v3_4.pine VERIFY.md
docs/superpowers/specs/
  2026-07-27-qar-pine-alignment-prd.md
  2026-07-27-claude-early-integration-prd.md
```

핵심 진입점:

- `js/config.js`: 가중치·필터·TTL
- `js/scanner/scan-controller.js`: 스캔 파이프라인
- `js/scanner/prefilter.js`: 모드별 1차 후보 선별
- `js/scanner/deep-scanner.js`: reversal 멀티타임프레임 분석
- `js/core/early-detect.js`: early 단계·품질 계산
- `js/core/scoring.js`: reversal 단계·점수

## 다음 검토 우선순위

1. 통합본을 고정된 기간·유니버스·채점 강도로 반복 측정해 후보 수, 자료 부족률,
   단계 분포와 사후 결과를 분리 기록한다.
2. early 임계값은 한 번에 하나만 바꾸고 후보 수 증가와 품질 저하를 함께 비교한다.
3. 실제 iPhone Safari에서 Safe Area, 터치, 팝업 차단 대응을 검증한다.
4. Pine에 early를 포팅하려면 별도 PRD와 독립 성과 검증을 먼저 수행한다.
5. WebSocket 가격 스트리밍과 모바일 사이드바 드로어는 별도 기능 범위로 다룬다.

## 설계 원칙

- 백엔드 없음, Binance 공개 데이터만 사용, 자동 주문 없음
- 기본 계산은 마감 캔들 기준이며 미래 데이터를 참조하지 않음
- 가중치·필터 임계값은 `js/config.js`에서 관리
- 자료 부족은 좋은 신호로 대체하지 않음
- 점수와 단계는 성공 확률·수익 보장이 아닌 규칙 기반 관찰 정보
- 새 계산 계약에는 재현 가능한 회귀 테스트를 추가
