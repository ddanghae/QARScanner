// Walk-forward study: does confirmed Williams fractal structure improve the
// shipped chart-pattern detector's outcomes? Outcomes are signal-level gross R,
// not simulated account PnL or live fills.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectChartPatterns } from "../js/core/chart-patterns.js";
import { evaluatePatternOutcome } from "../js/core/pattern-validation.js";
import { assessFractalContinuation } from "../js/core/fractal-continuation.js";

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT", "DOGEUSDT", "LINKUSDT", "LTCUSDT", "AVAXUSDT"];
const TIMEFRAMES = ["5m", "15m", "1h", "4h"];
const DURATION = { "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000 };
const HORIZON = { "5m": 12, "15m": 12, "1h": 12, "4h": 8 };
const WARMUP = { "5m": 60, "15m": 60, "1h": 60, "4h": 80 };
const LOOKBACK_DAYS = 90;
const PIVOT_DEPTH = 3;
const MIN_FIT = 55;
const TRAIN_RATIO = 0.7;
const PAGE_LIMIT = 1000;
const CONCURRENCY = 4;
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const now = Date.now();
const start = now - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(url) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { Accept: "application/json" } });
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`Binance API HTTP ${response.status}`);
        await sleep(800 * (attempt + 1));
        continue;
      }
      if (!response.ok) throw new Error(`Binance API HTTP ${response.status}: ${await response.text()}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(500 * (attempt + 1));
    }
  }
  throw lastError || new Error("Binance API request failed");
}

async function fetchSeries(symbol, timeframe) {
  const duration = DURATION[timeframe], firstOpen = Math.floor(start / duration) * duration;
  const unique = new Map();
  let cursor = firstOpen;
  while (cursor < now) {
    const url = new URL("https://fapi.binance.com/fapi/v1/klines");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", timeframe);
    url.searchParams.set("startTime", String(cursor));
    url.searchParams.set("endTime", String(now));
    url.searchParams.set("limit", String(PAGE_LIMIT));
    const raw = await getJson(url);
    if (!Array.isArray(raw)) throw new Error(`${symbol} ${timeframe}: invalid kline response`);
    const rows = raw.filter((item) => Number(item[0]) >= cursor && Number(item[0]) < now);
    if (!rows.length) break;
    for (const k of rows) {
      const bar = { openTime: Number(k[0]), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]), closeTime: Number(k[6]) };
      if (bar.closeTime < now) unique.set(bar.openTime, bar);
    }
    const lastOpen = Number(rows.at(-1)[0]);
    if (!(lastOpen >= cursor)) throw new Error(`${symbol} ${timeframe}: pagination cursor did not advance`);
    cursor = lastOpen + duration;
    if (rows.length < PAGE_LIMIT) break;
  }
  const bars = [...unique.values()].sort((a, b) => a.openTime - b.openTime);
  const gaps = [];
  for (let i = 1; i < bars.length; i++) {
    const delta = bars[i].openTime - bars[i - 1].openTime;
    if (delta !== duration) gaps.push(Math.max(1, Math.round(delta / duration) - 1));
  }
  return { bars, gaps, duration };
}

function segmentsFor(bars, duration) {
  const segments = [];
  let current = [];
  for (const bar of bars) {
    if (current.length && bar.openTime - current.at(-1).openTime !== duration) {
      segments.push(current);
      current = [];
    }
    current.push(bar);
  }
  if (current.length) segments.push(current);
  return segments;
}

function replayClosedSegment(bars, timeframe) {
  const horizonBars = HORIZON[timeframe], samples = [];
  for (let cutoff = WARMUP[timeframe]; cutoff + horizonBars < bars.length; cutoff += horizonBars) {
    const history = bars.slice(0, cutoff + 1);
    const assessment = assessFractalContinuation(history, detectChartPatterns(history, { pivotDepth: PIVOT_DEPTH }), {
      pivotDepth: PIVOT_DEPTH, minFit: MIN_FIT, asOf: bars[cutoff].closeTime,
    });
    const { pattern, fractalTrend: trend, fractalAlignment: alignment } = assessment;
    if (!pattern) continue;
    const outcome = evaluatePatternOutcome(pattern, bars.slice(cutoff + 1, cutoff + 1 + horizonBars), { horizonBars });
    if (outcome.status === "insufficient") continue;
    samples.push({
      at: bars[cutoff].openTime + DURATION[timeframe] - 1,
      patternName: pattern.name,
      family: pattern.family || "unknown",
      bias: pattern.bias,
      fitBand: Math.floor(Number(pattern.fitScore) / 10) * 10,
      fractalTrend: trend,
      fractalAlignment: alignment,
      ...outcome,
    });
  }
  return samples;
}

function stats(samples) {
  const n = samples.length;
  if (!n) return { n: 0 };
  const wins = samples.filter((x) => x.status === "win").length;
  const losses = samples.filter((x) => x.status === "loss").length;
  const open = samples.filter((x) => x.status === "open").length;
  const values = samples.map((x) => Number(x.r) || 0);
  const gains = values.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const lossSum = -values.filter((x) => x < 0).reduce((a, b) => a + b, 0);
  const sorted = [...values].sort((a, b) => a - b);
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  return {
    n,
    targetFirstPct: Math.round(wins / n * 1000) / 10,
    resolvedWinPct: wins + losses ? Math.round(wins / (wins + losses) * 1000) / 10 : null,
    stopFirstPct: Math.round(losses / n * 1000) / 10,
    horizonExitPct: Math.round(open / n * 1000) / 10,
    positiveR_pct: Math.round(values.filter((x) => x > 0).length / n * 1000) / 10,
    avgR: Math.round(values.reduce((a, b) => a + b, 0) / n * 1000) / 1000,
    medianR: Math.round(median * 1000) / 1000,
    profitFactor: lossSum ? Math.round(gains / lossSum * 100) / 100 : gains ? "inf" : null,
    wins, losses, horizonExits: open,
  };
}

function groups(samples, keyFn) {
  const map = new Map();
  for (const sample of samples) {
    const key = keyFn(sample);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(sample);
  }
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, rows]) => [key, stats(rows)]));
}

function groupsBySplit(rows, groupFn) {
  const train = rows.filter((x) => x.split === "train").map((x) => ({ ...x, r: x.grossR }));
  const test = rows.filter((x) => x.split === "test").map((x) => ({ ...x, r: x.grossR }));
  const trainGroups = groups(train, groupFn), testGroups = groups(test, groupFn);
  return Object.fromEntries(Object.keys(trainGroups).sort().map((key) => [key, { train: trainGroups[key], test: testGroups[key] || { n: 0 } }]));
}

const tasks = SYMBOLS.flatMap((symbol) => TIMEFRAMES.map((timeframe) => ({ symbol, timeframe })));
const seriesResults = [];
let cursor = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (cursor < tasks.length) {
    const { symbol, timeframe } = tasks[cursor++];
    const data = await fetchSeries(symbol, timeframe);
    const segments = segmentsFor(data.bars, data.duration).filter((x) => x.length > WARMUP[timeframe] + HORIZON[timeframe]);
    const samples = segments.flatMap((segment) => replayClosedSegment(segment, timeframe)).sort((a, b) => a.at - b.at);
    const splitAt = Math.max(1, Math.min(samples.length - 1, Math.round(samples.length * TRAIN_RATIO)));
    seriesResults.push({ symbol, timeframe, candleCount: data.bars.length, gapEvents: data.gaps.length, missingCandles: data.gaps.reduce((a, b) => a + b, 0), samples: samples.map((s, index) => ({ ...s, grossR: Math.round((Number(s.r) || 0) * 1000) / 1000, split: index < splitAt ? "train" : "test" })) });
    console.error(`완료 ${seriesResults.length}/${tasks.length} · ${symbol} ${timeframe} · 신호 ${samples.length}`);
  }
}));

const all = seriesResults.flatMap((row) => row.samples.map((s) => ({ ...s, symbol: row.symbol, timeframe: row.timeframe })));
const test = all.filter((s) => s.split === "test").map((s) => ({ ...s, r: s.grossR }));
const train = all.filter((s) => s.split === "train").map((s) => ({ ...s, r: s.grossR }));
const minTrain = 100, minTest = 40;
const zones = Object.entries(groupsBySplit(all, (x) => `${x.timeframe} · ${x.fractalAlignment}`))
  .map(([key, split]) => ({ key, ...split }))
  .filter((x) => x.train.n >= minTrain && x.test.n >= minTest)
  .sort((a, b) => (b.test.targetFirstPct ?? 0) - (a.test.targetFirstPct ?? 0));
const alignedByFamily = Object.entries(groupsBySplit(all, (x) => `${x.family} · ${x.fractalAlignment}`))
  .map(([key, split]) => ({ key, ...split }))
  .filter((x) => x.train.n >= minTrain && x.test.n >= minTest)
  .sort((a, b) => (b.train.targetFirstPct ?? 0) - (a.train.targetFirstPct ?? 0));
const familyTimeframeZones = Object.entries(groupsBySplit(all, (x) => `${x.timeframe} · ${x.family} · ${x.fractalAlignment}`))
  .map(([key, split]) => ({ key, ...split }))
  .filter((x) => x.train.n >= minTrain && x.test.n >= minTest)
  .sort((a, b) => (b.train.targetFirstPct ?? 0) - (a.train.targetFirstPct ?? 0));
const discoveryCandidates = familyTimeframeZones.filter((x) => x.train.avgR > 0 && Number(x.train.profitFactor) > 1);

const report = {
  title: "Market Scanner confirmed-fractal pattern backtest",
  generatedAt: new Date(now).toISOString(),
  source: "Binance USDⓈ-M public klines and the shipped detectChartPatterns implementation",
  definition: {
    fractal: "Williams-style pivot with three closed bars to its left and right; only confirmed pivots available by the signal cutoff are used.",
    structure: "Up = latest two confirmed fractal highs and lows both rise (HH+HL); down = both fall (LH+LL); otherwise mixed.",
    aligned: "Bullish pattern with up fractal structure, or bearish pattern with down fractal structure.",
    signal: "Same highest-fit actionable pattern (fit >= 55) as the previous pattern replay; only closed history is passed to the detector.",
    outcome: "Same trigger, invalidation, projection, and horizon rules as the previous replay. Same-candle stop/target ties count as stop; unresolved cases are marked at horizon close.",
    split: "Chronological 70/30 within each symbol and timeframe. The later 30% is held out. Candidate zones are read from train; test rows are reported separately.",
    limits: ["Gross R before trading costs; no exact order fill, fees, funding, slippage, partial exits, or portfolio constraints.", "Ten current major perpetual symbols only; results do not represent the full historical market universe.", "Group comparisons are exploratory and can still reflect chance; a new forward period is needed before practical use."],
  },
  scope: { symbols: SYMBOLS, timeframes: TIMEFRAMES, lookbackDays: LOOKBACK_DAYS, pivotDepth: PIVOT_DEPTH, minFit: MIN_FIT, trainRatio: TRAIN_RATIO, outcomeHorizonBars: HORIZON, trainMinForZone: minTrain, testMinForZone: minTest },
  aggregate: { train: stats(train), test: stats(test) },
  holdoutByTimeframe: groups(test, (x) => x.timeframe),
  holdoutByFractalAlignment: groups(test, (x) => x.fractalAlignment),
  discoveryZones: zones,
  exploratoryFamilyZones: alignedByFamily,
  familyTimeframeZones,
  discoveryCandidates,
  dataQuality: {
    series: seriesResults.length,
    bars: seriesResults.reduce((sum, x) => sum + x.candleCount, 0),
    gapEvents: seriesResults.reduce((sum, x) => sum + x.gapEvents, 0),
    missingCandles: seriesResults.reduce((sum, x) => sum + x.missingCandles, 0),
    failedSeries: tasks.length - seriesResults.length,
  },
  samples: all.map(({ at, patternName, family, bias, fitBand, fractalTrend, fractalAlignment, grossR, status, split, symbol, timeframe }) => ({ at: new Date(at).toISOString(), patternName, family, bias, fitBand, fractalTrend, fractalAlignment, grossR, status, split, symbol, timeframe })),
};

const date = new Date(now).toISOString().slice(0, 10);
const jsonPath = join(root, "research", `fractal-pattern-backtest-${date}.json`);
const mdPath = join(root, "research", `fractal-pattern-backtest-${date}.md`);
await mkdir(dirname(jsonPath), { recursive: true });
await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
const pct = (value) => value == null ? "—" : `${value}%`;
const table = zones.map((z) => `| ${z.key} | ${z.train.n} | ${pct(z.train.targetFirstPct)} | ${z.test.n} | ${pct(z.test.targetFirstPct)} | ${z.test.avgR}R | ${z.test.profitFactor} |`).join("\n");
const familyTable = alignedByFamily.map((z) => `| ${z.key} | ${z.train.n} | ${pct(z.train.targetFirstPct)} | ${z.test.n} | ${pct(z.test.targetFirstPct)} | ${z.test.avgR}R | ${z.test.profitFactor} |`).join("\n");
const candidateTable = discoveryCandidates.map((z) => `| ${z.key} | ${z.train.n} | ${pct(z.train.targetFirstPct)} (${pct(z.train.resolvedWinPct)}) | ${z.train.avgR}R / ${z.train.profitFactor} | ${z.test.n} | ${pct(z.test.targetFirstPct)} (${pct(z.test.resolvedWinPct)}) | ${z.test.avgR}R / ${z.test.profitFactor} |`).join("\n");
const timeframeFamilyTable = familyTimeframeZones.map((z) => `| ${z.key} | ${z.train.n} | ${pct(z.train.targetFirstPct)} | ${z.test.n} | ${pct(z.test.targetFirstPct)} | ${z.test.avgR}R | ${z.test.profitFactor} |`).join("\n");
const markdown = `# 마켓 스캐너 프랙탈 패턴 백테스트\n\n**생성:** ${new Date(now).toISOString()}  \n**기간:** 최근 ${LOOKBACK_DAYS}일 · 10개 USDT 무기한 종목 · 5분/15분/1시간/4시간\n\n## 시간순 미사용 구간 결과\n\n| 시간봉 | 표본 | 목표 선도달 | 손절 선도달 | 평균 R | PF |\n|---|---:|---:|---:|---:|---:|\n${Object.entries(report.holdoutByTimeframe).map(([tf, s]) => `| ${tf} | ${s.n} | ${pct(s.targetFirstPct)} | ${pct(s.stopFirstPct)} | ${s.avgR}R | ${s.profitFactor} |`).join("\n")}\n\n## 학습 구간에서 찾고 미사용 구간에서 확인한 후보\n\n후보는 학습 구간에서 표본 100건 이상, 평균 R 양수, PF 1 초과인 패턴·시간봉·프랙탈 조합으로 골랐습니다. 목표 선도달률은 전체 신호 중 목표가 손절보다 먼저 닿은 비율이며, 괄호는 목표 또는 손절에 닿아 결과가 확정된 신호만 놓고 계산한 비율입니다.\n\n| 후보 조합 | 학습 표본 | 학습 목표선도달 (확정건 기준) | 학습 평균 R / PF | 검증 표본 | 검증 목표선도달 (확정건 기준) | 검증 평균 R / PF |\n|---|---:|---:|---:|---:|---:|---:|\n${candidateTable || "| 기준을 만족한 후보 없음 | — | — | — | — | — | — |"}\n\n## 패턴·프랙탈별 검증 참고표\n\n| 조합 | 학습 표본 | 학습 목표선도달 | 검증 표본 | 검증 목표선도달 | 검증 평균 R | 검증 PF |\n|---|---:|---:|---:|---:|---:|---:|\n${timeframeFamilyTable || "| 표본 기준을 만족한 조합 없음 | — | — | — | — | — | — |"}\n\n목표도달률은 모든 신호 중 목표가 손절보다 먼저 닿은 비율입니다. 검증 구간은 종목·시간봉별 시간순 표본의 마지막 30%입니다.\n\n## 프랙탈 정의 및 제한\n\n- 프랙탈은 고점/저점의 좌우 3개 봉이 모두 마감된 Williams형 피봇으로 계산했습니다. 신호 시점에는 오른쪽 3개 봉이 이미 마감된 것만 사용했습니다.\n- 상승 구조는 최근 두 프랙탈 고점과 저점이 모두 높아진 HH+HL, 하락 구조는 모두 낮아진 LH+LL입니다. 패턴 방향이 이 구조와 같으면 정렬, 반대면 역행, 그 외는 혼합으로 분류했습니다.\n- 동일 스캐너 탐지 로직과 진입 트리거·손절·목표·평가 기간을 사용했습니다. 한 봉에서 목표와 손절이 함께 닿으면 손절 우선, 기간 종료 시 미청산 결과는 종가 기준으로 계산했습니다.\n- 수수료·슬리피지·펀딩비와 실제 진입 체결은 반영하지 않은 총 R입니다. 이 분석은 탐색용이며, 작은 표본이나 여러 조합 중 우연히 높게 나온 승률은 실전 성과를 보장하지 않습니다.\n- Binance 공개 선물 캔들 데이터 사용. [Binance Kline API 문서](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/market-data/rest-api/Kline-Candlestick-Data)\n\n**재현 스크립트:** research/fractal-pattern-backtest.mjs  \n**원자료:** research/fractal-pattern-backtest-${date}.json\n`;
await writeFile(mdPath, markdown, "utf8");
console.log(JSON.stringify({ jsonPath, mdPath, generatedAt: report.generatedAt, aggregate: report.aggregate, discoveryCandidates, dataQuality: report.dataQuality }, null, 2));
