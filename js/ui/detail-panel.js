// ui/detail-panel.js — 종목 상세 분석 패널 (§15 상세 보기).
// 셋업 점수 근거, 진행 단계, 흡수, 시간봉별 상태, 진입·손절·목표, 손익비, TradingView 버튼.

import { fmtPrice, fmtPct, fmtVolume, pctClass, escapeHtml } from "./format.js";
import { openTradingView, copyTvLink, tvChartUrl, binanceFuturesUrl } from "./tradingview.js";
import { toggleFavorite, isFavorite } from "../state.js";
import { toast } from "./notifications.js";

let panelEl = null;

export function initDetailPanel() {
  panelEl = document.getElementById("detail-panel");
  if (!panelEl) return;
  panelEl.addEventListener("click", (e) => {
    if (e.target.dataset.close !== undefined || e.target === panelEl) closeDetail();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDetail(); });
}

export function closeDetail() {
  if (panelEl) panelEl.classList.remove("open");
}

export function showDetail(r) {
  if (!panelEl) return;
  panelEl.innerHTML = renderDetail(r);
  panelEl.classList.add("open");

  // 버튼 바인딩 (실제 클릭 이벤트 안에서 새 탭 — 팝업 차단 회피)
  panelEl.querySelector("[data-tv-open]")?.addEventListener("click", () => openTradingView(r.symbol));
  panelEl.querySelector("[data-tv-copy]")?.addEventListener("click", async () => {
    const ok = await copyTvLink(r.symbol);
    toast(ok ? "TradingView 링크를 복사했습니다." : "복사 실패", ok ? "success" : "error");
  });
  panelEl.querySelector("[data-fav]")?.addEventListener("click", (e) => {
    toggleFavorite(r.symbol);
    e.currentTarget.classList.toggle("active", isFavorite(r.symbol));
  });
}

function renderDetail(r) {
  const p = r.plan;
  const isEarly = r.scanMode === "early" || Boolean(r.early);
  const isPumpFade = r.scanMode === "pump_fade";
  const standalone = isEarly || isPumpFade;
  const tvButtonLabel = standalone ? "TradingView 차트 열기" : "TradingView에서 독립 차트 정합 확인";
  const tvHandoffNote = isPumpFade
    ? "급등 후 급락(pump_fade)은 SHORT 전용 실험 파이프라인입니다. TradingView에는 심볼과 15분봉만 전달되며 점수·단계는 차트로 전달되지 않습니다."
    : isEarly
    ? "조기 포착(early) 판정은 Pine v3.4에 이식되지 않았습니다. TradingView에는 심볼과 15분봉만 전달되며 차트는 별도 관찰용입니다."
    : "TradingView에는 심볼과 15분봉만 전달됩니다. Pine v3.4는 QAR 방향·셋업 점수·진행 단계를 전달받지 않고, 일반 캔들에서 독립적으로 차트 정합을 확인합니다.";
  const stageLabel = String(r.stage.label || "").replace(/^\d+\s*/, "");
  const stageBadge = `<span class="badge badge-${r.stage.badge}">진행 ${r.stage.stage}단계 · ${escapeHtml(stageLabel)}</span>`;
  const dirBadge = `<span class="dir dir-${r.direction}">${r.direction === "long" ? "LONG" : "SHORT"}</span>`;

  return `
  <div class="detail-card" role="dialog" aria-modal="true">
    <button class="detail-close" data-close aria-label="닫기">✕</button>
    <header class="detail-head">
      <div class="detail-title">
        <button class="fav-btn ${isFavorite(r.symbol) ? "active" : ""}" data-fav aria-label="관심 종목">★</button>
        <h2>${escapeHtml(r.symbol)}</h2>
        <span class="score-pill score-${r.grade.key}">${isPumpFade ? "실험 점수" : "셋업 점수"} ${r.score}</span>
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

    <section class="detail-section">
      <h3>핵심 신호</h3>
      <ul class="signal-list">${r.topSignals.map((s) => `<li>✔ ${escapeHtml(s)}</li>`).join("")}</ul>
      <p class="absorption">흡수 추정: <b>${escapeHtml(r.absorption.label)}</b></p>
    </section>

    <section class="detail-section">
      <h3>진입 · 손절 · 목표 <small>(자동 주문 아님 · 기술적 참고 구간)</small></h3>
      <table class="plan-table">
        <tr><td>진입 후보</td><td>${fmtPrice(p.entry)}</td></tr>
        <tr><td>무효화(손절)</td><td>${fmtPrice(p.invalidation)}</td></tr>
        <tr><td>TP1 (${isPumpFade ? "1R" : r.direction === "short" ? "내부 저점" : "내부 고점"})</td><td>${fmtPrice(p.tp1)}</td></tr>
        <tr><td>TP2 (${isPumpFade ? "2R" : r.direction === "short" ? "주요 저점" : "주요 고점"})</td><td>${fmtPrice(p.tp2)}</td></tr>
        <tr><td>TP3 (${isPumpFade ? "3R" : r.direction === "short" ? "Sell-side" : "Buy-side"})</td><td>${fmtPrice(p.tp3)}</td></tr>
        <tr class="rr"><td>예상 손익비</td><td>${p.rrText}</td></tr>
        ${p.warning ? `<tr><td>위험 경고</td><td>${escapeHtml(p.warning)}</td></tr>` : ""}
      </table>
    </section>

    <section class="detail-section">
      <h3>시간봉별 상태</h3>
      <table class="tf-table">
        <thead><tr><th>TF</th><th>구조</th><th>RSI</th><th>EMA20</th><th>상대량</th><th>CVD</th><th>FVG/OB</th></tr></thead>
        <tbody>${["4h","1h","15m","5m"].map((tf) => tfRow(tf, r.timeframes[tf])).join("")}</tbody>
      </table>
    </section>

    <section class="detail-section">
      <h3>셋업 점수 근거</h3>
      <ul class="breakdown">
        ${r.breakdown.map((b) => `<li class="${b.hit ? "hit" : "miss"}"><span>${escapeHtml(b.label)}</span><span>${b.got}/${b.weight}</span></li>`).join("")}
        ${r.penalties.map((p) => `<li class="penalty"><span>${escapeHtml(p.label)}</span><span>${p.val}</span></li>`).join("")}
      </ul>
    </section>

    <p class="tv-handoff-note">${tvHandoffNote}</p>
    <footer class="detail-actions">
      <button class="btn btn-primary" data-tv-open>${tvButtonLabel}</button>
      <button class="btn" data-tv-copy>링크 복사</button>
      <a class="btn btn-ghost" href="${binanceFuturesUrl(r.symbol)}" target="_blank" rel="noopener noreferrer">Binance</a>
    </footer>
  </div>`;
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
