// api/binance.js — Binance USDⓈ-M Futures 공개 REST 접근 계층.
// 개인 API 키 사용 안 함. 공개 엔드포인트만. 동시요청 제한 + 큐 + 재시도 + 캐시.

import { CONFIG } from "../config.js";
import { state } from "../state.js";

const BASE = CONFIG.api.fapiBase;

// ---- 동시 요청 세마포어 ----
let active = 0;
const queue = [];
function acquire() {
  return new Promise((resolve) => {
    const tryRun = () => {
      if (active < CONFIG.api.maxConcurrent) {
        active++;
        resolve();
      } else {
        queue.push(tryRun);
      }
    };
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
async function rawFetch(path, { timeoutMs = CONFIG.api.requestTimeoutMs } = {}) {
  const url = BASE + path;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
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
  } finally {
    clearTimeout(timer);
  }
}

async function request(path, { ttl = 0, cacheKey } = {}) {
  const key = cacheKey || path;
  if (ttl > 0) {
    const cached = cacheGet(key);
    if (cached !== undefined) return cached;
  }
  await acquire();
  let attempt = 0;
  try {
    while (true) {
      try {
        const data = await rawFetch(path);
        state.apiHealth.connected = true;
        state.apiHealth.lastError = null;
        if (ttl > 0) cacheSet(key, data, ttl);
        return data;
      } catch (e) {
        attempt++;
        const canRetry = attempt <= CONFIG.api.maxRetries;
        if (!canRetry) {
          state.apiHealth.connected = false;
          state.apiHealth.lastError = e.message;
          throw e;
        }
        // 레이트리밋이면 더 길게 대기
        const backoff = CONFIG.api.retryBackoffMs * attempt * (e.rateLimited ? 3 : 1);
        await sleep(backoff);
      }
    }
  } finally {
    release();
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---- 공개 엔드포인트 ----

// 거래 가능한 USDT 무기한 선물 종목 메타
export async function getExchangeInfo() {
  const data = await request("/fapi/v1/exchangeInfo", {
    ttl: CONFIG.cacheTtlMs.exchangeInfo,
    cacheKey: "exchangeInfo",
  });
  return data.symbols || [];
}

// 24시간 티커 전체 (배열)
export async function getTicker24h() {
  return request("/fapi/v1/ticker/24hr", {
    ttl: CONFIG.cacheTtlMs.ticker24h,
    cacheKey: "ticker24h",
  });
}

// 단일 심볼 캔들. interval: 5m/15m/1h/4h ...
export async function getKlines(symbol, interval, limit) {
  const lim = limit || CONFIG.klinesLimit[interval] || 200;
  const ttl = CONFIG.cacheTtlMs[interval] || 60000;
  const path = `/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${lim}`;
  const raw = await request(path, { ttl, cacheKey: `k:${symbol}:${interval}:${lim}` });
  return parseKlines(raw);
}

// Mark Price (필요 시)
export async function getMarkPrice(symbol) {
  return request(`/fapi/v1/premiumIndex?symbol=${symbol}`);
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
  parseKlines, closedOnly, clearCache,
};
