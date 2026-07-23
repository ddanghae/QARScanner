// ui/dashboard.js — 상단 상태(§15) + 결과 카드/테이블 렌더.
// 스캔 이벤트 구독 → 진행률/상태/결과 갱신. 모바일은 카드 UI.

import { state, on, isFavorite, toggleFavorite } from "../state.js";
import { CONFIG } from "../config.js";
import { fmtPrice, fmtPct, fmtVolume, fmtTime, pctClass, escapeHtml } from "./format.js";
import { applyFilters } from "./settings.js";
import { showDetail } from "./detail-panel.js";
import { openTradingView } from "./tradingview.js";

let resultsEl, statusEl, progressEl;

export function initDashboard() {
  resultsEl = document.getElementById("results");
  statusEl = document.getElementById("status-bar");
  progressEl = document.getElementById("scan-progress");

  // 스캔 이벤트 구독
  on("scan:start", () => { renderStatus(); setBusy(true); });
  on("scan:phase", renderStatus);
  on("scan:progress", renderProgress);
  on("scan:prefiltered", renderStatus);
  on("scan:candidates", renderStatus);
  on("scan:done", () => { setBusy(false); renderStatus(); renderResults(); });
  on("scan:error", () => { setBusy(false); renderStatus(); });
  on("scan:aborted", () => { setBusy(false); renderStatus(); });
  on("filters:apply", renderResults);
  on("apihealth:changed", renderStatus);
  on("refresh:tick", renderCountdown);

  renderStatus();
  renderResults();
}

function renderCountdown(e) {
  const el = document.getElementById("refresh-countdown");
  if (!el) return;
  if (!e.active) { el.textContent = ""; return; }
  el.textContent = state.scan.running ? "· 갱신 중" : `· 다음 갱신 ${e.secondsRemaining}s`;
}

const PHASE_LABEL = {
  idle: "대기", universe: "종목 수집", prefilter: "유동성 필터",
  candidate: "1차 분석", deep: "정밀 분석", score: "점수 계산",
  done: "완료", error: "오류",
};

function renderStatus() {
  const sc = state.scan;
  const h = state.apiHealth;
  const conn = h.connected === true ? "Binance 연결됨" : h.connected === false ? "연결 실패" : "미확인";
  const connClass = h.connected === true ? "ok" : h.connected === false ? "bad" : "";
  const pill = document.getElementById("conn-pill");
  if (pill) { pill.textContent = conn; pill.className = `conn-pill ${connClass}`; }

  if (!statusEl) return;
  statusEl.innerHTML = `
    <div class="stat-card"><span class="stat-label">마지막 갱신</span><span class="stat-val">${fmtTime(sc.lastUpdated)}</span></div>
    <div class="stat-card"><span class="stat-label">전체 종목</span><span class="stat-val">${state.universe.length}</span></div>
    <div class="stat-card"><span class="stat-label">1차 통과</span><span class="stat-val">${state.prefiltered.length}</span></div>
    <div class="stat-card"><span class="stat-label">후보</span><span class="stat-val">${state.candidates.length}</span></div>
    <div class="stat-card stat-card-hero"><span class="stat-label">상태</span><span class="stat-val">${PHASE_LABEL[sc.phase] || sc.phase}</span></div>
  `;
}

function renderProgress(e) {
  if (!progressEl) return;
  const pct = Math.round((e.progress || 0) * 100);
  progressEl.style.width = pct + "%";
  progressEl.parentElement?.setAttribute("aria-valuenow", String(pct));
  const txt = document.getElementById("progress-text");
  if (txt) txt.textContent = `${PHASE_LABEL[state.scan.phase] || ""} ${e.done}/${e.total} (${pct}%)`;
}

function setBusy(busy) {
  const btn = document.getElementById("scan-btn");
  if (btn) { btn.disabled = busy; btn.textContent = busy ? "스캔 중…" : "스캔 시작"; }
  const stop = document.getElementById("stop-btn");
  if (stop) stop.style.display = busy ? "" : "none";
}

export function renderResults() {
  if (!resultsEl) return;
  const view = applyFilters(state.results).slice(0, CONFIG.ui.resultMax);
  if (!view.length) {
    resultsEl.innerHTML = `<div class="empty">${state.scan.phase === "done" ? "조건을 만족하는 후보가 없습니다." : "스캔을 시작하세요."}</div>`;
    return;
  }
  // 데스크톱 테이블 + 모바일 카드 — CSS 로 전환. 둘 다 생성.
  resultsEl.innerHTML = `
    <table class="result-table">
      <thead><tr>
        <th>#</th><th>종목</th><th>현재가</th><th>6h</th><th>거래대금</th>
        <th>점수</th><th>단계</th><th>방향</th><th>핵심 신호</th><th>손익비</th><th></th><th></th>
      </tr></thead>
      <tbody>${view.map(rowHtml).join("")}</tbody>
    </table>
    <div class="result-cards">${view.map(cardHtml).join("")}</div>
  `;
  bindRows(view);
}

function goldenCrossBadge(r) {
  const gc = r.goldenCrossRetest;
  if (!gc?.detected) return "";
  const label = gc.hasRejection ? "골든크로스 리테스트" : "골든크로스 리테스트(대기)";
  return `<span class="badge badge-cross">${label}</span>`;
}

function rowHtml(r) {
  return `<tr data-sym="${r.symbol}">
    <td>${r.rank}</td>
    <td class="sym"><button class="fav-mini ${isFavorite(r.symbol) ? "active" : ""}" data-fav="${r.symbol}">★</button>${escapeHtml(r.symbol)}</td>
    <td>${fmtPrice(r.price)}</td>
    <td class="${pctClass(r.change6h)}">${fmtPct(r.change6h)}</td>
    <td>${fmtVolume(r.quoteVolume)}</td>
    <td><span class="score-pill score-${r.grade.key}">${r.score}</span></td>
    <td><span class="badge badge-${r.stage.badge}">${r.stage.label}</span></td>
    <td><span class="dir dir-${r.direction}">${r.direction === "long" ? "LONG" : "SHORT"}</span></td>
    <td class="signals">${goldenCrossBadge(r)}${r.topSignals.map((s) => `<span>${escapeHtml(s)}</span>`).join("")}</td>
    <td>${r.plan.rrText}</td>
    <td><button class="btn-mini" data-detail="${r.symbol}">상세</button></td>
    <td><button class="btn-mini tv" data-tv="${r.symbol}" aria-label="TradingView">TV</button></td>
  </tr>`;
}

function cardHtml(r) {
  const p = r.plan;
  return `<div class="rcard" data-sym="${r.symbol}">
    <div class="rcard-top">
      <button class="fav-mini ${isFavorite(r.symbol) ? "active" : ""}" data-fav="${r.symbol}">★</button>
      <b class="rcard-sym">${escapeHtml(r.symbol)}</b>
      <span class="score-pill score-${r.grade.key}">${r.score}</span>
      <span class="dir dir-${r.direction}">${r.direction === "long" ? "LONG" : "SHORT"}</span>
    </div>
    <div class="rcard-stage"><span class="badge badge-${r.stage.badge}">${r.stage.label}</span>
      <span class="${pctClass(r.change6h)}">6h ${fmtPct(r.change6h)}</span>
      <span class="muted">${fmtPrice(r.price)}</span>
    </div>
    <ul class="rcard-signals">${r.goldenCrossRetest?.detected ? `<li>${goldenCrossBadge(r)}</li>` : ""}${r.topSignals.map((s) => `<li>· ${escapeHtml(s)}</li>`).join("")}</ul>
    <div class="rcard-plan">
      <span>진입 ${fmtPrice(p.entry)}</span>
      <span>손절 ${fmtPrice(p.invalidation)}</span>
      <span>손익비 ${p.rrText}</span>
    </div>
    <div class="rcard-actions">
      <button class="btn-mini" data-detail="${r.symbol}">상세 보기</button>
      <button class="btn-mini tv" data-tv="${r.symbol}">TradingView</button>
    </div>
  </div>`;
}

function bindRows(view) {
  const byId = (sym) => view.find((r) => r.symbol === sym);
  resultsEl.querySelectorAll("[data-detail]").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); const r = byId(b.dataset.detail); if (r) showDetail(r); }));
  resultsEl.querySelectorAll("[data-tv]").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); openTradingView(b.dataset.tv); }));
  resultsEl.querySelectorAll("[data-fav]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleFavorite(b.dataset.fav);
      b.classList.toggle("active", isFavorite(b.dataset.fav));
    }));
  // 카드/행 전체 클릭 → 상세
  resultsEl.querySelectorAll("[data-sym]").forEach((el) =>
    el.addEventListener("click", () => { const r = byId(el.dataset.sym); if (r) showDetail(r); }));
}

export default { initDashboard, renderResults };
