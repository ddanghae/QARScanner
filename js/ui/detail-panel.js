// ui/detail-panel.js — 종목 상세 분석 패널 (§15 상세 보기).
// 점수 근거, 단계, 흡수, 시간봉별 상태, 진입·손절·목표, 손익비, TradingView 버튼.

import { fmtPrice, fmtPct, fmtVolume, fmtWon, planMoney, pctClass, escapeHtml } from "./format.js";
import { openTradingView, copyTvLink, tvChartUrl, binanceFuturesUrl } from "./tradingview.js";
import { toggleFavorite, isFavorite, state } from "../state.js";
import { CONFIG } from "../config.js";
import { toast } from "./notifications.js";
import { SCAN_MODE_META, resultMode } from "../scan-modes.js";

let panelEl = null;
let lastFocused = null;

function focusableElements() {
  if (!panelEl) return [];
  return [...panelEl.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')];
}

// 시드머니를 넣었을 때의 손익 금액. 레버리지 없음, 왕복 비용 반영.
// "계획대로 지켰을 때" 의 산수다 — 목표 도달을 보장하지 않으므로 문구로 못 박는다.
function moneySection(p, mode, direction) {
  if (!p?.valid) return `<p class="warn"><b>가격 계획을 확인해야 합니다.</b> ${escapeHtml(p?.validationError || "가격 순서가 올바르지 않습니다.")}</p>`;
  if (direction === "short") return '<p class="muted">SHORT 금액·청산 계산은 아직 제공하지 않습니다.</p>';
  const s = state.settings;
  const early = mode === "early";
  const on = early && s.partialTake !== false;
  const m = planMoney(p, s.seedMoney, CONFIG.tradeCostRoundTripPct, s.leverage,
    CONFIG.maintenanceMarginPct, on ? undefined : 0);
  if (!m) return `<p class="muted">시드머니를 입력하면 손익 금액이 표시됩니다.</p>`;
  const levRow = m.leverage > 1
    ? `<tr><td>레버리지</td><td>${m.leverage}배 <small>(포지션 ${fmtWon(m.notional)})</small></td></tr>
       <tr><td>추정 청산가</td><td class="down">${fmtPrice(m.liqPrice)} <small>(-${m.liqDropPct.toFixed(1)}%)</small></td></tr>`
    : `<tr><td>레버리지</td><td>1배 <small>(청산 없음)</small></td></tr>`;
  // 청산이 손절보다 먼저 와도 금액은 그대로 보여준다. 다만 그 손실은 손절가에서 나온 게
  // 아니라 증거금 전액 소멸이라 라벨과 경고로 구분한다.
  const lossRow = m.liquidated
    ? `<tr><td>청산되면</td><td class="down">${fmtWon(m.loss)} <small>(증거금 전액 · -${m.liqDropPct.toFixed(1)}% 에서)</small></td></tr>`
    : `<tr><td>손절 맞으면</td><td class="down">${fmtWon(m.loss)} <small>(-${m.lossPct.toFixed(1)}%)</small></td></tr>`;
  const warn = m.liquidated
    ? `<p class="warn"><b>이 배수로는 손절에 닿기 전에 청산됩니다.</b> 손절이 -${m.lossPct.toFixed(1)}% 인데
       ${m.leverage}배의 청산선은 -${m.liqDropPct.toFixed(1)}% 입니다. 위 손실은 손절가가 아니라 증거금 전액이며,
       계획대로 가려면 ${m.maxSafeLeverage}배 이하로 낮추세요.</p>`
    : "";
  const pct = Math.round((p.partialFrac ?? 0.5) * 100);
  const midRow = on
    ? `<tr><td>TP1 에서 ${pct}% 빼고 본전에 걸리면</td><td class="up">+${fmtWon(m.partial)} <small>(+${m.partialPct.toFixed(1)}%)</small></td></tr>`
    : "";
  const how = early
    ? on
      ? `조기 포착 과거 실험처럼 TP1에서 ${pct}%를 빼고 손절을 본전(${fmtPrice(p.entry)})으로 올리는 전제입니다.`
      : '조기 포착 과거 실험처럼 목표까지 나누지 않고 유지하는 전제입니다.'
    : '급락 반등 결과의 진입·손절·TP2 가격 차이만 금액으로 바꾼 참고 계산입니다.';
  return `<table class="plan-table money-table">
    <tr><td>넣는 금액</td><td>${fmtWon(s.seedMoney)}</td></tr>
    ${levRow}
    ${lossRow}
    ${midRow}
    <tr><td>${on ? "나머지도 TP2 까지 가면" : "TP2 까지 가면"}</td><td class="up">+${fmtWon(m.gain)} <small>(+${m.fullPct.toFixed(1)}%)</small></td></tr>
  </table>
  ${warn}
  <p class="muted">${how}
  왕복 비용 ${CONFIG.tradeCostRoundTripPct}% 반영 · 도달 보장 아님${m.leverage > 1 ? ` · 청산가는 유지증거금 ${CONFIG.maintenanceMarginPct}% 가정의 근사치` : ""}</p>`;
}

export function initDetailPanel() {
  panelEl = document.getElementById("detail-panel");
  if (!panelEl) return;
  panelEl.addEventListener("click", (e) => {
    if (e.target.dataset.close !== undefined || e.target === panelEl) closeDetail();
  });
  document.addEventListener("keydown", (e) => {
    if (!panelEl?.classList.contains("open")) return;
    if (e.key === "Escape") { closeDetail(); return; }
    if (e.key !== "Tab") return;
    const focusable = focusableElements();
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
}

export function closeDetail() {
  if (!panelEl?.classList.contains("open")) return;
  panelEl.classList.remove("open");
  panelEl.setAttribute("aria-hidden", "true");
  const shell = document.querySelector(".app-shell");
  if (shell) shell.inert = false;
  if (lastFocused instanceof HTMLElement) lastFocused.focus();
  lastFocused = null;
}

export function showDetail(r) {
  if (!panelEl) return;
  lastFocused = document.activeElement;
  panelEl.innerHTML = renderDetail(r);
  panelEl.classList.add("open");
  panelEl.setAttribute("aria-hidden", "false");
  const shell = document.querySelector(".app-shell");
  if (shell) shell.inert = true;
  panelEl.querySelector("[data-close]")?.focus();

  // 버튼 바인딩 (실제 클릭 이벤트 안에서 새 탭 — 팝업 차단 회피)
  panelEl.querySelector("[data-tv-open]")?.addEventListener("click", () => openTradingView(r.symbol));
  panelEl.querySelector("[data-tv-copy]")?.addEventListener("click", async () => {
    const ok = await copyTvLink(r.symbol);
    toast(ok ? "TradingView 링크를 복사했습니다." : "복사 실패", ok ? "success" : "error");
  });
  panelEl.querySelector("[data-fav]")?.addEventListener("click", (e) => {
    toggleFavorite(r.symbol);
    const active = isFavorite(r.symbol);
    e.currentTarget.classList.toggle("active", active);
    e.currentTarget.setAttribute("aria-pressed", String(active));
    e.currentTarget.setAttribute("aria-label", `${r.symbol} 관심 종목 ${active ? "해제" : "추가"}`);
  });
}

function renderDetail(r) {
  const p = r.plan;
  const mode = resultMode(r);
  const modeMeta = SCAN_MODE_META[mode];
  const isPumpFade = mode === "pump_fade";
  const favorite = isFavorite(r.symbol);
  const planWarning = !p?.valid
    ? `<p class="warn"><b>이 가격 계획은 사용할 수 없습니다.</b> ${escapeHtml(p?.validationError || "가격 순서를 확인하세요.")}</p>`
    : "";
  const stageLabel = isPumpFade ? String(r.stage.label || "").replace(/^\d+\s*/, "") : r.stage.label;
  const stageBadge = `<span class="badge badge-${r.stage.badge}">${r.stage.stage}단계 · ${escapeHtml(stageLabel)}</span>`;
  const dirBadge = `<span class="dir dir-${r.direction}">${r.direction === "long" ? "LONG" : "SHORT"}</span>`;

  return `
  <div class="detail-card" role="dialog" aria-modal="true" aria-labelledby="detail-title">
    <button class="detail-close" data-close aria-label="닫기">✕</button>
    <header class="detail-head">
      <div class="detail-title">
        <button class="fav-btn ${favorite ? "active" : ""}" data-fav aria-pressed="${favorite}" aria-label="${escapeHtml(r.symbol)} 관심 종목 ${favorite ? "해제" : "추가"}">★</button>
        <h2 id="detail-title">${escapeHtml(r.symbol)}</h2>
        <span class="badge badge-mode badge-mode-${modeMeta.badge}">${modeMeta.label}</span>
        <span class="score-pill score-${r.grade.key}">${isPumpFade ? "실험 점수 " : ""}${r.score}</span>
        ${dirBadge}
      </div>
      <div class="detail-sub">
        ${stageBadge}
        <span>현재가 ${fmtPrice(r.price)}</span>
        <span class="${pctClass(r.change6h)}">6h ${fmtPct(r.change6h)}</span>
        <span>거래대금 ${fmtVolume(r.quoteVolume)}</span>
        ${r.newListing ? '<span class="badge badge-blue">신규</span>' : ""}
        ${r.provisional ? '<span class="badge badge-yellow">진행 중 캔들 포함 · 변경 가능</span>' : ""}
      </div>
    </header>

    ${mode === "early" ? `<p class="evidence-note">과거 자료 ${CONFIG.earlyValidation.start}~${CONFIG.earlyValidation.end} · ${CONFIG.earlyValidation.rows.toLocaleString("ko-KR")}행에서 확인한 값입니다. 한 시기 자료이며 미래 확률이 아닙니다.</p>` : ""}

    <section class="detail-section">
      <h3>핵심 신호</h3>
      <ul class="signal-list">${r.topSignals.map((s) => `<li>✔ ${escapeHtml(s)}</li>`).join("")}</ul>
      <p class="absorption">흡수 추정: <b>${escapeHtml(r.absorption.label)}</b></p>
    </section>

    <section class="detail-section">
      <h3>진입 · 손절 · 목표 <small>(자동 주문 아님 · 기술적 참고 구간)</small></h3>
      ${planWarning}
      <table class="plan-table">
        <tr><td>진입 후보</td><td>${fmtPrice(p.entry)}</td></tr>
        <tr><td>무효화(손절)</td><td>${fmtPrice(p.invalidation)}</td></tr>
        <tr><td>TP1 ${isPumpFade ? "(1R)" : p.partialFrac ? `(${Math.round(p.partialFrac * 100)}% 익절 · 손절을 본전으로)` : (r.direction === "short" ? "(내부 저점)" : "(내부 고점)")}</td><td>${fmtPrice(p.tp1)}</td></tr>
        <tr><td>TP2 (${isPumpFade ? "2R" : r.direction === "short" ? "주요 저점" : "주요 고점"})</td><td>${fmtPrice(p.tp2)}</td></tr>
        <tr><td>TP3 (${isPumpFade ? "3R" : r.direction === "short" ? "Sell-side" : "Buy-side"})</td><td>${fmtPrice(p.tp3)}</td></tr>
        <tr class="rr"><td>예상 손익비</td><td>${p.rrText}</td></tr>
        ${p.warning || p.validationError ? `<tr><td>위험 경고</td><td>${escapeHtml(p.warning || p.validationError)}</td></tr>` : ""}
      </table>
      ${isPumpFade ? '<p class="muted">급등 후 급락은 공개 데이터 기반 실험 신호이며 금액 계산을 제공하지 않습니다.</p>' : moneySection(p, mode, r.direction)}
      ${p.note ? `<p class="plan-note">${escapeHtml(p.note)}</p>` : ""}
      ${isPumpFade ? '<p class="plan-note">초기 임계값과 가중치이며 성공 확률이나 기대수익률로 해석할 수 없습니다.</p>' : ""}
    </section>

    ${tfSection(r)}

    <section class="detail-section">
      <h3>점수 근거</h3>
      <ul class="breakdown">
        ${r.breakdown.map((b) => `<li class="${b.hit ? "hit" : "miss"}"><span>${escapeHtml(b.label)}</span><span>${b.got}/${b.weight}</span></li>`).join("")}
        ${r.penalties.map((p) => `<li class="penalty"><span>${escapeHtml(p.label)}</span><span>${p.val}</span></li>`).join("")}
      </ul>
    </section>

    <footer class="detail-actions">
      <button class="btn btn-primary" data-tv-open>TradingView에서 타점 확인</button>
      <button class="btn" data-tv-copy>링크 복사</button>
      <a class="btn btn-ghost" href="${binanceFuturesUrl(r.symbol)}" target="_blank" rel="noopener noreferrer">Binance</a>
    </footer>
  </div>`;
}

// 조기 포착 모드 결과는 멀티타임프레임 분석을 하지 않아 timeframes 가 비어 있다.
// 전부 "-" 인 표를 띄우면 고장난 것처럼 보이므로 섹션 자체를 뺀다.
function tfSection(r) {
  const tfs = ["4h", "1h", "15m", "5m"];
  if (!tfs.some((tf) => r.timeframes?.[tf])) return "";
  return `
    <section class="detail-section">
      <h3>시간봉별 상태</h3>
      <table class="tf-table">
        <thead><tr><th>TF</th><th>구조</th><th>RSI</th><th>EMA20</th><th>상대량</th><th>CVD</th><th>FVG/OB</th></tr></thead>
        <tbody>${tfs.map((tf) => tfRow(tf, r.timeframes[tf])).join("")}</tbody>
      </table>
    </section>`;
}

function tfRow(tf, s) {
  if (!s) return `<tr><td>${tf}</td><td colspan="6">-</td></tr>`;
  const struct = s.lastStructure ? shortStruct(s.lastStructure) : (s.lastLabel || "-");
  const fo = `${s.fvg ? "FVG" : ""}${s.fvg && s.ob ? "+" : ""}${s.ob ? "OB" : ""}` || "-";
  return `<tr>
    <td><b>${tf}</b></td>
    <td>${escapeHtml(struct)}</td>
    <td>${s.rsi ?? "-"}</td>
    <td>${fmtPrice(s.ema20)}</td>
    <td>${s.relVol ?? "-"}</td>
    <td class="cvd-${s.cvdSlope}">${s.cvdSlope}</td>
    <td>${fo || "-"}</td>
  </tr>`;
}

function shortStruct(t) {
  return {
    bullish_bos: "Bull BOS", bearish_bos: "Bear BOS",
    bullish_choch: "Bull CHoCH", bearish_choch: "Bear CHoCH",
  }[t] || t;
}

export default { initDetailPanel, showDetail, closeDetail };
