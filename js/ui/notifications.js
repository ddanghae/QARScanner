// ui/notifications.js — 사용자 알림/오류 표시 (§20).
// 화면 전체가 멈추지 않게, 개별 오류를 토스트로 표시.

let container = null;

function ensureContainer() {
  if (container) return container;
  container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    container.className = "toast-container";
    document.body.appendChild(container);
  }
  return container;
}

// type: info|warn|error|success
export function toast(message, type = "info", timeout = 4000) {
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.textContent = message;
  ensureContainer().appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  const remove = () => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 250);
  };
  if (timeout > 0) setTimeout(remove, timeout);
  el.addEventListener("click", remove);
  return remove;
}

// §20 표준 오류 문구
export const ERRORS = {
  apiFail: "Binance API 연결 실패 — 잠시 후 다시 시도하세요.",
  rateLimit: "요청 제한에 도달했습니다 — 동시 요청 수를 줄이거나 잠시 기다리세요.",
  network: "네트워크 연결이 끊겼습니다.",
  klineShort: "일부 종목의 캔들 데이터가 부족합니다.",
  newListing: "신규 상장 종목으로 분석이 제한됩니다.",
  partialTf: "일부 시간봉만 수신되었습니다.",
  tvPopup: "TradingView 팝업이 차단되었습니다 — 링크를 복사했습니다.",
  cacheData: "캐시된 데이터를 사용 중입니다.",
  wsReconnect: "WebSocket 재연결 중…",
};

export function notifyError(key, fallback) {
  toast(ERRORS[key] || fallback || "오류가 발생했습니다.", "error", 5000);
}

export default { toast, notifyError, ERRORS };
