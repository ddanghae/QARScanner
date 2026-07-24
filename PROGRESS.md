# 진행 상황 (다른 컴퓨터에서 이어받기용)

이 파일은 세션이 끊겨도 어디까지 했고 뭘 더 할지 파악하기 위한 핸드오프 문서.
읽고 나서 삭제하지 말 것 — 다음 세션이 또 참고함.

## 저장소 / 배포

- 저장소: https://github.com/ddanghae/QARScanner (public)
- 라이브: https://ddanghae.github.io/QARScanner/ (GitHub Pages, main/root, 자동 재배포)
- 로컬 경로(이 작업이 시작된 컴퓨터): `C:\Users\CC\00\qar-ict-scanner`
- 다른 컴퓨터에서 이어받기: `git clone https://github.com/ddanghae/QARScanner.git` 후 아래 "재개 방법" 참고

## 지금까지 한 일 (커밋 순서대로)

1. **최초 구현** — 5페이지 한글 개발계획서(QAR+ICT Early Coin Scanner)를 그대로 구현.
   빈 폴더에서 시작(재사용할 기존 코드 없었음). Vanilla HTML/CSS/JS ES Modules,
   백엔드 없음, GitHub Pages 정적 배포, Binance 공개 REST API만 사용, 개인 API 키 없음.
   - 계산 엔진(core/): EMA·SMA·RSI·MACD·ATR·Bollinger·VWAP·OBV·StochRSI,
     Taker/Delta/CVD, 시장구조(Pivot·HH/HL/LH/LL·BOS·CHoCH), 유동성(Equal H/L·스윕),
     FVG, 오더블록, 진입/손절/TP+손익비, 흡수 추정+단계 분류(1~5)+100점 점수 체계
   - 스캐너(scanner/): 1~3단계 필터(전체종목→24h유동성→급락후보) →
     4단계 멀티타임프레임(4h/1h/15m/5m) 정밀분석 → 점수 필터+정렬
   - UI: 대시보드, 상세 패널, 필터/설정(localStorage), 토스트, TradingView 연결, PWA(sw.js)
   - 테스트: Node 실행 가능한 자체 하네스(프레임워크 없음), 계산값 고정 검증 +
     **리페인트 방지 검증**(prefix==full — 과거 계산이 미래 캔들 추가로 안 바뀌는지)

2. **자동 갱신 기능 추가** — 일정 주기 재스캔 + "다음 갱신까지 남은 시간" 카운트다운 +
   탭 백그라운드 시 주기 자동 감속(4배). `config.js`의 `refresh.*`로 조정.

3. **숏 방향 완전 구현** — 원래 롱 전용이었음. 단순 신호 미러링이 아니라
   **깔때기 자체가 롱 편향**이었던 걸 발견해 `prefilter.js`의 stage3 필터를 방향 인지로 수정
   (숏/양방향이면 급등·과매수 후보를 admit하도록). `deep-scanner.js`에 `buildShortSignals`
   추가, `scoring.js`에 방향별 라벨(급락↔급등, 저점↔고점 스윕 등), `direction: "both"`는
   종목별로 롱/숏 중 높은 점수 채택.
   - **실제 버그 발견+수정**: `risk-reward.js`에서 신고가/신저점 갱신 중 마지막 확정
     스윙이 진입 반대편에 있으면 손절-진입 거리가 거의 0이 돼 손익비가 수천만배로
     폭발하는 버그(RR 1:73,705,287 실측). 손절을 진입 반대편으로 clamp해서 해결.

4. **UI 리스킨** — 사용자가 제공한 대시보드 디자인 레퍼런스(Salleist/Finexy/Skillset류)
   참고해 사이드바+톱바 레이아웃으로 전면 리스킨. 로직은 전혀 안 건드림(순수 CSS+마크업).
   화이트 사이드바 + 다크 액티브 필, 다크 히어로 스탯 카드, 카드형 섹션, pill 뱃지.

5. **조기 포착 모드 추가** — 기존 깔때기는 "급락+과매도"라 조용한 매집 구간을
   못 잡는 문제를 발견. 스캔 모드 전환 방식으로 후보 깔때기와 채점만 교체하는
   `scanMode: reversal | early` 를 추가했다. early 는 4시간봉에서 변동성 압축
   (기존 볼린저 width 재사용) + 거래량 고갈 + 미결제약정(OI) 증가를 보고
   매집 → 임박 → 돌파 3단계로 분류한다. OI·펀딩비는 공개 엔드포인트
   (`openInterestHist`, `premiumIndex`)를 쓰며 펀딩비는 스캔당 1회만 호출한다.
   결과는 기존과 동일한 shape 을 반환해 결과표·상세 패널을 건드리지 않았다.
   중형 중심 유니버스(거래대금 5M↑, 상위 200, 대형코인 제외).
   - 주의: early 모드에서는 방향 필터와 노이즈 필터를 우회한다.
     (매집 구간은 정의상 횡보라 노이즈 필터에 전멸하고, early 는 롱 전용이다)
   - 신규 core 모듈은 `js/core/early-detect.js` 1개뿐(압축은 기존 bollinger().width 재사용).
   - 설계/계획: `docs/superpowers/specs/2026-07-24-early-pump-detection-design.md`,
     `docs/superpowers/plans/2026-07-24-early-pump-detection.md`
   - subagent-driven 방식으로 10개 태스크 TDD 구현, 태스크마다 spec+quality 리뷰 통과.

## 검증 상태

- **테스트 86/86 통과** — `node tests/run.js` (indicators, structure, liquidity, scoring,
  goldenCross, noise, early, repaint, refresh 9개 스위트)
- **라이브 Binance API로 실제 스캔 여러 번 검증** — 롱/숏/양방향 전부 확인,
  콘솔 에러 0, RR 폭발 버그도 라이브에서 재현 후 수정 확인(수정 전 1:73M → 수정 후 1:16)
- **조기 포착 모드 라이브 검증** — early 스캔 526종목→150 1차→14 후보, 결과 전부
  "1 매집" 단계로 정상 표시(early 라벨·early 신호·박스 기반 진입/손절/목표),
  reversal 모드로 되돌려 회귀 없음 확인, 콘솔 에러 0.

## 재개 방법

```bash
git clone https://github.com/ddanghae/QARScanner.git
cd QARScanner
node tests/run.js          # 테스트 확인 (38/38 나와야 정상)
python -m http.server 8123 # 로컬 미리보기 (ES 모듈이라 file://로는 안 열림)
# 브라우저에서 http://localhost:8123/ 접속
```

배포는 자동 — `main`에 push하면 GitHub Pages가 재빌드함. 별도 빌드 스텝 없음.

## 파일 구조 (36개 파일)

```
index.html, manifest.webmanifest, sw.js, README.md, PROGRESS.md(이 파일)
css/style.css
js/
  main.js, config.js, state.js
  api/binance.js
  core/  indicators.js volume-analysis.js market-structure.js liquidity.js
         fvg.js order-block.js risk-reward.js scoring.js
         golden-cross-retest.js noise-filter.js early-detect.js
  scanner/  prefilter.js deep-scanner.js scan-controller.js
  ui/  dashboard.js detail-panel.js settings.js notifications.js tradingview.js format.js
tests/
  harness.js fixtures.js run.js index.html
  indicators.test.js structure.test.js liquidity.test.js scoring.test.js
  golden-cross.test.js noise.test.js early-detect.test.js
  repaint.test.js refresh.test.js
```

핵심 진입점: [config.js](js/config.js)(모든 가중치·필터·TTL 조정 지점),
[scan-controller.js](js/scanner/scan-controller.js)(파이프라인 순서),
[deep-scanner.js](js/scanner/deep-scanner.js)(신호 조립 → 롱/숏),
[scoring.js](js/core/scoring.js)(흡수·단계·점수).

## 앞으로 할 수 있는 것 (우선순위 순, 아무것도 확정 아님)

0. **early 모드 임계값 튜닝** — `config.js`의 `earlyDetect`(박스폭·압축백분위·OI증가율 등)는
   감으로 잡은 초기값이다. 실사용하며 후보 수를 보고 `boxWidthMaxPct`, `squeezePctMax`,
   `oiChangeMinPct` 를 조정할 것. `earlyScoreWeights`/`earlyPenalties` 도 마찬가지.
   TradingView 지표는 아직 reversal 로직 기준이라 early 모드 포팅도 후보.
1. **점수 가중치 튜닝** — 실사용하면서 `config.js`의 `scoreWeights`/`penalties`가
   실제 좋은 셋업을 잘 걸러내는지 관찰 필요. 현재는 최초 설계값 그대로.
2. **실제 아이폰 Safari 테스트** — 이 개발 환경(에이전트)에선 실기기 테스트 불가.
   Safe Area·터치 44px·팝업 차단 대응 코드는 넣어뒀지만 실기기 검증 안 됨.
3. **WebSocket 실시간가 스트리밍** — 계획서 §5에 언급됐던 것. 지금은 REST 폴링만.
   전체 재스캔 없이 최종가만 실시간 갱신하고 싶으면 이거 추가.
4. **모바일 사이드바 드로어** — 지금은 900px 미만에서 사이드바가 CSS만으로
   가로 스크롤 탭 바로 바뀜(별도 JS 상태 없음). 진짜 슬라이드 드로어 원하면 추가 JS 필요.
5. **톱바 검색창** — 레퍼런스 디자인엔 있었으나 의도적으로 뺌(기능 없는 장식 안 만듦).
   심볼 빠른 검색/필터 기능으로 실제 구현하고 싶으면 요청.

## 지켜야 할 것 (설계 원칙 — README.md에도 있음)

- 백엔드 없음, GitHub Pages 정적 실행
- Binance 공개 API만, 개인 키 없음, 자동 주문 없음
- 모든 계산은 마감 캔들 기준(리페인트 방지) — 미래 데이터 참조 금지
- 가중치/필터는 `config.js`에서만 조정, 하드코딩 금지
- 새 기능 추가 시 `tests/`에 계산 검증 최소 1개는 남길 것
