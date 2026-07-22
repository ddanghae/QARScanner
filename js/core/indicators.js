// core/indicators.js — 표준 기술지표. 순수 함수, 재현·테스트 가능.
// 입력은 마감 캔들 배열(과거→현재). 미래 데이터 참조(lookahead) 없음.
// 각 함수는 입력 길이와 같은 길이 배열 반환 (계산 불가 구간은 null).

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (prev === null) {
      // 시드: 첫 period 개의 SMA
      if (i >= period - 1) {
        let s = 0;
        for (let j = i - period + 1; j <= i; j++) s += values[j];
        prev = s / period;
        out[i] = prev;
      }
    } else {
      prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

// Wilder RSI
export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d >= 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export function macd(closes, fast = 12, slow = 26, signalP = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = closes.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null
  );
  // 시그널은 macdLine의 EMA (null 구간 건너뜀)
  const valid = macdLine.map((v) => (v == null ? 0 : v));
  const firstIdx = macdLine.findIndex((v) => v != null);
  const signalLine = new Array(closes.length).fill(null);
  if (firstIdx >= 0) {
    const slice = valid.slice(firstIdx);
    const sig = ema(slice, signalP);
    for (let i = 0; i < sig.length; i++) signalLine[firstIdx + i] = sig[i];
  }
  const histogram = closes.map((_, i) =>
    macdLine[i] != null && signalLine[i] != null ? macdLine[i] - signalLine[i] : null
  );
  return { macdLine, signalLine, histogram };
}

// True Range 배열
export function trueRange(candles) {
  const out = new Array(candles.length).fill(null);
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (i === 0) { out[i] = c.high - c.low; continue; }
    const p = candles[i - 1].close;
    out[i] = Math.max(c.high - c.low, Math.abs(c.high - p), Math.abs(c.low - p));
  }
  return out;
}

// Wilder ATR
export function atr(candles, period = 14) {
  const tr = trueRange(candles);
  const out = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  let prev = sum / period;
  out[period] = prev;
  for (let i = period + 1; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

export function bollinger(closes, period = 20, mult = 2) {
  const mid = sma(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  const width = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += (closes[j] - mid[i]) ** 2;
    const sd = Math.sqrt(s / period);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
    width[i] = mid[i] ? (upper[i] - lower[i]) / mid[i] : null;
  }
  return { mid, upper, lower, width };
}

// 일일 VWAP — UTC 00:00 리셋. candles에 openTime(ms) 필요.
export function dailyVwap(candles) {
  const out = new Array(candles.length).fill(null);
  let cumPV = 0, cumV = 0, curDay = null;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const day = Math.floor(c.openTime / 86_400_000); // UTC 일 단위
    if (day !== curDay) { curDay = day; cumPV = 0; cumV = 0; }
    const typical = (c.high + c.low + c.close) / 3;
    cumPV += typical * c.volume;
    cumV += c.volume;
    out[i] = cumV > 0 ? cumPV / cumV : null;
  }
  return out;
}

export function obv(candles) {
  const out = new Array(candles.length).fill(null);
  let v = 0;
  out[0] = 0;
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].close > candles[i - 1].close) v += candles[i].volume;
    else if (candles[i].close < candles[i - 1].close) v -= candles[i].volume;
    out[i] = v;
  }
  return out;
}

// Stochastic RSI
export function stochRsi(closes, rsiP = 14, stochP = 14, kP = 3, dP = 3) {
  const r = rsi(closes, rsiP);
  const kRaw = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i++) {
    if (i < rsiP + stochP) continue;
    let lo = Infinity, hi = -Infinity;
    for (let j = i - stochP + 1; j <= i; j++) {
      if (r[j] == null) { lo = null; break; }
      lo = Math.min(lo, r[j]); hi = Math.max(hi, r[j]);
    }
    if (lo == null || hi === lo) { kRaw[i] = 0; continue; }
    kRaw[i] = ((r[i] - lo) / (hi - lo)) * 100;
  }
  const k = sma(kRaw.map((x) => (x == null ? 0 : x)), kP);
  const d = sma(k.map((x) => (x == null ? 0 : x)), dP);
  return { k, d };
}

// 마지막 유효(비-null) 값
export function last(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
  return null;
}
export function lastIndexValid(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return i;
  return -1;
}

// 전체 지표를 한 번에 계산해 캔들 세트에 붙인다.
export function computeIndicators(candles, cfg) {
  const closes = candles.map((c) => c.close);
  const emas = {};
  for (const p of cfg.emaPeriods) emas[p] = ema(closes, p);
  return {
    closes,
    ema: emas,
    sma20: sma(closes, cfg.smaPeriod),
    rsi: rsi(closes, cfg.rsiPeriod),
    macd: macd(closes, cfg.macd.fast, cfg.macd.slow, cfg.macd.signal),
    bb: bollinger(closes, cfg.bb.period, cfg.bb.mult),
    atr: atr(candles, cfg.atrPeriod),
    vwap: dailyVwap(candles),
    obv: cfg.obvEnabled ? obv(candles) : null,
    stochRsi: stochRsi(closes, cfg.stochRsi.rsi, cfg.stochRsi.stoch, cfg.stochRsi.k, cfg.stochRsi.d),
  };
}

export default {
  sma, ema, rsi, macd, trueRange, atr, bollinger, dailyVwap, obv, stochRsi,
  last, lastIndexValid, computeIndicators,
};
