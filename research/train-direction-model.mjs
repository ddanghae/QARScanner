#!/usr/bin/env node
// Binance 공개 4시간봉으로 24시간 3방향(up/down/neutral) 모델을 재학습한다.
// 운영 코드와 같은 feature/label 함수를 import해 연구-배포 계산 드리프트를 막는다.
// 현재 거래 중인 종목만 사용하므로 상장폐지 종목 누락(생존편향)은 보고서에 명시한다.

import { writeFileSync } from "node:fs";
import {
  DIRECTION_CLASSES,
  DIRECTION_FEATURE_NAMES,
  buildDirectionSeries,
  directionFeaturesAt,
  directionThresholdPct,
  labelDirectionOutcome,
} from "../js/core/direction-forecast.js";

const API = "https://fapi.binance.com";
const EVAL_EVERY = 6; // 4h × 6 = 하루마다 한 번 평가
const MIN_INDEX = 84;
const HORIZON_BARS = 6;
const MAX_CONCURRENT = 4;
// limit=1000 kline은 요청 가중치가 커서 500여 종목을 한 번에 쏘면 IP가 418로 차단된다.
// 전역 요청 시작 간격을 둬 분당 사용량을 안전 범위 아래로 제한한다.
const REQUEST_SPACING_MS = 250;
const args = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const out = { output: null, modelOutput: null, samplesOutput: null, maxSymbols: Infinity };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--output") out.output = argv[++i] || null;
    else if (argv[i] === "--model-output") out.modelOutput = argv[++i] || null;
    else if (argv[i] === "--samples-output") out.samplesOutput = argv[++i] || null;
    else if (argv[i] === "--max-symbols") out.maxSymbols = Number(argv[++i] || 0) || Infinity;
    else if (argv[i] === "--help") out.help = true;
    else throw new Error(`알 수 없는 인자: ${argv[i]}`);
  }
  return out;
}

if (args.help) {
  console.log("node research/train-direction-model.mjs [--output report.json] [--model-output direction-model-params.js] [--samples-output samples.json] [--max-symbols N]");
  process.exit(0);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let nextFetchAt = 0;
async function throttle() {
  const scheduled = Math.max(Date.now(), nextFetchAt);
  nextFetchAt = scheduled + REQUEST_SPACING_MS;
  if (scheduled > Date.now()) await sleep(scheduled - Date.now());
}
async function json(url) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await throttle();
      const res = await fetch(url);
      if (res.status === 429 || res.status >= 500) { await sleep(500 * attempt); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (error) {
      if (attempt === 4) throw error;
      await sleep(350 * attempt);
    }
  }
}

function parseKlines(raw) {
  return raw.map((k) => ({
    openTime: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4],
    volume: +k[5], closeTime: +k[6], quoteVolume: +k[7],
  }));
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0, done = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try { out[i] = await fn(items[i], i); }
      catch (error) { out[i] = { symbol: items[i], error: error.message, candles: [] }; }
      done++;
      if (done % 50 === 0 || done === items.length) console.error(`  candles ${done}/${items.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const info = await json(`${API}/fapi/v1/exchangeInfo`);
let symbols = info.symbols
  .filter((s) => s.contractType === "PERPETUAL" && s.quoteAsset === "USDT" && s.status === "TRADING")
  .map((s) => s.symbol);
symbols = symbols.filter((s) => s !== "BTCUSDT").slice(0, args.maxSymbols);
const btcCandles = parseKlines(await json(`${API}/fapi/v1/klines?symbol=BTCUSDT&interval=4h&limit=1000`));
const btcSeries = buildDirectionSeries(btcCandles);
const btcIndexByTime = new Map(btcCandles.map((c, i) => [c.closeTime, i]));
console.error(`symbols=${symbols.length} btcBars=${btcCandles.length}`);

const downloaded = await mapLimit(symbols, MAX_CONCURRENT, async (symbol) => ({
  symbol,
  candles: parseKlines(await json(`${API}/fapi/v1/klines?symbol=${symbol}&interval=4h&limit=1000`)),
}));

const samples = [];
let ambiguous = 0, incomplete = 0, skippedFeatures = 0;
for (const record of downloaded) {
  if (!record?.candles?.length) continue;
  const series = buildDirectionSeries(record.candles);
  for (let i = MIN_INDEX; i < record.candles.length - HORIZON_BARS; i += EVAL_EVERY) {
    const bi = btcIndexByTime.get(record.candles[i].closeTime);
    const f = directionFeaturesAt(series, i, btcSeries, bi);
    if (!f) { skippedFeatures++; continue; }
    const thresholdPct = directionThresholdPct(f.atrPctRaw);
    const labeled = labelDirectionOutcome(record.candles, i, thresholdPct, HORIZON_BARS);
    if (labeled.outcome === "ambiguous") { ambiguous++; continue; }
    if (!DIRECTION_CLASSES.includes(labeled.outcome)) { incomplete++; continue; }
    samples.push({ symbol: record.symbol, ts: record.candles[i].closeTime, x: f.vector, y: DIRECTION_CLASSES.indexOf(labeled.outcome) });
  }
}
samples.sort((a, b) => a.ts - b.ts || a.symbol.localeCompare(b.symbol));
if (samples.length < 1000) throw new Error(`학습 표본 부족: ${samples.length}`);
if (args.samplesOutput) writeFileSync(args.samplesOutput, JSON.stringify({ samples, ambiguous, incomplete, skippedFeatures }), "utf8");

const minTs = samples[0].ts, maxTs = samples[samples.length - 1].ts;
const span = maxTs - minTs;
const trainEnd = minTs + span * 0.6;
const validationEnd = minTs + span * 0.8;
const horizonMs = HORIZON_BARS * 4 * 60 * 60 * 1000;
const split = { train: [], validation: [], test: [], purged: [] };
for (const s of samples) {
  if (s.ts < trainEnd) (s.ts + horizonMs <= trainEnd ? split.train : split.purged).push(s);
  else if (s.ts < validationEnd) (s.ts + horizonMs <= validationEnd ? split.validation : split.purged).push(s);
  else (s.ts + horizonMs <= maxTs ? split.test : split.purged).push(s);
}

const mean = [], sd = [];
for (let j = 0; j < DIRECTION_FEATURE_NAMES.length; j++) {
  const mu = split.train.reduce((sum, s) => sum + s.x[j], 0) / split.train.length;
  const sigma = Math.sqrt(split.train.reduce((sum, s) => sum + (s.x[j] - mu) ** 2, 0) / split.train.length) || 1;
  mean.push(mu); sd.push(sigma);
}
const standardized = (list) => list.map((s) => ({ ...s, z: s.x.map((v, j) => (v - mean[j]) / sd[j]) }));
const train = standardized(split.train), validation = standardized(split.validation), test = standardized(split.test);
const trainCounts = DIRECTION_CLASSES.map((_, k) => train.filter((s) => s.y === k).length);
const trainPriors = trainCounts.map((n) => n / train.length);

function softmax(logits) {
  const m = Math.max(...logits);
  const e = logits.map((x) => Math.exp(x - m));
  const sum = e.reduce((a, b) => a + b, 0);
  return e.map((x) => x / sum);
}

function fit(list, options = {}) {
  const classes = DIRECTION_CLASSES.length, d = DIRECTION_FEATURE_NAMES.length;
  const weights = Array.from({ length: classes }, () => new Array(d).fill(0));
  const bias = new Array(classes).fill(0);
  const epochs = options.epochs ?? 500, lr = options.lr ?? 0.08, l2 = options.l2 ?? 0.002;
  for (let epoch = 0; epoch < epochs; epoch++) {
    const gw = Array.from({ length: classes }, () => new Float64Array(d));
    const gb = new Float64Array(classes);
    for (const s of list) {
      const logits = bias.map((b, k) => b + weights[k].reduce((sum, w, j) => sum + w * s.z[j], 0));
      const p = softmax(logits);
      for (let k = 0; k < classes; k++) {
        const error = p[k] - (s.y === k ? 1 : 0);
        gb[k] += error;
        for (let j = 0; j < d; j++) gw[k][j] += error * s.z[j];
      }
    }
    const eta = lr / Math.sqrt(1 + epoch / 40);
    for (let k = 0; k < classes; k++) {
      bias[k] -= eta * gb[k] / list.length;
      for (let j = 0; j < d; j++) weights[k][j] -= eta * (gw[k][j] / list.length + l2 * weights[k][j]);
    }
    if ((epoch + 1) % 100 === 0) console.error(`  fit ${epoch + 1}/${epochs}`);
  }
  return { weights, bias };
}

function fitBinary(list, target, options = {}) {
  const d = DIRECTION_FEATURE_NAMES.length;
  const weights = new Array(d).fill(0);
  let bias = 0;
  const epochs = options.epochs ?? 500, lr = options.lr ?? 0.08, l2 = options.l2 ?? 0.002;
  for (let epoch = 0; epoch < epochs; epoch++) {
    const gw = new Float64Array(d);
    let gb = 0;
    for (const s of list) {
      const raw = bias + weights.reduce((sum, w, j) => sum + w * s.z[j], 0);
      const p = 1 / (1 + Math.exp(-raw));
      const error = p - target(s);
      gb += error;
      for (let j = 0; j < d; j++) gw[j] += error * s.z[j];
    }
    const eta = lr / Math.sqrt(1 + epoch / 40);
    bias -= eta * gb / list.length;
    for (let j = 0; j < d; j++) weights[j] -= eta * (gw[j] / list.length + l2 * weights[j]);
  }
  return { weights, bias };
}

const rawScore = (model, sample) => model.bias + model.weights.reduce((sum, w, j) => sum + w * sample.z[j], 0);
const sigmoid = (v) => 1 / (1 + Math.exp(-Math.max(-35, Math.min(35, v))));

// 검증셋에서 slope+intercept만 맞춘다. 단순 temperature와 달리 클래스 기준선 변화도 보정한다.
function fitPlatt(list, scoreOf, target, options = {}) {
  let scale = 1, bias = 0;
  const epochs = options.epochs ?? 1000, lr = options.lr ?? 0.08, l2 = options.l2 ?? 0.002;
  for (let epoch = 0; epoch < epochs; epoch++) {
    let gs = 0, gb = 0;
    for (const s of list) {
      const raw = scoreOf(s);
      const error = sigmoid(scale * raw + bias) - target(s);
      gs += error * raw;
      gb += error;
    }
    const eta = lr / Math.sqrt(1 + epoch / 80);
    scale -= eta * (gs / list.length + l2 * (scale - 1));
    bias -= eta * gb / list.length;
  }
  return { scale, bias };
}

const multinomial = fit(train);
const multinomialRaw = (s) => multinomial.bias.map((b, k) =>
  b + multinomial.weights[k].reduce((sum, w, j) => sum + w * s.z[j], 0)
);
let multiTemperature = 1, bestMultiLoss = Infinity;
for (let t = 0.5; t <= 3.0001; t += 0.05) {
  const loss = -validation.reduce((sum, s) => sum + Math.log(Math.max(1e-12, softmax(multinomialRaw(s).map((x) => x / t))[s.y])), 0) / validation.length;
  if (loss < bestMultiLoss) { bestMultiLoss = loss; multiTemperature = Number(t.toFixed(2)); }
}
const multiCandidate = {
  type: "multinomial_logit",
  params: { weights: multinomial.weights, bias: multinomial.bias, temperature: multiTemperature },
  predict: (s) => softmax(multinomialRaw(s).map((x) => x / multiTemperature)),
};

// P(move) × P(up | move)로 분리하면 중립 빈도와 방향을 한 식에서 서로 밀어내지 않는다.
const movedTrain = train.filter((s) => s.y !== 2);
const moveModel = fitBinary(train, (s) => s.y === 2 ? 0 : 1);
const upModel = fitBinary(movedTrain, (s) => s.y === 0 ? 1 : 0);
const moveCal = fitPlatt(validation, (s) => rawScore(moveModel, s), (s) => s.y === 2 ? 0 : 1);
const validationMoved = validation.filter((s) => s.y !== 2);
const upCal = fitPlatt(validationMoved, (s) => rawScore(upModel, s), (s) => s.y === 0 ? 1 : 0);
const factorizedPredict = (s) => {
  const move = sigmoid(moveCal.scale * rawScore(moveModel, s) + moveCal.bias);
  const upGivenMove = sigmoid(upCal.scale * rawScore(upModel, s) + upCal.bias);
  return [move * upGivenMove, move * (1 - upGivenMove), 1 - move];
};
const factorizedCandidate = {
  type: "factorized_logit",
  params: { moveModel, upModel, moveCalibration: moveCal, upCalibration: upCal },
  predict: factorizedPredict,
};

// 선형 가정이 틀릴 때를 확인하는 Gaussian Naive Bayes 기준 모델.
function fitGaussianNb(list) {
  const classes = DIRECTION_CLASSES.length, d = DIRECTION_FEATURE_NAMES.length;
  const counts = new Array(classes).fill(0);
  const means = Array.from({ length: classes }, () => new Array(d).fill(0));
  const variances = Array.from({ length: classes }, () => new Array(d).fill(0));
  for (const s of list) { counts[s.y]++; for (let j = 0; j < d; j++) means[s.y][j] += s.z[j]; }
  for (let k = 0; k < classes; k++) for (let j = 0; j < d; j++) means[k][j] /= counts[k] || 1;
  for (const s of list) for (let j = 0; j < d; j++) variances[s.y][j] += (s.z[j] - means[s.y][j]) ** 2;
  for (let k = 0; k < classes; k++) for (let j = 0; j < d; j++) variances[k][j] = Math.max(0.05, variances[k][j] / Math.max(1, counts[k] - 1));
  return { priors: counts.map((n) => n / list.length), means, variances };
}
const gaussian = fitGaussianNb(train);
const gaussianRaw = (s) => DIRECTION_CLASSES.map((_, k) => {
  let out = Math.log(gaussian.priors[k]);
  for (let j = 0; j < s.z.length; j++) out += -0.5 * (Math.log(2 * Math.PI * gaussian.variances[k][j]) + ((s.z[j] - gaussian.means[k][j]) ** 2) / gaussian.variances[k][j]);
  return out;
});
let gaussianTemperature = 1, bestGaussianLoss = Infinity;
for (let t = 0.5; t <= 5.0001; t += 0.05) {
  const loss = -validation.reduce((sum, s) => sum + Math.log(Math.max(1e-12, softmax(gaussianRaw(s).map((x) => x / t))[s.y])), 0) / validation.length;
  if (loss < bestGaussianLoss) { bestGaussianLoss = loss; gaussianTemperature = Number(t.toFixed(2)); }
}
const gaussianCandidate = {
  type: "gaussian_nb",
  params: { ...gaussian, temperature: gaussianTemperature },
  predict: (s) => softmax(gaussianRaw(s).map((x) => x / gaussianTemperature)),
};

// 비선형 상호작용을 확인하는 작은 Extra Trees 앙상블. 브라우저 추론이 가능한 순수 JSON 트리다.
function mulberry32(seed) {
  return () => {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function shuffledFeatures(rng, count, total) {
  const all = Array.from({ length: total }, (_, i) => i);
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all.slice(0, count);
}
function classCounts(indices, list) {
  const counts = new Array(DIRECTION_CLASSES.length).fill(0);
  for (const i of indices) counts[list[i].y]++;
  return counts;
}
function gini(counts) {
  const n = counts.reduce((a, b) => a + b, 0);
  return n ? 1 - counts.reduce((sum, c) => sum + (c / n) ** 2, 0) : 0;
}
function leaf(indices, list) {
  const counts = classCounts(indices, list);
  const total = counts.reduce((a, b) => a + b, 0) + counts.length;
  return { probs: counts.map((n) => (n + 1) / total), n: indices.length };
}
function buildExtraTree(indices, list, rng, depth, options) {
  const counts = classCounts(indices, list);
  if (depth >= options.maxDepth || indices.length < options.minLeaf * 2 || counts.filter(Boolean).length <= 1) {
    return leaf(indices, list);
  }
  let best = null;
  const features = shuffledFeatures(rng, options.mtry, DIRECTION_FEATURE_NAMES.length);
  for (const feature of features) {
    for (let trial = 0; trial < options.thresholdTrials; trial++) {
      const threshold = list[indices[Math.floor(rng() * indices.length)]].z[feature];
      const left = [], right = [];
      for (const i of indices) (list[i].z[feature] <= threshold ? left : right).push(i);
      if (left.length < options.minLeaf || right.length < options.minLeaf) continue;
      const impurity = (left.length * gini(classCounts(left, list)) + right.length * gini(classCounts(right, list))) / indices.length;
      if (!best || impurity < best.impurity) best = { feature, threshold, left, right, impurity };
    }
  }
  if (!best) return leaf(indices, list);
  return {
    feature: best.feature,
    threshold: best.threshold,
    left: buildExtraTree(best.left, list, rng, depth + 1, options),
    right: buildExtraTree(best.right, list, rng, depth + 1, options),
  };
}
function fitExtraTrees(list, options = {}) {
  const cfg = { trees: 48, maxDepth: 6, minLeaf: 100, mtry: 4, thresholdTrials: 3, ...options };
  const rng = mulberry32(20260826);
  const trees = [];
  for (let t = 0; t < cfg.trees; t++) {
    const indices = [];
    for (let i = 0; i < list.length; i++) if (rng() < 0.72) indices.push(i);
    trees.push(buildExtraTree(indices, list, rng, 0, cfg));
    if ((t + 1) % 12 === 0) console.error(`  trees ${t + 1}/${cfg.trees}`);
  }
  return trees;
}
function predictTree(tree, z) {
  let node = tree;
  while (!node.probs) node = z[node.feature] <= node.threshold ? node.left : node.right;
  return node.probs;
}
const extraTrees = fitExtraTrees(train);
const forestRaw = (s) => {
  const sum = new Array(DIRECTION_CLASSES.length).fill(0);
  for (const tree of extraTrees) {
    const p = predictTree(tree, s.z);
    for (let k = 0; k < sum.length; k++) sum[k] += p[k];
  }
  return sum.map((v) => v / extraTrees.length);
};
let forestBlend = 0, bestForestLoss = Infinity;
for (let blend = 0; blend <= 1.0001; blend += 0.05) {
  const predictor = (s) => forestRaw(s).map((p, k) => p * (1 - blend) + trainPriors[k] * blend);
  const loss = logLoss(validation, predictor);
  if (loss < bestForestLoss) { bestForestLoss = loss; forestBlend = Number(blend.toFixed(2)); }
}
const forestCandidate = {
  type: "extra_trees",
  params: { trees: extraTrees, priors: trainPriors, blend: forestBlend },
  predict: (s) => forestRaw(s).map((p, k) => p * (1 - forestBlend) + trainPriors[k] * forestBlend),
};

function logLoss(list, predictor) {
  return -list.reduce((sum, s) => sum + Math.log(Math.max(1e-12, predictor(s)[s.y])), 0) / list.length;
}

function metrics(list, predictor) {
  const counts = new Array(DIRECTION_CLASSES.length).fill(0);
  const predicted = new Array(DIRECTION_CLASSES.length).fill(0);
  const bins = Array.from({ length: 10 }, () => ({ n: 0, confidence: 0, correct: 0 }));
  let correct = 0, brier = 0;
  for (const s of list) {
    counts[s.y]++;
    const p = predictor(s);
    const pred = p.indexOf(Math.max(...p));
    predicted[pred]++;
    if (pred === s.y) correct++;
    for (let k = 0; k < p.length; k++) brier += (p[k] - (s.y === k ? 1 : 0)) ** 2;
    const conf = p[pred];
    const bin = bins[Math.min(9, Math.floor(conf * 10))];
    bin.n++; bin.confidence += conf; if (pred === s.y) bin.correct++;
  }
  const n = list.length;
  const majority = Math.max(...counts) / n;
  const calibration = bins.filter((b) => b.n).map((b) => ({
    n: b.n, confidence: b.confidence / b.n, accuracy: b.correct / b.n,
  }));
  return {
    n,
    accuracy: correct / n,
    majorityBaselineAccuracy: majority,
    logLoss: logLoss(list, predictor),
    brier: brier / n,
    classRate: Object.fromEntries(DIRECTION_CLASSES.map((c, i) => [c, counts[i] / n])),
    predictedRate: Object.fromEntries(DIRECTION_CLASSES.map((c, i) => [c, predicted[i] / n])),
    expectedCalibrationError: calibration.reduce((sum, b) =>
      sum + (b.n / n) * Math.abs(b.confidence - b.accuracy), 0),
    calibration,
  };
}

const priorCandidate = {
  type: "constant_prior",
  params: { priors: trainPriors },
  predict: () => trainPriors,
};
const candidates = [priorCandidate, multiCandidate, factorizedCandidate, gaussianCandidate, forestCandidate];
const candidateMetrics = Object.fromEntries(candidates.map((candidate) => [candidate.type, {
  validation: metrics(validation, candidate.predict),
  test: metrics(test, candidate.predict),
}]));
const selected = candidates.slice().sort((a, b) =>
  candidateMetrics[a.type].validation.logLoss - candidateMetrics[b.type].validation.logLoss
)[0];
console.error(`selected=${selected.type} validationLogLoss=${candidateMetrics[selected.type].validation.logLoss.toFixed(6)}`);
const selectedTest = candidateMetrics[selected.type].test;
const priorTest = candidateMetrics.constant_prior.test;
const ready = selected.type !== "constant_prior"
  && selectedTest.n >= 5000
  && selectedTest.logLoss < priorTest.logLoss
  && selectedTest.brier < priorTest.brier
  && selectedTest.expectedCalibrationError <= 0.08;
console.error(`promotion=${ready ? "PASS" : "FAIL"} testLogLoss=${selectedTest.logLoss.toFixed(6)} prior=${priorTest.logLoss.toFixed(6)}`);

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  dataAsOf: new Date(maxTs).toISOString(),
  source: "Binance USDⓈ-M Futures public 4h klines, current TRADING symbols",
  definition: "next 6 closed 4h bars: first touch of ±clamp(1.5×ATR14%, 2%, 8%); neither=neutral; same-bar both=excluded",
  caveats: [
    "현재 거래 중인 종목만 포함해 상장폐지 종목 생존편향이 있다.",
    "최대 1000개 4시간봉(약 166일)만 사용해 여러 시장 국면을 충분히 포함하지 못한다.",
    "모든 종목-일 표본 모델이며 스캐너 통과 집합만으로 별도 재보정하지 않았다.",
    "확률은 방향 경계 첫 도달 모델이며 TP/SL 도달률이나 기대수익률이 아니다.",
  ],
  excluded: { ambiguous, incomplete, skippedFeatures, failedSymbols: downloaded.filter((r) => r?.error).length },
  boundaries: { minTs, trainEnd, validationEnd, maxTs, purged: split.purged.length },
  counts: { total: samples.length, train: train.length, validation: validation.length, test: test.length },
  candidates: candidateMetrics,
  model: {
    version: 1,
    ready,
    trainedAt: new Date().toISOString(),
    dataAsOf: new Date(maxTs).toISOString(),
    horizonBars: HORIZON_BARS,
    thresholdAtr: 1.5,
    minThresholdPct: 2,
    maxThresholdPct: 8,
    featureNames: DIRECTION_FEATURE_NAMES,
    mean,
    sd,
    type: selected.type,
    params: selected.params,
    promotionGate: {
      passed: ready,
      rules: "non-constant winner; test n>=5000; logLoss and Brier beat train-prior baseline; ECE<=0.08",
      selectedTest: { logLoss: selectedTest.logLoss, brier: selectedTest.brier, expectedCalibrationError: selectedTest.expectedCalibrationError },
      priorTest: { logLoss: priorTest.logLoss, brier: priorTest.brier, expectedCalibrationError: priorTest.expectedCalibrationError },
    },
    metrics: {
      sampleCount: samples.length,
      train: metrics(train, selected.predict),
      validation: metrics(validation, selected.predict),
      test: metrics(test, selected.predict),
    },
  },
};

const jsonText = JSON.stringify(report, null, 2) + "\n";
if (args.output) writeFileSync(args.output, jsonText, "utf8");
if (args.modelOutput) {
  const generated = "// GENERATED by research/train-direction-model.mjs — 검증 게이트 실패 시 ready=false.\n"
    + `export const DIRECTION_MODEL = ${JSON.stringify(report.model, null, 2)};\n\n`
    + "export default DIRECTION_MODEL;\n";
  writeFileSync(args.modelOutput, generated, "utf8");
}
if (args.output) {
  console.log(JSON.stringify({
    output: args.output,
    modelOutput: args.modelOutput,
    selected: report.model.type,
    promotionGate: report.model.promotionGate,
    counts: report.counts,
  }, null, 2));
} else {
  console.log(jsonText);
}
