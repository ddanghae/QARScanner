# 조기 포착 모드 (Early Pump Detection) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 50~150% 상승 전의 알트코인을 매집·임박·돌파 3단계로 구분해 잡아내는 스캔 모드를 추가한다.

**Architecture:** 기존 파이프라인(API 계층, 캔들 파싱, 지표, 결과표, 상세 패널)을 그대로 재사용하고 후보 깔때기와 채점만 교체하는 **스캔 모드 전환** 방식. `settings.scanMode`가 `"reversal"`(기존) 또는 `"early"`(신규)를 가리킨다. early 모드는 기존과 **동일한 결과 shape**을 반환하므로 UI 렌더 코드를 건드리지 않는다. 신규 core 모듈은 `early-detect.js` 1개뿐이고, 변동성 압축은 기존 `bollinger().width`를 재사용한다.

**Tech Stack:** Vanilla JS (ES Modules), 빌드 과정 없음, GitHub Pages 정적 배포, Binance 공개 REST API(개인 키 없음), 자체 테스트 하네스(`tests/harness.js`, 프레임워크 없음).

## Global Constraints

- 백엔드 없음. GitHub Pages 정적 실행. 빌드 스텝 없음.
- Binance **공개** API만 사용. 개인 API 키 없음. 자동 주문 없음.
- 모든 계산은 **마감 캔들** 기준. 미래 데이터 참조(lookahead) 금지.
- 가중치·임계값은 `js/config.js`에서만 조정. 하드코딩 금지.
- 새 기능은 `tests/`에 계산 검증을 최소 1개 남긴다.
- 파일 경로는 모두 상대경로(절대경로 금지).
- 테스트 실행: 저장소 루트(`QARScanner/`)에서 `node tests/run.js`. 전부 통과해야 한다.
- 기존 reversal 모드 동작을 바꾸지 않는다(회귀 금지).
- 스펙 원본: `docs/superpowers/specs/2026-07-24-early-pump-detection-design.md`

---

## File Structure

| 파일 | 책임 |
|---|---|
| `js/config.js` (수정) | `earlyDetect` 임계값, `earlyScoreWeights`, `earlyPenalties` |
| `js/state.js` (수정) | `scanMode` 설정 기본값 |
| `js/api/binance.js` (수정) | `getOpenInterestHist()`, `getPremiumIndexAll()` |
| `js/core/early-detect.js` (신규) | 박스·압축백분위·거래량·OI 계산, 3단계 분류, 제외 판정, 채점, plan, 결과 조립 |
| `js/scanner/prefilter.js` (수정) | `stage2Liquidity` 파라미터화, `stage3EvaluateEarly()` |
| `js/scanner/scan-controller.js` (수정) | `scanMode` 분기 |
| `js/ui/settings.js` (수정) | 모드 select 바인딩, `applyFilters` early 우회 |
| `index.html` (수정) | 모드 select 마크업 |
| `tests/early-detect.test.js` (신규) | 위 순수 함수 전체 검증 |
| `tests/run.js` (수정) | early 스위트 등록 |

---

### Task 1: config·state 기반값 + OI/펀딩 API 함수

**Files:**
- Modify: `js/config.js`
- Modify: `js/state.js`
- Modify: `js/api/binance.js`
- Create: `tests/early-detect.test.js`
- Modify: `tests/run.js`

**Interfaces:**
- Consumes: 없음 (첫 태스크)
- Produces:
  - `CONFIG.earlyDetect` — 임계값 객체 (아래 키 전부)
  - `CONFIG.earlyScoreWeights` — `{ squeeze, oiBuildUp, volumeProfile, rangePosition, trendReclaim }` (합 100)
  - `CONFIG.earlyPenalties` — `{ alreadyPumped, oiDump, fundingOverheated, thinLiquidity }` (음수)
  - `state.settings.scanMode` — `"reversal" | "early"`, 기본 `"reversal"`
  - `getOpenInterestHist(symbol, period, limit) -> Promise<Array<{ time:number, oi:number }>>`
  - `getPremiumIndexAll() -> Promise<Map<string, number>>` (심볼 → lastFundingRate)

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/early-detect.test.js` 를 새로 만든다:

```js
// tests/early-detect.test.js — 조기 포착 모드 계산 검증.

import { suite, test, assert, eq } from "./harness.js";
import { CONFIG } from "../js/config.js";

export function run() {
  suite("early");

  test("early 가중치 합 = 100", () => {
    const sum = Object.values(CONFIG.earlyScoreWeights).reduce((a, b) => a + b, 0);
    eq(sum, 100, "early 점수 가중치 총합 100");
  });

  test("early 감점은 모두 음수", () => {
    for (const [k, v] of Object.entries(CONFIG.earlyPenalties)) {
      assert(v < 0, `${k} 는 음수여야 함 (실제 ${v})`);
    }
  });

  test("early 임계값 존재", () => {
    const e = CONFIG.earlyDetect;
    for (const k of ["boxLookback", "squeezeLookback", "boxWidthMaxPct", "squeezePctMax",
      "volDryMax", "oiChangeMinPct", "squeezePctTight", "rangePosMin", "relVolMin",
      "breakoutRelVol", "breakoutMaxRunPct", "pumpedMaxPct", "oiDumpPct", "fundingMaxAbs"]) {
      assert(e[k] !== undefined, `earlyDetect.${k} 필요`);
    }
  });
}
```

`tests/run.js` 에 등록한다. import 줄 추가:

```js
import { run as earlyDetect } from "./early-detect.test.js";
```

그리고 `runAll()` 안에서 `noise();` 다음 줄에 추가:

```js
  earlyDetect();
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `node tests/run.js`
Expected: FAIL — `early 가중치 합 = 100` 등에서 `Cannot read properties of undefined` (CONFIG.earlyScoreWeights 없음)

- [ ] **Step 3: config 블록 추가**

`js/config.js` 의 `noiseFilter` 블록 바로 다음(= `scoreWeights` 앞)에 삽입:

```js
  // ---- 조기 포착 모드 (early) ----
  // 큰 상승 이전 흔적: 변동성 압축 + 거래량 고갈 + 미결제약정 증가.
  // 기준 시간봉 4h. 임계값은 실사용하며 조정하는 것을 전제로 한다.
  earlyDetect: {
    // 계산 파라미터
    boxLookback: 60,        // 박스 판정 봉 수 (4h × 60 ≈ 10일)
    squeezeLookback: 100,   // 압축 백분위 계산 구간
    volRecentN: 20,         // 최근 거래량 평균 구간
    volPriorN: 60,          // 비교 대상 이전 구간
    oiPeriod: "1h",         // openInterestHist period
    oiLimit: 72,            // 72시간
    // 유니버스 (중형 중심)
    minQuoteVolume: 5_000_000,
    topByVolume: 200,
    excludeMajors: ["BTC", "ETH", "BNB", "SOL", "XRP", "DOGE"],
    keepMax: 50,
    // 1단계 매집
    boxWidthMaxPct: 25,     // 박스 폭 이 % 이하
    squeezePctMax: 30,      // 압축 백분위 이하
    volDryMax: 0.8,         // 거래량 고갈 비율 이하
    oiChangeMinPct: 5,      // 72시간 OI 증가율 이상
    // 2단계 임박
    squeezePctTight: 15,    // 압축 극단
    rangePosMin: 0.95,      // 박스 상단 근접
    relVolMin: 1.0,         // 거래량 회복
    // 3단계 돌파
    breakoutRelVol: 2.0,    // 돌파 시 상대거래량
    breakoutMaxRunPct: 15,  // 돌파 후 상승폭 이 % 이하만 (초입)
    // 제외
    pumpedMaxPct: 40,       // 24h 이 % 초과 상승 = 이미 감
    oiDumpPct: -10,         // 72h OI 이 % 이하 = 포지션 이탈
    fundingMaxAbs: 0.001,   // |펀딩비| 이 값 초과 = 한쪽 과열
  },

  // ---- 조기 포착 채점 (합계 100) ----
  earlyScoreWeights: {
    squeeze: 25,          // 변동성 압축 정도
    oiBuildUp: 25,        // 미결제약정 증가
    volumeProfile: 20,    // 거래량 고갈
    rangePosition: 15,    // 박스 상단 근접
    trendReclaim: 15,     // 장기선 회복
  },

  // ---- 조기 포착 감점 ----
  earlyPenalties: {
    alreadyPumped: -20,      // 24h +25~40% (이미 어느 정도 감)
    oiDump: -15,             // OI 감소
    fundingOverheated: -10,  // 펀딩 한쪽 쏠림
    thinLiquidity: -10,      // 거래대금 10M 미만
  },
```

- [ ] **Step 4: state 에 scanMode 추가**

`js/state.js` 의 `defaultSettings` 안, `direction` 줄 바로 다음에 추가:

```js
  scanMode: "reversal",      // "reversal"(급락 반등) | "early"(조기 포착)
```

- [ ] **Step 5: API 함수 2개 추가**

`js/api/binance.js` 의 `getMarkPrice` 함수 바로 다음에 추가:

```js
// 미결제약정 추이 (공개). period: 5m/15m/30m/1h/2h/4h/6h/12h/1d, 최근 30일치만 제공.
// 반환: [{ time, oi }] 과거→현재. 데이터 없으면 빈 배열.
export async function getOpenInterestHist(symbol, period, limit) {
  const p = period || CONFIG.earlyDetect.oiPeriod;
  const lim = limit || CONFIG.earlyDetect.oiLimit;
  const path = `/futures/data/openInterestHist?symbol=${symbol}&period=${p}&limit=${lim}`;
  try {
    const raw = await request(path, { ttl: CONFIG.cacheTtlMs["1h"], cacheKey: `oi:${symbol}:${p}:${lim}` });
    if (!Array.isArray(raw)) return [];
    return raw.map((r) => ({ time: r.timestamp, oi: +r.sumOpenInterest }));
  } catch {
    // 신규 상장 등으로 데이터가 없으면 빈 배열 (후보를 죽이지 않는다)
    return [];
  }
}

// 전 종목 펀딩비 1회 호출 (심볼 미지정 → 배열). 반환: Map<symbol, lastFundingRate>
export async function getPremiumIndexAll() {
  try {
    const raw = await request("/fapi/v1/premiumIndex", {
      ttl: CONFIG.cacheTtlMs.ticker24h,
      cacheKey: "premiumIndexAll",
    });
    const arr = Array.isArray(raw) ? raw : [raw];
    return new Map(arr.map((r) => [r.symbol, +r.lastFundingRate]));
  } catch {
    return new Map();
  }
}
```

그리고 같은 파일 맨 아래 `export default { ... }` 목록에 두 이름을 추가한다:

```js
export default {
  getExchangeInfo, getTicker24h, getKlines, getMarkPrice,
  getOpenInterestHist, getPremiumIndexAll,
  parseKlines, closedOnly, clearCache,
};
```

- [ ] **Step 6: 테스트 통과 확인**

Run: `node tests/run.js`
Expected: PASS — `[early] early 가중치 합 = 100`, `[early] early 감점은 모두 음수`, `[early] early 임계값 존재` 3개가 통과하고 전체 합계가 이전보다 3 증가

- [ ] **Step 7: 커밋**

```bash
git add js/config.js js/state.js js/api/binance.js tests/early-detect.test.js tests/run.js
git commit -m "조기 포착 모드 기반값 추가 — config 임계값/가중치, scanMode 설정, OI·펀딩 API"
```

---

### Task 2: 박스 · 압축 백분위 · 거래량 프로파일 계산

**Files:**
- Create: `js/core/early-detect.js`
- Modify: `tests/early-detect.test.js`

**Interfaces:**
- Consumes: `CONFIG.earlyDetect` (Task 1), 기존 `bollinger(closes, period, mult) -> { mid, upper, lower, width }` (`js/core/indicators.js`)
- Produces:
  - `boxRange(candles, lookback) -> { boxHigh, boxLow, boxWidthPct, rangePos } | null`
  - `squeezePercentile(widths, lookback) -> number | null` (0~100, 낮을수록 압축)
  - `volDryRatio(candles, recentN, priorN) -> number | null`

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/early-detect.test.js` 의 import 줄에 추가:

```js
import { boxRange, squeezePercentile, volDryRatio } from "../js/core/early-detect.js";
import { candlesFromCloses } from "./fixtures.js";
```

`run()` 안 마지막에 추가:

```js
  test("박스 범위·폭·위치 계산", () => {
    // 10~20 사이를 오간 뒤 마지막이 19 → 상단 근처
    const closes = [10, 20, 12, 18, 11, 19];
    const c = candlesFromCloses(closes, { spread: 0 });
    const box = boxRange(c, 6);
    eq(box.boxHigh, 20, "박스 상단");
    eq(box.boxLow, 10, "박스 하단");
    // (20-10) / 15 * 100 = 66.67
    assert(Math.abs(box.boxWidthPct - 66.666) < 0.01, `박스 폭 % (실제 ${box.boxWidthPct})`);
    // (19-10)/(20-10) = 0.9
    assert(Math.abs(box.rangePos - 0.9) < 1e-9, `박스 내 위치 (실제 ${box.rangePos})`);
  });

  test("박스 — 캔들 부족하면 null", () => {
    const c = candlesFromCloses([1, 2, 3], { spread: 0 });
    eq(boxRange(c, 60), null, "lookback 미만이면 null");
  });

  test("압축 백분위 — 현재가 가장 좁으면 0", () => {
    const widths = [5, 4, 3, 2, 1]; // 마지막이 최소
    eq(squeezePercentile(widths, 5), 0, "가장 좁으면 0");
  });

  test("압축 백분위 — 현재가 가장 넓으면 높음", () => {
    const widths = [1, 2, 3, 4, 5]; // 마지막이 최대
    eq(squeezePercentile(widths, 5), 80, "5개 중 4개가 더 작음 → 80");
  });

  test("거래량 고갈 비율", () => {
    // 이전 4봉 볼륨 100, 최근 2봉 볼륨 50 → 0.5
    const c = candlesFromCloses([1, 1, 1, 1, 1, 1], { spread: 0, vol: (i) => (i < 4 ? 100 : 50) });
    const r = volDryRatio(c, 2, 4);
    assert(Math.abs(r - 0.5) < 1e-9, `고갈 비율 0.5 (실제 ${r})`);
  });
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `node tests/run.js`
Expected: FAIL — `Cannot find module ... early-detect.js`

- [ ] **Step 3: 최소 구현**

`js/core/early-detect.js` 를 새로 만든다:

```js
// core/early-detect.js — 조기 포착 모드 계산.
// 큰 상승 이전 흔적(변동성 압축 + 거래량 고갈 + 미결제약정 증가)을 4시간봉에서 판정한다.
// 모든 함수는 순수 함수이며 마감 캔들만 사용한다(미래 참조 없음).

// 최근 lookback 봉의 박스(고/저)와 그 안에서의 현재 위치.
export function boxRange(candles, lookback) {
  const n = candles.length;
  if (n < lookback) return null;
  const win = candles.slice(n - lookback);
  let boxHigh = -Infinity, boxLow = Infinity;
  for (const c of win) {
    if (c.high > boxHigh) boxHigh = c.high;
    if (c.low < boxLow) boxLow = c.low;
  }
  const mid = (boxHigh + boxLow) / 2;
  const span = boxHigh - boxLow;
  const price = candles[n - 1].close;
  return {
    boxHigh,
    boxLow,
    boxWidthPct: mid > 0 ? (span / mid) * 100 : 0,
    rangePos: span > 0 ? (price - boxLow) / span : 0,
  };
}

// 볼린저 폭 배열에서 "현재 폭이 최근 lookback 중 몇 %ile 로 좁은가".
// 0 에 가까울수록 압축. 현재보다 작은 값의 개수 비율.
export function squeezePercentile(widths, lookback) {
  const valid = widths.filter((w) => w != null);
  if (valid.length < lookback) return null;
  const win = valid.slice(valid.length - lookback);
  const cur = win[win.length - 1];
  let smaller = 0;
  for (const w of win) if (w < cur) smaller++;
  return (smaller / win.length) * 100;
}

// 최근 recentN 봉 평균 거래량 ÷ 그 이전 priorN 봉 평균 거래량. 낮을수록 고갈.
export function volDryRatio(candles, recentN, priorN) {
  const n = candles.length;
  if (n < recentN + priorN) return null;
  const recent = candles.slice(n - recentN);
  const prior = candles.slice(n - recentN - priorN, n - recentN);
  const avg = (arr) => arr.reduce((s, c) => s + c.volume, 0) / arr.length;
  const prev = avg(prior);
  if (!(prev > 0)) return null;
  return avg(recent) / prev;
}

export default { boxRange, squeezePercentile, volDryRatio };
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `node tests/run.js`
Expected: PASS — `[early] 박스 범위·폭·위치 계산`, `[early] 박스 — 캔들 부족하면 null`, `[early] 압축 백분위 — 현재가 가장 좁으면 0`, `[early] 압축 백분위 — 현재가 가장 넓으면 높음`, `[early] 거래량 고갈 비율` 전부 통과

- [ ] **Step 5: 커밋**

```bash
git add js/core/early-detect.js tests/early-detect.test.js
git commit -m "조기 포착 — 박스·압축 백분위·거래량 고갈 계산 추가"
```

---

### Task 3: 미결제약정(OI) 분석

**Files:**
- Modify: `js/core/early-detect.js`
- Modify: `tests/early-detect.test.js`

**Interfaces:**
- Consumes: Task 1 의 `getOpenInterestHist()` 반환 형식 `[{ time, oi }]`
- Produces: `analyzeOi(series) -> { change72h, change12h, prev12h }` (계산 불가 항목은 `null`)

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/early-detect.test.js` import 에 `analyzeOi` 추가:

```js
import { boxRange, squeezePercentile, volDryRatio, analyzeOi } from "../js/core/early-detect.js";
```

`run()` 안에 추가:

```js
  test("OI 변화율 — 증가", () => {
    // 73개: 0번 100, 이후 선형 증가해서 마지막 200 → 72h 변화 +100%
    const series = Array.from({ length: 73 }, (_, i) => ({ time: i, oi: 100 + (100 * i) / 72 }));
    const r = analyzeOi(series);
    assert(Math.abs(r.change72h - 100) < 1e-6, `72h +100% (실제 ${r.change72h})`);
    assert(r.change12h > 0, "12h 증가");
  });

  test("OI 변화율 — 가속 판정", () => {
    // 앞 구간은 완만, 최근 12h 가 급증
    const series = [];
    for (let i = 0; i <= 60; i++) series.push({ time: i, oi: 100 });
    for (let i = 61; i <= 72; i++) series.push({ time: i, oi: 100 + (i - 60) * 5 });
    const r = analyzeOi(series);
    assert(r.change12h > r.prev12h, `최근 12h 가 이전 12h 보다 큼 (${r.change12h} > ${r.prev12h})`);
  });

  test("OI 데이터 부족 → null", () => {
    const r = analyzeOi([{ time: 1, oi: 100 }]);
    eq(r.change72h, null, "72h 계산 불가");
    eq(r.change12h, null, "12h 계산 불가");
  });

  test("OI 빈 배열 → 전부 null", () => {
    const r = analyzeOi([]);
    eq(r.change72h, null);
    eq(r.prev12h, null);
  });
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `node tests/run.js`
Expected: FAIL — `analyzeOi is not a function`

- [ ] **Step 3: 구현 추가**

`js/core/early-detect.js` 의 `volDryRatio` 다음, `export default` 앞에 추가:

```js
// OI 시계열(1시간 간격, 과거→현재)에서 변화율 3종.
// change72h: 72시간 변화, change12h: 최근 12시간, prev12h: 그 이전 12시간(가속 비교용).
export function analyzeOi(series) {
  const pct = (from, to) => (from > 0 ? ((to - from) / from) * 100 : null);
  const n = Array.isArray(series) ? series.length : 0;
  const at = (backHours) => (n > backHours ? series[n - 1 - backHours].oi : null);
  const now = n > 0 ? series[n - 1].oi : null;
  const h72 = at(72), h12 = at(12), h24 = at(24);
  return {
    change72h: now != null && h72 != null ? pct(h72, now) : null,
    change12h: now != null && h12 != null ? pct(h12, now) : null,
    prev12h: h12 != null && h24 != null ? pct(h24, h12) : null,
  };
}
```

`export default` 줄을 갱신한다:

```js
export default { boxRange, squeezePercentile, volDryRatio, analyzeOi };
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `node tests/run.js`
Expected: PASS — `[early] OI 변화율 — 증가`, `[early] OI 변화율 — 가속 판정`, `[early] OI 데이터 부족 → null`, `[early] OI 빈 배열 → 전부 null` 통과

- [ ] **Step 5: 커밋**

```bash
git add js/core/early-detect.js tests/early-detect.test.js
git commit -m "조기 포착 — 미결제약정 변화율 분석 추가"
```

---

### Task 4: 3단계 분류 + 제외 판정

**Files:**
- Modify: `js/core/early-detect.js`
- Modify: `tests/early-detect.test.js`

**Interfaces:**
- Consumes: Task 2·3 의 계산값
- Produces:
  - `EarlyMetrics` 형태(객체 리터럴, 아래 키): `{ boxWidthPct, rangePos, boxHigh, boxLow, squeezePct, volDry, relVol3, oi: { change72h, change12h, prev12h }, funding, change24h, quoteVolume, closeAboveEma200, ema200SlopeOk, breakoutClose, atrRising, runFromBreakoutPct }`
  - `classifyEarlyStage(m, cfg) -> { stage, key, label, badge } | null`
  - `earlyExclusion(m, cfg) -> string | null` (제외 사유, 없으면 null)

- [ ] **Step 1: 실패하는 테스트 작성**

import 갱신:

```js
import {
  boxRange, squeezePercentile, volDryRatio, analyzeOi,
  classifyEarlyStage, earlyExclusion,
} from "../js/core/early-detect.js";
```

`run()` 안에 추가. 먼저 헬퍼를 파일 상단(`run()` 밖)에 둔다:

```js
// 1단계(매집) 조건을 모두 만족하는 기본 지표. 개별 테스트에서 필요한 값만 덮어쓴다.
function baseMetrics(over = {}) {
  return {
    boxWidthPct: 20, rangePos: 0.5, boxHigh: 120, boxLow: 100,
    squeezePct: 20, volDry: 0.7, relVol3: 0.9,
    oi: { change72h: 10, change12h: 3, prev12h: 2 },
    funding: 0.0001, change24h: 5, quoteVolume: 50_000_000,
    closeAboveEma200: true, ema200SlopeOk: true,
    breakoutClose: false, atrRising: false, runFromBreakoutPct: 0,
    ...over,
  };
}
```

테스트:

```js
  test("1단계 매집 판정", () => {
    const s = classifyEarlyStage(baseMetrics(), CONFIG);
    eq(s.stage, 1, "매집 단계");
    eq(s.key, "accumulation");
  });

  test("2단계 임박 — 압축 극단 + 상단 근접 + 거래량 회복 + OI 가속", () => {
    const s = classifyEarlyStage(baseMetrics({
      squeezePct: 10, rangePos: 0.97, relVol3: 1.2,
      oi: { change72h: 10, change12h: 6, prev12h: 2 },
    }), CONFIG);
    eq(s.stage, 2, "임박 단계");
    eq(s.key, "imminent");
  });

  test("3단계 돌파 — 상단 종가돌파 + 거래량 급증 + ATR 상승 + 초입", () => {
    const s = classifyEarlyStage(baseMetrics({
      breakoutClose: true, relVol3: 2.5, atrRising: true, runFromBreakoutPct: 5,
    }), CONFIG);
    eq(s.stage, 3, "돌파 단계");
    eq(s.key, "breakout");
  });

  test("돌파했지만 이미 많이 오름 → 단계 없음", () => {
    const s = classifyEarlyStage(baseMetrics({
      breakoutClose: true, relVol3: 2.5, atrRising: true, runFromBreakoutPct: 30,
    }), CONFIG);
    eq(s, null, "초입 아니면 제외");
  });

  test("박스 넓으면 단계 없음", () => {
    eq(classifyEarlyStage(baseMetrics({ boxWidthPct: 90 }), CONFIG), null);
  });

  test("OI 없어도(null) 1단계 통과 — 후보 유지", () => {
    const s = classifyEarlyStage(baseMetrics({
      oi: { change72h: null, change12h: null, prev12h: null },
    }), CONFIG);
    eq(s.stage, 1, "OI null 이면 OI 조건은 통과로 간주");
  });

  test("제외 — 이미 급등", () => {
    assert(earlyExclusion(baseMetrics({ change24h: 60 }), CONFIG) !== null, "24h +60% 제외");
  });

  test("제외 — OI 급감", () => {
    assert(earlyExclusion(baseMetrics({
      oi: { change72h: -20, change12h: -5, prev12h: -3 },
    }), CONFIG) !== null, "OI -20% 제외");
  });

  test("제외 — 펀딩 과열", () => {
    assert(earlyExclusion(baseMetrics({ funding: 0.005 }), CONFIG) !== null, "펀딩 0.5% 제외");
  });

  test("제외 — OI·펀딩 null 이면 해당 조건 건너뜀", () => {
    eq(earlyExclusion(baseMetrics({
      oi: { change72h: null, change12h: null, prev12h: null }, funding: null,
    }), CONFIG), null, "null 이면 제외하지 않음");
  });
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `node tests/run.js`
Expected: FAIL — `classifyEarlyStage is not a function`

- [ ] **Step 3: 구현 추가**

`js/core/early-detect.js` 의 `analyzeOi` 다음에 추가:

```js
// 제외 사유. 없으면 null. OI·펀딩이 null 이면 해당 조건은 건너뛴다.
export function earlyExclusion(m, cfg) {
  const e = cfg.earlyDetect;
  if (m.change24h != null && m.change24h > e.pumpedMaxPct) return "이미 급등";
  if (m.oi.change72h != null && m.oi.change72h <= e.oiDumpPct) return "미결제약정 급감";
  if (m.funding != null && Math.abs(m.funding) > e.fundingMaxAbs) return "펀딩 과열";
  return null;
}

// 3단계 분류. 위 단계부터 판정하고, 어디에도 안 걸리면 null(결과에서 제외).
export function classifyEarlyStage(m, cfg) {
  const e = cfg.earlyDetect;

  // 3단계 돌파 — 박스 상단을 종가로 뚫고, 거래량 급증 + 변동성 확장. 단 아직 초입일 때만.
  if (m.breakoutClose && m.relVol3 >= e.breakoutRelVol && m.atrRising) {
    return m.runFromBreakoutPct <= e.breakoutMaxRunPct
      ? stage(3, "breakout", "3 돌파", "purple")
      : null; // 이미 많이 감 → 추격 방지
  }

  // 1단계 조건(매집)을 먼저 확인. OI 데이터가 없으면 OI 조건은 통과로 간주한다.
  const oiOk = m.oi.change72h == null || m.oi.change72h >= e.oiChangeMinPct;
  const trendOk = m.closeAboveEma200 || m.ema200SlopeOk;
  const accumulation =
    m.boxWidthPct <= e.boxWidthMaxPct &&
    m.squeezePct != null && m.squeezePct <= e.squeezePctMax &&
    m.volDry != null && m.volDry <= e.volDryMax &&
    oiOk && trendOk;
  if (!accumulation) return null;

  // 2단계 임박 — 압축 극단 + 박스 상단 근접 + 거래량 회복 + OI 가속
  const oiAccel = m.oi.change12h != null && m.oi.prev12h != null && m.oi.change12h > m.oi.prev12h;
  if (
    m.squeezePct <= e.squeezePctTight &&
    m.rangePos >= e.rangePosMin &&
    m.relVol3 >= e.relVolMin &&
    oiAccel
  ) {
    return stage(2, "imminent", "2 임박", "yellow");
  }

  return stage(1, "accumulation", "1 매집", "blue");
}

function stage(n, key, label, badge) {
  return { stage: n, key, label, badge };
}
```

`export default` 갱신:

```js
export default { boxRange, squeezePercentile, volDryRatio, analyzeOi, classifyEarlyStage, earlyExclusion };
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `node tests/run.js`
Expected: PASS — 위에서 추가한 10개 테스트 전부 통과

- [ ] **Step 5: 커밋**

```bash
git add js/core/early-detect.js tests/early-detect.test.js
git commit -m "조기 포착 — 매집/임박/돌파 3단계 분류 + 제외 판정 추가"
```

---

### Task 5: 채점 + 진입 계획(plan)

**Files:**
- Modify: `js/core/early-detect.js`
- Modify: `tests/early-detect.test.js`

**Interfaces:**
- Consumes: Task 4 의 `EarlyMetrics`, `CONFIG.earlyScoreWeights`, `CONFIG.earlyPenalties`
- Produces:
  - `scoreEarly(m, cfg) -> { score, breakdown, penalties }`
    - `breakdown`: `[{ key, label, weight, got, hit }]` (기존 `scoring.js` 와 동일 형식 — `topSignals()` 재사용 가능)
    - `penalties`: `[{ key, label, val }]`
  - `earlyPlan(m, atrVal) -> { entry, stop, tp1, tp2, tp3, invalidation, riskReward, rrText, valid }`

- [ ] **Step 1: 실패하는 테스트 작성**

import 갱신:

```js
import {
  boxRange, squeezePercentile, volDryRatio, analyzeOi,
  classifyEarlyStage, earlyExclusion, scoreEarly, earlyPlan,
} from "../js/core/early-detect.js";
```

테스트 추가:

```js
  test("채점 — 조건 좋을수록 점수 높음(단조성)", () => {
    const weak = scoreEarly(baseMetrics({ squeezePct: 45, oi: { change72h: 1, change12h: 0, prev12h: 0 }, volDry: 0.95, rangePos: 0.1 }), CONFIG).score;
    const strong = scoreEarly(baseMetrics({ squeezePct: 2, oi: { change72h: 30, change12h: 10, prev12h: 3 }, volDry: 0.2, rangePos: 0.98 }), CONFIG).score;
    assert(strong > weak, `강한 조건이 더 높아야 (${strong} > ${weak})`);
  });

  test("채점 — 최고 조건은 만점 근처", () => {
    const r = scoreEarly(baseMetrics({
      squeezePct: 0, oi: { change72h: 30, change12h: 10, prev12h: 3 },
      volDry: 0, rangePos: 1, closeAboveEma200: true,
    }), CONFIG);
    eq(r.score, 100, "모든 항목 만점");
  });

  test("채점 — OI 없으면 해당 항목 0점, 나머지는 살아있음", () => {
    const r = scoreEarly(baseMetrics({ oi: { change72h: null, change12h: null, prev12h: null } }), CONFIG);
    const oiItem = r.breakdown.find((b) => b.key === "oiBuildUp");
    eq(oiItem.got, 0, "OI 항목 0점");
    assert(r.score > 0, "다른 항목 점수는 남음");
  });

  test("채점 — 감점 반영", () => {
    const base = scoreEarly(baseMetrics(), CONFIG).score;
    const penalized = scoreEarly(baseMetrics({ change24h: 30, quoteVolume: 1_000_000 }), CONFIG).score;
    assert(penalized < base, `감점 후 하락 (${penalized} < ${base})`);
  });

  test("plan — 손절은 진입 아래, 손익비 유한", () => {
    const p = earlyPlan(baseMetrics({ boxHigh: 120, boxLow: 100 }), 2, 110);
    assert(p.stop < p.entry, "손절 < 진입");
    assert(isFinite(p.riskReward) && p.riskReward > 0, `손익비 유한 (${p.riskReward})`);
    assert(p.tp2 > p.tp1, "TP2 > TP1");
  });

  test("plan — 박스 하단이 진입 위여도 손절은 진입 아래로 clamp", () => {
    // 비정상 입력(박스 하단 > 현재가)에서도 손절이 진입 위로 가지 않아야 한다
    const p = earlyPlan(baseMetrics({ boxHigh: 120, boxLow: 150 }), 2, 110);
    assert(p.stop < p.entry, `손절 clamp (stop ${p.stop} < entry ${p.entry})`);
    assert(isFinite(p.riskReward), "손익비 유한");
  });
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `node tests/run.js`
Expected: FAIL — `scoreEarly is not a function`

- [ ] **Step 3: 구현 추가**

`js/core/early-detect.js` 의 `stage()` 헬퍼 다음에 추가:

```js
// ---- 채점 ----
// 기존 scoring.js 의 breakdown/penalties 형식을 그대로 따른다(topSignals 재사용 가능).
export function scoreEarly(m, cfg) {
  const w = cfg.earlyScoreWeights;
  const p = cfg.earlyPenalties;
  const clamp01 = (x) => Math.max(0, Math.min(1, x));

  // 압축: 백분위 0 → 만점, 50 이상 → 0점
  const squeezeGot = m.squeezePct == null ? 0 : w.squeeze * (1 - Math.min(m.squeezePct, 50) / 50);
  // OI: +30% 이상이면 만점. 데이터 없으면 0점.
  const oiGot = m.oi.change72h == null ? 0 : w.oiBuildUp * (Math.min(Math.max(m.oi.change72h, 0), 30) / 30);
  // 거래량 고갈: 낮을수록 높은 점수
  const volGot = m.volDry == null ? 0 : w.volumeProfile * (1 - Math.min(m.volDry, 1));
  // 박스 상단 근접
  const rangeGot = w.rangePosition * clamp01(m.rangePos);
  // 장기선 회복
  const trendGot = m.closeAboveEma200 ? w.trendReclaim : m.ema200SlopeOk ? w.trendReclaim * 0.5 : 0;

  const breakdown = [
    mkItem("squeeze", "변동성 압축", w.squeeze, squeezeGot),
    mkItem("oiBuildUp", "미결제약정 증가", w.oiBuildUp, oiGot),
    mkItem("volumeProfile", "거래량 고갈", w.volumeProfile, volGot),
    mkItem("rangePosition", "박스 상단 근접", w.rangePosition, rangeGot),
    mkItem("trendReclaim", "장기선 회복", w.trendReclaim, trendGot),
  ];

  let score = breakdown.reduce((s, b) => s + b.got, 0);

  const penalties = [];
  const pen = (cond, val, key, label) => {
    if (cond) { score += val; penalties.push({ key, label, val }); }
  };
  const e = cfg.earlyDetect;
  pen(m.change24h != null && m.change24h >= 25 && m.change24h <= e.pumpedMaxPct,
    p.alreadyPumped, "alreadyPumped", "이미 상당폭 상승");
  pen(m.oi.change72h != null && m.oi.change72h < 0, p.oiDump, "oiDump", "미결제약정 감소");
  pen(m.funding != null && Math.abs(m.funding) > e.fundingMaxAbs / 2,
    p.fundingOverheated, "fundingOverheated", "펀딩 쏠림");
  pen(m.quoteVolume != null && m.quoteVolume < 10_000_000, p.thinLiquidity, "thinLiquidity", "거래대금 부족");

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, breakdown, penalties };
}

function mkItem(key, label, weight, got) {
  const g = Math.round(got * 100) / 100;
  return { key, label, weight, got: g, hit: g > 0 };
}

// ---- 진입 계획 ----
// 박스 기반. 기존 plan 필드명을 그대로 채워 UI/상세패널이 수정 없이 동작하게 한다.
// 손절은 반드시 진입 아래로 clamp (risk-reward.js 의 RR 폭발 버그와 동일한 방어).
export function earlyPlan(m, atrVal, price) {
  const entry = price;
  const span = Math.max(m.boxHigh - m.boxLow, 1e-9);
  const buffer = (atrVal || 0) * 0.5;
  const stop = Math.min(m.boxLow, entry) - buffer;
  const tp1 = m.boxHigh + span * 1.0;
  const tp2 = m.boxHigh + span * 1.5;
  const tp3 = m.boxHigh + span * 2.0;
  const risk = Math.max(entry - stop, 1e-9);
  const reward = Math.max(tp2 - entry, 0);
  const rr = reward / risk;
  return {
    entry, stop, tp1, tp2, tp3,
    invalidation: stop,
    riskReward: rr,
    rrText: `1:${rr.toFixed(2)}`,
    valid: rr > 0 && entry > stop,
  };
}
```

`export default` 갱신:

```js
export default {
  boxRange, squeezePercentile, volDryRatio, analyzeOi,
  classifyEarlyStage, earlyExclusion, scoreEarly, earlyPlan,
};
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `node tests/run.js`
Expected: PASS — 채점 4개 + plan 2개 테스트 통과

- [ ] **Step 5: 커밋**

```bash
git add js/core/early-detect.js tests/early-detect.test.js
git commit -m "조기 포착 — 5항목 채점 + 박스 기반 진입 계획 추가"
```

---

### Task 6: 지표 조립(buildEarlyMetrics) + 결과 조립 + 리페인트 검증

**Files:**
- Modify: `js/core/early-detect.js`
- Modify: `tests/early-detect.test.js`

**Interfaces:**
- Consumes: Task 2~5 전부, 기존 `bollinger`, `atr`, `ema`, `last` (`js/core/indicators.js`), `relativeVolume` (`js/core/volume-analysis.js`), `gradeFor` + `topSignals` (`js/core/scoring.js`)
- Produces:
  - `buildEarlyMetrics(c4, oiSeries, funding, ticker, cfg) -> EarlyMetrics | null`
    - `c4`: 4시간봉 마감 캔들 배열
    - `ticker`: `{ change24h, quoteVolume }`
  - `buildEarlyResult(item, c4, oiSeries, funding, cfg) -> 결과객체 | null`
    - 결과는 기존 `deepAnalyze` 와 동일 shape (스펙 "결과 객체 호환" 절)

- [ ] **Step 1: 실패하는 테스트 작성**

import 갱신:

```js
import {
  boxRange, squeezePercentile, volDryRatio, analyzeOi,
  classifyEarlyStage, earlyExclusion, scoreEarly, earlyPlan,
  buildEarlyMetrics, buildEarlyResult,
} from "../js/core/early-detect.js";
```

테스트 추가:

```js
  test("지표 조립 — 캔들 부족하면 null", () => {
    const c = candlesFromCloses([1, 2, 3], { spread: 0 });
    eq(buildEarlyMetrics(c, [], null, { change24h: 0, quoteVolume: 1e7 }, CONFIG), null);
  });

  test("지표 조립 — 좁은 횡보에서 압축·고갈 지표가 나온다", () => {
    // 200봉 좁은 횡보 + 최근 거래량 감소
    // 진폭이 점점 줄어드는 횡보 → 최근 볼린저 폭이 가장 좁아 압축 백분위가 낮게 나온다
    const closes = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 5) * (5 * (1 - i / 200)));
    const c = candlesFromCloses(closes, { spread: 0.05, vol: (i) => (i < 140 ? 100 : 50) });
    const m = buildEarlyMetrics(c, [], null, { change24h: 2, quoteVolume: 5e7 }, CONFIG);
    assert(m !== null, "지표 생성됨");
    assert(m.boxWidthPct < 25, `박스 좁음 (${m.boxWidthPct})`);
    assert(m.volDry != null && m.volDry < 1, `거래량 고갈 (${m.volDry})`);
    assert(m.squeezePct != null, "압축 백분위 계산됨");
  });

  test("결과 조립 — 기존 결과 shape 을 채운다", () => {
    // 진폭이 점점 줄어드는 횡보 → 최근 볼린저 폭이 가장 좁아 압축 백분위가 낮게 나온다
    const closes = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 5) * (5 * (1 - i / 200)));
    const c = candlesFromCloses(closes, { spread: 0.05, vol: (i) => (i < 140 ? 100 : 50) });
    const item = { symbol: "TESTUSDT", baseAsset: "TEST", quoteVolume: 5e7, change24h: 2, newListing: false };
    const r = buildEarlyResult(item, c, [], null, CONFIG);
    if (r) {
      for (const k of ["symbol", "price", "score", "grade", "stage", "breakdown", "penalties", "topSignals", "plan", "direction"]) {
        assert(r[k] !== undefined, `결과에 ${k} 필요`);
      }
      eq(r.direction, "long", "early 는 롱 전용");
      assert(r.stage.stage >= 1 && r.stage.stage <= 3, "단계는 1~3");
    }
  });

  test("리페인트 — 박스는 과거 값이 미래 캔들로 바뀌지 않음", () => {
    const closes = Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 7) * 2);
    const full = candlesFromCloses(closes, { spread: 0.3 });
    for (const cut of [70, 90, 110]) {
      const prefix = full.slice(0, cut);
      const a = boxRange(prefix, 60);
      const b = boxRange(full.slice(0, cut), 60);
      eq(JSON.stringify(a), JSON.stringify(b), `prefix==full at ${cut}`);
    }
  });
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `node tests/run.js`
Expected: FAIL — `buildEarlyMetrics is not a function`

- [ ] **Step 3: 구현 추가**

`js/core/early-detect.js` 상단 import 를 추가한다(파일 최상단 주석 아래):

```js
import { bollinger, atr, ema, last } from "./indicators.js";
import { relativeVolume } from "./volume-analysis.js";
import { gradeFor, topSignals } from "./scoring.js";
```

그리고 `earlyPlan` 다음에 추가:

```js
// ---- 지표 조립 ----
// c4: 4시간봉 마감 캔들. oiSeries: [{time,oi}] (없으면 빈 배열). funding: number|null.
// ticker: { change24h, quoteVolume }
export function buildEarlyMetrics(c4, oiSeries, funding, ticker, cfg) {
  const e = cfg.earlyDetect;
  const box = boxRange(c4, e.boxLookback);
  if (!box) return null;

  const closes = c4.map((c) => c.close);
  const widths = bollinger(closes, cfg.indicators.bb.period, cfg.indicators.bb.mult).width;
  const squeezePct = squeezePercentile(widths, e.squeezeLookback);
  const volDry = volDryRatio(c4, e.volRecentN, e.volPriorN);
  const oi = analyzeOi(oiSeries || []);

  const relVolArr = relativeVolume(c4, 20);
  const recentRel = relVolArr.slice(-3).filter((x) => x != null);
  const relVol3 = recentRel.length ? recentRel.reduce((a, b) => a + b, 0) / recentRel.length : 0;

  const ema200 = ema(closes, 200);
  const price = closes[closes.length - 1];
  const ema200Now = last(ema200);
  const ema200Idx = ema200.length - 1;
  const ema200Prev = ema200Idx - 20 >= 0 ? ema200[ema200Idx - 20] : null;
  const closeAboveEma200 = ema200Now != null && price > ema200Now;
  const ema200SlopeOk = ema200Now != null && ema200Prev != null && ema200Now >= ema200Prev;

  // 돌파 판정: 직전 봉까지의 박스 상단을 현재 종가가 넘었는가
  const prevBox = boxRange(c4.slice(0, -1), e.boxLookback);
  const breakoutLevel = prevBox ? prevBox.boxHigh : box.boxHigh;
  const breakoutClose = price > breakoutLevel;
  const runFromBreakoutPct = breakoutLevel > 0 ? ((price - breakoutLevel) / breakoutLevel) * 100 : 0;

  const atrArr = atr(c4, cfg.indicators.atrPeriod);
  const atrNow = last(atrArr);
  const atrIdx = atrArr.length - 1;
  const atrPrev = atrIdx - 5 >= 0 ? atrArr[atrIdx - 5] : null;
  const atrRising = atrNow != null && atrPrev != null && atrNow > atrPrev;

  return {
    boxHigh: box.boxHigh, boxLow: box.boxLow,
    boxWidthPct: box.boxWidthPct, rangePos: box.rangePos,
    squeezePct, volDry, relVol3, oi,
    funding: funding == null ? null : funding,
    change24h: ticker?.change24h ?? null,
    quoteVolume: ticker?.quoteVolume ?? null,
    closeAboveEma200, ema200SlopeOk,
    breakoutClose, atrRising, runFromBreakoutPct,
    price, atrVal: atrNow,
  };
}

// ---- 결과 조립 ----
// 기존 deepAnalyze 와 동일한 shape 을 반환한다(스펙 "결과 객체 호환").
// 단계에 안 걸리거나 제외 사유가 있으면 null.
export function buildEarlyResult(item, c4, oiSeries, funding, cfg) {
  const m = buildEarlyMetrics(c4, oiSeries, funding, item, cfg);
  if (!m) return null;
  if (earlyExclusion(m, cfg)) return null;
  const stageInfo = classifyEarlyStage(m, cfg);
  if (!stageInfo) return null;

  const scored = scoreEarly(m, cfg);
  const plan = earlyPlan(m, m.atrVal, m.price);

  return {
    symbol: item.symbol,
    baseAsset: item.baseAsset,
    price: m.price,
    change6h: 0,
    change24h: m.change24h ?? 0,
    quoteVolume: item.quoteVolume,
    newListing: item.newListing,
    direction: "long",
    score: scored.score,
    grade: gradeFor(scored.score, cfg),
    stage: stageInfo,
    absorption: { level: "insufficient", label: "조기 포착 모드 — 미적용", score: 0 },
    breakdown: scored.breakdown,
    penalties: scored.penalties,
    topSignals: topSignals(scored.breakdown, 3),
    goldenCrossRetest: { detected: false, reason: "조기 포착 모드" },
    near1hEma200: false,
    noise: { noisy: false, ci: null, relVol: m.relVol3, reasons: [] },
    early: { squeezePct: m.squeezePct, volDry: m.volDry, oi: m.oi, funding: m.funding, boxHigh: m.boxHigh, boxLow: m.boxLow },
    plan,
    rsi1h: null,
    timeframes: {},
  };
}
```

`export default` 갱신:

```js
export default {
  boxRange, squeezePercentile, volDryRatio, analyzeOi,
  classifyEarlyStage, earlyExclusion, scoreEarly, earlyPlan,
  buildEarlyMetrics, buildEarlyResult,
};
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `node tests/run.js`
Expected: PASS — 지표 조립 2개, 결과 조립 1개, 리페인트 1개 통과

- [ ] **Step 5: 커밋**

```bash
git add js/core/early-detect.js tests/early-detect.test.js
git commit -m "조기 포착 — 지표/결과 조립 + 리페인트 검증 추가"
```

---

### Task 7: prefilter — 유니버스 파라미터화 + early 1차 선별

**Files:**
- Modify: `js/scanner/prefilter.js`
- Modify: `tests/early-detect.test.js`

**Interfaces:**
- Consumes: `CONFIG.earlyDetect` (Task 1)
- Produces:
  - `stage2Liquidity(universe, tickers, nowMs, pfOverride) -> { prefiltered, newListings }` — 4번째 인자 추가(기존 호출부는 그대로 동작)
  - `excludeMajors(list, majors) -> Array` — baseAsset 기준 대형코인 제거
  - `stage3EvaluateEarly(item, k4h, cfg) -> { pass, reason, boxWidthPct, squeezePct, volDry }`

- [ ] **Step 1: 실패하는 테스트 작성**

import 추가:

```js
import { stage2Liquidity, excludeMajors, stage3EvaluateEarly } from "../js/scanner/prefilter.js";
```

테스트 추가:

```js
  test("stage2 — pfOverride 로 유니버스 기준 교체", () => {
    const universe = [
      { symbol: "AUSDT", baseAsset: "A", onboardDate: 0 },
      { symbol: "BUSDT", baseAsset: "B", onboardDate: 0 },
    ];
    const mkTick = (symbol, qv) => ({
      symbol, quoteVolume: String(qv), count: "999999", lastPrice: "1",
      priceChangePercent: "1", highPrice: "1", lowPrice: "1", weightedAvgPrice: "1",
    });
    const tickers = [mkTick("AUSDT", 8_000_000), mkTick("BUSDT", 30_000_000)];
    // 기본(20M)이면 B 만 통과
    const def = stage2Liquidity(universe, tickers, Date.now());
    eq(def.prefiltered.length, 1, "기본 기준으로는 1개");
    // early(5M)면 둘 다 통과
    const early = stage2Liquidity(universe, tickers, Date.now(), {
      ...CONFIG.prefilter,
      minQuoteVolume: CONFIG.earlyDetect.minQuoteVolume,
      topByVolume: CONFIG.earlyDetect.topByVolume,
    });
    eq(early.prefiltered.length, 2, "early 기준으로는 2개");
  });

  test("대형코인 제외", () => {
    const list = [{ baseAsset: "BTC" }, { baseAsset: "PEPE" }, { baseAsset: "ETH" }];
    const out = excludeMajors(list, ["BTC", "ETH"]);
    eq(out.length, 1, "1개만 남음");
    eq(out[0].baseAsset, "PEPE");
  });

  test("early 1차 선별 — 좁은 횡보는 통과", () => {
    // 진폭이 점점 줄어드는 횡보 → 최근 볼린저 폭이 가장 좁아 압축 백분위가 낮게 나온다
    const closes = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 5) * (5 * (1 - i / 200)));
    const c = candlesFromCloses(closes, { spread: 0.05, vol: (i) => (i < 140 ? 100 : 50) });
    const r = stage3EvaluateEarly({ symbol: "XUSDT" }, c, CONFIG);
    eq(r.pass, true, `통과해야 함 (사유: ${r.reason})`);
  });

  test("early 1차 선별 — 넓게 출렁이면 탈락", () => {
    const closes = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 5) * 40);
    const c = candlesFromCloses(closes, { spread: 1 });
    const r = stage3EvaluateEarly({ symbol: "YUSDT" }, c, CONFIG);
    eq(r.pass, false, "박스가 넓으면 탈락");
  });

  test("early 1차 선별 — 캔들 부족하면 탈락", () => {
    const c = candlesFromCloses([1, 2, 3], { spread: 0 });
    eq(stage3EvaluateEarly({ symbol: "ZUSDT" }, c, CONFIG).pass, false);
  });
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `node tests/run.js`
Expected: FAIL — `excludeMajors is not a function`

- [ ] **Step 3: prefilter 수정**

`js/scanner/prefilter.js` 상단 import 에 추가:

```js
import { boxRange, squeezePercentile, volDryRatio } from "../core/early-detect.js";
import { bollinger } from "../core/indicators.js";
```

`stage2Liquidity` 시그니처와 첫 줄을 바꾼다:

```js
export function stage2Liquidity(universe, tickers, nowMs, pfOverride) {
  const tickMap = new Map(tickers.map((t) => [t.symbol, t]));
  const pf = pfOverride || CONFIG.prefilter;
```

(나머지 본문은 그대로 둔다. `pf` 를 쓰는 부분이 자동으로 오버라이드를 따른다.)

파일 하단 `capCandidates` 다음에 추가:

```js
// 대형코인 제외 (조기 포착 모드 — 큰 상승이 드묾)
export function excludeMajors(list, majors) {
  if (!majors || !majors.length) return list;
  const set = new Set(majors);
  return list.filter((x) => !set.has(x.baseAsset));
}

// ---- early 1차 선별 ----
// 4시간봉으로 "좁은 박스 + 압축 + 거래량 고갈" 을 빠르게 확인해 정밀 분석 후보를 줄인다.
// OI 호출 전에 걸러내는 것이 목적이므로 여기서는 OI 를 보지 않는다.
export function stage3EvaluateEarly(item, k4h, cfg) {
  const e = cfg.earlyDetect;
  const box = boxRange(k4h, e.boxLookback);
  if (!box) return { pass: false, reason: "데이터 부족" };

  const closes = k4h.map((c) => c.close);
  const widths = bollinger(closes, cfg.indicators.bb.period, cfg.indicators.bb.mult).width;
  const squeezePct = squeezePercentile(widths, e.squeezeLookback);
  const volDry = volDryRatio(k4h, e.volRecentN, e.volPriorN);

  const boxOk = box.boxWidthPct <= e.boxWidthMaxPct;
  // 압축·고갈은 계산 불가(데이터 부족)면 통과시키고 정밀 단계에서 다시 본다.
  const squeezeOk = squeezePct == null || squeezePct <= e.squeezePctMax;
  const volOk = volDry == null || volDry <= e.volDryMax;
  const pass = boxOk && squeezeOk && volOk;

  return {
    pass,
    reason: pass ? "후보" : !boxOk ? "박스 넓음" : !squeezeOk ? "압축 부족" : "거래량 고갈 아님",
    boxWidthPct: box.boxWidthPct,
    squeezePct,
    volDry,
  };
}
```

파일 맨 아래 `export default` 를 갱신한다:

```js
export default {
  stage1Universe, isNewListing, stage2Liquidity, stage3Evaluate, capCandidates,
  excludeMajors, stage3EvaluateEarly,
};
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `node tests/run.js`
Expected: PASS — prefilter 5개 테스트 통과. 기존 테스트도 전부 그대로 통과(=`stage2Liquidity` 기존 호출부 회귀 없음)

- [ ] **Step 5: 커밋**

```bash
git add js/scanner/prefilter.js tests/early-detect.test.js
git commit -m "조기 포착 — 유니버스 파라미터화 + 4시간봉 1차 선별 추가"
```

---

### Task 8: scan-controller 모드 분기

**Files:**
- Modify: `js/scanner/scan-controller.js`

**Interfaces:**
- Consumes: Task 1 API 함수, Task 6 `buildEarlyResult`, Task 7 `excludeMajors`·`stage3EvaluateEarly`·`stage2Liquidity(…, pfOverride)`
- Produces: `runScan()` 이 `state.settings.scanMode === "early"` 일 때 early 파이프라인을 실행하고 `state.results` 에 기존 shape 결과를 채운다.

- [ ] **Step 1: import 추가**

`js/scanner/scan-controller.js` 상단 import 를 갱신한다:

```js
import { getExchangeInfo, getTicker24h, getKlines, getOpenInterestHist, getPremiumIndexAll } from "../api/binance.js";
import { stage1Universe, stage2Liquidity, stage3Evaluate, capCandidates, excludeMajors, stage3EvaluateEarly } from "./prefilter.js";
import { deepAnalyze } from "./deep-scanner.js";
import { buildEarlyResult } from "../core/early-detect.js";
```

- [ ] **Step 2: early 파이프라인 함수 추가**

`runScan` 함수 **앞에** 추가한다:

```js
// ---- 조기 포착 모드 파이프라인 ----
// 반환: 기존과 동일 shape 결과 배열 (rank 는 호출부에서 부여)
async function runEarlyPipeline(universe, now) {
  const e = CONFIG.earlyDetect;

  // 2단계: early 유니버스 기준으로 유동성 필터
  setPhase("prefilter");
  const tickers = await getTicker24h();
  state.tickers = tickers;
  const { prefiltered, newListings } = stage2Liquidity(universe, tickers, now, {
    ...CONFIG.prefilter,
    minQuoteVolume: e.minQuoteVolume,
    topByVolume: e.topByVolume,
  });
  const midCaps = excludeMajors(prefiltered, e.excludeMajors);
  state.prefiltered = midCaps;
  state.newListings = newListings;
  emit("scan:prefiltered", { count: midCaps.length, newListings });
  if (abortToken.aborted) return null;

  // 펀딩비는 스캔당 1회 (전 종목)
  const fundingMap = await getPremiumIndexAll();

  // 3단계: 4시간봉으로 1차 선별
  setPhase("candidate");
  const evaluated = await mapWithProgress(midCaps, async (item) => {
    const k4h = await getKlines(item.symbol, "4h");
    const closed = k4h.slice(0, state.settings.includeRealtimeCandle ? k4h.length : -1);
    return { item, k4h: closed, res: stage3EvaluateEarly(item, closed, CONFIG) };
  });
  let candidates = evaluated
    .filter((x) => x.res.pass)
    .sort((a, b) => (a.res.squeezePct ?? 100) - (b.res.squeezePct ?? 100)) // 압축 강한 순
    .slice(0, e.keepMax);
  state.candidates = candidates.map((x) => x.item);
  emit("scan:candidates", { count: candidates.length });
  if (abortToken.aborted) return null;

  // 4단계: 후보만 OI 조회 후 정밀 판정
  setPhase("deep");
  const analyzed = await mapWithProgress(candidates, async ({ item, k4h }) => {
    const oiSeries = await getOpenInterestHist(item.symbol, e.oiPeriod, e.oiLimit);
    const funding = fundingMap.get(item.symbol) ?? null;
    return buildEarlyResult(item, k4h, oiSeries, funding, CONFIG);
  });
  return analyzed.filter(Boolean);
}
```

- [ ] **Step 3: runScan 에 분기 삽입**

`runScan` 안에서 1단계(universe) 수집 직후, 기존 2단계 블록을 감싸도록 분기를 넣는다. 아래 부분을

```js
    // --- 2단계: 24h 유동성 필터 ---
    setPhase("prefilter");
```

이렇게 바꾼다:

```js
    // --- 조기 포착 모드면 별도 파이프라인 ---
    if (state.settings.scanMode === "early") {
      const earlyResults = await runEarlyPipeline(universe, now);
      if (earlyResults === null) return finishAborted();
      setPhase("score");
      const results = earlyResults
        .filter((r) => r.score >= state.settings.minScore)
        .sort((a, b) => b.score - a.score)
        .map((r, i) => ({ ...r, rank: i + 1 }));
      state.results = results;
      setPhase("done");
      state.scan.running = false;
      state.scan.lastUpdated = Date.now();
      emit("scan:done", { count: results.length, analyzed: earlyResults.length });
      return results;
    }

    // --- 2단계: 24h 유동성 필터 ---
    setPhase("prefilter");
```

- [ ] **Step 4: 기존 테스트 회귀 확인**

Run: `node tests/run.js`
Expected: PASS — 전부 통과(early 파이프라인은 네트워크가 필요해 단위 테스트 대상이 아니며, 기존 스위트가 깨지지 않는 것이 이 단계의 검증 기준)

- [ ] **Step 5: 문법 오류 확인**

Run: `node --input-type=module -e "import('./js/scanner/scan-controller.js').then(()=>console.log('OK')).catch(e=>{console.error(e.message);process.exit(1)})"`
Expected: `OK` 출력 (모듈이 파싱·로드됨)

- [ ] **Step 6: 커밋**

```bash
git add js/scanner/scan-controller.js
git commit -m "조기 포착 — 스캔 모드 분기 및 early 파이프라인 연결"
```

---

### Task 9: UI — 모드 선택 + 필터 우회

**Files:**
- Modify: `index.html`
- Modify: `js/ui/settings.js`

**Interfaces:**
- Consumes: `state.settings.scanMode` (Task 1)
- Produces: 사용자가 모드를 고를 수 있고, early 모드에서 방향/노이즈 필터가 결과를 지우지 않는다.

- [ ] **Step 1: 필터 우회 로직 수정**

`js/ui/settings.js` 의 `applyFilters` 시작 부분을 바꾼다. 기존:

```js
export function applyFilters(results) {
  const s = state.settings;
  let list = results.slice();

  // 방향
  if (s.direction !== "both") list = list.filter((r) => r.direction === s.direction);
```

변경 후:

```js
export function applyFilters(results) {
  const s = state.settings;
  const early = s.scanMode === "early";
  let list = results.slice();

  // 방향 — early 모드는 롱 전용이라 방향 필터를 건너뛴다(안 그러면 결과가 전부 사라짐)
  if (!early && s.direction !== "both") list = list.filter((r) => r.direction === s.direction);
```

그리고 노이즈 필터 줄을 바꾼다. 기존:

```js
  // 노이즈(촙 구간·저거래량) 제외
  if (s.filterNoise) list = list.filter((r) => !r.noise?.noisy);
```

변경 후:

```js
  // 노이즈(촙 구간·저거래량) 제외
  // early 모드의 매집 구간은 정의상 횡보(=촙)라 이 필터를 적용하면 후보가 전멸한다.
  if (!early && s.filterNoise) list = list.filter((r) => !r.noise?.noisy);
```

- [ ] **Step 2: 모드 select 바인딩 + 단계 라벨 전환**

`js/ui/settings.js` 의 `initSettingsUI()` 안, `bindSelect("filter-direction", "direction");` 위에 추가:

```js
  bindSelect("filter-scanmode", "scanMode");
```

그리고 같은 파일의 `syncControls()` 안 `setVal("filter-direction", s.direction);` 위에 추가:

```js
  setVal("filter-scanmode", s.scanMode);
  syncStageLabels(s.scanMode);
```

`syncControls` 함수 **뒤**에 헬퍼를 추가한다:

```js
// 단계 필터의 선택지 문구를 모드에 맞게 바꾼다(값은 그대로 1~5).
const STAGE_LABELS = {
  reversal: ["전체", "1 매집", "2 유동성 회수", "3 구조전환", "4 진입 구간", "5 추격 금지"],
  early: ["전체", "1 매집", "2 임박", "3 돌파", "—", "—"],
};
function syncStageLabels(mode) {
  const el = document.getElementById("filter-stage");
  if (!el) return;
  const labels = STAGE_LABELS[mode] || STAGE_LABELS.reversal;
  for (let i = 0; i < el.options.length && i < labels.length; i++) {
    el.options[i].textContent = labels[i];
  }
}
```

- [ ] **Step 3: index.html 에 모드 select 추가**

`index.html` 의 필터 그리드에서 `<label>방향` 블록 **바로 앞**에 추가:

```html
            <label>스캔 모드
              <select id="filter-scanmode">
                <option value="reversal">급락 반등 (기본)</option>
                <option value="early">조기 포착 (오르기 전)</option>
              </select>
            </label>
```

- [ ] **Step 4: 설정 탭에 설명 추가**

`index.html` 의 설정 탭 `<section class="card settings-group">` 중 "채점 강도" 섹션 **앞**에 새 섹션을 추가:

```html
        <section class="card settings-group">
          <div class="card-head"><h2>스캔 모드</h2></div>
          <div class="set-row">
            <div class="set-control">
              <label for="filter-scanmode-info">현재 모드</label>
              <span id="filter-scanmode-info" class="tagline">위 필터 바의 "스캔 모드"에서 변경</span>
            </div>
            <p class="set-help"><b>급락 반등</b>은 크게 떨어진 코인이 되돌아오는 자리를 찾습니다. <b>조기 포착</b>은 반대로, 아직 조용히 바닥에서 <b>변동성이 눌려 있고 거래량이 마른</b> 상태에서 미결제약정이 늘고 있는 코인을 찾아 <b>매집 → 임박 → 돌파</b> 3단계로 보여줍니다. 크게 오르기 전을 노릴 때 조기 포착을 쓰세요. 단, 언제 오를지는 알 수 없고 오르지 않을 수도 있습니다.</p>
          </div>
        </section>
```

- [ ] **Step 5: 회귀 확인**

Run: `node tests/run.js`
Expected: PASS — 전부 통과

- [ ] **Step 6: 브라우저 확인**

Run: `python -m http.server 8130 --directory .`
브라우저에서 `http://localhost:8130` 접속 후 확인:
- 필터 바에 "스캔 모드" select 가 보인다
- "조기 포착"을 고르면 단계 필터 문구가 `1 매집 / 2 임박 / 3 돌파` 로 바뀐다
- 콘솔 에러 0개

확인 후 서버를 종료한다.

- [ ] **Step 7: 커밋**

```bash
git add index.html js/ui/settings.js
git commit -m "조기 포착 — 스캔 모드 선택 UI + early 모드 필터 우회"
```

---

### Task 10: 실제 스캔 검증 + 문서 갱신

**Files:**
- Modify: `PROGRESS.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 1~9 전부
- Produces: 라이브 검증 결과와 갱신된 핸드오프 문서

- [ ] **Step 1: 라이브 스캔 검증**

Run: `python -m http.server 8130 --directory .`
브라우저 `http://localhost:8130` 에서:
1. 스캔 모드를 "조기 포착"으로 변경
2. "스캔 시작" 클릭
3. 확인 항목:
   - 콘솔 에러 0개
   - 결과가 1개 이상 나오면 단계 배지가 `1 매집` / `2 임박` / `3 돌파` 중 하나로 표시된다
   - 결과가 0개면 설정 탭에서 채점 강도를 낮추거나 `config.js` 의 `earlyDetect.boxWidthMaxPct` 를 올려 다시 시도한다
   - "상세" 버튼을 눌러 진입/손절/목표가 표시되는지 확인
4. 스캔 모드를 "급락 반등"으로 되돌려 기존 동작이 그대로인지 확인(회귀 점검)

관찰한 후보 수와 조정한 값을 기록해 둔다.

- [ ] **Step 2: PROGRESS.md 갱신**

`PROGRESS.md` 의 "지금까지 한 일" 목록 마지막 항목 다음에 추가한다(번호는 기존 마지막 번호 + 1):

```markdown
N. **조기 포착 모드 추가** — 기존 깔때기는 "급락+과매도" 라 조용한 매집 구간을
   못 잡는 문제를 발견. 스캔 모드 전환 방식으로 후보 깔때기와 채점만 교체하는
   `scanMode: reversal | early` 를 추가했다. early 는 4시간봉에서 변동성 압축
   (기존 볼린저 width 재사용) + 거래량 고갈 + 미결제약정 증가를 보고
   매집 → 임박 → 돌파 3단계로 분류한다. 미결제약정·펀딩비는 공개 엔드포인트
   (`openInterestHist`, `premiumIndex`)를 쓰며 펀딩비는 스캔당 1회만 호출한다.
   결과는 기존과 동일한 shape 을 반환해 결과표·상세 패널을 건드리지 않았다.
   - 주의: early 모드에서는 방향 필터와 노이즈 필터를 우회한다.
     (매집 구간은 정의상 횡보라 노이즈 필터에 전멸하고, early 는 롱 전용이다)
   - 설계 문서: `docs/superpowers/specs/2026-07-24-early-pump-detection-design.md`
```

"앞으로 할 수 있는 것" 목록에 추가:

```markdown
6. **early 모드 임계값 튜닝** — `config.js` 의 `earlyDetect` 는 감으로 잡은 초기값이다.
   실사용하며 후보 수를 보고 `boxWidthMaxPct`, `squeezePctMax`, `oiChangeMinPct` 를 조정할 것.
7. **TradingView 지표에 early 모드 포팅** — 현재 지표는 reversal 로직 기준이다.
```

- [ ] **Step 3: README.md 갱신**

`README.md` 에서 기능을 설명하는 목록에 한 줄 추가한다(파일의 기존 기능 목록 형식을 따른다):

```markdown
- **스캔 모드 2종** — `급락 반등`(기본, 떨어진 것의 되돌림)과 `조기 포착`(변동성 압축 + 거래량 고갈 + 미결제약정 증가로 매집/임박/돌파 3단계 판정)
```

- [ ] **Step 4: 전체 테스트 최종 확인**

Run: `node tests/run.js`
Expected: PASS — 전부 통과, 실패 0

- [ ] **Step 5: 커밋 및 배포**

```bash
git add PROGRESS.md README.md
git commit -m "조기 포착 모드 문서 갱신 — 핸드오프 문서와 README 반영"
git push origin main
```

---

## Self-Review

**스펙 커버리지**

| 스펙 항목 | 담당 태스크 |
|---|---|
| 유니버스(중형, 대형 제외, 5M/200) | Task 1(config), Task 7(`excludeMajors`, `pfOverride`) |
| OI·펀딩 데이터 소스 | Task 1(API 2종), Task 8(호출 배치) |
| 박스·압축 백분위·거래량 프로파일 | Task 2 |
| OI 변화율 3종 | Task 3 |
| 1·2·3단계 판정 | Task 4 |
| 제외 조건 3종 | Task 4 |
| 채점 5항목 + 감점 4종 | Task 5 |
| 진입 계획(plan) | Task 5 |
| 결과 shape 호환 | Task 6 |
| 노이즈·방향 필터 우회 | Task 9 |
| 단계 필터 라벨 전환 | Task 9 |
| 오류 처리(OI/펀딩 null, 캔들 부족) | Task 1(빈 배열 반환), Task 4(null 통과), Task 6(null 반환) |
| 리페인트 검증 | Task 6 |
| 테스트 전 항목 | Task 2~7 |

**타입 일관성 확인 완료**
- `analyzeOi` 반환 키는 `change72h` / `change12h` / `prev12h` 로 Task 3·4·5·6에서 동일하게 사용
- `EarlyMetrics.oi` 는 항상 `analyzeOi` 결과 객체(3키 모두 존재, 값만 null 가능)
- `earlyPlan(m, atrVal, price)` 3인자 — Task 5 정의, Task 6 호출 일치
- `stage2Liquidity` 4번째 인자는 선택 — 기존 호출부(reversal) 무변경
- `stage` 객체는 `{ stage, key, label, badge }` — 기존 `scoring.js` 형식과 동일해 `applyFilters`/대시보드가 그대로 동작

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-24-early-pump-detection.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
