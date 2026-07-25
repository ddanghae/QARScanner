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

## 검증 상태

- **테스트 99/99 통과** — `node tests/run.js` (indicators, structure, liquidity, scoring,
  goldenCross, noise, early, repaint, refresh 9개 스위트)
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
node tests/run.js          # 테스트 확인 (99/99 나와야 정상)
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

0. **early 임계값 — 실측 데이터 (2026-07-25 라이브)**

   `oiChangeMinPct` 는 6번 수정 전까지 한 번도 실제로 돌아간 적이 없는 감값이었다.
   `5 → 0` 으로 낮췄다(0 = "OI 가 줄지만 않았으면 통과". 순위는 `oiBuildUp` 점수가 매김).
   음수로 더 내리는 건 "OI 증가"라는 모드 전제와 모순이라 하지 않았다.

   후보 6종목 기준 임계값별 통과 수:

   | oiChangeMinPct | 5 | 2 | **0** | -2 | -5 |
   |---|---|---|---|---|---|
   | 통과 | 0 | 0 | **1** | 3 | 4 |

   **진짜 병목은 OI 가 아니라 1차 선별이다.** 148종목 탈락 사유:

   | 사유 | 종목 수 |
   |---|---|
   | 박스 넓음 (`boxWidthMaxPct: 25`) | 70 |
   | 압축 부족 (`squeezePctMax: 30`) | 65 |
   | 거래량 고갈 아님 (`volDryMax: 0.8`) | 7 |
   | **통과** | **6** |

   후보를 늘리고 싶으면 `boxWidthMaxPct`(25→35)와 `squeezePctMax`(30→40)를 먼저 볼 것.
   OI 를 더 낮추는 건 효과가 작고 모드 취지도 해친다.

   `earlyScoreWeights`/`earlyPenalties` 는 여전히 초기값이다. 특히 `oiBuildUp` 은
   0~30% 스케일인데 실측 OI 변화가 -5.7~+1.2% 라 25점 중 1점 내외만 나온다.
   등급 밴드로 라벨은 맞췄지만(위 7번) 근본적으로는 이 스케일이 현실과 안 맞는다.
   `oiBuildUp` 을 0~5% 스케일로 바꾸면 점수 분포가 위로 늘어나 밴드도 다시 잡아야 한다.
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
