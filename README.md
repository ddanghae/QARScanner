# QAR ICT Early Scanner

Binance USDⓈ-M Futures 초기 구조전환 후보 스캐너.
GitHub Pages에서 실행되는 **정적 웹앱**입니다. 빌드 과정·백엔드·개인 API 키가 필요 없습니다.

> ⚠️ 기술적 참고용 도구입니다. 자동 주문 기능이 없으며, 표시되는 진입/손절/목표가는
> 실제 주문 가격이 아닌 계산된 참고 구간입니다. 투자 판단의 책임은 사용자에게 있습니다.

> 작업을 다른 컴퓨터에서 이어가려면 [PROGRESS.md](PROGRESS.md) 먼저 읽을 것.

---

## 무엇을 하는가

1. Binance Futures 전체 USDT 무기한 종목을 불러옵니다. (공개 REST API)
2. 24시간 거래대금·거래횟수로 유동성 상위 종목을 추립니다.
3. 급락·저점 근접·과매도 회복 후보를 1시간봉으로 빠르게 걸러냅니다.
4. 남은 후보를 4시간·1시간·15분·5분 멀티타임프레임으로 정밀 분석합니다.
5. 시장구조(BOS/CHoCH), 유동성 스윕, FVG·오더블록, 거래량/Delta, 매도 흡수를
   종합해 **셋업 점수 0~100점**과 **진행 단계**로 분류합니다. 급락 반등 모드는
   **0~5단계**(근거 부족→관찰 초기→유동성 회수→구조전환→진입 구간→늦음·추격 금지),
   조기 포착 모드는 기존 **1~3단계**를 사용합니다.
6. 후보를 클릭하면 로그인된 TradingView 차트로 연결합니다.

방향은 **롱**(급락·과매도 반등), **숏**(급등·과매수 반락), **양방향**을 지원합니다.
숏은 롱의 대칭 — 고점 유동성 스윕·하락 구조전환·bearish FVG/OB·매수 흡수로 평가합니다.
양방향은 종목별로 롱/숏 중 높은 점수 쪽을 표시합니다.

### 점수와 단계의 의미

- **셋업 점수**는 QARScanner 규칙을 얼마나 충족했는지 나타내는 0~100점 값입니다.
- early의 셋업 점수는 **압축·OI·거래량·박스 위치·추세 근거의 품질**이며,
  `매집 → 임박 → 돌파` 진행 단계와 별개입니다. 단계가 높다고 점수가 반드시 높지는 않습니다.
- **진행 단계**는 reversal 구조가 어디까지 진행됐는지 나타냅니다. `0 근거 부족`과
  `1 관찰 초기`를 구분하며, `5 늦음·추격 금지`는 기본 목록에서 숨기고 단계 5를
  명시적으로 선택했을 때만 표시합니다.
- Pine v3.4의 **차트 정합 등급**은 현재 차트에서 정밀 조건을 통과한 후보의 규칙
  정합도를 나타냅니다. 셋업 점수·진행 단계와 서로 환산하지 않습니다.
- 어느 값도 성공 확률이나 수익을 보장하지 않습니다.

### 스캔 모드 2종

- **급락 반등**(기본) — 위 파이프라인. 크게 떨어진 것의 되돌림을 노립니다.
- **조기 포착** — 크게 오르기 전의 조용한 구간을 좁힙니다. 충분한 4시간봉·OI 이력을
  확인하고 **박스 폭 + 후보용 변동성 압축 + 거래량 고갈 + OI 비감소**를 공통 게이트로
  사용하며, OI 증가폭은 근거 품질 점수로 가산합니다. 필수 이력이 부족하면 후보에서
  제외합니다. 장기 추세 회복은 매집·임박 단계에서 추가로 요구하고, 통과 후보는
  **매집 → 임박 → 돌파** 3단계로 분류합니다.
  중형 중심(거래대금 5M↑, 상위 200, 대형코인 제외), 롱 전용. OI·펀딩비는 공개
  엔드포인트를 쓰며 펀딩비는 스캔당 1회만 호출합니다. 매집 구간은 정의상 횡보라
  이 모드에서는 방향·노이즈 필터를 자동으로 우회합니다. 언제 오를지는 알 수 없고
  오르지 않을 수도 있는 **후보 좁히기** 도구입니다.

## 사용법

1. 상단 **스캔 시작** 버튼을 누르면 파이프라인이 실행됩니다.
2. 진행률 바에서 단계(종목 수집 → 유동성 필터 → 1차 분석 → 정밀 분석)를 확인합니다.
3. 결과 목록에서 점수·단계·방향·핵심 신호·손익비를 확인합니다.
4. **상세**를 누르면 점수 근거, 시간봉별 상태, 진입·손절·목표가를 봅니다.
5. reversal 결과의 **TV 정합**은 해당 심볼의 15분 TradingView 차트를 열어 Pine v3.4의
   독립 차트 정합을 확인합니다. early 결과의 **TV 차트**는 별도 관찰용입니다. QAR의
   방향·점수·단계는 Pine으로 전달되지 않으며, 링크는 심볼과 15분봉만 넘깁니다.
6. 필터 영역에서 방향·점수·거래대금·진행 단계·정렬을 조정하고 **필터 적용**을 누릅니다.
   reversal은 `최소 셋업 점수`를 직접 사용합니다. early는 이 선택기를 숨기고 채점 강도에
   대응하는 실제 `조기 포착 품질 컷`을 표시합니다.
   `5 늦음·추격 금지` 결과는 이 단계 필터를 직접 선택한 경우에만 조회됩니다.
   설정은 `localStorage`에 자동 저장됩니다.
7. **자동 갱신**을 켜면 일정 주기(기본 90초)로 재스캔하며 "다음 갱신까지 남은 시간"이 표시됩니다.
   탭이 백그라운드로 가면 주기가 자동으로 느려집니다.(§18) 주기는 `js/config.js`의 `refresh.intervalMs`에서 조정합니다.

### 리페인트(미래 참조) 방지

기본 점수는 **마감 캔들**만 사용합니다. 진행 중 캔들을 포함한 실시간 예상 신호를 보려면
설정에서 별도로 켤 수 있으며, 이 경우 신호는 실시간 추정으로 구분됩니다.
모든 지표는 과거 데이터만으로 계산되며 미래 데이터를 참조하지 않습니다. (`tests/repaint.test.js`로 검증)

---

## GitHub Pages 배포

이 폴더(`QARScanner/`)를 저장소 루트 또는 하위 경로에 그대로 올리면 됩니다.
모든 경로가 **상대경로**라 하위 경로에서도 동작합니다.

### 방법 A — 저장소에 직접 배포

```bash
cd QARScanner
git init
git add .
git commit -m "QAR ICT Early Scanner"
git branch -M main
git remote add origin https://github.com/<사용자명>/<저장소명>.git
git push -u origin main
```

그다음 GitHub 저장소에서:

1. **Settings → Pages** 이동
2. **Source**를 `Deploy from a branch`로 선택
3. **Branch**를 `main` / `/ (root)`로 선택하고 저장
4. 잠시 후 `https://<사용자명>.github.io/<저장소명>/` 에서 실행됩니다.

> 이 폴더를 저장소의 하위 폴더(예: `docs/`)에 두었다면 Pages Source를 `main` / `/docs`로 지정하세요.

### 방법 B — 로컬 미리보기

정적 파일이지만 ES 모듈은 `file://`에서 로드되지 않으므로 로컬 서버가 필요합니다.

```bash
# Python
cd QARScanner
python -m http.server 8123

# 또는 Node
npx --yes serve -l 8123 .
```

브라우저에서 `http://localhost:8123/` 접속.

---

## 테스트

계산·구조·유동성·점수·리페인트 방지 테스트가 포함됩니다.

```bash
# Node (CI 친화적, 종료코드 반환)
node tests/run.js

# 브라우저
# http://localhost:8123/tests/ 접속
```

현재 전체 테스트는 **118/118 통과**했습니다. (EMA·RSI·MACD·ATR·Bollinger·VWAP·OBV,
Pivot·BOS·CHoCH, 스윕·FVG, stage 0/1, 흡수 60%/100%, stage 5 필터,
timestamp 기반 OI·자료 부족 fail-closed·단계별 압축·early 등급·돌파 우선,
모드 전환 UI 동기화, TradingView 심볼·15분봉 인계, prefix==full 리페인트 검증)

---

## 파일 구조

```
QARScanner/
├── index.html            # 단일 페이지
├── manifest.webmanifest  # PWA (선택)
├── sw.js                 # 서비스워커 — 앱 셸만 캐시, API 응답은 캐시 안 함
├── css/style.css         # 모바일 우선, 다크모드, 카드/테이블 반응형
├── js/
│   ├── main.js           # 진입점
│   ├── config.js         # 모든 튜닝값 (가중치·감점·필터·TTL)
│   ├── state.js          # 전역 상태 + localStorage 설정
│   ├── api/binance.js    # 공개 REST + 동시요청 제한·큐·재시도·캐시
│   ├── core/             # 순수 계산 모듈 (테스트 대상)
│   │   ├── indicators.js       # EMA/SMA/RSI/MACD/BB/ATR/VWAP/StochRSI/OBV
│   │   ├── volume-analysis.js  # Taker/Delta/CVD/상대거래량
│   │   ├── market-structure.js # Pivot/HH·HL·LH·LL/BOS/CHoCH
│   │   ├── liquidity.js        # Equal H/L·스윕·목표 유동성
│   │   ├── fvg.js              # FVG (open/partial/filled/inverse)
│   │   ├── order-block.js      # 오더블록 (자체 규칙)
│   │   ├── risk-reward.js      # 진입·손절·TP·손익비
│   │   └── scoring.js          # 흡수 추정·단계 분류·100점 점수
│   ├── scanner/
│   │   ├── prefilter.js        # 1~3단계 필터
│   │   ├── deep-scanner.js     # 멀티타임프레임 정밀 분석
│   │   └── scan-controller.js  # 파이프라인 오케스트레이션
│   └── ui/
│       ├── dashboard.js, detail-panel.js, settings.js,
│       ├── notifications.js, tradingview.js, format.js
├── tradingview/
│   ├── easy_market_flow_v3_3.pine # 첨부 원본 보존
│   ├── easy_market_flow_v3_4.pine # 정밀 게이트 + 차트 정합 등급 버전
│   └── VERIFY.md                # TradingView 검증 기록
├── docs/superpowers/specs/
│   ├── 2026-07-27-qar-pine-alignment-prd.md
│   └── 2026-07-27-claude-early-integration-prd.md
└── tests/                # Node/브라우저 테스트 하네스와 회귀 스위트
```

## 설계 원칙

- 백엔드 없이 GitHub Pages에서 실행되는 정적 웹앱
- Vanilla HTML/CSS/JS ES Modules, 모든 경로 상대경로
- Binance 공개 REST만 사용, 개인 API 키·자동 주문 없음
- 모든 가중치·필터 임계값은 `js/config.js`에서 조정 가능
- 계산은 재현·테스트 가능하게 분리, 미래 데이터 참조(lookahead) 금지
- 아이폰 Safari(뷰포트/Safe Area/44px 터치/메모리) 고려

## 한계

- 실제 호가창을 복원하지 않습니다. 흡수·Delta는 kline의 Taker Volume 기반 **추정**입니다.
- TradingView 유료·Invite-Only 지표를 복제하지 않습니다. 링크로만 연결합니다.
- QARScanner와 Pine v3.4는 같은 점수나 판정을 교환하지 않습니다. reversal은 독립 차트
  정합 확인, early는 별도 차트 관찰이며 Pine v3.4에 early 판정은 포팅되지 않았습니다.
- 점수·단계·손익비는 참고 지표이며 매매 신호가 아닙니다.
