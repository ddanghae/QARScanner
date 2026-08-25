// api/binance.js — Binance USDⓈ-M Futures 공개 REST 접근 계층.
// 개인 API 키 사용 안 함. 공개 엔드포인트만. 동시요청 제한 + 큐 + 재시도 + 캐시.

import { CONFIG } from "../config.js";
import { state, emit } from "../state.js";

const BASE = CONFIG.api.fapiBase;

// ---- 동시 요청 세마포어 ----
let active = 0;
const queue = [];
function abortError(message = "요청이 중단되었습니다.") {
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}
function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}
function acquire(signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const entry = { signal, resolve, reject, onAbort: null };
    const run = () => {
      if (signal?.aborted) { reject(abortError()); return false; }
      if (entry.onAbort) signal.removeEventListener("abort", entry.onAbort);
      active++;
      resolve();
      return true;
    };
    entry.run = run;
    if (active < CONFIG.api.maxConcurrent) {
      run();
      return;
    }
    entry.onAbort = () => {
      const index = queue.indexOf(entry);
      if (index >= 0) queue.splice(index, 1);
      reject(abortError());
    };
    signal?.addEventListener("abort", entry.onAbort, { once: true });
    queue.push(entry);
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
const inFlight = new Map(); // key -> { promise, signal }
let blockedUntil = 0;
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > hit.ttl) { cache.delete(key); return undefined; }
  return hit.data;
}
function cacheSet(key, data, ttl) {
  cache.set(key, { at: Date.now(), ttl, data });
  pruneCache();
}
export function clearCache() { cache.clear(); }

function pruneCache() {
  const now = Date.now();
  for (const [key, hit] of cache) {
    if (now - hit.at > hit.ttl) cache.delete(key);
  }
  const max = Math.max(1, Number(CONFIG.api.maxCacheEntries) || 1200);
  while (cache.size > max) cache.delete(cache.keys().next().value);
}

// ---- 저수준 fetch: 타임아웃 + 재시도 + 백오프 ----
async function rawFetch(path, { timeoutMs = CONFIG.api.requestTimeoutMs, signal } = {}) {
  throwIfAborted(signal);
  const url = BASE + path;
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "Accept": "application/json" } });
    throwIfAborted(signal);
    // API 사용량 헤더 추적 (있으면)
    const w = res.headers.get("X-MBX-USED-WEIGHT-1M");
    if (w) {
      state.apiHealth.weightUsed = Number(w);
      if (state.apiHealth.weightUsed >= CONFIG.api.weightPauseAt) {
        blockRequests(CONFIG.api.weightCooldownMs, "API 사용량이 높아 잠시 쉽니다.", "weight");
      }
      emit("apihealth:changed", { ...state.apiHealth });
    }
    if (res.status === 429 || res.status === 418) {
      const err = new Error(`레이트리밋 (${res.status})`);
      err.status = res.status;
      err.rateLimited = true;
      err.retryAfterMs = retryAfterMs(res.headers.get("Retry-After"),
        res.status === 418 ? CONFIG.api.banFallbackMs : CONFIG.api.rateLimitFallbackMs);
      blockRequests(err.retryAfterMs, err.message, String(res.status));
      throw err;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err = new Error(`HTTP ${res.status} ${path} ${body.slice(0, 120)}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    throwIfAborted(signal);
    return data;
  } catch (e) {
    if (signal?.aborted) throw abortError();
    if (timedOut) {
      const err = new Error("요청 시간이 초과되었습니다.");
      err.status = 408;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function retryAfterMs(value, fallback) {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value || "");
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return fallback;
}

function blockRequests(ms, message, reason) {
  blockedUntil = Math.max(blockedUntil, Date.now() + Math.max(0, ms || 0));
  state.apiHealth.blockedUntil = blockedUntil;
  state.apiHealth.lastError = message;
  state.apiHealth.lastStatus = reason;
  emit("apihealth:changed", { ...state.apiHealth });
  emit("api:blocked", { until: blockedUntil, message, reason });
}

async function waitForCooldown(signal) {
  const wait = blockedUntil - Date.now();
  if (wait > 0) await sleep(wait, signal);
}

export function shouldRetryError(error) {
  if (!error || error.name === "AbortError" || error.status === 418) return false;
  if (error.status == null) return true;
  return error.status === 408 || error.status === 429 || error.status >= 500;
}

export function retryDelayFor(error, attempt) {
  if (Number.isFinite(error?.retryAfterMs)) return Math.max(0, error.retryAfterMs);
  return CONFIG.api.retryBackoffMs * Math.max(1, attempt);
}

async function performRequest(path, { ttl, key, signal }) {
  await waitForCooldown(signal);
  await acquire(signal);
  let attempt = 0;
  try {
    while (true) {
      throwIfAborted(signal);
      await waitForCooldown(signal);
      try {
        const data = await rawFetch(path, { signal });
        throwIfAborted(signal);
        state.apiHealth.connected = true;
        state.apiHealth.lastError = null;
        state.apiHealth.lastStatus = "ok";
        throwIfAborted(signal);
        if (ttl > 0) cacheSet(key, data, ttl);
        emit("apihealth:changed", { ...state.apiHealth });
        return data;
      } catch (e) {
        if (e.name === "AbortError") throw e;
        attempt++;
        const canRetry = attempt <= CONFIG.api.maxRetries && shouldRetryError(e);
        if (!canRetry) {
          state.apiHealth.connected = false;
          state.apiHealth.lastError = e.message;
          state.apiHealth.lastStatus = e.status ?? "network";
          emit("apihealth:changed", { ...state.apiHealth });
          throw e;
        }
        await sleep(retryDelayFor(e, attempt), signal);
      }
    }
  } finally {
    release();
  }
}

async function request(path, { ttl = 0, cacheKey, signal } = {}) {
  throwIfAborted(signal);
  const key = cacheKey || path;
  if (ttl > 0) {
    const cached = cacheGet(key);
    if (cached !== undefined) return cached;
  }
  const existing = inFlight.get(key);
  if (existing && existing.signal === signal) return existing.promise;
  const entry = { signal, promise: null };
  entry.promise = performRequest(path, { ttl, key, signal }).finally(() => {
    if (inFlight.get(key) === entry) inFlight.delete(key);
  });
  inFlight.set(key, entry);
  return entry.promise;
}

function sleep(ms, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, Math.max(0, ms));
    function done() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      reject(abortError());
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function apiRuntimeSnapshot() {
  return { active, queued: queue.length, inFlight: inFlight.size, cacheEntries: cache.size, blockedUntil };
}

export function resetApiRuntimeForTests() {
  cache.clear();
  inFlight.clear();
  blockedUntil = 0;
  state.apiHealth.blockedUntil = 0;
  while (queue.length) {
    const entry = queue.shift();
    entry.reject(abortError());
  }
}

// ---- 공개 엔드포인트 ----

// 거래 가능한 USDT 무기한 선물 종목 메타
export async function getExchangeInfo(options = {}) {
  const data = await request("/fapi/v1/exchangeInfo", {
    ttl: CONFIG.cacheTtlMs.exchangeInfo,
    cacheKey: "exchangeInfo",
    signal: options.signal,
  });
  return data.symbols || [];
}

// 24시간 티커 전체 (배열)
export async function getTicker24h(options = {}) {
  return request("/fapi/v1/ticker/24hr", {
    ttl: CONFIG.cacheTtlMs.ticker24h,
    cacheKey: "ticker24h",
    signal: options.signal,
  });
}

// 단일 심볼 캔들. interval: 5m/15m/1h/4h ...
export async function getKlines(symbol, interval, limit, options = {}) {
  const lim = limit || CONFIG.klinesLimit[interval] || 200;
  const ttl = CONFIG.cacheTtlMs[interval] || 60000;
  const end = Number.isFinite(options.endTime) ? `&endTime=${Math.floor(options.endTime)}` : "";
  const path = `/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${lim}${end}`;
  const bucketSource = options.cacheBucket ?? options.endTime;
  const intervalSize = intervalToMs(interval);
  const numericBucket = Number(bucketSource);
  const bucket = Number.isFinite(numericBucket) && intervalSize
    ? Math.floor(numericBucket / intervalSize) * intervalSize
    : bucketSource ?? "latest";
  const raw = await request(path, {
    ttl,
    cacheKey: `k:${symbol}:${interval}:${lim}:${bucket}`,
    signal: options.signal,
  });
  return parseKlines(raw);
}

function intervalToMs(interval) {
  const match = /^(\d+)([mhdw])$/.exec(String(interval));
  if (!match) return null;
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[match[2]];
  return Number(match[1]) * unit;
}

// Mark Price (필요 시)
export async function getMarkPrice(symbol, options = {}) {
  return request(`/fapi/v1/premiumIndex?symbol=${symbol}`, { signal: options.signal });
}

// 미결제약정 추이 (공개). period: 5m/15m/30m/1h/2h/4h/6h/12h/1d, 최근 30일치만 제공.
// 반환: [{ time, oi }] 과거→현재. 데이터 없으면 빈 배열.
export async function getOpenInterestHist(symbol, period, limit, options = {}) {
  const p = period || CONFIG.earlyDetect.oiPeriod;
  const lim = limit || CONFIG.earlyDetect.oiLimit;
  const path = `/futures/data/openInterestHist?symbol=${symbol}&period=${p}&limit=${lim}`;
  try {
    const raw = await request(path, {
      ttl: CONFIG.cacheTtlMs["1h"], cacheKey: `oi:${symbol}:${p}:${lim}`, signal: options.signal,
    });
    if (!Array.isArray(raw)) return [];
    return raw.map((r) => ({ time: r.timestamp, oi: +r.sumOpenInterest }));
  } catch (e) {
    if (e.name === "AbortError" || e.rateLimited) throw e;
    options.onDegraded?.({ endpoint: "openInterest", symbol, error: e });
    // 신규 상장 등으로 데이터가 없으면 빈 배열 (후보를 죽이지 않는다)
    console.warn(`미결제약정 조회 실패 (${symbol})`, e);
    return [];
  }
}

// 전 종목 펀딩비 1회 호출 (심볼 미지정 → 배열). 반환: Map<symbol, lastFundingRate>
export async function getPremiumIndexAll(options = {}) {
  try {
    const raw = await request("/fapi/v1/premiumIndex", {
      ttl: CONFIG.cacheTtlMs.ticker24h,
      cacheKey: "premiumIndexAll",
      signal: options.signal,
    });
    const arr = Array.isArray(raw) ? raw : [raw];
    return new Map(arr.map((r) => [r.symbol, +r.lastFundingRate]));
  } catch (e) {
    if (e.name === "AbortError" || e.rateLimited) throw e;
    options.onDegraded?.({ endpoint: "funding", error: e });
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
export function closedOnly(candles, includeRealtime, cutoff) {
  if (!Array.isArray(candles)) return [];
  if (Number.isFinite(cutoff)) {
    return candles.filter((c) => includeRealtime
      ? Number(c?.openTime) <= cutoff
      : Number(c?.closeTime) <= cutoff);
  }
  if (includeRealtime) return candles;
  return candles.slice(0, -1);
}

export default {
  getExchangeInfo, getTicker24h, getKlines, getMarkPrice,
  getOpenInterestHist, getPremiumIndexAll,
  parseKlines, closedOnly, clearCache,
  shouldRetryError, retryDelayFor, apiRuntimeSnapshot,
};
