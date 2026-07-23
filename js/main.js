// main.js — 진입점. UI 초기화 + 스캔 버튼 + 서비스워커 등록 + 백그라운드 처리.
// index.html 에서 <script type="module" src="./js/main.js"> 로 로드.

import { state, on, emit } from "./state.js";
import { runScan, abortScan, startAutoRefresh, stopAutoRefresh } from "./scanner/scan-controller.js";
import { initDashboard } from "./ui/dashboard.js";
import { initSettingsUI } from "./ui/settings.js";
import { initDetailPanel } from "./ui/detail-panel.js";
import { toast, notifyError } from "./ui/notifications.js";

function boot() {
  initSettingsUI();
  initDetailPanel();
  initDashboard();

  // 스캔 버튼
  document.getElementById("scan-btn")?.addEventListener("click", () => {
    runScan().catch((e) => notifyError(null, e.message));
  });
  document.getElementById("stop-btn")?.addEventListener("click", () => abortScan());

  // 사이드바 — 기존 컨트롤을 대신 클릭/토글하는 얇은 위임 (중복 상태 없음)
  document.querySelectorAll("[data-click]").forEach((btn) => {
    btn.addEventListener("click", () => document.getElementById(btn.dataset.click)?.click());
  });
  document.querySelectorAll("[data-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => document.getElementById(btn.dataset.toggle)?.click());
  });

  initTabs();

  // 오류 이벤트 → 토스트
  on("scan:error", (msg) => notifyError(null, msg));
  on("scan:done", (info) => toast(`스캔 완료 — 후보 ${info.count}개`, "success"));
  on("scan:aborted", () => toast("스캔을 중단했습니다.", "info"));
  document.addEventListener("tv:popup-blocked", () => notifyError("tvPopup"));

  // 자동 갱신 토글 (§15)
  on("autorefresh:toggle", (onFlag) => {
    if (onFlag) { startAutoRefresh(); toast("자동 갱신 켜짐", "info"); }
    else { stopAutoRefresh(); toast("자동 갱신 꺼짐", "info"); }
  });
  if (state.settings.autoRefresh) startAutoRefresh();

  // 백그라운드 전환 시 갱신 빈도 감소 (§18) — 다음 예약부터 배수 적용
  document.addEventListener("visibilitychange", () => {
    state.backgrounded = document.hidden;
  });

  // 네트워크 상태
  window.addEventListener("offline", () => notifyError("network"));
  window.addEventListener("online", () => toast("네트워크 재연결됨", "success"));

  registerServiceWorker();
  console.log("QAR ICT Early Scanner 준비 완료");
}

// 개요 / 설정 탭 전환 — 두 뷰를 show/hide 하고 사이드바 active + 톱바 제목 갱신
function initTabs() {
  const views = { overview: document.getElementById("view-overview"), settings: document.getElementById("view-settings") };
  const titles = { overview: "개요", settings: "설정" };
  const navBtns = document.querySelectorAll("[data-nav]");
  navBtns.forEach((btn) => btn.addEventListener("click", () => {
    const nav = btn.dataset.nav;
    if (!views[nav]) return;
    for (const [k, el] of Object.entries(views)) if (el) el.hidden = k !== nav;
    navBtns.forEach((b) => b.classList.toggle("active", b === btn));
    const h1 = document.querySelector(".topbar-title h1");
    if (h1 && titles[nav]) h1.textContent = titles[nav];
  }));
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    // 상대경로 — GitHub Pages 하위 경로에서도 동작
    await navigator.serviceWorker.register("./sw.js");
  } catch (e) {
    console.warn("서비스워커 등록 실패", e);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
