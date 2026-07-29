// ui/dashboard.js — 상단 상태(§15) + 결과 카드/테이블 렌더.
// 스캔 이벤트 구독 → 진행률/상태/결과 갱신. 모바일은 카드 UI.

import { state, on, isFavorite, toggleFavorite } from "../state.js";
import { CONFIG } from "../config.js";
import { fmtPrice, fmtPct, fmtVolume, fmtTime, fmtWon, planMoney, pctClass, escapeHtml } from "./format.js";
import { applyFilters, syncControls } from "./settings.js";
import { showDetail } from "./detail-panel.js";
import { openTradingView } from "./tradingview.js";
import { recordTrade } from "./paper.js";

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
  // 설정 변경 시 컨트롤(단계 라벨 등 부수효과 포함) 재동기화 후 결과 재렌더
  on("filters:apply", () => { syncControls(); renderResults(); });
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
  const view = applyFilters(state.results);
  visibleSyms = new Set(view.map((r) => r.symbol));
  if (!view.length) {
    resultsEl.innerHTML = `<div class="empty">${emptyMessage()}</div>`;
    return;
  }
  // 데스크톱 테이블 + 모바일 카드 — CSS 로 전환. 둘 다 생성.
  resultsEl.innerHTML = `
    <table class="result-table">
      <thead><tr>
        <th>#</th><th>종목</th><th>현재가</th><th>6h</th><th>거래대금</th>
        <th>점수</th><th>단계</th><th>방향</th><th>${isEarly() ? "급등확률" : "손익비"}</th>
        <th>손절 / 목표 금액</th><th></th><th></th>
      </tr></thead>
      <tbody>${view.map(rowHtml).join("")}</tbody>
    </table>
    <div class="result-cards">${view.map(cardHtml).join("")}</div>
  `;
  bindRows(view);
}

// 후보가 없을 때 — 스캐너가 고장난 건지 시장에 없는 건지 구분되게 깔때기를 보여준다.
// early 는 확실한 소수만 고르므로 0건이 정상 결과일 수 있다.
function emptyMessage() {
  if (state.scan.phase !== "done") return "스캔을 시작하세요.";
  // 단계 이름은 모드마다 달라 라벨을 붙이면 한쪽이 거짓이 된다(reversal 은 압축·박스가 아니라 급락·RSI).
  const funnel = `깔때기 ${state.universe.length} → ${state.prefiltered.length}`
    + ` → ${state.candidates.length} → ${state.results.length}`;
  const why = state.settings.scanMode === "early"
    ? `조기 포착은 14일 추세·24시간 변동·최근 상장으로 채점해 ${CONFIG.earlyMinScore}점 이상만 보여줍니다.`
    : "필터를 완화하거나 채점 강도를 낮춰보세요.";
  return `<b>조건을 만족하는 후보가 없습니다.</b><br><span class="muted">${funnel}</span><br><span class="muted">${why}</span>`;
}

// 조기 포착은 목표가 R 배수 고정이라 손익비가 항상 1:2.00 — 정보가 없다.
// 대신 그 점수대의 실측 급등 확률을 보여준다(검증셋 17,597행). 그게 이 모드가 실제로 파는 것이다.
const isEarly = () => state.settings.scanMode === "early";

function oddsCell(r) {
  if (!isEarly()) return escapeHtml(r.plan.rrText);
  const b = CONFIG.earlyHitBaseline;
  const lift = (r.grade.hitRate / b).toFixed(1);
  return `<span class="odds" title="${CONFIG.earlyHitLabel} · 무작위 ${b}% 대비 ${lift}배">${r.grade.hitRate}% <span class="muted">(${lift}x)</span></span>`;
}

// 시드머니를 이 종목에 넣었을 때 손절 시 잃는 돈 / 목표 도달 시 버는 돈.
// 계획대로 지켰을 때의 산수일 뿐이다 — 확률도 보장도 아니라서 옆의 급등확률과 같이 읽어야 한다.
function moneyCell(r) {
  const s = state.settings;
  const m = planMoney(r.plan, s.seedMoney, CONFIG.tradeCostRoundTripPct, s.leverage, CONFIG.maintenanceMarginPct);
  if (!m) return `<span class="muted">시드머니 입력</span>`;
  // 청산이 손절보다 먼저 와도 금액은 보여준다 — 다만 그 금액은 증거금 전액이고,
  // 손절가에 닿기 전에 끝난다는 사실을 라벨로 붙인다.
  const tail = m.liquidated
    ? ` <b class="warn-inline">청산</b> <span class="muted">(${m.leverage}배 · 최대 ${m.maxSafeLeverage}배)</span>`
    : m.leverage > 1 ? ` <span class="muted">${m.leverage}배</span>` : "";
  const title = m.liquidated
    ? `${m.leverage}배 청산선 -${m.liqDropPct.toFixed(1)}% 가 손절 -${m.lossPct.toFixed(1)}% 보다 얕다 — 손절 전에 증거금 전액 소멸. ${m.maxSafeLeverage}배 이하 권장.`
    : `손절 -${m.lossPct.toFixed(1)}% · 목표 +${m.gainPct.toFixed(1)}% · 왕복비용 ${CONFIG.tradeCostRoundTripPct}% 반영`;
  return `<span class="money" title="${title}">`
    + `<span class="down">${fmtWon(m.loss)}</span> / <span class="up">+${fmtWon(m.gain)}</span>${tail}</span>`;
}

// 지금 화면에 같이 떠 있는 후보 중 이 종목과 같이 움직이는 것. 화면 밖 종목은 알려도 소용없다.
let visibleSyms = new Set();
function corrBadge(r) {
  const peers = (r.correlatedWith || []).filter((x) => visibleSyms.has(x.symbol));
  if (!peers.length) return "";
  const names = peers.slice(0, 2).map((x) => x.symbol.replace(/USDT$/, "")).join(", ");
  const top = peers[0].r.toFixed(2);
  return `<span class="badge badge-corr" title="7일 4시간봉 수익률 상관 ${top} — 나눠 담아도 사실상 같은 베팅입니다">↔ ${escapeHtml(names)}</span>`;
}

function goldenCrossBadge(r) {
  const gc = r.goldenCrossRetest;
  if (!gc?.detected) return "";
  const label = gc.hasRejection ? "골든크로스 리테스트" : "골든크로스 리테스트(대기)";
  return `<span class="badge badge-cross">${label}</span>`;
}

function nearEma200Badge(r) {
  return r.near1hEma200 ? `<span class="badge badge-ema200">1h 200선 밀착</span>` : "";
}

function noiseBadge(r) {
  return r.noise?.noisy ? `<span class="badge badge-noise">노이즈 · ${r.noise.reasons.join("/")}</span>` : "";
}

function rowHtml(r) {
  return `<tr data-sym="${r.symbol}">
    <td>${r.rank}</td>
    <td class="sym"><button class="fav-mini ${isFavorite(r.symbol) ? "active" : ""}" data-fav="${r.symbol}">★</button>${escapeHtml(r.symbol)}</td>
    <td>${fmtPrice(r.price)}</td>
    <td class="${pctClass(r.change6h)}">${fmtPct(r.change6h)}</td>
    <td>${fmtVolume(r.quoteVolume)}</td>
    <td><span class="score-pill score-${r.grade.key}">${r.score}</span></td>
    <td><span class="badge badge-${r.stage.badge}">${r.stage.label}</span>${goldenCrossBadge(r)}${nearEma200Badge(r)}${noiseBadge(r)}${corrBadge(r)}</td>
    <td><span class="dir dir-${r.direction}">${r.direction === "long" ? "LONG" : "SHORT"}</span></td>
    <td>${oddsCell(r)}</td>
    <td>${moneyCell(r)}</td>
    <td><button class="btn-mini" data-detail="${r.symbol}">상세</button><button class="btn-mini" data-paper="${r.symbol}">기록</button></td>
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
    <div class="rcard-stage"><span class="badge badge-${r.stage.badge}">${r.stage.label}</span>${nearEma200Badge(r)}${noiseBadge(r)}${corrBadge(r)}
      <span class="${pctClass(r.change6h)}">6h ${fmtPct(r.change6h)}</span>
      <span class="muted">${fmtPrice(r.price)}</span>
    </div>
    <ul class="rcard-signals">${r.goldenCrossRetest?.detected ? `<li>${goldenCrossBadge(r)}</li>` : ""}${r.topSignals.map((s) => `<li>· ${escapeHtml(s)}</li>`).join("")}</ul>
    <div class="rcard-plan">
      <span>진입 ${fmtPrice(p.entry)}</span>
      <span>손절 ${fmtPrice(p.invalidation)}</span>
      <span>${isEarly() ? "급등확률" : "손익비"} ${oddsCell(r)}</span>
      <span>${moneyCell(r)}</span>
    </div>
    <div class="rcard-actions">
      <button class="btn-mini" data-detail="${r.symbol}">상세 보기</button>
      <button class="btn-mini" data-paper="${r.symbol}">기록</button>
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
  resultsEl.querySelectorAll("[data-paper]").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); const r = byId(b.dataset.paper); if (r) recordTrade(r); }));
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
