# 진행 상황 (다른 컴퓨터에서 이어받기용)

이 파일은 세션이 끊겨도 어디까지 했고 뭘 더 할지 파악하기 위한 핸드오프 문서.
읽고 나서 삭제하지 말 것 — 다음 세션이 또 참고함.

## 저장소 / 배포

- 저장소: https://github.com/ddanghae/QARScanner (public)
- 라이브: https://ddanghae.github.io/QARScanner/ (GitHub Pages, main/root, 자동 재배포)
- 로컬 경로: 컴퓨터마다 다름 (예: `C:\Users\CC\00\qar-ict-scanner`, `C:\Users\anny\Documents\pine\QARScanner`)
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

6. **전체 점검 + 버그 수정 (2026-07-25)** — 대시보드 스캐너 전 파일 점검. early 모드가
   설계대로 동작하지 않고 있던 것을 발견해 수정했다.
   - **`oiLimit: 72` → `73`** — `analyzeOi` 가 72시간 변화율을 내려면 기준점 포함 73개가
     필요한데 72개만 받아와 `change72h` 가 **항상 null** 이었다. 결과적으로
     `oiChangeMinPct` 조건이 검사 자체가 안 되고(무조건 통과), `oiBuildUp` 25점이 항상 0,
     `oiDump` 제외·감점도 안 걸렸다. **early 모드의 핵심 지표가 통째로 죽어 있었다.**
     (위 5번의 "14 후보 전부 1 매집" 라이브 검증은 이 위양성의 결과였다.)
   - **`klinesLimit["4h"]: 220` → `240`** — 마감 219봉이면 EMA200 유효 구간이 마지막
     20봉뿐이라 `ema200[idx-20]` 이 null → `ema200SlopeOk` 가 **항상 false**.
     early 가 사실상 "200선 위 종가" 만 인정하고 있었다. API weight 는 동일(limit 100~499).
   - **`volumeProfile` 채점 기준을 `1.0` → `volDryMax`** — 1단계 게이트가 `volDry<=0.8`
     인데 점수는 1.0 기준이라 통과 종목이 20점 중 최대 4점만 받았다. 16점이 사수(死数).
     이 3개 탓에 early 점수 천장이 59 였고 기본 minScore 55 와 등급 85+ 를 못 넘었다 → 천장 100 회복.
   - **`window.open(url,"_blank","noopener,noreferrer")`** — 스펙상 features 에 noopener 가
     있으면 항상 null 을 반환한다. 정상 오픈까지 팝업 차단으로 오판해 TradingView 를
     누를 때마다 오류 토스트가 떴다. opener 는 수동으로 끊는 방식으로 교체.
     (토스트 문구도 "링크를 복사했습니다" 라고 거짓말하고 있어 수정)
   - **minScore 를 스캔 단계에서 자르지 않도록** — `state.results` 를 만들 때 잘라버려서
     UI 에서 "최소 점수" 를 낮춰도 되살릴 데이터가 없었다(재스캔해야만 반영).
     이제 전량 저장하고 `applyFilters` 가 최종 필터. 두 모드 중복 블록은 `finishScan` 하나로.
   - **죽은 컨트롤 정리** — "최소 거래대금" 은 설정만 쓰고 아무도 안 읽어서 `stage2Liquidity`
     에 배선(reversal 만. early 는 중형 유니버스 기준 유지). "급락 기준"·"시간봉" 은
     읽는 코드가 0곳이라 삭제(`dropBasis`/`timeframeFocus`/`lastTab` 설정키도 제거).
   - **early 모드 UI 부정합** — 단계 4·5 와 "하락률" 정렬은 early 에 존재하지 않는데
     선택 가능해 조용히 빈 결과가 됐다. 비활성화 + 선택돼 있으면 기본값으로 되돌림.
     상세 패널의 "시간봉별 상태" 표는 early 에서 전부 "-" 라 섹션째 숨김.
   - **안 쓰는 계산 제거** — `computeIndicators` 가 `sma20`/`macd`/`bb`/`obv`/`stochRsi` 를
     계산했지만 신호 조립에서 아무도 안 읽었다(후보 50 × 4시간봉 = 200회 낭비). 함수 자체는
     export 유지. `stochRsi` 의 null→0 오염, fvg 의 미사용 변수, deep-scanner 의 no-op map 도 정리.
   - sw.js: APP_SHELL 에 빠져 있던 `early-detect`/`golden-cross-retest`/`noise-filter` 추가,
     캐시 버전 v3→v4.
   - **고치지 않은 것**: `detectStructureEvents` 가 pivot 확정(좌우 `swingPivot`봉) 전인
     `sw.idx+1` 부터 돌파를 스캔한다. 이벤트 `candleTime` 이 실제 인지 가능 시점보다 이르다.
     현재 상태 신호에는 영향이 없고 고치면 모든 BOS/CHoCH 결과가 바뀌므로 별도 판단 필요.

7. **early 전용 등급 밴드 (2026-07-25)** — 6번 수정 후에도 등급이 reversal 기준
   (85/75/65/55/0)이라 정상 후보가 "제외" 로 표시되는 문제가 남아 있었다.
   게이트를 넓혀 32종목 표본을 뽑아 실측 분포를 보고 밴드를 다시 잡았다.

   표본 분포 — 최고 61(ALLO), 53(UNI), 그다음 35(ZEC) 33 32 32 31 30 30 29 28 27 26 25 …
   중앙값 22.

   | | early | reversal |
   |---|---|---|
   | 강한 후보 | 50 | 85 |
   | 관심 후보 | 35 | 75 |
   | 관찰 후보 | 25 | 65 |
   | 조건 부족 | 15 | 55 |
   | 제외 | 0 | 0 |

   - `CONFIG.earlyGrades` 추가. `gradeFor` 는 `cfg.grades` 만 읽으므로
     `buildEarlyResult` 에서 `gradeFor(score, { grades: cfg.earlyGrades })` 로 넘긴다.
     **`key` 는 CSS(`.score-strong` 등)와 물려 있어 바꾸면 안 된다.**
   - `CONFIG.earlyMinScore` 추가 — 표시 하한. 밴드 경계와 일치해야 한다
     (경계 중간에 걸치면 등급이 잘려 보인다). 8번에서 15→25 로 올렸다.
   - 필터 바의 "최소 점수"와 채점 강도는 reversal 점수대 기준이라 early 에 못 쓴다.
     early 모드에서는 컨트롤을 잠그고 라벨에 고정값을 표시한다
     (단계 4·5, "하락률" 정렬과 같은 처리. `syncModeControls` 한 곳에 모아둠).
   - 검증: ZECUSDT 35점 → 전 `제외`/`score-excluded` → 후 `관심 후보`/`score-watch`.
     reversal 로 되돌리면 컨트롤·라벨 전부 원복 확인.
     (단 ZEC 는 8번의 핵심 소계 게이트에서 탈락한다.)

8. **early — "확실한 소수" 로 방향 전환 (2026-07-25)** — 후보 수를 늘리는 게 아니라
   확실한 것만 고르는 쪽으로 바꿨다. 계기는 실측에서 드러난 두 가지 결함이다.

   **(1) 가중합 구멍** — `trendReclaim` 15점이 "200선 위" 이진(0/15)이라 공짜 점수처럼
   작동했다. 통과 종목 ZECUSDT 는 총점 35 중 15점이 여기서 나왔고 핵심 3항목
   (압축·OI·고갈) 득점률은 0.62 / 0.05 / 0.12 로 최하위권이었다. 즉 이 모드의 정의와
   무관한 항목이 순위를 정하고 있었다.

   **(2) 하드 문턱이 아슬아슬하게 진짜 후보를 잘랐다** — 핵심 소계 1위 EDGE(52%)는
   OI -0.3% 로, 유일하게 OI 가 붙던 UNI(+6.4%)는 volDry 0.86 으로 탈락한 반면
   핵심 소계 27% 인 ZEC 만 통과했다.

   그래서 **개별 문턱은 "명백한 이탈" 만 배제하도록 완화하고(`volDryMax` 0.8→1.0,
   `oiChangeMinPct` 0→-5), 선별은 핵심 3항목 소계가 담당**하게 했다.
   - `earlyCoreKeys` + `earlyCoreMinPct: 40` — 압축·OI증가·거래량고갈 소계가 만점 대비
     40% 미만이면 제외. `coreStrengthPct()` 가 계산하고 `buildEarlyResult` 에서 한 번 본다.
   - `earlyKeepTop: 3` — 표시 상한. `applyFilters` 에서 early 일 때만 slice.
   - `earlyMinScore` 15 → 25 — "관찰 후보" 이상만 노출(조건 부족·제외는 숨김).
   - 빈 결과일 때 깔때기 숫자와 이유를 보여준다(`dashboard.emptyMessage`).
     확실한 소수만 고르면 0건이 정상 결과일 수 있는데, 그때 고장으로 보이면 안 된다.

   **결과 (같은 시장 스냅샷, 전후 비교)**

   | | 전 | 후 |
   |---|---|---|
   | 1위 | ZEC 35점 관심 후보 (핵심 27%, OI +1.6%) | **UNI 56점 강한 후보 (핵심 42%, OI +6.4%)** |
   | 2위 | — | **EDGE 29점 관찰 후보 (핵심 52%)** |
   | ZEC | 통과 | 탈락 (핵심 27% < 40%) |

   1차 선별 통과는 6→11 로 늘고(문턱 완화) 최종은 1→2 로, 순위는 핵심 신호 기준으로 뒤집혔다.

   **주의** — `earlyCoreMinPct` 40 도 실측 한 스냅샷으로 잡은 값이다. 후보가 계속 0건이면
   35 로, 어중이떠중이가 섞이면 45~50 으로 조정할 것. 개별 문턱(`volDryMax`,
   `oiChangeMinPct`)을 다시 조이는 방향은 (2) 때문에 권하지 않는다.

9. **급락 반등(reversal) 점검 + 수정 (2026-07-25)** — early 에 적용한 원칙을 그대로
   reversal 에도 적용했다. 실측해 보니 같은 병을 앓고 있었다.

   **(1) 깔때기가 필터가 아니었다 (71 → 58, 82% 통과)**
   - `drop24hMax: 8` 이 이름과 정반대로 동작했다. `drop6hMax` 는 -1.5(음수=하락)인데
     이것만 +8 이었고, "24h 급등 컷" 이라는 주석과 달리 **OR 허용절**에 들어 있어
     "24h 가 +8% 이하면 통과" 로 작동했다. 71종목 중 60 이 이 절로 들어왔다. → `-8`
   - `nearLowPct: 18` — 하루 18% 넘게 움직이는 코인이 드물어 71 중 58 통과. → `8`
   - **6h 급등 중인 코인이 "급락 반등" 롱 후보로 들어왔다**(실측 +18.9%, +11.2%, +9.9%).
     하락 증거가 OR 로 묶여 `drop6hMax` 가 무시됐기 때문. `maxCounterMove6h: 3` 을 AND 로
     추가해 "이미 반등이 진행됐으면 초기가 아니다" 를 강제한다. 숏은 대칭(-3).
   - 결과: 72 → 46.

   **(2) 롱인데 진입가가 현재가보다 위 (50건 중 20건, 최대 +4.49%)**
   `computeLongPlan` 이 FVG mid·OB mid·VWAP1h·EMA20 를 **단순 평균**했다. 서로 무관한
   레벨이 섞여 실제 지지가 아닌 허공 가격이 나왔고 실행 불가한 계획이 됐다.
   `nearestEntry()` 로 교체 — 롱은 현재가 아래 가장 가까운 지지, 숏은 위 가장 가까운 저항,
   방향에 맞는 레벨이 없으면 현재가. 폴백 TP 기준도 `price` → `entry` 로 통일. → **0건**.

   **(3) 손익비 폭주 (최대 1:30.1, 리스크 폭 0.16%)**
   저변동성 종목에서 0.5×ATR(15m) 손절이 지나치게 좁았다. `CONFIG.riskReward.minStopPct: 0.5`
   로 최소 손절 폭을 강제. → 최대 1:11.6.

   **(4) 손익비가 단계 분류를 지배했다** — `poorRiskReward`(RR<1.5)가 5단계 트리거라
   50건 중 33건(66%)이 "늦음·추격 금지" 로 몰렸다. "늦었다" 는 시장 국면이고 손익비는
   계획 품질이라 개념이 다르다. `classifyStage` 에서 제거(감점으로는 그대로 반영).
   → 추격 금지 10/46(22%), 관찰 초기 23·구조전환 10·유동성 회수 3 으로 분산.

   **(5) 핵심 신호가 점수에 기여하지 않았다** — 저점 스윕 2/50, FVG·OB 중첩 5/50 인데
   "급락 및 과매도" 39/50, "거래대금" 38/50. early 와 같은 가중합 구멍이라 같은 장치로 막는다.
   `reversalCoreKeys`(스윕·스윕회수·1h구조전환·FVG/OB, 합 50점) + `reversalCoreMinPct: 40`.
   `coreStrengthPct()` 는 `scoring.js` 로 옮겨 두 모드가 공용한다. → 46 → 5.
   `reversalKeepTop: 5` 도 추가.

   **(6) 등급·채점 강도가 도달 불가능한 값이었다** — 실측 최고점이 60 인데 밴드가
   85/75/65/55 라 50건 중 48건이 "제외" 였고 "강한/관심/관찰 후보" 가 한 번도 안 나왔다.
   채점 강도 4(65)·5(75)는 **항상 0건**이었다.

   | | 신 | 구 |
   |---|---|---|
   | 강한 후보 | 55 | 85 |
   | 관심 후보 | 40 | 75 |
   | 관찰 후보 | 30 | 65 |
   | 조건 부족 | 20 | 55 |
   | 채점 강도 1~5 | 20/25/30/40/55 | 30/40/55/65/75 |

   `minListScore`(죽은 값)는 삭제, `defaultSettings.minScore` 55→30, 필터 바의
   "최소 점수" 선택지도 밴드에 맞춰 교체했다.

   **최종 결과 (2026-07-25 라이브, 525종목)**

   ```
   525 → 유동성 72 → 후보 46 → 핵심 게이트 5 → 화면 3
   PUMPUSDT 60 강한 후보 (핵심 50%) · 유동성 회수
   ERAUSDT  50 관심 후보 (핵심 50%) · 구조전환 초기 + 골든크로스 리테스트
   XPLUSDT  37 관찰 후보 (핵심 70%)
   (APRUSDT 37 은 노이즈 필터 촙 구간, HBARUSDT 24 는 minScore 30 미달로 숨김)
   ```

   **주의** — `reversalCoreMinPct` 40 도 한 스냅샷 기준이다.

10. **상관 감점 그룹화 (2026-07-25)** — 9번 뒤에도 "핵심이 강한데 총점이 낮은" 어긋남이
    남아 있었다. 원인을 실측해 보니 가중치가 아니라 **감점 중복**이었다.

    XPLUSDT 는 핵심 4항목 만점(50/50)인데 총점 34("관찰 후보")였다. 감점 -26 의 내역:

    | 감점 | 값 | 보는 것 |
    |---|---|---|
    | `strongResistanceAbove` | -8 | eqHighs 가 1 ATR 이내 |
    | `shortTargetDistance` | -8 | buySideTarget 이 1.5 ATR 이내 |
    | `poorRiskReward` | -10 | majorHigh1h 기준 RR < 1.5 |

    **셋 다 "위로 갈 공간이 없다" 는 한 가지 사실**이다. 보는 레벨만 다르다.
    여기에 `scoreWeights.riskReward` 보너스(+5)까지 더하면 공간 하나가 100점 중 23점을
    좌우한다. `CONFIG.penaltyGroups` 를 추가해 **그룹당 가장 센 감점 하나만** 적용한다
    (`scoring.dedupePenaltyGroups`, 표시 순서는 유지). 그룹 밖 감점은 그대로 누적.

    | 종목 | 전 | 후 |
    |---|---|---|
    | XPLUSDT (핵심 50/50) | 34 · 관찰 후보 · 감점 -26 | **50 · 관심 후보 · 감점 -10** |
    | TRUMPUSDT | 27 · 감점 -18 | 27 · 감점 -18 (`strongDowntrend4h` 는 그룹 밖) |
    | APR/HANA/LA | 변화 없음 | 변화 없음 |

    밴드는 안 건드렸다 — 최고점 60 그대로고 XPL 만 위로 올라온다.

    **일부러 안 한 것**
    - **가중치 재배분(핵심 70/30)** — 시뮬레이션하면 XPL 65 vs APR 65 동점이고,
      80/20 까지 밀어야 XPL 이 1위가 된다. 그런데 XPL 의 감점은 진짜다(위에 저항,
      목표 가까움, RR<1.5 = 먹을 게 없는 자리). 셋업이 완벽해도 실행 여건이 나쁘면
      순위가 내려가는 게 맞다. **APR 이 1위인 현재 순위는 틀리지 않았다** —
      틀린 건 XPL 이 밀려난 정도뿐이었고 그건 감점 중복 때문이었다.
    - **early 에는 그룹 불필요** — `alreadyPumped`/`oiDump`/`fundingOverheated`/
      `thinLiquidity` 는 서로 독립이라 중복 차감이 없다. early 에 남은 문제는
      `oiBuildUp` 의 0~30% 스케일로 성격이 다르다(위 0번 참조).

11. **early 재적합 — 채점을 검증된 3요인으로 (2026-07-26)** — 10번까지는 가중치를 감으로
    잡고 실측 한 스냅샷으로 밴드를 맞추는 식이었다. 이번엔 데이터로 다시 뽑았다.

    바이낸스 USDT 무기한 529종목 × 일별 평가 **57,720행**을 시간순 70/30 으로 나눠
    학습셋에서만 변형을 고르고 검증셋에서 한 번 확인했다.
    라벨 = "이후 7일 내 24시간 +40% 이상". 원자료·재현 스크립트는 `research/` 에 있다.

    **다변량 로지스틱에서 죽은 것** — `|펀딩|` -0.135, `거래량확장` +0.030.
    단변량 리프트 2.1~3.5x 는 **모멘텀의 대리변수**였다는 뜻이다. 셋을 빼고 3요인만
    남긴 쪽이 검증셋 상위3 기준 **10.71x** 로 기존 5요인(6.04x)을 이겼다.

    - 채점: `momentum 45 / change24h 32 / freshness 23`, 감점은 `thinLiquidity -10` 만
    - 제거: `crowding`·`volExpansion`·`oiBuildUp` 항목, `deadZone`·`fundingFlat` 감점
    - 제거: `earlyCoreKeys`/`earlyCoreMinPct` 핵심 소계 하한. 3요인 전부 검증 요인이라
      보조 항목으로 총점을 부풀릴 구멍이 없다. 단독 최대인 freshness 23점이 표시 하한을
      못 넘는다는 걸 테스트로 고정했다.
    - 밴드 재보정 `70/55/40/25`, 표시 하한 25 → 40 (점수 분포가 위로 올라갔다)
    - `.pine` 모드 2도 변형 D 로 교체 — 펀딩·OI 가 채점에서 빠져 **근사·생략 없이**
      스캐너와 계산이 같아졌다(예전엔 OI 를 `<심볼>_OI` 로 우회하고 펀딩은 통째로 생략)
    - **8번의 `earlyCoreMinPct`, 0번의 `oiChangeMinPct` 관련 서술은 이 시점부터 무효다.**
      OI·펀딩은 채점에 안 쓰인다(`crowdAbs` 를 읽는 곳이 없다 — 상세 표시 전용).

    검증: `research/verify-port.mjs` 가 배포 채점이 변형 D 와 같은지 리프트로 assert,
    `research/verify-pine.mjs` 가 .pine 상수·밴드가 config 와 같은지 assert.

12. **청산 규칙 + 화면 표시 (2026-07-29)** — 11번 뒤에도 백테스트 기대값이
    +0.007R 수준이었다. 원인을 찾아보니 채점이 아니라 **파는 방식**이었다.

    **(1) 박스 기반 손절이 손해였다** — `earlyPlan` 이 박스 하단(-0.5 ATR)과 ATR 배수 중
    `math.max` 로 "진입에 더 가까운 쪽" 을 채택했다. 이름은 상한이었지만 실제로는 **더 좁은
    손절**을 골라 목표 도달 전에 먼저 맞았다. 이것만 순수 ATR 배수로 바꿔도 +0.084R.

    **(2) 격자 탐색** — `research/sweep-exits.mjs`. 손절 배수 × 목표 R × 보유봉.
    심볼당 1회 페치 후 조합 전부를 같은 패스에서 평가한다. 전체 529종목, 신호 5,111건.
    1차 격자의 최고점이 끝단(3R/60봉)에 걸려 2차로 밖을 다시 봤다.

    | 조합 | 평균 | PF | MDD | 승률 |
    |---|---|---|---|---|
    | **ATR×4 · 4R · 90봉** | +0.155R | **1.34** | **-22.8R** | 36% |
    | ATR×2 · 6R · 90봉 | **+0.171R** | 1.25 | -32.9R | 27% |

    평균만 보면 후자가 위지만 목표 171 / 손절 1010 의 **소수 대박 의존형**이라 뺐다.
    `stopAtr: 4` / `targetR: 4` / `holdBars: 90` 으로 config 에 넣고 .pine 도 맞췄다.

    **배포 규칙으로 다시 돌린 전체 백테스트**

    | | 전 | 후 |
    |---|---|---|
    | 평균 | +0.017R | **+0.150R** |
    | PF | 1.03 | **1.33** |
    | MDD | -51.1R | **-22.9R** |
    | 승률 | 36% | 36% |

    승률은 그대로다 — 이기는 판을 크게 먹어서 생긴 차이다.
    점수 70+ 구간은 +0.240R · PF 1.55 로 전체 평균의 1.6배. 목표를 멀리 두니
    점수의 가치가 드러났다.

    **(3) 급등확률 노출** — 손익비가 R 배수 고정이라 화면에 항상 `1:2.00` 이 떠
    정보가 0 이었다. 그 칸을 그 점수대의 검증셋 실측 적중률로 바꿨다.
    `70+ 29% (8.25x) / 55-69 16% / 40-54 12%`, 기준선 3.57%.
    `gradeFor` 가 밴드 객체를 그대로 반환하므로 `earlyGrades` 에 `hitRate` 를 넣는 것
    말고 배선이 필요 없다. **밴드를 옮기면 확률도 같이 옮겨야 한다** — 테스트가 막는다.

    **(4) 손익 금액 + 레버리지** — 시드머니 입력(기본 100만원)과 레버리지 선택
    (1/2/3/5/10/20배). 표시 전용이라 재스캔 없이 즉시 다시 그린다.
    왕복 비용 0.2% 를 양쪽에서 뺀다 — 백테스트와 같은 값이라야 두 숫자가 맞는다.

    레버리지는 손익만 키우는 게 아니라 **청산**을 만든다. 이 모드의 손절은 ATR×4 라
    실측 -30~45% 대가 기본인데 3배의 청산선은 -32.8% 다. 손절가에 닿기 전에 끝난다.
    - 손실을 시드에서 자른다 — 격리 마진은 증거금보다 더 못 잃는다
      (안 자르면 100만원 넣고 -114.9만원 이라는 존재하지 않는 숫자가 나온다)
    - 청산이 손절보다 앞서면 행 이름을 "청산되면" 으로 바꾸고 안전 배수를 제시한다
    - 청산가는 유지증거금 0.5% 가정의 **근사치**. 구간표(0.4~5%)는 안 넣었다 —
      경고를 띄울지 가르는 용도라 자릿수만 맞으면 된다

    **(5) 서비스워커가 HTTP 캐시를 먹던 문제** — `respondWith` 안의 `fetch(e.request)` 가
    브라우저 캐시에서 응답을 받아 "네트워크 우선" 이 이름뿐이었다. `index.html` 만 새로
    받고 `js/ui/*.js` 는 옛것이라 **새 컨트롤은 보이는데 표시가 안 나오는** 증상이 났다.
    `fetch(e.request, { cache: "reload" })` + 캐시 v5 → v6.

    **방침** — 이 도구는 예측만 한다. 포지션은 사용자가 잡는다. 진입/손절/목표 표시는
    참고용이며, 백테스트 +0.150R 은 이 도구가 책임지는 수익 곡선이 아니다.

    **한계** — ATR×4 · 4R 은 4시간봉 1000개(약 166일) 한 구간에서 한 번 측정한 값이다.
    알트 강세 국면이 포함돼 있다. 국면이 바뀌면 다시 훑을 것:
    `SWEEP_STOPS=... SWEEP_TARGETS=... SWEEP_TIMES=... node research/sweep-exits.mjs all`

13. **병렬 갈래 병합 (2026-07-29)** — 같은 조상 `db01999` 에서 **다른 컴퓨터가 독립적으로
    early 모드를 다시 만들고 있었다.** 원격 `main` 에 5커밋(Opus 4.8). 겹치는 파일 9개.

    두 갈래가 **같은 결론에 독립적으로 도달한 부분**이 있다.
    - 압축·거래량 고갈 전제는 틀렸다 (저쪽: "예측력이 반대", 이쪽: "표본 외에서 죽음")
    - 박스 기반 손절·목표는 도달 불가능한 값을 낸다 → **양쪽 다 ATR 기준으로 교체**

    대체 모델은 갈렸다.

    | | A 이 저장소 | B origin/main |
    |---|---|---|
    | 채점 | momentum 45 / change24h 32 / freshness 23 | volatilityRange 40 / rangePosition 25 / oiBuildUp 25 / volumeExpansion 10 |
    | OI | 제거 (다변량에서 모멘텀 대리변수) | 핵심 요인 |
    | 게이트 | 죽은 구간(\|14d\|<15%) 배제만 | boxWidth 하한 50, rangePos<=0.30 |
    | 손절 | ATR×4 | min(박스하단, 2ATR, 20%) |
    | 측정 | 57,720행 시간분할 70/30, 검증셋 리프트 | 급등 82건 재생, 포착률 |

    **같은 표본에 둘 다 돌려서 정했다** (`research/compare-models.mjs`).
    같은 봉·같은 라벨("7일 내 24h +40%")·각자의 청산 규칙. 평가 5,821건, 기준 급등률 5.41%.

    | | A | B |
    |---|---|---|
    | 노출 | 359 | 198 |
    | 적중률 | **33.15%** | 28.28% |
    | 리프트 | **6.13x** | 5.23x |
    | 상위 3/일 | **13.04x** | 11.09x |
    | 상위 10/일 | **9.43x** | 7.20x |
    | 백테스트 | **+0.100R** · PF 1.24 | -0.054R · PF 0.93 |
    | MDD | **-37.3R** | -55.5R |

    B 의 R 이 마이너스인 원인은 청산이다 — 목표 45 / 손절 137. 좁은 손절이 목표 전에
    먼저 맞는다. `sweep-exits.mjs` 격자 결과(ATR×1.5 최악, ATR×4 최고)와 방향이 같다.

    **A 채택.** 다만 **겹침이 중요하다** — 둘 다 고른 129건의 적중률은 38.76%(7.16x)로
    양쪽 단독보다 높았다. 서로 다른 것을 보고 있고 동의할 때가 가장 정확하다.
    교집합 모델은 노출이 129/5,821 로 너무 적어 이번엔 넣지 않았다. 후보로 남긴다.

    **B 에서 살려온 것**
    - 되돌림 실측 — 급등 141건 고점 이후 중앙 **82% 반납**, 31%는 전량 반납,
      절반 미만 반납은 10.6%. 채점 모델과 무관한 측정이라 `earlyPlan.note` 로
      상세 패널에 그대로 띄운다(`.plan-note`). 분할 익절 전제를 못 박는 문구다.
    - "급등 후 버틸 종목은 사전 지표로 구분되지 않는다" 는 음성 결과. 거래대금 채점을
      넣어봤지만 효과가 노이즈 수준이라 저쪽도 되돌렸다 — 다시 시도하지 말 것.
    - README 의 한계 서술 톤(후보 좁히기 도구, 단독 매매 근거 아님).

    **B 에서 안 가져온 것과 이유**
    - `maxStopPct 0.20` — 격자 탐색에서 좁은 손절이 손해라는 결과와 정면 충돌한다.
    - `minScoreFor` + 채점 강도 → earlyMinScore 연결 — 저쪽이 고친 "죽은 컨트롤" 문제는
      이쪽도 이미 해결했다(early 에서 컨트롤을 잠그고 고정값과 이유를 라벨에 표시).
      저쪽 단계값(25/32/40/50/60)은 이쪽 밴드(70/55/40/25)와 경계가 안 맞는다.
    - 후보 정렬 기준 박스폭 내림차순 — A 모델은 박스폭을 채점하지 않는다.

    **한계** — 비교 구간이 11일뿐이다. Binance `openInterestHist` 가 30일만 보존하고
    `limit` 상한이 500 이라 B 의 OI 25점이 살아 있는 구간이 그만큼밖에 안 된다.
    긴 구간으로는 공정 비교가 불가능하다. 국면이 바뀌면 다시 볼 것:
    `MAIN_WT=<워크트리> node research/compare-models.mjs oi`

## 검증 상태

- **테스트 110/110 통과** — `node tests/run.js` (indicators, structure, liquidity, scoring,
  goldenCross, noise, early, repaint, refresh 9개 스위트)
- **재현 스크립트 2개** — 둘 다 `research/` 안에서 실행해야 한다(상대 경로).
  - `node verify-port.mjs` — 배포 채점이 변형 D 와 같은지 (검증셋 상위3 = 10.71x)
  - `node verify-pine.mjs` — .pine 상수 19개 + 등급 밴드 4개가 config 와 일치하는지
- **조기 포착 라이브 검증 (2026-07-29, 11~12번 후)** — 콘솔 에러 0.
  급등확률 컬럼 렌더, 시드 3배 → 금액 정확히 3배, 레버리지 1/2/3/10배 청산 판정,
  계획 계산이 ATR×4 · 1:4.00 인지 확인.
  - ※ .pine 자체 컴파일은 트레이딩뷰에 붙여야 확인된다 — 상수 일치만 자동 검증된다.
  - early 스위트에 **config 경계값 회귀 테스트 3개** 추가. `oiLimit`/`klinesLimit["4h"]` 를
    되돌리면 테스트가 깨진다 — 계산식이 아니라 "표본이 1개 모자라" 죽었던 버그라서
    상수를 만지는 순간 다시 조용히 죽기 때문.
- **라이브 Binance API로 실제 스캔 여러 번 검증** — 롱/숏/양방향 전부 확인,
  콘솔 에러 0, RR 폭발 버그도 라이브에서 재현 후 수정 확인(수정 전 1:73M → 수정 후 1:16)
- **조기 포착 모드 라이브 검증 (2026-07-25, 6~8번 수정 후)** —
  early 스캔 525종목 → 유동성 148 → 압축·박스 11 → **최종 2건**
  (UNIUSDT 56점 강한 후보 / EDGEUSDT 29점 관찰 후보). 콘솔 에러 0.
  - OI: `oiLen 73`, `change72h` 전 종목 값 산출 확인(수정 전엔 항상 null)
  - EMA200 기울기: 수정 전 항상 false → 후 정상 산출
  - 최소 점수 55→30 으로 낮추면 **재스캔 없이** 표시 2→11 행 (reversal)
  - early 상한: 50건 입력에도 3건만 표시 / reversal 은 상한 없음(23건)
  - 빈 결과 시 깔때기 안내 렌더 확인
  - reversal 모드 회귀: 525→72→50 정밀, RR 이상치 0, 시간봉 표 4개 정상,
    early 전용 컨트롤 잠금 전부 원복
  - ※ 5번 시절의 "14 후보 전부 1 매집" 은 OI 버그로 인한 위양성이었다(6번 참조).

## 재개 방법

```bash
git clone https://github.com/ddanghae/QARScanner.git
cd QARScanner
node tests/run.js          # 테스트 확인 (110/110 나와야 정상)
python -m http.server 8123 # 로컬 미리보기 (ES 모듈이라 file://로는 안 열림)
# 브라우저에서 http://localhost:8123/ 접속
```

배포는 자동 — `main`에 push하면 GitHub Pages가 재빌드함. 별도 빌드 스텝 없음.

## 파일 구조

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
pine/  qar_scanner_sync_indicator.pine   (트레이딩뷰 동기화 지표. 모드 2 = early)
docs/  펌프예측_연구정리.md               (11~12번의 원자료 정리 — 수치 출처)
       superpowers/{specs,plans}/…
research/                               (재현 스크립트 + 원자료 CSV)
  sweep-exits.mjs    청산 규칙 격자 탐색 (--selftest 내장)
  backtest.mjs       배포 규칙 워크포워드 (심볼 목록 또는 all)
  control.mjs        대조군 — 신호 없이 무조건 진입
  verify-port.mjs    배포 채점 = 변형 D 인지 assert
  verify-pine.mjs    .pine 상수 = config 인지 assert
  refit.mjs variants.mjs predict-dump.mjs predict-eval.mjs
  predict.csv(5.8MB) gainers.csv gainers_0726.csv pumpers_0729.txt …
```

핵심 진입점: [config.js](js/config.js)(모든 가중치·필터·TTL 조정 지점),
[scan-controller.js](js/scanner/scan-controller.js)(파이프라인 순서),
[deep-scanner.js](js/scanner/deep-scanner.js)(신호 조립 → 롱/숏),
[scoring.js](js/core/scoring.js)(흡수·단계·점수).

## 앞으로 할 수 있는 것 (우선순위 순, 아무것도 확정 아님)

0. ~~**early 임계값 — 실측 데이터 (2026-07-25)**~~ **폐기 — 11번 참조.**
   `oiChangeMinPct`·`volDryMax`·`squeezePctMax`·`oiBuildUp` 스케일 논의는 전부 무효다.
   압축·거래량고갈·OI 는 검증에서 살아남지 못해 채점과 1차 게이트에서 빠졌다.
   "TradingView 지표 early 포팅" 도 완료(11번).

1. **early 청산 규칙 재측정** — `ATR×4 · 4R · 90봉` 은 한 국면(약 166일, 알트 강세 포함)
   한 번의 측정값이다. 국면이 바뀌면 `research/sweep-exits.mjs` 를 다시 돌릴 것.
   격자는 환경변수로 바꾼다. 최고점이 격자 끝단에 걸리면 밖을 다시 볼 것 — 1차에서
   그랬고, 밖에 더 좋은 조합이 있었다.

2. **reversal 모드는 아직 감값이다** — 11번의 재적합은 early 에만 했다. `scoreWeights`/
   `penalties` 는 최초 설계값이고 밴드만 실측으로 맞춰뒀다(9번). 같은 방법(라벨 정의 →
   `predict-dump.mjs` 로 행 뽑기 → `refit.mjs` → `variants.mjs`)을 reversal 에 적용할 수 있다.
3. **실제 아이폰 Safari 테스트** — 이 개발 환경(에이전트)에선 실기기 테스트 불가.
   Safe Area·터치 44px·팝업 차단 대응 코드는 넣어뒀지만 실기기 검증 안 됨.
4. **.pine 트레이딩뷰 컴파일 확인** — `verify-pine.mjs` 는 상수 일치만 본다.
   문법 오류는 붙여봐야 안다.
5. **WebSocket 실시간가 스트리밍** — 계획서 §5에 언급됐던 것. 지금은 REST 폴링만.
   전체 재스캔 없이 최종가만 실시간 갱신하고 싶으면 이거 추가.
6. **모바일 사이드바 드로어** — 지금은 900px 미만에서 사이드바가 CSS만으로
   가로 스크롤 탭 바로 바뀜(별도 JS 상태 없음). 진짜 슬라이드 드로어 원하면 추가 JS 필요.
7. **톱바 검색창** — 레퍼런스 디자인엔 있었으나 의도적으로 뺌(기능 없는 장식 안 만듦).
   심볼 빠른 검색/필터 기능으로 실제 구현하고 싶으면 요청.

## 지켜야 할 것 (설계 원칙 — README.md에도 있음)

- 백엔드 없음, GitHub Pages 정적 실행
- Binance 공개 API만, 개인 키 없음, 자동 주문 없음
- 모든 계산은 마감 캔들 기준(리페인트 방지) — 미래 데이터 참조 금지
- 가중치/필터는 `config.js`에서만 조정, 하드코딩 금지
- 새 기능 추가 시 `tests/`에 계산 검증 최소 1개는 남길 것
