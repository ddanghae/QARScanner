// ui/dashboard.js — 상단 상태(§15) + 결과 카드/테이블 렌더.
// 스캔 이벤트 구독 → 진행률/상태/결과 갱신. 모바일은 카드 UI.

import { state, on, emit, isFavorite, toggleFavorite } from "../state.js";
import { CONFIG } from "../config.js";
import { fmtPrice, fmtPct, fmtVolume, fmtTime, fmtWon, planMoney, pctClass, escapeHtml } from "./format.js";
import { applyFilters, syncControls } from "./settings.js";
import { showDetail } from "./detail-panel.js";
import { openTradingView } from "./tradingview.js";
import { recordTrade } from "./paper.js";
import { SCAN_MODES, SCAN_MODE_META, modesForScan, resultKey, resultMode } from "../scan-modes.js";
import { crtBadge } from "./crt-tbs.js";
import { expireResult } from "../core/signal-freshness.js";
import { buildDecisionGate } from "../core/decision-gate.js";

let resultsEl, statusEl, progressEl;
let expiryTimer;

export function initDashboard() {
  resultsEl = document.getElementById("results");
  statusEl = document.getElementById("status-bar");
  progressEl = document.getElementById("scan-progress");

  // 스캔 이벤트 구독
  on("scan:start", () => { renderStatus(); setBusy(true); });
  on("scan:phase", renderStatus);
  on("scan:mode", renderStatus);
  on("scan:progress", renderProgress);
  on("scan:prefiltered", renderStatus);
  on("scan:candidates", renderStatus);
  on("scan:done", () => { setBusy(false); renderStatus(); renderResults(); });
  on("scan:error", () => { setBusy(false); renderStatus(); });
  on("scan:aborted", () => { setBusy(false); renderStatus(); });
  on("market:regime", renderStatus);
  // 설정 변경 시 컨트롤(단계 라벨 등 부수효과 포함) 재동기화 후 결과 재렌더
  on("filters:apply", () => { syncControls(); renderStatus(); renderResults(); });
  on("apihealth:changed", renderStatus);
  on("refresh:tick", renderCountdown);
  clearInterval(expiryTimer);
  expiryTimer = setInterval(() => {
    let changed = false;
    state.results = state.results.map((r) => {
      const fresh = expireResult(r);
      changed ||= fresh !== r;
      return fresh;
    });
    if (changed) { renderResults(); emit("signals:expired"); }
  }, 1000);

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
  confirmation: "CRT + TBS 확인", done: "완료", error: "오류",
};

function renderStatus() {
  const sc = state.scan;
  const h = state.apiHealth;
  const conn = h.connected === true ? "Binance 연결됨" : h.connected === false ? "연결 실패" : "미확인";
  const connClass = h.connected === true ? "ok" : h.connected === false ? "bad" : "";
  const pill = document.getElementById("conn-pill");
  if (pill) { pill.textContent = conn; pill.className = `conn-pill ${connClass}`; }

  if (!statusEl) return;
  const unifiedDone = state.settings.scanMode === "all" && sc.phase === "done";
  const visibleCount = applyFilters(state.results).length;
  const phase = `${modeProgressLabel(sc)}${PHASE_LABEL[sc.phase] || sc.phase}`;
  const firstPass = unifiedDone ? modeStatText("prefiltered") : `${state.prefiltered.length}개`;
  statusEl.innerHTML = `
    ${marketRegimeCard()}
    <div class="stat-card"><span class="stat-label">스캔 상태</span><span class="stat-val stat-val-compact">${escapeHtml(phase)}</span><small>마지막 갱신 ${fmtTime(sc.lastUpdated)}</small></div>
    <div class="stat-card"><span class="stat-label">검색 범위</span><span class="stat-val">${state.universe.length}</span><small>1차 통과 ${escapeHtml(firstPass)}</small></div>
    <div class="stat-card stat-card-hero"><span class="stat-label">표시 후보</span><span class="stat-val">${visibleCount}</span><small>정밀 분석 ${state.candidates.length}개</small></div>
  `;
}

function marketRegimeCard() {
  const regime = state.marketRegime;
  if (!regime?.available) {
    return `<div class="stat-card stat-card-regime"><span class="stat-label">BTC 시장국면</span><span class="stat-val stat-val-compact">산출 보류</span><small>${escapeHtml(regime?.reason || "스캔 후 표시")}</small></div>`;
  }
  const m = regime.metrics || {};
  const ret = Number.isFinite(m.ret7d) ? `${m.ret7d >= 0 ? "+" : ""}${m.ret7d.toFixed(1)}%` : "—";
  return `<div class="stat-card stat-card-regime regime-${regime.key}"><span class="stat-label">BTC 시장국면</span>`
    + `<span class="stat-val stat-val-compact">${escapeHtml(regime.label)}</span>`
    + `<small>7일 ${ret} · 점수 보정 없음</small></div>`;
}

function modeStatText(key) {
  return SCAN_MODES.map((mode) => `${SCAN_MODE_META[mode].shortLabel} ${state.scan.modeStats?.[mode]?.[key] ?? 0}`).join(" · ");
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
  if (btn) { btn.disabled = busy; btn.textContent = busy ? "스캔 중…" : "스캔 시작"; }
  const stop = document.getElementById("stop-btn");
  if (stop) stop.style.display = busy ? "" : "none";
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
  return `<div class="mode-summary" aria-label="모드별 검색 결과">${counts}</div>`;
}

function modeSection(mode, rows) {
  const meta = SCAN_MODE_META[mode];
  const error = state.scan.modeErrors?.[mode];
  const body = rows.length ? resultTables(rows)
    : `<div class="mode-empty">${error ? `실행 실패 · ${escapeHtml(error)}` : state.settings.crtTbsOnly ? "기존 후보와 방향이 같은 CRT + TBS 확인 신호가 없습니다. 재스캔으로 갱신하세요." : "조건을 만족하는 후보가 없습니다."}</div>`;
  return `<section class="mode-results mode-results-${meta.badge}">
    <div class="mode-results-head"><h3>${modeBadge(mode)}</h3><span>${rows.length}개</span></div>
    ${body}
  </section>`;
}

function resultTables(view) {
  // 데스크톱은 의미별 7개 열, 모바일은 같은 정보를 카드로 묶는다.
  return `
    <table class="result-table">
      <thead><tr>
        <th>후보</th><th>검토 상태</th><th>스캔 시세</th><th>24h 전망</th>
        <th>계획</th><th>예상 손익</th><th></th>
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
  if (state.settings.crtTbsOnly) return "기존 후보와 방향이 같은 CRT + TBS 확인 신호가 없습니다.<br>범위 복귀와 5분 전환 확인을 기다린 뒤 재스캔하세요. 필터를 끄면 기존 후보를 볼 수 있습니다.";
  // 단계 이름은 모드마다 달라 라벨을 붙이면 한쪽이 거짓이 된다(reversal 은 압축·박스가 아니라 급락·RSI).
  const funnel = `깔때기 ${state.universe.length} → ${state.prefiltered.length}`
    + ` → ${state.candidates.length} → ${state.results.length}`;
  const why = `조기 포착은 잠재력 ${CONFIG.earlyMinScore}점 이상만 보여주고, 준비도와 위험도를 따로 확인합니다.`;
  return `<b>조건을 만족하는 후보가 없습니다.</b><br><span class="muted">${funnel}</span><br><span class="muted">${why}</span>`;
}

// 조기 포착은 목표가 R 배수 고정이라 손익비가 항상 1:2.00 — 정보가 없다.
// 대신 그 점수대의 실측 급등 확률을 보여준다(검증셋 17,597행). 그게 이 모드가 실제로 파는 것이다.
const isEarly = (r) => resultMode(r) === "early";
const isPumpFade = (r) => r?.scanMode === "pump_fade";
const isSweep = (r) => resultMode(r) === "sweep_retest";
const scoreLabel = (r) => isSweep(r) ? `진행 ${r.stage.stage}/5` : String(r.score);

// 조기포착은 4시간봉으로 신호를 계산하지만, 가격 칸은 티커를 받은 순간의 시장가다.
// 예전 6h 값은 실제로 계산하지 않고 0으로 표시했으므로, 검증 가능한 24h 티커 변동만 쓴다.
function marketChange(r) {
  return isEarly(r)
    ? { label: "24h", value: r.change24h }
    : { label: "6h", value: r.change6h };
}

function modeBadge(mode) {
  const meta = SCAN_MODE_META[mode] || SCAN_MODE_META.early;
  return `<span class="badge badge-mode badge-mode-${meta.badge}">${meta.label}</span>`;
}

function oddsCell(r) {
  if (isSweep(r)) return `진행 ${r.stage.stage}/5`;
  if (!isEarly(r)) return escapeHtml(r.plan.rrText);
  const b = CONFIG.earlyHitBaseline;
  const lift = (r.grade.hitRate / b).toFixed(1);
  return `<span class="odds" title="${CONFIG.earlyHitLabel} · 무작위 ${b}% 대비 ${lift}배">${r.grade.hitRate}% <span class="muted">(${lift}x)</span></span>`;
}

const FORECAST_LABEL = { up: "상승 우세", down: "하락 우세", neutral: "횡보 우세" };
const CONFIDENCE_LABEL = { high: "높음", medium: "보통", low: "낮음" };

function forecastCell(r) {
  if (isSweep(r)) return `<span class="forecast-unavailable">패턴 순서 판정 전용</span>`;
  const f = r?.forecast;
  if (!f?.available) {
    const reason = escapeHtml(f?.reason || "검증 가능한 방향 모델 없음");
    return `<span class="forecast-unavailable" title="${reason}">산출 보류</span>`;
  }
  const title = `${f.horizonHours}시간 안에 마지막 4시간 마감가 ±${f.thresholdPct.toFixed(1)}% 경계 중 먼저 닿는 방향 · `
    + `상승 ${f.up}% / 하락 ${f.down}% / 횡보 ${f.neutral}% · 신뢰도 ${CONFIDENCE_LABEL[f.confidence]}`;
  return `<span class="forecast forecast-${f.lead}" title="${escapeHtml(title)}">`
    + `<b>${FORECAST_LABEL[f.lead]}</b> <span class="forecast-pair">↑${f.up}% · ↓${f.down}%</span>`
    + `<small>횡보 ${f.neutral}% · 신뢰 ${CONFIDENCE_LABEL[f.confidence]}</small></span>`;
}

// 시드머니를 이 종목에 넣었을 때 손절 시 잃는 돈 / 목표 도달 시 버는 돈.
// 계획대로 지켰을 때의 산수일 뿐이다 — 확률도 보장도 아니라서 옆의 급등확률과 같이 읽어야 한다.
const partialOn = () => state.settings.partialTake !== false;

function moneyCell(r) {
  if (isSweep(r)) return `<span class="muted">탐지 전용 · 금액 계산 안 함</span>`;
  if (isPumpFade(r)) return `<span class="muted">실험 신호 · 금액 계산 안 함</span>`;
  if (!r.plan?.valid) return `<span class="muted">계획 보류</span>`;
  const s = state.settings;
  const m = planMoney(r.plan, s.seedMoney, CONFIG.tradeCostRoundTripPct, s.leverage,
    CONFIG.maintenanceMarginPct, partialOn() ? undefined : 0);
  if (!m) return `<span class="muted">시드머니 입력</span>`;
  // 청산이 손절보다 먼저 와도 금액은 보여준다 — 다만 그 금액은 증거금 전액이고,
  // 손절가에 닿기 전에 끝난다는 사실을 라벨로 붙인다.
  const tail = m.liquidated
    ? ` <b class="warn-inline">청산</b> <span class="muted">(${m.leverage}배 · 최대 ${m.maxSafeLeverage}배)</span>`
    : m.leverage > 1 ? ` <span class="muted">${m.leverage}배</span>` : "";
  const title = m.liquidated
    ? `${m.leverage}배 청산선 -${m.liqDropPct.toFixed(1)}% 가 손절 -${m.lossPct.toFixed(1)}% 보다 얕다 — 손절 전에 증거금 전액 소멸. ${m.maxSafeLeverage}배 이하 권장.`
    : partialOn()
      ? `TP1 에서 ${Math.round(m.partialFrac * 100)}% 빼고 손절을 본전으로 올리는 전제 · `
        + `손절 -${m.lossPct.toFixed(1)}% / 절반 +${m.partialPct.toFixed(1)}% / 끝까지 +${m.fullPct.toFixed(1)}% · `
        + `왕복비용 ${CONFIG.tradeCostRoundTripPct}% 반영`
      : `목표까지 통째로 버티는 전제 · 손절 -${m.lossPct.toFixed(1)}% / 목표 +${m.gainPct.toFixed(1)}% · `
        + `왕복비용 ${CONFIG.tradeCostRoundTripPct}% 반영`;
  const mid = partialOn() ? ` / <span class="up">+${fmtWon(m.partial)}</span>` : "";
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

function planCell(r) {
  if (isSweep(r)) return `<div class="plan-stack plan-stack-wrap"><b>${escapeHtml(r.sweepRetest?.label || r.stage.label)}</b>`
    + `<small>${escapeHtml(r.sweepRetest?.reason || "다음 순서를 기다립니다.")}</small></div>`;
  if (!r.plan?.valid) return `<div class="plan-stack plan-stack-wrap"><b>계획 보류</b>`
    + `<small>${escapeHtml(r.plan?.warning || "새 마감봉 뒤 다시 계산해 주세요.")}</small></div>`;
  return `<div class="plan-stack"><span>진입 <b>${fmtPrice(r.plan.entry)}</b></span>`
    + `<span>손절 <b class="down">${fmtPrice(r.plan.invalidation)}</b></span>`
    + `<small>${isEarly(r) ? "급등확률" : "손익비"} ${oddsCell(r)}</small></div>`;
}

function paperButton(r, key) {
  return isSweep(r)
    ? '<button class="btn-mini" disabled title="진입·손절·목표 계획을 만들지 않는 탐지 전용 모드입니다.">기록 불가</button>'
    : !r.plan?.valid
      ? `<button class="btn-mini" disabled title="${escapeHtml(r.plan?.warning || "계획이 유효하지 않습니다.")}">기록 보류</button>`
    : `<button class="btn-mini" data-paper="${key}">기록</button>`;
}

function regimeBadge(r) {
  const fit = r?.regimeFit;
  if (!fit || fit.key === "unknown") return "";
  const title = r.marketRegime?.label ? `BTC ${r.marketRegime.label} · 아직 점수에는 반영하지 않음` : "시장국면 확인";
  return `<span class="badge badge-regime-${fit.key}" title="${escapeHtml(title)}">${escapeHtml(fit.label)}</span>`;
}

function decisionGateBadge(r) {
  const gate = buildDecisionGate(r);
  const title = `${gate.note} · 통과 ${gate.passes} / 주의 ${gate.warnings} / 차단 ${gate.blockers}`;
  return `<span class="badge badge-gate-${gate.status}" title="${escapeHtml(title)}">${escapeHtml(gate.label)}</span>`;
}

function earlyAxisBadges(r) {
  const a = r?.earlyAxes;
  if (!a) return "";
  const riskKey = a.risk.score >= 75 ? "green" : a.risk.score >= 50 ? "yellow" : "red";
  return `<span class="badge badge-blue" title="검증된 7일 급등 잠재력 점수">잠재력 ${a.potential.score}</span>`
    + `<span class="badge badge-purple" title="방향·상단 접근·거래량·변동성의 현재 준비 상태이며 확률이 아닙니다">준비도 ${a.readiness.score}</span>`
    + `<span class="badge badge-${riskKey}" title="100에 가까울수록 관찰 위험이 낮습니다. 성공 확률이 아닙니다">위험 ${a.risk.label}</span>`;
}

function sweepConfirmationBadge(r) {
  const s = r?.earlyConfirmation?.sweepRetest;
  if (!s?.confirmed) return "";
  return `<span class="badge badge-green" title="${escapeHtml(s.reason || "발생 순서를 충족했습니다.")}">첫 눌림 확인</span>`;
}

function candidateTags(r) {
  return `${decisionGateBadge(r)}<span class="badge badge-${r.stage.badge}">${r.stage.label}</span>`
    + `${earlyAxisBadges(r)}${regimeBadge(r)}${sweepConfirmationBadge(r)}${corrBadge(r)}${crtBadge(r)}`;
}

function rowHtml(r) {
  const key = resultKey(r);
  const change = marketChange(r);
  return `<tr data-result-key="${key}">
    <td class="candidate-cell"><div class="candidate-main"><button class="fav-mini ${isFavorite(r.symbol) ? "active" : ""}" data-fav="${r.symbol}">★</button><b>${escapeHtml(r.symbol)}</b><span class="score-pill score-${r.grade.key}">${scoreLabel(r)}</span></div><div class="candidate-sub"><span>#${r.rank}</span>${modeBadge(resultMode(r))}<span class="dir dir-${r.direction}">${r.direction === "long" ? "LONG" : "SHORT"}</span></div></td>
    <td><div class="decision-stack">${candidateTags(r)}</div></td>
    <td><div class="market-stack"><b>${fmtPrice(r.price)}</b><span class="${pctClass(change.value)}">${change.label} ${fmtPct(change.value)}</span><small>${fmtVolume(r.quoteVolume)}</small></div></td>
    <td>${forecastCell(r)}</td>
    <td>${planCell(r)}</td>
    <td class="risk-cell">${moneyCell(r)}</td>
    <td><div class="row-actions"><button class="btn-mini" data-detail="${key}">상세</button>${paperButton(r, key)}<button class="btn-mini tv" data-tv="${r.symbol}" aria-label="TradingView">TV</button></div></td>
  </tr>`;
}

function cardHtml(r) {
  const p = r.plan;
  const key = resultKey(r);
  const change = marketChange(r);
  return `<div class="rcard" data-result-key="${key}">
    <div class="rcard-top">
      <button class="fav-mini ${isFavorite(r.symbol) ? "active" : ""}" data-fav="${r.symbol}">★</button>
      <b class="rcard-sym">${escapeHtml(r.symbol)}</b>
      <span class="score-pill score-${r.grade.key}">${scoreLabel(r)}</span>
    </div>
    <div class="rcard-meta">${modeBadge(resultMode(r))}<span class="dir dir-${r.direction}">${r.direction === "long" ? "LONG" : "SHORT"}</span><span class="muted">#${r.rank}</span></div>
    <div class="rcard-decision">${candidateTags(r)}</div>
    <div class="rcard-grid">
      <div class="rcard-metric"><small>스캔 시세</small><b>${fmtPrice(r.price)}</b><span class="${pctClass(change.value)}">${change.label} ${fmtPct(change.value)} · ${fmtVolume(r.quoteVolume)}</span></div>
      <div class="rcard-metric"><small>24h 전망</small>${forecastCell(r)}</div>
      <div class="rcard-metric"><small>${isSweep(r) ? "패턴 상태" : "계획"}</small>${planCell(r)}</div>
      <div class="rcard-metric"><small>예상 손익</small>${moneyCell(r)}</div>
    </div>
    <div class="rcard-actions">
      <button class="btn-mini btn-detail" data-detail="${key}">상세</button>
      ${paperButton(r, key)}
      <button class="btn-mini tv" data-tv="${r.symbol}">차트</button>
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
      toggleFavorite(b.dataset.fav);
      b.classList.toggle("active", isFavorite(b.dataset.fav));
    }));
  // 카드/행 전체 클릭 → 상세
  resultsEl.querySelectorAll("[data-result-key]").forEach((el) =>
    el.addEventListener("click", () => { const r = byId(el.dataset.resultKey); if (r) showDetail(r); }));
}

export default { initDashboard, renderResults };
