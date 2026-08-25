// ui/dashboard.js — 상단 상태(§15) + 결과 카드/테이블 렌더.
// 스캔 이벤트 구독 → 진행률/상태/결과 갱신. 모바일은 카드 UI.

import { state, on, isFavorite, toggleFavorite } from "../state.js";
import { CONFIG } from "../config.js";
import { fmtPrice, fmtPct, fmtVolume, fmtTime, fmtWon, planMoney, pctClass, escapeHtml } from "./format.js";
import { applyFilters, syncControls } from "./settings.js";
import { showDetail } from "./detail-panel.js";
import { openTradingView } from "./tradingview.js";
import { recordTrade, paperRecordState } from "./paper.js";
import { SCAN_MODES, SCAN_MODE_META, modesForScan, resultKey, resultMode } from "../scan-modes.js";

let resultsEl, statusEl, progressEl;

export function initDashboard() {
  resultsEl = document.getElementById("results");
  statusEl = document.getElementById("status-bar");
  progressEl = document.getElementById("scan-progress");

  // 스캔 이벤트 구독
  on("scan:start", () => { renderStatus(); renderResults(); setBusy(true); });
  on("scan:phase", () => { renderStatus(); setBusy(state.scan.running); });
  on("scan:mode", renderStatus);
  on("scan:progress", renderProgress);
  on("scan:prefiltered", renderStatus);
  on("scan:candidates", renderStatus);
  on("scan:done", () => { setBusy(false); renderStatus(); renderResults(); });
  on("scan:error", () => { setBusy(false); renderStatus(); renderResults(); });
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
  done: "완료", stopping: "중단하는 중", error: "오류",
};

function renderStatus() {
  const sc = state.scan;
  const h = state.apiHealth;
  const blocked = Number(h.blockedUntil) > Date.now();
  const conn = blocked ? "요청 잠시 멈춤" :
    h.connected === true ? "Binance 연결됨" : h.connected === false ? "연결 실패" : "미확인";
  const connClass = blocked || h.connected === false ? "bad" : h.connected === true ? "ok" : "";
  const pill = document.getElementById("conn-pill");
  if (pill) { pill.textContent = conn; pill.className = `conn-pill ${connClass}`; }

  if (!statusEl) return;
  const unifiedDone = state.settings.scanMode === "all" && sc.phase === "done";
  statusEl.innerHTML = `
    <div class="stat-card"><span class="stat-label">마지막 갱신</span><span class="stat-val">${fmtTime(sc.lastUpdated)}</span></div>
    <div class="stat-card"><span class="stat-label">전체 종목</span><span class="stat-val">${state.universe.length}</span></div>
    <div class="stat-card"><span class="stat-label">${unifiedDone ? "모드별 1차 통과" : "1차 통과"}</span><span class="stat-val ${unifiedDone ? "stat-val-compact" : ""}">${unifiedDone ? modeStatText("prefiltered") : state.prefiltered.length}</span></div>
    <div class="stat-card"><span class="stat-label">${unifiedDone ? "모드별 후보" : "후보"}</span><span class="stat-val ${unifiedDone ? "stat-val-compact" : ""}">${unifiedDone ? modeStatText("candidates") : state.candidates.length}</span></div>
    <div class="stat-card stat-card-hero"><span class="stat-label">상태</span><span class="stat-val">${modeProgressLabel(sc)}${PHASE_LABEL[sc.phase] || sc.phase}</span></div>
  `;
}

function modeStatText(key) {
  return SCAN_MODES.map((mode) => {
    const value = state.scan.modeStats?.[mode]?.[key];
    return `${SCAN_MODE_META[mode].shortLabel} ${value == null ? "-" : value}`;
  }).join(" · ");
}

function modeProgressLabel(sc) {
  if (!sc.currentMode) return "";
  const label = SCAN_MODE_META[sc.currentMode]?.label || sc.currentMode;
  return sc.modeTotal > 1 ? `${label} ${sc.modeIndex}/${sc.modeTotal} · ` : `${label} · `;
}

function renderProgress(e) {
  if (!progressEl) return;
  const pct = Math.round((e.progress || 0) * 100);
  progressEl.style.width = pct + "%";
  progressEl.parentElement?.setAttribute("aria-valuenow", String(pct));
  const txt = document.getElementById("progress-text");
  if (txt) txt.textContent = `${modeProgressLabel(state.scan)}${PHASE_LABEL[state.scan.phase] || ""} ${e.done}/${e.total} (${pct}%)`;
}

function setBusy(busy) {
  const btn = document.getElementById("scan-btn");
  if (btn) {
    btn.disabled = busy;
    btn.textContent = busy ? (state.scan.stopping ? "중단하는 중…" : "스캔 중…") : "스캔 시작";
  }
  const stop = document.getElementById("stop-btn");
  if (stop) {
    stop.style.display = busy ? "" : "none";
    stop.disabled = Boolean(state.scan.stopping);
    stop.textContent = state.scan.stopping ? "중단하는 중…" : "중단";
  }
}

export function renderResults() {
  if (!resultsEl) return;
  const view = applyFilters(state.results);
  visibleSyms = new Set(view.map((r) => r.symbol));
  const modes = modesForScan(state.settings.scanMode);
  if (!view.length && state.settings.scanMode !== "all") {
    resultsEl.innerHTML = `<div class="empty">${emptyMessage()}</div>`;
    return;
  }
  const summary = state.settings.scanMode === "all" ? unifiedSummary(view) : "";
  resultsEl.innerHTML = summary + modes.map((mode) => modeSection(mode, view.filter((r) => resultMode(r) === mode))).join("");
  bindRows(view);
}

function unifiedSummary(view) {
  const counts = modesForScan("all").map((mode) => {
    const n = view.filter((r) => resultMode(r) === mode).length;
    return `<span class="mode-count">${modeBadge(mode)} <b>${n}</b></span>`;
  }).join("");
  return `<div class="mode-summary" aria-label="모드별 검색 결과">${counts}</div>
    <p class="mode-score-note">세 스캐너의 점수는 계산 기준이 달라 서로 직접 비교할 수 없습니다.</p>
    ${state.scan.realtimeSuppressed ? '<p class="mode-score-note">같은 시각의 자료만 맞추기 위해 전체 검색에서는 진행 중 봉을 제외했습니다.</p>' : ""}`;
}

function modeSection(mode, rows) {
  const meta = SCAN_MODE_META[mode];
  const error = state.scan.modeErrors?.[mode];
  const stats = state.scan.modeStats?.[mode];
  const stateText = error ? "실패" : stats?.status === "degraded"
    ? `일부 자료 실패 ${stats.failed}건`
    : stats?.status === "ok" ? "정상 완료" : "";
  const body = rows.length ? resultTables(rows, mode)
    : `<div class="mode-empty">${error ? `실행 실패 · ${escapeHtml(error)}` : "조건을 만족하는 후보가 없습니다."}</div>`;
  const evidence = mode === "early" ? earlyEvidenceNote() : "";
  return `<section class="mode-results mode-results-${meta.badge}">
    <div class="mode-results-head"><h3>${modeBadge(mode)}</h3><span>${rows.length}개${stateText ? ` · ${escapeHtml(stateText)}` : ""}</span></div>
    ${evidence}
    ${body}
  </section>`;
}

function earlyEvidenceNote() {
  const sample = CONFIG.earlyValidation;
  return `<p class="evidence-note">과거 자료 ${sample.start}~${sample.end} · ${sample.rows.toLocaleString("ko-KR")}행에서 확인한 값입니다. 한 시기 자료이며 미래 확률이 아닙니다.</p>`;
}

function resultTables(view, mode) {
  // 데스크톱 테이블 + 모바일 카드 — CSS 로 전환. 둘 다 생성.
  return `
    <table class="result-table">
      <thead><tr>
        <th>#</th><th>스캐너</th><th>종목</th><th>현재가</th><th>6h</th><th>거래대금</th>
        <th>점수</th><th>단계</th><th>방향</th><th>${mode === "early" ? "과거 적중률" : "손익비"}</th>
        <th>${partialOn() ? "손절 / 절반 / 끝까지" : "손절 / 목표"}</th><th></th><th></th>
      </tr></thead>
      <tbody>${view.map(rowHtml).join("")}</tbody>
    </table>
    <div class="result-cards">${view.map(cardHtml).join("")}</div>
  `;
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
    : state.settings.scanMode === "pump_fade"
      ? `급등 후 급락은 1h 급등 뒤 거절·소진·구조 붕괴 근거가 ${CONFIG.pumpFade.minScore}점 이상인 SHORT 후보만 보여줍니다.`
      : "필터를 완화하거나 채점 강도를 낮춰보세요.";
  return `<b>조건을 만족하는 후보가 없습니다.</b><br><span class="muted">${funnel}</span><br><span class="muted">${why}</span>`;
}

// 조기 포착은 목표가 R 배수 고정이라 손익비가 항상 1:2.00 — 정보가 없다.
// 대신 특정 과거 검증 기간에서 같은 점수대가 맞았던 비율을 보여준다. 미래 확률은 아니다.
const isEarly = (r) => resultMode(r) === "early";
const isPumpFade = (r) => r?.scanMode === "pump_fade";

function modeBadge(mode) {
  const meta = SCAN_MODE_META[mode] || SCAN_MODE_META.reversal;
  return `<span class="badge badge-mode badge-mode-${meta.badge}">${meta.label}</span>`;
}

function oddsCell(r) {
  if (!isEarly(r)) return escapeHtml(r.plan.rrText);
  const b = CONFIG.earlyHitBaseline;
  const lift = (r.grade.hitRate / b).toFixed(1);
  const sample = CONFIG.earlyValidation;
  const title = `${sample.start}~${sample.end} 과거 자료 ${sample.rows.toLocaleString("ko-KR")}건 · `
    + `${CONFIG.earlyHitLabel} · 같은 기간 전체 ${b}% 대비 ${lift}배 · 미래 보장 아님`;
  return `<span class="odds" title="${escapeHtml(title)}">${r.grade.hitRate}% <span class="muted">(${lift}x)</span></span>`;
}

// 시드머니를 이 종목에 넣었을 때 손절 시 잃는 돈 / 목표 도달 시 버는 돈.
// 계획대로 지켰을 때의 참고 산수일 뿐이며 도달 가능성을 뜻하지 않는다.
const partialOn = () => state.settings.partialTake !== false;

function moneyCell(r) {
  if (isPumpFade(r)) return `<span class="muted">실험 신호 · 금액 계산 안 함</span>`;
  if (!r.plan?.valid) return `<span class="muted">가격 계획 확인 필요</span>`;
  if (r.direction === "short") return `<span class="muted">SHORT 금액 계산 안 함</span>`;
  const s = state.settings;
  const usePartial = isEarly(r) && partialOn();
  const m = planMoney(r.plan, s.seedMoney, CONFIG.tradeCostRoundTripPct, s.leverage,
    CONFIG.maintenanceMarginPct, usePartial ? undefined : 0);
  if (!m) return `<span class="muted">시드머니 입력</span>`;
  // 청산이 손절보다 먼저 와도 금액은 보여준다 — 다만 그 금액은 증거금 전액이고,
  // 손절가에 닿기 전에 끝난다는 사실을 라벨로 붙인다.
  const tail = m.liquidated
    ? ` <b class="warn-inline">청산</b> <span class="muted">(${m.leverage}배 · 최대 ${m.maxSafeLeverage}배)</span>`
    : m.leverage > 1 ? ` <span class="muted">${m.leverage}배</span>` : "";
  const title = m.liquidated
    ? `${m.leverage}배 청산선 -${m.liqDropPct.toFixed(1)}% 가 손절 -${m.lossPct.toFixed(1)}% 보다 얕다 — 손절 전에 증거금 전액 소멸. ${m.maxSafeLeverage}배 이하 권장.`
    : usePartial
      ? `TP1 에서 ${Math.round(m.partialFrac * 100)}% 빼고 손절을 본전으로 올리는 전제 · `
        + `손절 -${m.lossPct.toFixed(1)}% / 절반 +${m.partialPct.toFixed(1)}% / 끝까지 +${m.fullPct.toFixed(1)}% · `
        + `왕복비용 ${CONFIG.tradeCostRoundTripPct}% 반영`
      : `목표까지 통째로 버티는 전제 · 손절 -${m.lossPct.toFixed(1)}% / 목표 +${m.gainPct.toFixed(1)}% · `
        + `왕복비용 ${CONFIG.tradeCostRoundTripPct}% 반영`;
  const mid = usePartial ? ` / <span class="up">+${fmtWon(m.partial)}</span>` : "";
  return `<span class="money" title="${title}">`
    + `<span class="down">${fmtWon(m.loss)}</span>${mid}`
    + ` / <span class="up">+${fmtWon(m.gain)}</span>${tail}</span>`;
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

function resultStateBadges(r) {
  const badges = [];
  if (!r.plan?.valid) badges.push(`<span class="badge badge-danger" title="${escapeHtml(r.plan?.validationError || "가격 계획 오류")}">가격 계획 확인</span>`);
  if (r.provisional) badges.push('<span class="badge badge-yellow">진행 중 봉 포함</span>');
  return badges.join("");
}

function paperButton(r, label = "기록") {
  const permission = paperRecordState(r);
  const disabled = permission.allowed ? "" : " disabled aria-disabled=\"true\"";
  const title = permission.allowed ? "가상 기록에 추가" : permission.reason;
  return `<button class="btn-mini" data-paper="${resultKey(r)}" title="${escapeHtml(title)}"${disabled}>${permission.allowed ? label : "기록 불가"}</button>`;
}

function favoriteButton(r, className = "fav-mini") {
  const active = isFavorite(r.symbol);
  const action = active ? "해제" : "추가";
  return `<button class="${className} ${active ? "active" : ""}" data-fav="${escapeHtml(r.symbol)}" aria-pressed="${active}" aria-label="${escapeHtml(r.symbol)} 관심 종목 ${action}">★</button>`;
}

function rowHtml(r) {
  const key = resultKey(r);
  return `<tr data-result-key="${key}">
    <td>${r.rank}</td>
    <td>${modeBadge(resultMode(r))}</td>
    <td class="sym">${favoriteButton(r)}${escapeHtml(r.symbol)}</td>
    <td>${fmtPrice(r.price)}</td>
    <td class="${pctClass(r.change6h)}">${fmtPct(r.change6h)}</td>
    <td>${fmtVolume(r.quoteVolume)}</td>
    <td><span class="score-pill score-${r.grade.key}">${r.score}</span></td>
    <td><span class="badge badge-${r.stage.badge}">${r.stage.label}</span>${goldenCrossBadge(r)}${nearEma200Badge(r)}${noiseBadge(r)}${corrBadge(r)}${resultStateBadges(r)}</td>
    <td><span class="dir dir-${r.direction}">${r.direction === "long" ? "LONG" : "SHORT"}</span></td>
    <td>${oddsCell(r)}</td>
    <td>${moneyCell(r)}</td>
    <td><button class="btn-mini" data-detail="${key}">상세</button>${paperButton(r)}</td>
    <td><button class="btn-mini tv" data-tv="${r.symbol}" aria-label="TradingView">TV</button></td>
  </tr>`;
}

function cardHtml(r) {
  const p = r.plan;
  const key = resultKey(r);
  return `<div class="rcard" data-result-key="${key}">
    <div class="rcard-top">
      ${favoriteButton(r)}
      <b class="rcard-sym">${escapeHtml(r.symbol)}</b>
      ${modeBadge(resultMode(r))}
      <span class="score-pill score-${r.grade.key}">${r.score}</span>
      <span class="dir dir-${r.direction}">${r.direction === "long" ? "LONG" : "SHORT"}</span>
    </div>
    <div class="rcard-stage"><span class="badge badge-${r.stage.badge}">${r.stage.label}</span>${nearEma200Badge(r)}${noiseBadge(r)}${corrBadge(r)}${resultStateBadges(r)}
      <span class="${pctClass(r.change6h)}">6h ${fmtPct(r.change6h)}</span>
      <span class="muted">${fmtPrice(r.price)}</span>
    </div>
    <ul class="rcard-signals">${r.goldenCrossRetest?.detected ? `<li>${goldenCrossBadge(r)}</li>` : ""}${r.topSignals.map((s) => `<li>· ${escapeHtml(s)}</li>`).join("")}</ul>
    <div class="rcard-plan">
      <span>진입 ${fmtPrice(p.entry)}</span>
      <span>손절 ${fmtPrice(p.invalidation)}</span>
      <span>${isEarly(r) ? "과거 적중률" : "손익비"} ${oddsCell(r)}</span>
      <span>${moneyCell(r)}</span>
    </div>
    <div class="rcard-actions">
      <button class="btn-mini" data-detail="${key}">상세 보기</button>
      ${paperButton(r)}
      <button class="btn-mini tv" data-tv="${r.symbol}">TradingView</button>
    </div>
  </div>`;
}

function bindRows(view) {
  const byId = (key) => view.find((r) => resultKey(r) === key);
  resultsEl.querySelectorAll("[data-detail]").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); const r = byId(b.dataset.detail); if (r) showDetail(r); }));
  resultsEl.querySelectorAll("[data-tv]").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); openTradingView(b.dataset.tv); }));
  resultsEl.querySelectorAll("[data-paper]").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); const r = byId(b.dataset.paper); if (r) recordTrade(r); }));
  resultsEl.querySelectorAll("[data-fav]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const symbol = b.dataset.fav;
      toggleFavorite(symbol);
      const active = isFavorite(symbol);
      resultsEl.querySelectorAll("[data-fav]").forEach((button) => {
        if (button.dataset.fav !== symbol) return;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", String(active));
        button.setAttribute("aria-label", `${symbol} 관심 종목 ${active ? "해제" : "추가"}`);
      });
    }));
  // 카드/행 전체 클릭 → 상세
  resultsEl.querySelectorAll("[data-result-key]").forEach((el) =>
    el.addEventListener("click", () => { const r = byId(el.dataset.resultKey); if (r) showDetail(r); }));
}

export default { initDashboard, renderResults };
