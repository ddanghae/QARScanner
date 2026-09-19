// ui/detail-panel.js — 종목 상세 분석 패널 (§15 상세 보기).
// 점수 근거, 단계, 흡수, 시간봉별 상태, 진입·손절·목표, 손익비, TradingView 버튼.

import { fmtPrice, fmtPct, fmtVolume, fmtWon, planMoney, pctClass, escapeHtml } from "./format.js";
import { openTradingView, copyTvLink, tvChartUrl, binanceFuturesUrl } from "./tradingview.js";
import { toggleFavorite, isFavorite, state, on } from "../state.js";
import { CONFIG } from "../config.js";
import { toast } from "./notifications.js";
import { SCAN_MODE_META, resultMode, resultKey } from "../scan-modes.js";
import { crtSection } from "./crt-tbs.js";
import { expireResult } from "../core/signal-freshness.js";
import { buildDecisionGate } from "../core/decision-gate.js";

let panelEl = null;
let activeResultKey = null;

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
    ? `TP1 에서 ${pct}% 를 빼고 손절을 본전(${fmtPrice(p.entry)})으로 올렸을 때의 계산입니다. 본전 청산에도 비용이 발생합니다.`
    : `목표까지 전량 보유했을 때의 계산입니다. 필터의 "파는 방식" 에서 바꿀 수 있습니다.`;
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
  on("signals:expired", () => {
    if (!panelEl.classList.contains("open")) return;
    const r = state.results.find((r) => resultKey(r) === activeResultKey);
    if (r) showDetail(r);
  });
  panelEl.addEventListener("click", (e) => {
    if (e.target.dataset.close !== undefined || e.target === panelEl) closeDetail();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDetail(); });
}

export function closeDetail() {
  if (panelEl) {
    panelEl.classList.remove("open");
    panelEl.setAttribute("aria-hidden", "true");
  }
}

export function showDetail(r) {
  if (!panelEl) return;
  r = expireResult(r);
  activeResultKey = resultKey(r);
  panelEl.innerHTML = renderDetail(r);
  panelEl.classList.add("open");
  panelEl.setAttribute("aria-hidden", "false");

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

export function renderDetail(r) {
  const p = r.plan;
  const mode = resultMode(r);
  const modeMeta = SCAN_MODE_META[mode];
  const isPumpFade = mode === "pump_fade";
  const isSweep = mode === "sweep_retest";
  const stageLabel = isPumpFade ? String(r.stage.label || "").replace(/^\d+\s*/, "") : r.stage.label;
  const stageBadge = `<span class="badge badge-${r.stage.badge}">${r.stage.stage}단계 · ${escapeHtml(stageLabel)}</span>`;
  const dirBadge = `<span class="dir dir-${r.direction}">${r.direction === "long" ? "LONG" : "SHORT"}</span>`;

  return `
  <div class="detail-card" role="dialog" aria-modal="true">
    <button class="detail-close" data-close aria-label="닫기">✕</button>
    <header class="detail-head">
      <div class="detail-title">
        <button class="fav-btn ${isFavorite(r.symbol) ? "active" : ""}" data-fav aria-label="관심 종목">★</button>
        <h2>${escapeHtml(r.symbol)}</h2>
        <span class="badge badge-mode badge-mode-${modeMeta.badge}">${modeMeta.label}</span>
        <span class="score-pill score-${r.grade.key}">${isSweep ? `진행 ${r.stage.stage}/5` : `${isPumpFade ? "실험 점수 " : ""}${r.score}`}</span>
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

    ${earlyAxesSection(r)}

    ${decisionGateSection(r)}

    ${isSweep ? "" : forecastSection(r)}
    ${isSweep ? "" : crtSection(r)}

    ${isSweep ? sweepRetestSection(r) : `<section class="detail-section">
      <h3>진입 · 손절 · 목표 <small>(자동 주문 아님 · 기술적 참고 구간)</small></h3>
      <table class="plan-table">
        <tr><td>진입 후보</td><td>${fmtPrice(p.entry)}</td></tr>
        <tr><td>무효화(손절)</td><td>${fmtPrice(p.invalidation)}</td></tr>
        <tr><td>TP1 ${isPumpFade ? "(1R)" : p.partialFrac ? `(${Math.round(p.partialFrac * 100)}% 익절 · 손절을 본전으로)` : (r.direction === "short" ? "(내부 저점)" : "(내부 고점)")}</td><td>${fmtPrice(p.tp1)}</td></tr>
        <tr><td>TP2 (${isPumpFade ? "2R" : r.direction === "short" ? "주요 저점" : "주요 고점"})</td><td>${fmtPrice(p.tp2)}</td></tr>
        <tr><td>TP3 (${isPumpFade ? "3R" : r.direction === "short" ? "Sell-side" : "Buy-side"})</td><td>${fmtPrice(p.tp3)}</td></tr>
        <tr class="rr"><td>예상 손익비</td><td>${p.rrText}</td></tr>
        ${p.warning ? `<tr><td>위험 경고</td><td>${escapeHtml(p.warning)}</td></tr>` : ""}
      </table>
      ${isPumpFade ? '<p class="muted">pump_fade는 공개 데이터 기반 실험 신호만 제공하며 금액·레버리지·청산 계산을 적용하지 않습니다.</p>' : moneySection(p)}
      ${p.note ? `<p class="plan-note">${escapeHtml(p.note)}</p>` : ""}
      ${isPumpFade ? '<p class="plan-note">초기 임계값과 가중치이며 성공 확률이나 기대수익률로 해석할 수 없습니다.</p>' : ""}
    </section>`}

    ${tfSection(r)}

    <section class="detail-section">
      <h3>${isSweep ? "패턴 순서" : "점수 근거"}</h3>
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

function earlyAxesSection(r) {
  const a = r?.earlyAxes;
  if (!a) return "";
  const list = (items) => items?.length ? items.map(escapeHtml).join(" · ") : "추가 확인 없음";
  const sweep = r?.earlyConfirmation?.sweepRetest;
  const sweepText = sweep?.confirmed ? `확인 · ${sweep.reason}` : (sweep?.label || "확인 없음");
  return `<section class="detail-section">
    <h3>조기포착 3축 <small>(한 숫자로 섞지 않음)</small></h3>
    <table class="plan-table">
      <tr><td>급등 잠재력</td><td><b>${a.potential.score} · ${escapeHtml(a.potential.label)}</b><br><small>과거 검증 점수 · ${CONFIG.earlyHitLabel}</small></td></tr>
      <tr><td>현재 준비도</td><td><b>${a.readiness.score} · ${escapeHtml(a.readiness.label)}</b><br><small>${list(a.readiness.reasons)}</small></td></tr>
      <tr><td>관찰 위험도</td><td><b>${a.risk.score} · ${escapeHtml(a.risk.label)}</b><br><small>${list(a.risk.reasons)}</small></td></tr>
      <tr><td>첫 눌림 확인</td><td>${escapeHtml(sweepText)}</td></tr>
    </table>
    <p class="plan-note">잠재력만 과거 급등 라벨로 검증된 점수입니다. 준비도와 위험도는 현재 상태를 놓치지 않기 위한 체크리스트이며 성공 확률이나 매수 지시가 아닙니다.</p>
  </section>`;
}

export function sweepRetestSection(r) {
  const s = r?.sweepRetest || {};
  const b = s.base || {};
  const levels = s.levels || {};
  const time = value => Number.isFinite(value)
    ? new Date(value).toLocaleString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "-";
  const events = (s.events || []).map(event => `<li><b>${escapeHtml(event.label)}</b><span>${time(event.time)}</span></li>`).join("");
  const confluence = (s.confluence || []).length
    ? s.confluence.map(x => `<span class="badge badge-blue">${escapeHtml(x)}</span>`).join(" ")
    : '<span class="muted">겹치는 보조 구간 없음 — 필수 조건은 아님</span>';
  return `<section class="detail-section">
    <h3>스윕 후 첫 눌림 탐지 <small>(마감봉 순서 판정)</small></h3>
    <p><b>${escapeHtml(s.label || "판정 보류")}</b> · ${escapeHtml(s.reason || "자료가 부족합니다.")}</p>
    <ul class="decision-checks">${events || '<li class="decision-info"><span>아직 확정된 이벤트가 없습니다.</span></li>'}</ul>
    <table class="plan-table">
      <tr><td>선행 급락</td><td>${Number.isFinite(b.drop) ? b.drop.toFixed(1) + "%" : "-"}</td></tr>
      <tr><td>저거래량 횡보</td><td>${b.bars || "-"}시간 · 급락 구간 대비 ${Number.isFinite(b.volumeRatio) ? (b.volumeRatio * 100).toFixed(0) + "%" : "-"}</td></tr>
      <tr><td>기준 지지</td><td>${fmtPrice(levels.support ?? b.support)}</td></tr>
      <tr><td>W 넥라인</td><td>${fmtPrice(levels.neckline)}</td></tr>
      <tr><td>스윕 저점</td><td>${fmtPrice(levels.sweepLow)}</td></tr>
      <tr><td>확인 만료</td><td>${time(s.expiresAt)}</td></tr>
    </table>
    <p class="muted">보조 겹침: ${confluence}</p>
    <p class="plan-note">초기 규칙: 6시간 -15% 이하 · 20~40시간 횡보 · 횡보 폭 8% 이하 · 거래량 65% 이하 · 3개 15분봉 내 회수 · 돌파/5분 거래량 1.5배. 수익성 검증값이 아니며 진입가·목표가·포지션 크기를 만들지 않습니다.</p>
  </section>`;
}

function decisionGateSection(r) {
  const gate = buildDecisionGate(r);
  const icon = { pass: "✓", warn: "!", block: "×", info: "·" };
  return `<section class="detail-section decision-gate decision-gate-${gate.status}">
    <div class="decision-gate-head">
      <h3>후보 검토 체크리스트</h3>
      <span class="badge badge-gate-${gate.status}">${escapeHtml(gate.label)}</span>
    </div>
    <ul class="decision-checks">${gate.checks.map((check) => `
      <li class="decision-${check.level}"><b>${icon[check.level]} ${escapeHtml(check.label)}</b><span>${escapeHtml(check.detail)}</span></li>`).join("")}</ul>
    <p class="plan-note">${escapeHtml(gate.note)} 점수와 정렬에는 반영하지 않습니다.</p>
  </section>`;
}

function forecastSection(r) {
  const f = r?.forecast;
  if (!f?.available) return `<section class="detail-section forecast-detail forecast-detail-unavailable">
    <h3>24시간 방향 전망 <small>(스캐너 점수와 별도)</small></h3>
    <p class="muted">${escapeHtml(f?.reason || "방향 모델을 검증 중이라 숫자를 표시하지 않습니다.")}</p>
  </section>`;
  const label = { up: "상승 우세", down: "하락 우세", neutral: "횡보 우세" }[f.lead];
  const confidence = { high: "높음", medium: "보통", low: "낮음" }[f.confidence];
  const upper = f.upperBoundary;
  const lower = f.lowerBoundary;
  const dataDate = f.dataAsOf ? new Date(f.dataAsOf).toISOString().slice(0, 10) : "-";
  const drivers = (f.drivers || []).map((d) => `<li>${escapeHtml(d.label)}</li>`).join("");
  const extraWarn = f.outOfDistribution
    ? '<p class="warn">현재 입력이 학습 범위를 크게 벗어나 신뢰도를 낮췄습니다.</p>' : "";
  return `<section class="detail-section forecast-detail">
    <h3>24시간 방향 전망 <small>(스캐너 점수와 별도 · 자동 주문 아님)</small></h3>
    <div class="forecast-headline forecast-${f.lead}"><b>${label}</b><span>신뢰도 ${confidence}</span></div>
    <div class="forecast-bars" aria-label="상승 ${f.up}%, 하락 ${f.down}%, 횡보 ${f.neutral}%">
      <div class="forecast-bar forecast-bar-up" style="--forecast-width:${f.up}%"><span>상승</span><b>${f.up}%</b></div>
      <div class="forecast-bar forecast-bar-down" style="--forecast-width:${f.down}%"><span>하락</span><b>${f.down}%</b></div>
      <div class="forecast-bar forecast-bar-neutral" style="--forecast-width:${f.neutral}%"><span>횡보</span><b>${f.neutral}%</b></div>
    </div>
    <table class="plan-table">
      <tr><td>예측 질문</td><td>${f.horizonHours}시간 안에 어느 경계에 먼저 닿나?</td></tr>
      <tr><td>기준 가격</td><td>${fmtPrice(f.referencePrice)} (마지막 4시간 마감가)</td></tr>
      <tr><td>상승 경계</td><td class="up">${fmtPrice(upper)} (+${f.thresholdPct.toFixed(1)}%)</td></tr>
      <tr><td>하락 경계</td><td class="down">${fmtPrice(lower)} (-${f.thresholdPct.toFixed(1)}%)</td></tr>
      <tr><td>학습 표본</td><td>${f.sampleCount?.toLocaleString?.() ?? "-"}건 · 데이터 ${dataDate}까지</td></tr>
    </table>
    ${drivers ? `<p class="muted">이 전망에 크게 작용한 입력</p><ul class="signal-list">${drivers}</ul>` : ""}
    ${extraWarn}
    <p class="plan-note">위 숫자는 TP·손절 도달률이나 수익 확률이 아닙니다. 마지막 4시간 마감가에서 코인별 변동성 경계 중
    어느 쪽을 먼저 건드릴지 추정한 값이며, 최근 약 166일·현재 거래 중인 종목만 사용한 한계가 있습니다.</p>
  </section>`;
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
