// api/binance.js — Binance USDⓈ-M Futures 공개 REST 접근 계층.
// 개인 API 키 사용 안 함. 공개 엔드포인트만. 동시요청 제한 + 큐 + 재시도 + 캐시.

import { CONFIG } from "../config.js";
import { state } from "../state.js";

const BASE = CONFIG.api.fapiBase;

// ---- 동시 요청 세마포어 ----
let active = 0;
const queue = [];

function abortError() {
  if (typeof DOMException === "function") return new DOMException("사용자가 요청을 중단했습니다.", "AbortError");
  const error = new Error("사용자가 요청을 중단했습니다.");
  error.name = "AbortError";
  return error;
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function acquire(signal) {
  return new Promise((resolve, reject) => {
    const waiter = {
      run() {
        if (signal?.aborted) {
          reject(abortError());
          return false;
        }
        if (active < CONFIG.api.maxConcurrent) {
          active++;
          signal?.removeEventListener("abort", onAbort);
          resolve();
          return true;
        }
        queue.push(waiter);
        return false;
      },
    };
    const onAbort = () => {
      const index = queue.indexOf(waiter);
      if (index >= 0) queue.splice(index, 1);
      reject(abortError());
    };
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    waiter.run();
  });
}

function release() {
  active = Math.max(0, active - 1);
  while (queue.length) {
    const next = queue.shift();
    if (next.run()) break;
  }
}

// ---- 캐시 ----
const cache = new Map(); // key -> { at, ttl, data }
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > hit.ttl) { cache.delete(key); return undefined; }
  return hit.data;
}
function cacheSet(key, data, ttl) {
  cache.set(key, { at: Date.now(), ttl, data });
}
export function clearCache() { cache.clear(); }

// ---- 저수준 fetch: 타임아웃 + 재시도 + 백오프 ----
async function rawFetch(path, { timeoutMs = CONFIG.api.requestTimeoutMs, signal } = {}) {
  const url = BASE + path;
  const ctrl = new AbortController();
  let timedOut = false;
  const onAbort = () => ctrl.abort();
  throwIfAborted(signal);
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "Accept": "application/json" } });
    // API 사용량 헤더 추적 (있으면)
    const w = res.headers.get("X-MBX-USED-WEIGHT-1M");
    if (w) state.apiHealth.weightUsed = Number(w);
    if (res.status === 429 || res.status === 418) {
      const err = new Error(`레이트리밋 (${res.status})`);
      err.rateLimited = true;
      throw err;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${path} ${body.slice(0, 120)}`);
    }
    return await res.json();
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (timedOut && isAbortError(error)) {
      const timeoutError = new Error(`요청 시간 초과 (${timeoutMs}ms)`);
      timeoutError.timeout = true;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function request(path, { ttl = 0, cacheKey, signal } = {}) {
  throwIfAborted(signal);
  const key = cacheKey || path;
  if (ttl > 0) {
    const cached = cacheGet(key);
    if (cached !== undefined) return cached;
  }
  await acquire(signal);
  let attempt = 0;
  try {
    while (true) {
      try {
        throwIfAborted(signal);
        const data = await rawFetch(path, { signal });
        state.apiHealth.connected = true;
        state.apiHealth.lastError = null;
        if (ttl > 0) cacheSet(key, data, ttl);
        return data;
      } catch (e) {
        if (isAbortError(e) || signal?.aborted) throw abortError();
        attempt++;
        const canRetry = attempt <= CONFIG.api.maxRetries;
        if (!canRetry) {
          state.apiHealth.connected = false;
          state.apiHealth.lastError = e.message;
          throw e;
        }
        // 레이트리밋이면 더 길게 대기
        const backoff = CONFIG.api.retryBackoffMs * attempt * (e.rateLimited ? 3 : 1);
        await sleep(backoff, signal);
      }
    }
  } finally {
    release();
  }
}

function sleep(ms, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ---- 공개 엔드포인트 ----

// 거래 가능한 USDT 무기한 선물 종목 메타
export async function getExchangeInfo(signal) {
  const data = await request("/fapi/v1/exchangeInfo", {
    ttl: CONFIG.cacheTtlMs.exchangeInfo,
    cacheKey: "exchangeInfo",
    signal,
  });
  return data.symbols || [];
}

// 24시간 티커 전체 (배열)
export async function getTicker24h(signal) {
  return request("/fapi/v1/ticker/24hr", {
    ttl: CONFIG.cacheTtlMs.ticker24h,
    cacheKey: "ticker24h",
    signal,
  });
}

// 단일 심볼 캔들. interval: 5m/15m/1h/4h ...
export async function getKlines(symbol, interval, limit, signal) {
  const lim = limit || CONFIG.klinesLimit[interval] || 200;
  const ttl = CONFIG.cacheTtlMs[interval] || 60000;
  const path = `/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${lim}`;
  const raw = await request(path, { ttl, cacheKey: `k:${symbol}:${interval}:${lim}`, signal });
  return parseKlines(raw);
}

// Closed forward-paper outcomes need an exact post-detection range, not the latest N candles.
export function buildKlineRangePath(symbol, interval, startTime, endTime, limit = 1500) {
  const safeSymbol = String(symbol || "").trim().toUpperCase();
  const safeInterval = String(interval || "").trim();
  const start = startTime == null ? NaN : Math.floor(Number(startTime));
  const end = endTime == null ? NaN : Math.floor(Number(endTime));
  const lim = Math.min(1500, Math.max(1, Math.floor(Number(limit)) || 1));
  if (!/^[A-Z0-9_]+$/.test(safeSymbol)) throw new Error("Invalid symbol for kline range");
  if (!/^[1-9][0-9]*[mhdwM]$/.test(safeInterval)) throw new Error("Invalid interval for kline range");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new Error("Invalid kline time range");
  return `/fapi/v1/klines?symbol=${encodeURIComponent(safeSymbol)}&interval=${encodeURIComponent(safeInterval)}&startTime=${start}&endTime=${end}&limit=${lim}`;
}

export async function getKlinesRange(symbol, interval, startTime, endTime, limit = 1500, signal) {
  const path = buildKlineRangePath(symbol, interval, startTime, endTime, limit);
  const ttl = CONFIG.cacheTtlMs[interval] || 60000;
  const raw = await request(path, { ttl, cacheKey: `range:${path}`, signal });
  return parseKlines(raw);
}

// Mark Price (필요 시)
export async function getMarkPrice(symbol, signal) {
  return request(`/fapi/v1/premiumIndex?symbol=${symbol}`, { signal });
}

// 미결제약정 추이 (공개). period: 5m/15m/30m/1h/2h/4h/6h/12h/1d, 최근 30일치만 제공.
// 반환: [{ time, oi }] 과거→현재. 데이터 없으면 빈 배열.
export async function getOpenInterestHist(symbol, period, limit, signal) {
  const p = period || CONFIG.earlyDetect.oiPeriod;
  const lim = limit || CONFIG.earlyDetect.oiLimit;
  const path = `/futures/data/openInterestHist?symbol=${symbol}&period=${p}&limit=${lim}`;
  try {
    const raw = await request(path, { ttl: CONFIG.cacheTtlMs["1h"], cacheKey: `oi:${symbol}:${p}:${lim}`, signal });
    if (!Array.isArray(raw)) return [];
    return raw.map((r) => ({ time: r.timestamp, oi: +r.sumOpenInterest }));
  } catch (e) {
    if (isAbortError(e) || signal?.aborted) throw abortError();
    // 신규 상장·일시 오류는 빈 배열. early 판정 계층에서 자료 부족으로 fail closed한다.
    console.warn(`미결제약정 조회 실패 (${symbol})`, e);
    return [];
  }
}

// 전 종목 펀딩비 1회 호출 (심볼 미지정 → 배열). 반환: Map<symbol, lastFundingRate>
export async function getPremiumIndexAll(signal) {
  try {
    const raw = await request("/fapi/v1/premiumIndex", {
      ttl: CONFIG.cacheTtlMs.ticker24h,
      cacheKey: "premiumIndexAll",
      signal,
    });
    const arr = Array.isArray(raw) ? raw : [raw];
    return new Map(arr.map((r) => [r.symbol, +r.lastFundingRate]));
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) throw abortError();
    return new Map();
  }
}

// ---- 캔들 파싱 ----
// Binance kline 배열 인덱스:
// 0 openTime,1 open,2 high,3 low,4 close,5 volume,6 closeTime,
// 7 quoteVolume,8 trades,9 takerBuyBase,10 takerBuyQuote,11 ignore
export function parseKlines(raw) {
  return raw.map((k) => {
    const volume = +k[5];
    const takerBuyBase = +k[9];
    return {
      openTime: k[0],
      open: +k[1],
      high: +k[2],
      low: +k[3],
      close: +k[4],
      volume,
      closeTime: k[6],
      quoteVolume: +k[7],
      trades: +k[8],
      takerBuyBase,
      takerBuyQuote: +k[10],
      takerSellBase: volume - takerBuyBase, // 추정 Taker Sell
    };
  });
}

// 마감 캔들만 반환 (리페인트 방지). 마지막(진행 중) 캔들 제외 옵션.
export function closedOnly(candles, includeRealtime) {
  if (includeRealtime) return candles;
  return candles.slice(0, -1);
}

export default {
  getExchangeInfo, getTicker24h, getKlines, getKlinesRange, getMarkPrice,
  getOpenInterestHist, getPremiumIndexAll,
  parseKlines, closedOnly, clearCache, buildKlineRangePath,
};
