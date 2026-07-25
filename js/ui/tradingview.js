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
  // features 에 "noopener" 를 넣으면 스펙상 window.open 이 항상 null 을 반환한다.
  // 그래서 정상 오픈까지 팝업 차단으로 오판해 매번 오류 토스트가 떴다.
  // 차단 여부를 판별하려면 반환값이 필요하므로 opener 는 수동으로 끊는다.
  const win = window.open(url, "_blank");
  if (win) {
    win.opener = null;
    return url;
  }
  document.dispatchEvent(new CustomEvent("tv:popup-blocked", { detail: { url } }));
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
