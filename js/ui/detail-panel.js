// ui/detail-panel.js — 종목 상세 분석 패널 (§15 상세 보기).
// 점수 근거, 단계, 흡수, 시간봉별 상태, 진입·손절·목표, 손익비, TradingView 버튼.

import { fmtPrice, fmtPct, fmtVolume, fmtWon, planMoney, pctClass, escapeHtml } from "./format.js";
import { openTradingView, copyTvLink, tvChartUrl, binanceFuturesUrl } from "./tradingview.js";
import { toggleFavorite, isFavorite, state } from "../state.js";
import { CONFIG } from "../config.js";
import { toast } from "./notifications.js";

let panelEl = null;

// 1시간봉 물량 흐름 — 대량거래 봉과 CVD 다이버전스.
//
// 점수에 반영하지 않는다(deep-scanner.js 주석의 측정 근거 참조).
//
// 매수 비율과 종가 위치는 **일부러 렌더하지 않는다.** 실측에서 방향 예측력이 없었고
// (매도 흡수 0.79x · 혼재 1.36x — 가설과 뒤집힘) 경고 문구를 붙여도 "매수 75%" 같은 숫자를
// 보면 사람은 방향으로 읽는다. 예측력 없는 숫자를 방향처럼 읽히게 두는 게 안 보여주는 것보다
// 나쁘다. 값 자체는 volumeSpikes 가 계속 계산하고 research/predict-dump.mjs 가 열로 뽑는다
// — 다시 재서 예측력이 나오면 그때 여기에 붙일 것.
function volumeFlowSection(r) {
  const sp = r.volSpike1h;
  const dv = r.cvdDiv1h;
  if (!sp && !(dv?.bullish || dv?.bearish)) return "";

  const rows = [];
  if (sp) {
    const ago = sp.barsAgo === 0 ? "직전 봉" : `${sp.barsAgo}봉 전`;
    const held = sp.pctAbove == null ? "—"
      : `이후 종가 ${Math.round(sp.pctAbove * 100)}% 가 그 위`;
    rows.push(`<tr><td>대량거래 봉</td><td>${sp.relVol.toFixed(1)}배 · ${ago}</td></tr>`);
    rows.push(`<tr><td>물량대 (${fmtPrice(sp.level)})</td><td>${held}</td></tr>`);
  }
  if (dv?.bullish) rows.push(`<tr><td>CVD</td><td>상승 다이버전스 <small>(가격 저점↓ / CVD 저점↑)</small></td></tr>`);
  if (dv?.bearish) rows.push(`<tr><td>CVD</td><td>하락 다이버전스 <small>(가격 고점↑ / CVD 고점↓)</small></td></tr>`);

  return `
    <section class="detail-section">
      <h3>1시간봉 물량 흐름 <small>(점수 미반영 · 참고용)</small></h3>
      <table class="plan-table">${rows.join("")}</table>
      <p class="muted">529종목 57,796건(4시간봉) 측정 결과입니다.
      <b>대량거래 봉</b>: 점수 40 이상 구간에서는 있든 없든 급등률이 같았습니다(16.2% 대 16.1%)
      — 이미 점수에 든 거래량 확장이 같은 것을 더 잘 잡습니다.
      <b>CVD 다이버전스</b>: 학습 1.20배 / 검증 1.15배 — 방향은 맞지만 약합니다.
      둘 다 점수를 대체하지 못하며 위치 참고용입니다.</p>
    </section>`;
}

// 시드머니를 넣었을 때의 손익 금액. 레버리지 없음, 왕복 비용 반영.
// "계획대로 지켰을 때" 의 산수다 — 목표 도달을 보장하지 않으므로 문구로 못 박는다.
function moneySection(p) {
  const s = state.settings;
  const on = s.partialTake !== false;
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
  const how = on
    ? `TP1 에서 ${pct}% 를 빼고 손절을 본전(${fmtPrice(p.entry)})으로 올리는 전제입니다 —
       평균 수익은 낮지만 아픈 구간이 절반이고 승률이 37% → 49% 입니다.`
    : `목표까지 통째로 버티는 전제입니다 — 평균 수익이 더 높은 대신 아픈 구간이 2배이고
       10번 중 3.7번만 이깁니다. 필터의 "파는 방식" 에서 바꿀 수 있습니다.`;
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
  const stageBadge = `<span class="badge badge-${r.stage.badge}">${r.stage.stage}단계 · ${r.stage.label}</span>`;
  const dirBadge = `<span class="dir dir-${r.direction}">${r.direction === "long" ? "LONG" : "SHORT"}</span>`;

  return `
  <div class="detail-card" role="dialog" aria-modal="true">
    <button class="detail-close" data-close aria-label="닫기">✕</button>
    <header class="detail-head">
      <div class="detail-title">
        <button class="fav-btn ${isFavorite(r.symbol) ? "active" : ""}" data-fav aria-label="관심 종목">★</button>
        <h2>${escapeHtml(r.symbol)}</h2>
        <span class="score-pill score-${r.grade.key}">${r.score}</span>
        ${dirBadge}
      </div>
      <div class="detail-sub">
        ${stageBadge}
        <span>현재가 ${fmtPrice(r.price)}</span>
        <span class="${pctClass(r.change6h)}">6h ${fmtPct(r.change6h)}</span>
        <span>거래대금 ${fmtVolume(r.quoteVolume)}</span>
        ${r.newListing ? '<span class="badge badge-blue">신규</span>' : ""}
      </div>
    </header>

    <section class="detail-section">
      <h3>핵심 신호</h3>
      <ul class="signal-list">${r.topSignals.map((s) => `<li>✔ ${escapeHtml(s)}</li>`).join("")}</ul>
      <p class="absorption">흡수 추정: <b>${escapeHtml(r.absorption.label)}</b></p>
    </section>

    ${volumeFlowSection(r)}

    <section class="detail-section">
      <h3>진입 · 손절 · 목표 <small>(자동 주문 아님 · 기술적 참고 구간)</small></h3>
      <table class="plan-table">
        <tr><td>진입 후보</td><td>${fmtPrice(p.entry)}</td></tr>
        <tr><td>무효화(손절)</td><td>${fmtPrice(p.invalidation)}</td></tr>
        <tr><td>TP1 ${p.partialFrac ? `(${Math.round(p.partialFrac * 100)}% 익절 · 손절을 본전으로)` : (r.direction === "short" ? "(내부 저점)" : "(내부 고점)")}</td><td>${fmtPrice(p.tp1)}</td></tr>
        <tr><td>TP2 (${r.direction === "short" ? "주요 저점" : "주요 고점"})</td><td>${fmtPrice(p.tp2)}</td></tr>
        <tr><td>TP3 (${r.direction === "short" ? "Sell-side" : "Buy-side"})</td><td>${fmtPrice(p.tp3)}</td></tr>
        <tr class="rr"><td>예상 손익비</td><td>${p.rrText}</td></tr>
      </table>
      ${moneySection(p)}
      ${p.note ? `<p class="plan-note">${escapeHtml(p.note)}</p>` : ""}
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
