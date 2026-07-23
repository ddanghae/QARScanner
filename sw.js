// sw.js — 서비스워커 (§19 PWA).
// 앱 셸(정적 파일)만 캐시. Binance API 응답은 절대 캐시하지 않음(데이터 최신성).
// 캐시 버전을 명확히 관리 → 최신 코드 미반영 문제 방지.

const CACHE_VERSION = "qar-ict-v3";
const APP_SHELL = [
  "./",
  "./index.html",
  "./css/style.css",
  "./manifest.webmanifest",
  "./js/main.js",
  "./js/config.js",
  "./js/state.js",
  "./js/api/binance.js",
  "./js/core/indicators.js",
  "./js/core/volume-analysis.js",
  "./js/core/market-structure.js",
  "./js/core/liquidity.js",
  "./js/core/fvg.js",
  "./js/core/order-block.js",
  "./js/core/risk-reward.js",
  "./js/core/scoring.js",
  "./js/scanner/prefilter.js",
  "./js/scanner/deep-scanner.js",
  "./js/scanner/scan-controller.js",
  "./js/ui/dashboard.js",
  "./js/ui/detail-panel.js",
  "./js/ui/settings.js",
  "./js/ui/notifications.js",
  "./js/ui/tradingview.js",
  "./js/ui/format.js",
];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_VERSION).then((c) => c.addAll(APP_SHELL).catch(() => {}))
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Binance API / 외부 도메인 → 캐시 우회, 항상 네트워크
  if (url.hostname.includes("binance.com") || url.hostname.includes("tradingview.com")) {
    return; // 기본 네트워크 처리
  }
  // 동일 출처 정적 자산만 처리
  if (url.origin !== self.location.origin) return;

  // 앱 셸: 네트워크 우선 → 실패 시 캐시 (최신 코드 우선, 오프라인 폴백)
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("./index.html")))
  );
});
