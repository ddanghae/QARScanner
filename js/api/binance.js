// api/binance.js — Binance USDⓈ-M Futures 공개 REST 접근 계층.
// 개인 API 키 사용 안 함. 공개 엔드포인트만. 동시요청 제한 + 큐 + 재시도 + 캐시.

import { CONFIG } from "../config.js";
import { state } from "../state.js";

const BASE = CONFIG.api.fapiBase;

// ---- 동시 요청 세마포어 ----
let active = 0;
const queue = [];
function acquire(signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException("스캔 중단", "AbortError")); return; }
    const cancel = () => {
      const index = queue.indexOf(tryRun);
      if (index >= 0) queue.splice(index, 1);
      signal?.removeEventListener("abort", cancel);
      reject(new DOMException("스캔 중단", "AbortError"));
    };
    const tryRun = () => {
      if (active < CONFIG.api.maxConcurrent) {
        signal?.removeEventListener("abort", cancel);
        active++;
        resolve();
      } else {
        queue.push(tryRun);
      }
    };
    signal?.addEventListener("abort", cancel, { once: true });
    tryRun();
  });
}
function release() {
  active--;
  const next = queue.shift();
  if (next) next();
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
  const cancel = () => ctrl.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) ctrl.abort();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "Accept": "application/json" } });
    // API 사용량 헤더 추적 (있으면)
    const w = res.headers.get("X-MBX-USED-WEIGHT-1M");
    if (w) state.apiHealth.weightUsed = Number(w);
    if (res.status === 429 || res.status === 418) {
      const err = new Error(`레이트리밋 (${res.status})`);
      err.rateLimited = true;
      const value = res.headers.get("Retry-After");
      const seconds = value == null ? NaN : Number(value);
      const duration = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
      err.retryAfterMs = Math.max(0, Number.isFinite(duration) ? duration : 30_000);
      throw err;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${path} ${body.slice(0, 120)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

async function request(path, { ttl = 0, cacheKey, signal, force = false } = {}) {
  if (signal?.aborted) throw new DOMException("스캔 중단", "AbortError");
  const key = cacheKey || path;
  if (ttl > 0 && !force) {
    const cached = cacheGet(key);
    if (cached !== undefined) return cached;
  }
  await acquire(signal);
  let attempt = 0;
  try {
    while (true) {
      try {
        if (signal?.aborted) throw new DOMException("스캔 중단", "AbortError");
        const data = await rawFetch(path, { signal });
        if (signal?.aborted) throw new DOMException("스캔 중단", "AbortError");
        state.apiHealth.connected = true;
        state.apiHealth.lastError = null;
        if (ttl > 0) cacheSet(key, data, ttl);
        return data;
      } catch (e) {
        if (signal?.aborted) throw new DOMException("스캔 중단", "AbortError");
        attempt++;
        const canRetry = attempt <= CONFIG.api.maxRetries;
        if (!canRetry) {
          state.apiHealth.connected = false;
          state.apiHealth.lastError = e.message;
          throw e;
        }
        // 레이트리밋이면 더 길게 대기
        const backoff = Math.max(CONFIG.api.retryBackoffMs * attempt * (e.rateLimited ? 3 : 1), e.retryAfterMs || 0);
        await sleep(backoff, signal);
      }
    }
  } finally {
    release();
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException("스캔 중단", "AbortError")); return; }
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); reject(new DOMException("스캔 중단", "AbortError")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", cancel); resolve(); }, ms);
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

// ---- 공개 엔드포인트 ----

// 거래 가능한 USDT 무기한 선물 종목 메타
export async function getExchangeInfo(options = {}) {
  const data = await request("/fapi/v1/exchangeInfo", {
    ttl: CONFIG.cacheTtlMs.exchangeInfo,
    cacheKey: "exchangeInfo",
    ...options,
  });
  return data.symbols || [];
}

// 24시간 티커 전체 (배열)
export async function getTicker24h(options = {}) {
  return request("/fapi/v1/ticker/24hr", {
    ttl: CONFIG.cacheTtlMs.ticker24h,
    cacheKey: "ticker24h",
    ...options,
  });
}

// 단일 심볼 캔들. interval: 5m/15m/1h/4h ...
export async function getKlines(symbol, interval, limit, options = {}) {
  const lim = limit || CONFIG.klinesLimit[interval] || 200;
  const ttl = CONFIG.cacheTtlMs[interval] || 60000;
  const path = `/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${lim}`;
  const raw = await request(path, { ttl, cacheKey: `k:${symbol}:${interval}:${lim}`, ...options });
  return parseKlines(raw);
}

// Mark Price (필요 시)
export async function getMarkPrice(symbol) {
  return request(`/fapi/v1/premiumIndex?symbol=${symbol}`);
}

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
  } catch (e) {
    // 신규 상장 등으로 데이터가 없으면 빈 배열 (후보를 죽이지 않는다)
    console.warn(`미결제약정 조회 실패 (${symbol})`, e);
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
  getExchangeInfo, getTicker24h, getKlines, getMarkPrice,
  getOpenInterestHist, getPremiumIndexAll,
  parseKlines, closedOnly, clearCache,
};
