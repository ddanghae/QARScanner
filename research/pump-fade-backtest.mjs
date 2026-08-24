#!/usr/bin/env node
// Offline, reproducible pump_fade threshold sweep.
// This script never mutates production weights and never sends exchange orders.

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { CONFIG } from "../js/config.js";
import { buildPumpFadeResult, pumpFadePrefilter } from "../js/core/pump-fade.js";
import {
  HOUR_MS,
  chronologicalBoundaries,
  labelPumpFadeOutcome,
  liftFrom,
  splitChronologically,
  summarizeOutcomes,
} from "./pump-fade-research-core.mjs";

const THRESHOLD_SWEEP = [
  { pump6hMinPct: 12, pump24hMinPct: 25 },
  { pump6hMinPct: 12, pump24hMinPct: 30 },
  { pump6hMinPct: 15, pump24hMinPct: 25 },
  { pump6hMinPct: 15, pump24hMinPct: 30 },
];

const HELP = `Usage:
  node research/pump-fade-backtest.mjs --input <dataset.json|jsonl> [--output report.json]

Input records (JSON array, {"records": [...]}, or one JSON object per line):
  {
    "symbol": "ABCUSDT",
    "quoteVolume": 50000000,
    "candles": {
      "1h":  [{"openTime":0,"closeTime":1,"open":1,"high":1,"low":1,"close":1,"volume":1,"takerBuyBase":0.5}],
      "15m": [...],
      "5m":  [...]
    }
  }

The sweep reports 12/15% six-hour thresholds crossed with 25/30% 24-hour thresholds.
Signals are split chronologically 60% train / 20% validation / 20% test with a six-hour purge.
Same-5m-bar target/stop hits are AMBIGUOUS and excluded from hit-rate and return metrics.
All metrics are gross of fees, funding, slippage, and borrow constraints.
`;

function parseArgs(argv) {
  const args = { input: null, output: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--input") args.input = argv[++i] || null;
    else if (arg === "--output") args.output = argv[++i] || null;
    else throw new Error(`알 수 없는 인자: ${arg}`);
  }
  return args;
}

function parseInputText(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.records)) return parsed.records;
    return [parsed];
  } catch {
    return trimmed.split(/\r?\n/).filter(Boolean).map((line, index) => {
      try { return JSON.parse(line); }
      catch (error) { throw new Error(`JSONL ${index + 1}행 파싱 실패: ${error.message}`); }
    });
  }
}

function numericCandle(candle) {
  const out = { ...candle };
  for (const key of [
    "openTime", "closeTime", "open", "high", "low", "close", "volume",
    "quoteVolume", "trades", "takerBuyBase", "takerBuyQuote", "takerSellBase",
  ]) {
    if (out[key] != null) out[key] = Number(out[key]);
  }
  if (!Number.isFinite(out.takerSellBase) && Number.isFinite(out.volume) && Number.isFinite(out.takerBuyBase)) {
    out.takerSellBase = out.volume - out.takerBuyBase;
  }
  return out;
}

function normalizeRecords(rawRecords) {
  const records = [];
  const skipped = [];
  for (const raw of rawRecords) {
    const symbol = String(raw?.symbol || "").trim();
    const source = raw?.candles || raw;
    const c1h = Array.isArray(source?.["1h"]) ? source["1h"].map(numericCandle) : [];
    const c15m = Array.isArray(source?.["15m"]) ? source["15m"].map(numericCandle) : [];
    const c5m = Array.isArray(source?.["5m"]) ? source["5m"].map(numericCandle) : [];
    if (!symbol || c1h.length < 25 || c15m.length < CONFIG.pumpFade.recentHighLookback15m || c5m.length < 5) {
      skipped.push({ symbol: symbol || "(missing)", reason: "필수 시간봉 또는 이력 부족" });
      continue;
    }
    const valid1h = c1h.every((c) => Number.isFinite(c.closeTime) && Number.isFinite(c.close) && c.close > 0);
    const valid15m = c15m.every((c) => ["closeTime", "openTime", "open", "high", "low", "close", "volume", "takerBuyBase"]
      .every((key) => Number.isFinite(c[key])) && c.close > 0 && c.volume >= 0);
    const valid5m = c5m.every((c) => ["closeTime", "high", "low", "close"].every((key) => Number.isFinite(c[key])) && c.close > 0);
    if (!valid1h || !valid15m || !valid5m) {
      skipped.push({ symbol, reason: "비정상 숫자 또는 필수 캔들 필드 누락" });
      continue;
    }
    const sort = (a, b) => a.closeTime - b.closeTime;
    c1h.sort(sort); c15m.sort(sort); c5m.sort(sort);
    records.push({
      symbol,
      baseAsset: raw.baseAsset || symbol.replace(/USDT$/, ""),
      quoteVolume: Number(raw.quoteVolume) || 0,
      newListing: Boolean(raw.newListing),
      candles1h: c1h,
      candles15m: c15m,
      candles5m: c5m,
    });
  }
  return { records, skipped };
}

function configForThreshold(threshold) {
  return {
    ...CONFIG,
    pumpFade: { ...CONFIG.pumpFade, ...threshold },
  };
}

function generateSamples(record, cfg, options = {}) {
  const horizonMs = options.horizonMs ?? 6 * HOUR_MS;
  const cooldownMs = options.cooldownMs ?? 6 * HOUR_MS;
  const baseSamples = [];
  const signalSamples = [];
  let oneHourEnd = 0;
  let fiveMinuteEnd = 0;
  let lastBaseTime = -Infinity;
  let lastSignalTime = -Infinity;

  for (let i = cfg.pumpFade.recentHighLookback15m - 1; i < record.candles15m.length; i++) {
    const signalCandle = record.candles15m[i];
    const signalTime = signalCandle.closeTime;
    while (oneHourEnd < record.candles1h.length && record.candles1h[oneHourEnd].closeTime <= signalTime) oneHourEnd++;
    while (fiveMinuteEnd < record.candles5m.length && record.candles5m[fiveMinuteEnd].closeTime <= signalTime) fiveMinuteEnd++;
    if (oneHourEnd < 25 || fiveMinuteEnd < cfg.pumpFade.microBreakdownBars5m + 1) continue;

    const candles1h = record.candles1h.slice(Math.max(0, oneHourEnd - 25), oneHourEnd);
    const pump = pumpFadePrefilter(candles1h, cfg);
    if (!pump.pass) continue;

    if (signalTime - lastBaseTime >= cooldownMs) {
      baseSamples.push({
        cohort: "pump_base",
        symbol: record.symbol,
        signalTime,
        outcome: labelPumpFadeOutcome(record.candles5m, signalTime, signalCandle.close, { horizonMs }),
      });
      lastBaseTime = signalTime;
    }

    if (signalTime - lastSignalTime < cooldownMs) continue;
    const result = buildPumpFadeResult(
      record,
      candles1h,
      record.candles15m.slice(Math.max(0, i + 1 - cfg.klinesLimit["15m"]), i + 1),
      record.candles5m.slice(Math.max(0, fiveMinuteEnd - cfg.klinesLimit["5m"]), fiveMinuteEnd),
      cfg,
    );
    if (!result || result.score < cfg.pumpFade.minScore) continue;
    signalSamples.push({
      cohort: "pump_fade_signal",
      symbol: record.symbol,
      signalTime,
      stage: result.stage.stage,
      score: result.score,
      outcome: labelPumpFadeOutcome(record.candles5m, signalTime, result.price, { horizonMs }),
    });
    lastSignalTime = signalTime;
  }
  return { baseSamples, signalSamples };
}

function datasetBoundaries(records) {
  let minTime = Infinity;
  let maxTime = -Infinity;
  let count = 0;
  for (const record of records) {
    for (const candle of record.candles15m) {
      if (!Number.isFinite(candle.closeTime)) continue;
      minTime = Math.min(minTime, candle.closeTime);
      maxTime = Math.max(maxTime, candle.closeTime);
      count++;
    }
  }
  if (count < 2) throw new Error("시간순 분할에 필요한 15분봉 시각이 부족합니다.");
  return chronologicalBoundaries(minTime, maxTime);
}

function splitReport(samples, baseSamples, boundaries, horizonMs) {
  const signalSplits = splitChronologically(samples, boundaries, horizonMs);
  const baseSplits = splitChronologically(baseSamples, boundaries, horizonMs);
  const report = {};
  for (const split of ["train", "validation", "test"]) {
    const signal = summarizeOutcomes(signalSplits[split]);
    const base = summarizeOutcomes(baseSplits[split]);
    report[split] = {
      signalCount: signal.sampleCount,
      baseCount: base.sampleCount,
      signal,
      base,
      baseRate: base.hitRate,
      lift: liftFrom(signal, base),
    };
  }
  report.purged = {
    signalCount: signalSplits.purged.length,
    baseCount: baseSplits.purged.length,
  };
  return report;
}

export function runThresholdSweep(records, options = {}) {
  const horizonMs = options.horizonMs ?? 6 * HOUR_MS;
  const boundaries = datasetBoundaries(records);
  const thresholds = THRESHOLD_SWEEP.map((threshold) => {
    const cfg = configForThreshold(threshold);
    const allBase = [];
    const allSignals = [];
    for (const record of records) {
      const generated = generateSamples(record, cfg, { horizonMs });
      allBase.push(...generated.baseSamples);
      allSignals.push(...generated.signalSamples);
    }
    return {
      threshold,
      splits: splitReport(allSignals, allBase, boundaries, horizonMs),
    };
  });
  return {
    schemaVersion: 1,
    experimental: true,
    boundaries,
    assumptions: {
      split: "chronological 60/20/20 with 6h purge",
      target: "SHORT -8% within 6h",
      stop: "+5% before target",
      sameCandle: "AMBIGUOUS and excluded from rates/returns",
      returns: "gross; fees, funding, slippage and borrow constraints excluded",
      promotion: "no automatic production refit or threshold promotion",
    },
    thresholds,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (!args.input) throw new Error("--input 경로가 필요합니다. --help를 확인하세요.");
  const raw = parseInputText(await readFile(args.input, "utf8"));
  const normalized = normalizeRecords(raw);
  if (!normalized.records.length) throw new Error("분석 가능한 레코드가 없습니다.");
  const report = runThresholdSweep(normalized.records);
  report.input = {
    path: args.input,
    recordCount: normalized.records.length,
    skippedCount: normalized.skipped.length,
    skipped: normalized.skipped,
  };
  const json = JSON.stringify(report, null, 2) + "\n";
  if (args.output) await writeFile(args.output, json, "utf8");
  process.stdout.write(json);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(`pump-fade backtest failed: ${error.message}`);
    process.exitCode = 1;
  });
}
