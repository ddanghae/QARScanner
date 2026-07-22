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
   종합해 **0~100점**으로 점수화하고 **1~5단계**(매집→유동성 회수→구조전환→진입→추격 금지)로 분류합니다.
6. 후보를 클릭하면 로그인된 TradingView 차트로 연결합니다.

방향은 **롱**(급락·과매도 반등), **숏**(급등·과매수 반락), **양방향**을 지원합니다.
숏은 롱의 대칭 — 고점 유동성 스윕·하락 구조전환·bearish FVG/OB·매수 흡수로 평가합니다.
양방향은 종목별로 롱/숏 중 높은 점수 쪽을 표시합니다.

## 사용법

1. 상단 **스캔 시작** 버튼을 누르면 파이프라인이 실행됩니다.
2. 진행률 바에서 단계(종목 수집 → 유동성 필터 → 1차 분석 → 정밀 분석)를 확인합니다.
3. 결과 목록에서 점수·단계·방향·핵심 신호·손익비를 확인합니다.
4. **상세**를 누르면 점수 근거, 시간봉별 상태, 진입·손절·목표가를 봅니다.
5. **TV / TradingView에서 타점 확인**을 누르면 새 탭에서 차트가 열립니다.
6. 필터 영역에서 방향·최소 점수·거래대금·단계·정렬을 조정하고 **필터 적용**을 누릅니다.
   설정은 `localStorage`에 자동 저장됩니다.
7. **자동 갱신**을 켜면 일정 주기(기본 90초)로 재스캔하며 "다음 갱신까지 남은 시간"이 표시됩니다.
   탭이 백그라운드로 가면 주기가 자동으로 느려집니다.(§18) 주기는 `js/config.js`의 `refresh.intervalMs`에서 조정합니다.

### 리페인트(미래 참조) 방지

기본 점수는 **마감 캔들**만 사용합니다. 진행 중 캔들을 포함한 실시간 예상 신호를 보려면
설정에서 별도로 켤 수 있으며, 이 경우 신호는 실시간 추정으로 구분됩니다.
모든 지표는 과거 데이터만으로 계산되며 미래 데이터를 참조하지 않습니다. (`tests/repaint.test.js`로 검증)

---

## GitHub Pages 배포

이 폴더(`qar-ict-scanner/`)를 저장소 루트 또는 하위 경로에 그대로 올리면 됩니다.
모든 경로가 **상대경로**라 하위 경로에서도 동작합니다.

### 방법 A — 저장소에 직접 배포

```bash
cd qar-ict-scanner
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
cd qar-ict-scanner
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

현재 32개 테스트 전부 통과합니다. (EMA·RSI·MACD·ATR·Bollinger·VWAP·OBV,
Pivot·BOS·CHoCH, 스윕·FVG, 흡수·단계·점수, prefix==full 리페인트 검증)

---

## 파일 구조

```
qar-ict-scanner/
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
└── tests/                # harness + 5개 테스트 스위트 + 브라우저 러너
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
- 점수·단계·손익비는 참고 지표이며 매매 신호가 아닙니다.
