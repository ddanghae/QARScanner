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

5. **조기 포착 모드 추가** — ⚠️ 여기 적힌 "변동성 압축 + 거래량 고갈" 전제는 **8번에서
   백테스트로 반증되어 폐기**됐다. 아래는 당시 기록으로만 남긴다.
   기존 깔때기는 "급락+과매도"라 조용한 매집 구간을
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

6. **early 모드 실측 기반 튜닝 + 무증상 버그 2건 수정** — "임계값이 빡세서 후보가 안 나온다"
   고 보고 숫자를 조정하려 했으나, 실측해 보니 **계산 자체가 죽어 있었다**. 감으로 고치지 말고
   `docs/` 아래 방식대로 먼저 측정할 것.
   - **버그 A — OI 72시간 변화가 항상 null**: `oiLimit: 72` 로 요청하면 정확히 72개가 오는데
     72시간 "전" 값을 집으려면 73개가 필요(현재 봉 포함). 그래서 `change72h` 가 영구 null →
     `oiBuildUp` **25점이 영구 0점**(최고 점수가 구조적으로 75점), OI 게이트도 조용히 무력화.
     → `oiLimit: 80`.
   - **버그 B — EMA200 기울기가 항상 false**: 4h 캔들 220개 요청 → 마감 219개 → EMA200 은
     200봉 시드라 유효값이 20개뿐 → 20봉 전 값(`[idx-20]`)이 null → 기울기 판정 불가.
     추세 게이트가 `종가>EMA200` 하나로 축소돼 후보 20개 중 12개(60%) 사망. → `4h: 250`.
     (Binance klines 가중치는 101~500 동일 구간이라 비용 변화 없음)
   - **OI 게이트 재조정**: 버그 A 를 고치자 이번엔 `oiChangeMinPct: 5` 가 후보 20개를 전멸시킴.
     134종목 실측 결과 **압축된 코인과 OI 급증 코인은 거의 배타적** — 압축 통과 20종목의
     OI 72h 최대가 +1.08%(중앙 -1.76%)인 반면, 전 종목 기준으론 30%가 +5% 이상이었다.
     즉 시장 전체로는 현실적인 수치지만 압축 코인에는 도달 불가 → 시장 상태와 무관하게 항상 0개.
     게이트는 "포지션 이탈 없음"(`oiChangeMinPct: 0`)까지만 보고 실제 증가폭은 채점으로 보상,
     채점 만점 기준도 도달 가능한 값(`oiScoreFullPct: 10`, 하드코딩 30 을 config 로 이동).
   - **early 최소 점수 분리** (`STRICTNESS_LEVELS[].earlyMinScore`, `minScoreFor()`): early 점수는
     "얼마나 터지기 직전인가" 사다리라 1 매집은 박스 중앙(위치≈0.4)이라 `rangePosition` 15점을
     구조적으로 못 받아 상한이 ~55다(2 임박 ~85, 3 돌파 ~90+). reversal 기본 컷 55 를 그대로
     쓰면 조기 포착의 존재 이유인 매집 단계가 전부 숨는다. 두 모드는 척도가 달라 컷을 공유하면 안 됨.
   - 결과: early 후보 **0개 → 4개**(ADA/VIRTUAL/LIT/LDO, 46~52점 "1 매집"), reversal 회귀 없음.
   - 회귀 테스트 3개 추가. 옛 설정값(72/220)으로 되돌리면 실제로 실패하는 것까지 확인했다
     (통과만 하는 무의미한 테스트가 아님).

7. **압축 게이트 완화 + 강도 선택기 early 연결** — `squeezePctMax: 30 → 60`.
   ⚠️ 압축 게이트 자체는 8번에서 제거됐다(예측력이 반대 방향). 강도 선택기 연결은 유효.
   - 30 이 좁았던 이유 둘: (a) **3단계 돌파는 정의상 압축이 이미 풀린 상태**라 좁은 게이트가
     정상 돌파 후보를 막고 있었다(실측 LINKUSDT 백분위 48 — 박스 상단 돌파 중인데 차단).
     (b) 압축 점수가 `25*(1-min(백분위,50)/50)` 이라 백분위 50 이상은 어차피 0점 →
     게이트로 또 막는 건 이중 차단. **게이트는 넓게, 순위는 점수로**가 맞다.
   - 실측 스윕(표시 후보 수): 30→3, 40→3, 50→4, 60→5, 70→6, 100→6. 60 이후 이득 없어 60 채택.
   - **중요 — 게이트는 더 이상 병목이 아니다**: OI·추세 게이트를 *둘 다 완전히 제거*해도
     표시 개수는 5개 그대로였다(단계 통과는 5→23으로 늘지만 추가분이 전부 0~33점이라
     점수 컷에서 걸림). 200선 아래 + OI 감소 코인은 `trendReclaim`(15) + `oiBuildUp`(25)에서
     40점을 구조적으로 잃기 때문. 즉 후보를 더 늘리려면 **품질을 낮추는 선택**이 필요하다.
   - 지난 커밋에서 early 가 `minScore` 를 무시하게 만들어 "채점 강도" 선택기가 early 에서
     죽은 컨트롤이 됐던 것도 같이 마무리 — 강도 단계마다 `earlyMinScore`(25/32/40/50/60)를
     두고 `minScoreFor()` 가 단계를 따라가게 했다. 실측: 강도1→5, 3→5, 4→3, 5→0개.
     (1~3 이 같은 이유는 위처럼 단계 판정에서 이미 5개로 막혀 점수 컷이 병목이 아니기 때문)
   - 결과: 후보 20→32, 표시 4→5, **"3 돌파" 단계가 처음으로 등장**. reversal 회귀 없음.

8. **백테스트로 early 모드의 전제가 반증됨 → 실측 프랙탈로 교체** (가장 중요한 회차)
   - **방법**: 172종목 4h 500봉(≈83일)에서 "+50% / 5일 내" 급등 82건을 찾고, 각 급등의
     시작 시점까지만 캔들을 잘라(미래 차단) 스캐너를 그대로 재생. 대조군 392건과 비교.
     한계: 유동성 필터·펀딩비는 과거 재구성 불가, OI 는 최근 ~20일치만 가능.
   - **결과: 포착률 1/82 = 1.2%, 대조군 3.6%** — 즉 급등보다 비급등에서 더 자주 울렸다.
     전 구간 5,824 표본 무필터 재측정에서도 `박스폭<=25` 게이트는 적중 1.3% / **향상 0.27x**
     (기준 급등률 4.70%의 1/4). 임계값이 아니라 **방향이 반대**였다.
   - **실측 프랙탈** (급등군 vs 대조군 중앙값):
     박스폭 43.2 vs 18.0 · 박스내 위치 0.20 vs 0.40 · 거래량고갈 0.9 vs 0.7 ·
     OI 72h p75 13.7% vs 2.9%. → 압축·고갈·상단근접은 **전부 반대**, OI 만 가설과 일치.
   - **적용**: `boxWidthMaxPct: 25`(상한) → `boxWidthMinPct: 30`(하한) + `rangePosMax: 0.30`.
     압축·거래량고갈은 게이트에서 제거(표시·분석용으로는 계속 계산). 채점도 교체 —
     `volatilityRange 40 / rangePosition 25 / oiBuildUp 25 / volumeExpansion 10`.
     단계도 재정의: 1 바닥권 → 2 반등 시작 → 3 돌파.
   - **검증(같은 백테스트 재실행)**: 포착률 **1.2% → 37.8%**(31배), 대조군 오탐은 3.6% → **3.1%**로
     오히려 감소. 포착 예: RIF +173%(98점), LAB +106%(100점), TLM +109%(80점) — 최고점은
     전부 OI 급증 종목이라 OI 채점이 실제로 순위를 가른다.
   - **정직한 한계**: 향상도의 대부분은 박스 폭에서 나온다(단독 3.35x). 즉 이 신호의 정체는
     "변동성 큰 종목 고르기"에 가깝고 정밀한 타이밍 신호가 아니다. 무필터 기준 적중률은
     10~16% 수준 — 발동해도 대부분은 급등하지 않는다. 단독 매매 근거로 쓰지 말 것.
   - **OI 게이트 대안**(측정해 두고 채택 안 함): `oiChangeMinPct: -5 → +5` 로 조이면
     포착 47.6%→43.9%, 오탐 8.9%→4.1%, 변별비 5.33x→**10.76x**. 표본이 36건뿐이라
     과적합 위험이 있고, 이미 점수(oiBuildUp)가 같은 일을 해서 채택하지 않았다.
     후보가 너무 많다고 느끼면 여기부터 조일 것.

## 검증 상태

- **테스트 95/95 통과** — `node tests/run.js` (indicators, structure, liquidity, scoring,
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
node tests/run.js          # 테스트 확인 (95/95 나와야 정상)
python -m http.server 8123 # 로컬 미리보기 (ES 모듈이라 file://로는 안 열림)
# 브라우저에서 http://localhost:8123/ 접속
```

배포는 자동 — `main`에 push하면 GitHub Pages가 재빌드함. 별도 빌드 스텝 없음.

## 파일 구조 (46개 파일)

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

0. **reversal 모드도 백테스트해 볼 것** — early 는 8번에서 백테스트로 전제가 뒤집혔는데,
   reversal 모드(급락 반등)는 아직 한 번도 백테스트한 적이 없다. 같은 방식으로 검증하면
   여기서도 반대 방향인 항목이 나올 수 있다. 백테스트 스크립트 패턴은 8번 참고
   (앱 코드를 그대로 import + `globalThis.localStorage` shim → Node 실행, 급등 시점까지
   캔들을 잘라 미래 차단). reversal 은 1h/15m/5m 이 필요해 과거 구간 조회가 더 번거롭다
   (`klines` 의 startTime/endTime 사용).
   - **어떤 임계값도 감으로 만지지 말 것.** 이 프로젝트에서 감으로 잡은 값은 지금까지
     전부(압축·거래량 고갈·박스 상단 근접) 실측에서 반대로 나왔다.
1. **early 후보 수 조절** — 지금은 표시 13개 수준. 조이려면 `oiChangeMinPct: -5 → +5`
   (8번의 측정: 변별비 5.33x → 10.76x, 포착 47.6% → 43.9%). 늘리려면 `boxWidthMinPct`
   를 30 → 25 로 낮추거나 `rangePosMax` 를 0.30 → 0.40 으로 푼다(둘 다 변별력이 떨어진다).
2. **reversal 점수 가중치 튜닝** — `config.js`의 reversal 쪽 `scoreWeights`/`penalties`는
   여전히 최초 설계값 그대로이고 백테스트한 적이 없다. 0번과 함께 볼 것.
3. **실제 아이폰 Safari 테스트** — 이 개발 환경(에이전트)에선 실기기 테스트 불가.
   Safe Area·터치 44px·팝업 차단 대응 코드는 넣어뒀지만 실기기 검증 안 됨.
4. **WebSocket 실시간가 스트리밍** — 계획서 §5에 언급됐던 것. 지금은 REST 폴링만.
   전체 재스캔 없이 최종가만 실시간 갱신하고 싶으면 이거 추가.
5. **모바일 사이드바 드로어** — 지금은 900px 미만에서 사이드바가 CSS만으로
   가로 스크롤 탭 바로 바뀜(별도 JS 상태 없음). 진짜 슬라이드 드로어 원하면 추가 JS 필요.
6. **톱바 검색창** — 레퍼런스 디자인엔 있었으나 의도적으로 뺌(기능 없는 장식 안 만듦).
   심볼 빠른 검색/필터 기능으로 실제 구현하고 싶으면 요청.
7. **TradingView 지표 early 모드 포팅** — 지금은 reversal 로직 기준.

## 지켜야 할 것 (설계 원칙 — README.md에도 있음)

- 백엔드 없음, GitHub Pages 정적 실행
- Binance 공개 API만, 개인 키 없음, 자동 주문 없음
- 모든 계산은 마감 캔들 기준(리페인트 방지) — 미래 데이터 참조 금지
- 가중치/필터는 `config.js`에서만 조정, 하드코딩 금지
- 새 기능 추가 시 `tests/`에 계산 검증 최소 1개는 남길 것
