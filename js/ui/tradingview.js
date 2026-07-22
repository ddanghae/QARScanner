// ui/tradingview.js — TradingView 연결 (§16).
// 후보 클릭 → 새 탭에서 로그인된 TradingView 차트 열기.
// 유료/Invite-Only 지표 자동설치·복제 안 함. 단순 링크만.

import { CONFIG } from "../config.js";

// BINANCE:${symbol}.P  (USDⓈ-M 무기한)
export function tvSymbol(symbol) {
  return `BINANCE:${symbol}${CONFIG.ui.tradingViewSuffix}`;
}

export function tvChartUrl(symbol) {
  const sym = tvSymbol(symbol);
  return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(sym)}`;
}

export function binanceFuturesUrl(symbol) {
  return `https://www.binance.com/en/futures/${symbol}`;
}

// 실제 사용자 클릭 이벤트 안에서 호출 → 아이폰 Safari 팝업 차단 회피.
export function openTradingView(symbol) {
  const url = tvChartUrl(symbol);
  const win = window.open(url, "_blank", "noopener,noreferrer");
  if (!win) {
    // 팝업 차단됨 → 이벤트 알림
    document.dispatchEvent(new CustomEvent("tv:popup-blocked", { detail: { url } }));
  }
  return url;
}

export async function copyTvLink(symbol) {
  const url = tvChartUrl(symbol);
  try {
    await navigator.clipboard.writeText(url);
    return true;
  } catch {
    return false;
  }
}

export default { tvSymbol, tvChartUrl, binanceFuturesUrl, openTradingView, copyTvLink };
