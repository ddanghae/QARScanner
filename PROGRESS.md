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

### 10. pump_fade 세 번째 독립 모드

- `scanMode: pump_fade`와 UI 이름 `급등 후 급락 (숏)`을 추가했다. 기존 reversal/early와
  계산 경로를 공유하지 않는 SHORT 전용 파이프라인이다.
- 기존 `stage2Liquidity`의 거래대금 상위 130개 유니버스에서 1시간 마감봉의 6시간 +12%
  또는 24시간 +25% 급등을 확인한다. 급등 통과 집합은 성능을 이유로 추가 절단하지 않고
  모두 15분·5분 정밀 분석한 뒤 단계 우선, 점수 순으로 최종 5개만 남긴다.
- 15분 거래량 클라이맥스, 윗꼬리, 고점 sweep 실패, 최근 3봉 Taker Buy 소진,
  EMA20/VWAP 이탈과 5분 구조 붕괴를 계산한다. 2개 이상의 고점 거절 근거와 하락 확인이
  모두 있어야 `3 급락 확인`이다.
- 점수는 초기 실험 가중치 100점과 고점 대비 12% 이상 하락 시 -25점을 사용한다.
  45점 컷과 채점 강도는 검증 전 고정하며 UI에서 성공 확률로 표현하지 않는다.
- SHORT 계획은 최근 15분 고점 + 0.5 ATR을 손절로, 1R/2R/3R을 하방 목표로 사용한다.
  손절 거리가 8% 이상이거나 TP3가 0 이하이면 계획을 무효화한다.
- 기본은 진행 중 마지막 캔들을 제외하고 `includeRealtimeCandle=true`일 때만
  `provisional` 결과를 허용한다. 15분 신호보다 미래인 5분봉은 시각으로 제거한다.
- `research/pump-fade-backtest.mjs`는 12/15% × 25/30% 네 조합을 시간순 60/20/20과
  6시간 purge로 모두 보고한다. 사후 라벨은 운영 코어와 분리했고 동일 봉 목표/손절은
  `AMBIGUOUS`, 중간 또는 종료 봉 누락은 `INCOMPLETE`로 처리한다.
- 승인 PRD: `docs/superpowers/specs/2026-08-24-pump-fade-mode-prd.md`
- 요구문에 언급된 `js/ui/format.js`의 `planMoney()`와 청산가 필드는 현재 파일 및 전체
  Git 이력에 존재하지 않았다. 승인된 범위에 따라 레버리지·청산 모델을 새로 만들지 않고,
  실제 LONG 계획 회귀와 새 SHORT stop/TP 방향만 테스트했다.

### 11. 스캔 기록과 forward paper 성과

- 성공한 스캔의 최종 후보를 브라우저 로컬 저장소 `qar-scan-history-v1`에 최대 500건 기록한다.
  같은 심볼·모드·방향·임시 여부가 6시간 안에 반복되면 최초 스냅샷을 유지하고 최근 시각과
  포착 횟수만 갱신한다. 기록 기능 적용 전 과거 신호는 복구하지 않는다.
- 포착 완료 뒤 첫 5분 경계의 시가를 가상 진입가로 고정한다. 공개 Binance 5분봉을 정확한
  `startTime/endTime` 범위로 받아 LONG/SHORT 방향 수익률을 1h/6h/24h에 계산한다.
- 마감되지 않은 봉과 포착 이전 봉은 제외한다. 5분봉 공백은 `INCOMPLETE`, TP1과 손절이
  같은 봉에서 닿으면 `AMBIGUOUS`이며 이미 완료된 체크포인트와 계획 결과는 다시 쓰지 않는다.
- 기록 탭은 기간·모드·방향·상태 필터, 모드별 요약, 코인별 반복 횟수, 24h MFE/MAE,
  TP1 선도달과 JSON/CSV 내보내기를 제공한다. 임시 신호와 불완전 자료는 헤드라인 성과
  분모에서 제외한다.
- 저장 실패는 스캔을 멈추지 않고 경고 상태로만 남긴다. 기록 삭제는 사용자 브라우저 확인 뒤
  전용 키만 제거하며 기존 설정은 보존한다.
- 승인 PRD: `docs/superpowers/specs/2026-08-24-scan-history-performance-prd.md`

## 검증 상태

- 통합 전 `origin/main`은 `90/90`, 로컬 QAR/Pine `deecc31`은 `100/100`이었고,
  중복을 제외한 병합 기초 기대치는 `104`개였다.
- pump_fade 작업 전 기준선은 `118/118`, 기록 기능 전 기준선은 `156/156`, 현재 전체 자동 테스트는 `179/179` 통과했다.
  전체 JS/MJS 44개 `node --check`, `git diff --check`, 서비스워커 앱 셸 27개 경로 검사,
  연구 CLI `--help`도 통과했다. 합성 데이터 스모크는 threshold 4개와 base 표본 40개를
  생성했고 동일 입력의 보고서 byte 문자열이 재현됨을 확인했다.
- pump_fade 운영 계산은 마감봉 기본, 신호시각 이하 5분봉만 사용, prefix와 미래 봉 추가
  결과 불변, 비정상 시각·0 거래량 fail-closed를 테스트했다. 연구 계산은 미래 라벨 모듈을
  운영 코어가 import하지 않으며 split 경계의 6시간 결과 구간을 purge한다.
- 2026-08-24 공개 Binance USDⓈ-M kline 요청은 `200 OK`와 사용량 헤더를 반환했고,
  `exchangeInfo`의 당시 `REQUEST_WEIGHT` 한도는 분당 2400이었다. 코드는 동시요청 5,
  시간봉별 캐시, 429/418 재시도를 유지한다. 다만 전체 130개 후보가 모두 급등한 상황의
  반복 실스캔 부하 테스트는 실행하지 않았다.
- 1280×760 headless Chromium에서 reversal stage 5 상태에서 early로 전환해 단계 필터가
  `전체`로 정상화되고 수동 점수 입력이 숨겨지며 품질 컷 `40+`가 표시됨을 확인했다.
  페이지 오류와 4xx 응답은 0건이었다.
- 이번 pump_fade 실행에서는 Browser 보안 정책이 로컬 `file://` 접근을 거부해 실제 페이지
  스모크를 우회하지 않았다. 대신 DOM 이벤트 회귀 테스트로 SHORT 방향 잠금, 단계 1~3,
  고정 45점 컷과 강도 선택 잠금을 검증했다. 로컬 서버 기반 시각 검증은 남아 있다.
- 기록 탭은 로컬 HTTP 서버에서 데스크톱 기본 뷰와 390×844 모바일 뷰를 확인했다. 필터,
  요약 카드, 모드 표, 빈 기록 상태가 정상 렌더링됐고 브라우저 콘솔 경고·오류는 0건이었다.
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
        golden-cross-retest.js noise-filter.js early-detect.js pump-fade.js
  scanner/ prefilter.js deep-scanner.js scan-controller.js
  ui/ dashboard.js detail-panel.js settings.js notifications.js tradingview.js format.js
tests/
  harness.js fixtures.js run.js index.html
  indicators.test.js structure.test.js liquidity.test.js scoring.test.js
  golden-cross.test.js noise.test.js early-detect.test.js pump-fade.test.js
  pump-fade-research.test.js
  repaint.test.js refresh.test.js settings.test.js tradingview.test.js
tradingview/
  easy_market_flow_v3_3.pine easy_market_flow_v3_4.pine VERIFY.md
docs/superpowers/specs/
  2026-07-27-qar-pine-alignment-prd.md
  2026-07-27-claude-early-integration-prd.md
  2026-08-24-pump-fade-mode-prd.md
research/
  pump-fade-backtest.mjs pump-fade-research-core.mjs
```

핵심 진입점:

- `js/config.js`: 가중치·필터·TTL
- `js/scanner/scan-controller.js`: 스캔 파이프라인
- `js/scanner/prefilter.js`: 모드별 1차 후보 선별
- `js/scanner/deep-scanner.js`: reversal 멀티타임프레임 분석
- `js/core/early-detect.js`: early 단계·품질 계산
- `js/core/pump-fade.js`: pump_fade 단계·점수·SHORT 계획 계산
- `js/core/scoring.js`: reversal 단계·점수

## 다음 검토 우선순위

1. 기록 기능으로 실제 forward paper 사건을 충분히 쌓은 뒤, 모드별 표본 수·미완료 수·24h
   방향 수익 분포를 먼저 보고 비용을 반영하지 않은 값으로 성과 우위를 주장하지 않는다.
2. 동일 시점 유니버스와 생존 종목 편향을 통제한 실제 과거 데이터셋을 준비해 pump_fade의
   4개 threshold를 실행하고 표본 수, base rate, lift, 비용 차감 성과를 split별로 비교한다.
3. 전체 유동성 상위 130개가 급등 필터를 통과하는 스트레스 조건에서 API 사용량과 스캔
   완료 시간을 측정한다. 속도를 위해 후보 수를 임의 축소하지 않는다.
4. 로컬 서버와 실제 iPhone Safari에서 pump_fade 모드 전환, Safe Area, 터치, 팝업 차단을 검증한다.
5. early 임계값은 한 번에 하나만 바꾸고 후보 수 증가와 품질 저하를 함께 비교한다.
6. Pine에 early/pump_fade를 포팅하려면 별도 PRD와 독립 성과 검증을 먼저 수행한다.
7. WebSocket 가격 스트리밍과 모바일 사이드바 드로어는 별도 기능 범위로 다룬다.

## 설계 원칙

- 백엔드 없음, Binance 공개 데이터만 사용, 자동 주문 없음
- 기본 계산은 마감 캔들 기준이며 미래 데이터를 참조하지 않음
- 가중치·필터 임계값은 `js/config.js`에서 관리
- 자료 부족은 좋은 신호로 대체하지 않음
- 점수와 단계는 성공 확률·수익 보장이 아닌 규칙 기반 관찰 정보
- 새 계산 계약에는 재현 가능한 회귀 테스트를 추가
