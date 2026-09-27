// Chronological walk-forward replay of the shipped chart-pattern detector.
// This measures pattern-level level outcomes, not simulated account PnL or live fills.
// At each cutoff, detection receives only closed candles up to that point. The next
// horizon bars are used only for outcome evaluation, and adjacent outcomes do not overlap.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectChartPatterns } from "../js/core/chart-patterns.js";
import { evaluatePatternOutcome } from "../js/core/pattern-validation.js";

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
  throw lastError || new Error("Binance API 요청 실패");
}

async function fetchSeries(symbol, timeframe) {
  const duration = DURATION[timeframe];
  const firstOpen = Math.floor(start / duration) * duration;
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
    if (!Array.isArray(raw)) throw new Error(`${symbol} ${timeframe}: 예상하지 못한 캔들 응답`);
    const rows = raw.filter((item) => Number(item[0]) >= cursor && Number(item[0]) < now);
    if (!rows.length) break;
    for (const k of rows) {
      const bar = {
        openTime: Number(k[0]), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]),
        volume: Number(k[5]), closeTime: Number(k[6]), quoteVolume: Number(k[7]),
      };
      if (bar.closeTime < now) unique.set(bar.openTime, bar);
    }
    const lastOpen = Number(rows.at(-1)[0]);
    if (!(lastOpen >= cursor)) throw new Error(`${symbol} ${timeframe}: 페이지 커서가 진행되지 않음`);
    cursor = lastOpen + duration;
    if (rows.length < PAGE_LIMIT) break;
  }
  const bars = [...unique.values()].sort((a, b) => a.openTime - b.openTime);
  const invalid = bars.filter((b) => ![b.open, b.high, b.low, b.close, b.volume].every(Number.isFinite)
    || b.low <= 0 || b.high < Math.max(b.open, b.close) || b.low > Math.min(b.open, b.close) || b.volume < 0).length;
  if (invalid) throw new Error(`${symbol} ${timeframe}: 유효하지 않은 OHLCV 봉 ${invalid}개`);
  const gaps = [];
  for (let i = 1; i < bars.length; i++) {
    const delta = bars[i].openTime - bars[i - 1].openTime;
    if (delta !== duration) gaps.push({ after: bars[i - 1].openTime, missingBars: Math.max(1, Math.round(delta / duration) - 1) });
  }
  return { bars, gaps, firstOpen, duration };
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

function actionable(pattern) {
  if (!pattern || !["bullish", "bearish"].includes(pattern.bias) || Number(pattern.fitScore) < MIN_FIT) return false;
  const values = [pattern.trigger, pattern.invalidation, pattern.projection].map(Number);
  if (!values.every(Number.isFinite)) return false;
  const [trigger, invalidation, projection] = values;
  return pattern.bias === "bullish"
    ? invalidation < trigger && trigger < projection
    : projection < trigger && trigger < invalidation;
}

function replayClosedSegment(bars, timeframe) {
  const horizonBars = HORIZON[timeframe];
  const firstCutoff = WARMUP[timeframe];
  const samples = [];
  for (let cutoff = firstCutoff; cutoff + horizonBars < bars.length; cutoff += horizonBars) {
    const history = bars.slice(0, cutoff + 1);
    const found = detectChartPatterns(history, { pivotDepth: PIVOT_DEPTH })
      .filter(actionable)
      .sort((a, b) => Number(b.fitScore) - Number(a.fitScore));
    const pattern = found[0];
    if (!pattern) continue;
    const outcome = evaluatePatternOutcome(pattern, bars.slice(cutoff + 1, cutoff + 1 + horizonBars), { horizonBars });
    if (outcome.status === "insufficient") continue;
    samples.push({
      at: bars[cutoff].openTime + DURATION[timeframe] - 1,
      patternId: pattern.id,
      patternName: pattern.name,
      family: pattern.family,
      bias: pattern.bias,
      fitScore: pattern.fitScore,
      ...outcome,
    });
  }
  return samples;
}

function stats(samples) {
  const n = samples.length;
  if (!n) return { n: 0, label: "신호 없음" };
  const wins = samples.filter((x) => x.status === "win").length;
  const losses = samples.filter((x) => x.status === "loss").length;
  const timeClosed = samples.filter((x) => x.status === "open").length;
  const r = samples.map((x) => Number(x.r) || 0);
  const gains = r.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const lossesR = -r.filter((x) => x < 0).reduce((a, b) => a + b, 0);
  const sorted = [...r].sort((a, b) => a - b);
  const medianR = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  return {
    n,
    targetFirstPct: Math.round(wins / n * 1000) / 10,
    stopFirstPct: Math.round(losses / n * 1000) / 10,
    horizonExitPct: Math.round(timeClosed / n * 1000) / 10,
    positiveOutcomePct: Math.round(r.filter((x) => x > 0).length / n * 1000) / 10,
    avgGrossR: Math.round(r.reduce((a, b) => a + b, 0) / n * 1000) / 1000,
    medianGrossR: Math.round(medianR * 1000) / 1000,
    profitFactorGross: lossesR ? Math.round(gains / lossesR * 100) / 100 : gains ? "inf" : null,
    wins, losses, horizonExits: timeClosed,
    firstSignal: new Date(samples[0].at).toISOString(), lastSignal: new Date(samples.at(-1).at).toISOString(),
  };
}

function groupSamples(samples, keyFn) {
  const groups = new Map();
  for (const sample of samples) {
    const key = keyFn(sample);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sample);
  }
  return Object.fromEntries([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, rows]) => [key, stats(rows)]));
}

const tasks = SYMBOLS.flatMap((symbol) => TIMEFRAMES.map((timeframe) => ({ symbol, timeframe })));
const results = [];
let cursor = 0;
const workers = Array.from({ length: CONCURRENCY }, async () => {
  while (cursor < tasks.length) {
    const task = tasks[cursor++];
    const { symbol, timeframe } = task;
    const data = await fetchSeries(symbol, timeframe);
    const segments = segmentsFor(data.bars, data.duration).filter((x) => x.length > WARMUP[timeframe] + HORIZON[timeframe]);
    const samples = segments.flatMap((segment) => replayClosedSegment(segment, timeframe)).sort((a, b) => a.at - b.at);
    const splitAt = Math.max(1, Math.min(samples.length - 1, Math.round(samples.length * TRAIN_RATIO)));
    results.push({
      symbol, timeframe,
      data: {
        candleCount: data.bars.length,
        gapEvents: data.gaps.length,
        missingCandles: data.gaps.reduce((sum, x) => sum + x.missingBars, 0),
        segmentCount: segments.length,
        firstCandle: data.bars[0] ? new Date(data.bars[0].openTime).toISOString() : null,
        lastClosedCandle: data.bars.at(-1) ? new Date(data.bars.at(-1).closeTime).toISOString() : null,
      },
      train: stats(samples.slice(0, splitAt)),
      test: stats(samples.slice(splitAt)),
      samples: samples.map(({ at, patternId, patternName, family, bias, fitScore, status, r }, index) => ({
        at: new Date(at).toISOString(), patternId, patternName, family, bias, fitScore, status,
        split: index < splitAt ? "train" : "test", grossR: Math.round((Number(r) || 0) * 1000) / 1000,
      })),
    });
    console.error(`완료 ${results.length}/${tasks.length} · ${symbol} ${timeframe} · 봉 ${data.bars.length} · 테스트 표본 ${stats(samples.slice(splitAt)).n}`);
  }
});
await Promise.all(workers);

const chronological = (row) => row.samples.map((s) => ({ ...s, symbol: row.symbol, timeframe: row.timeframe }));
const allSamples = results.flatMap(chronological).sort((a, b) => a.at.localeCompare(b.at));
const holdout = allSamples.filter((sample) => sample.split === "test").map((sample) => ({ ...sample, r: sample.grossR }));
const report = {
  title: "Market Scanner pattern detector walk-forward backtest",
  generatedAt: new Date(now).toISOString(),
  source: "Binance USDⓈ-M public Kline endpoint; chart patterns from js/core/chart-patterns.js",
  scope: { symbols: SYMBOLS, timeframes: TIMEFRAMES, lookbackDays: LOOKBACK_DAYS, start: new Date(start).toISOString(), end: new Date(now).toISOString(), pivotDepth: PIVOT_DEPTH, minimumFit: MIN_FIT, trainRatio: TRAIN_RATIO, horizonsBars: HORIZON, warmupBars: WARMUP },
  methodology: {
    split: "Within each symbol/timeframe, emitted samples are sorted chronologically and the last 30% are holdout; no parameters are fitted on the holdout.",
    signal: "At each cutoff, use only closed OHLCV candles through that cutoff; evaluate the highest-fit actionable directional pattern (fit >= 55).",
    overlap: "Evaluate once per outcome horizon so future outcome windows do not overlap within a symbol/timeframe.",
    outcome: "Hypothetical entry at the pattern trigger; stop is counted first if stop and projection are touched in the same candle; unresolved cases are marked to market at the horizon close.",
    caveats: ["Gross R only: commission, funding, slippage, entry-band fills, partial TP exits, and portfolio concurrency are not modeled.", "Universe is a fixed set of ten established USDT perpetuals, not all symbols or a point-in-time historical universe.", "This evaluates pattern levels, not the Pine script compiler or exact TradingView rendering."],
  },
  aggregateHoldout: { ...stats(holdout), firstSignal: holdout[0]?.at || null, lastSignal: holdout.at(-1)?.at || null },
  holdoutByTimeframe: groupSamples(holdout, (x) => x.timeframe),
  holdoutBySymbol: groupSamples(holdout, (x) => x.symbol),
  holdoutByFamily: groupSamples(holdout, (x) => x.family || "unknown"),
  holdoutStart: holdout[0]?.at || null,
  series: results.sort((a, b) => TIMEFRAMES.indexOf(a.timeframe) - TIMEFRAMES.indexOf(b.timeframe) || a.symbol.localeCompare(b.symbol)),
};

const reportPath = join(root, "research", `pattern-backtest-${new Date(now).toISOString().slice(0, 10)}.json`);
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log(JSON.stringify({
  reportPath,
  generatedAt: report.generatedAt,
  scope: report.scope,
  aggregateHoldout: report.aggregateHoldout,
  holdoutByTimeframe: report.holdoutByTimeframe,
  holdoutBySymbol: report.holdoutBySymbol,
  holdoutByFamily: report.holdoutByFamily,
  dataQuality: {
    series: results.length,
    candleCount: results.reduce((sum, x) => sum + x.data.candleCount, 0),
    gapEvents: results.reduce((sum, x) => sum + x.data.gapEvents, 0),
    missingCandles: results.reduce((sum, x) => sum + x.data.missingCandles, 0),
    failedSeries: tasks.length - results.length,
  },
}, null, 2));
