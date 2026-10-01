import { fmtPrice, fmtPriceList, fmtVolume, fmtTime, escapeHtml } from "./format.js";
import { currentRetestSignal, RETEST_LABELS } from "../core/trend-retest.js";

let side = "both", confirmedOnly = false;
const stageOrder = { ready: 0, retest: 1, breakout: 2, watch: 3, risk: 4, invalid: 5, late: 6, expired: 7 };
export function retestRows(rows, now = Date.now()) {
  return rows.map(row => ({ ...row, trendRetest: currentRetestSignal(row.trendRetest, now) }))
    .filter(row => row.trendRetest?.pattern && row.trendRetest.direction)
    .sort((a,b) => stageOrder[a.trendRetest.status]-stageOrder[b.trendRetest.status] || b.quoteVolume-a.quoteVolume);
}

export function retestTabHtml(rows, requestedTimeframes = [], now = Date.now()) {
  const all = retestRows(rows, now);
  const visible = all.filter(row => (side === "both" || row.trendRetest.direction === side)
    && (!confirmedOnly || row.trendRetest.status === "ready"));
  const missing = ["5m", "1h"].filter(tf => !requestedTimeframes.includes(tf));
  return `<div class="retest-controls" role="group" aria-label="추세·수급 방향 선택">
    ${[["both","전체"],["long","롱"],["short","숏"]].map(([value,label]) => `<button type="button" class="btn-mini ${side === value ? "selected" : ""}" data-retest-side="${value}" aria-pressed="${side === value}">${label}${value === "both" ? "" : ` ${all.filter(row => row.trendRetest.direction === value).length}`}</button>`).join("")}
    <label><input type="checkbox" data-retest-confirmed ${confirmedOnly ? "checked" : ""}> 전환 확인만</label>
  </div>
  <p class="fractal-scan-note">QAR 추세·수급 리테스트 · 1시간 추세 + 5분 확정 프랙탈 + 지속형 돌파 → 첫 눌림 → 전환 확인. 수급은 별도 관찰 정보이며 승률이 아닙니다. 실전 성과 미검증.</p>
  ${missing.length ? `<div class="retest-warning" role="status">${escapeHtml(missing.join(" · "))} 시간봉을 선택하고 다시 스캔하세요. 이 전략은 마감 5분봉·1시간봉이 필요합니다.</div>` : ""}
  <div class="pattern-cards">${visible.length ? visible.map((row,index) => retestCardHtml(row,index+1,now)).join("") : `<div class="empty pattern-side-empty"><strong>추세·수급 후보 대기</strong><p>${missing.length ? "필수 시간봉 자료가 부족합니다." : "현재 선택 조건에 맞는 지속형·첫 눌림 후보가 없습니다."}</p></div>`}</div>
  <details class="pattern-method"><summary>전략 규칙과 수급 해석</summary><p>패턴 가격선은 돌파 이전 마감 봉에서 고정합니다. 첫 눌림은 돌파선 ±0.25 ATR 또는 돌파 뒤 형성된 FVG와의 첫 교차입니다. 이후 봉의 종가 전환을 확인하고 구조 손절·비용 후 손익비를 계산합니다. 확인 신호는 최대 15분, 최신 5분봉이 지연되면 먼저 만료됩니다. 거래량·Delta·CVD·흡수는 공개 캔들 기반 추정이며 참여자의 신원이나 의도를 알 수 없습니다. 미결제약정·펀딩은 활성 상위 10종목만 추가 조회합니다. 조회가 없거나 실패하면 누락으로 표시합니다. 비용 가정은 왕복 0.2%이며 실제 펀딩·시장 충격은 포함하지 않습니다.</p></details>`;
}

export function bindRetestControls(root, render) {
  root.querySelectorAll("[data-retest-side]").forEach(button => button.addEventListener("click", () => { side = button.dataset.retestSide; render(); }));
  root.querySelectorAll("[data-retest-confirmed]").forEach(input => input.addEventListener("change", () => { confirmedOnly = input.checked; render(); }));
}

export function hasExpiredRetestCards(root, now = Date.now()) {
  return [...root.querySelectorAll("[data-retest-expiry]")].some(card => Number(card.dataset.retestExpiry) <= now);
}

export function retestCardHtml(row, rank = 1, now = Date.now()) {
  const s = currentRetestSignal(row.trendRetest, now), long = s.direction === "long", supply = s.supply;
  const deadline = s.status !== "expired" && Number.isFinite(s.asOf) ? Math.min(s.expiresAt || Infinity, s.asOf + 302000) : null;
  const evidence = supply?.evidence || [];
  const supporting = evidence.filter(item => item.side === s.direction).length;
  const opposing = evidence.filter(item => item.side !== s.direction && item.side !== "neutral").length;
  const plan = s.plan;
  const prices = plan ? fmtPriceList([plan.entryLow, plan.entryHigh, plan.stop, plan.tp1, plan.tp2, plan.tp3]) : [];
  const structure = { up: "고점·저점 상승", down: "고점·저점 하락", mixed: "혼조", insufficient: "자료 부족" }[s.context?.trend] || "확인 필요";
  const oi = supply?.oiChangePct == null ? "미조회·자료 부족" : `${supply.oiChangePct >= 0 ? "+" : ""}${supply.oiChangePct.toFixed(2)}%`;
  const funding = supply?.funding == null ? "미조회·자료 부족" : `${(supply.funding * 100).toFixed(4)}%`;
  const volume = supply?.relVolume == null ? "—" : `${supply.relVolume.toFixed(2)}배`;
  const buy = supply?.buyRatio == null ? "—" : `${(supply.buyRatio * 100).toFixed(1)}%`;
  const delta = supply?.delta == null ? "—" : supply.delta.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
  return `<section class="pattern-card retest-card ${long ? "scan-long" : "scan-short"}" ${deadline ? `data-retest-expiry="${deadline}"` : ""}>
    <div class="pattern-card-top"><div class="pattern-card-symbol"><small>#${rank}</small><strong>${escapeHtml(row.symbol)}</strong></div><span class="pattern-card-price">${fmtPrice(row.price)}</span></div>
    <div class="fractal-card-heading"><span class="pattern-badge ${long ? "pattern-bullish" : "pattern-bearish"}">${long ? "롱" : "숏"} · ${escapeHtml(s.pattern.name)}</span><b>${escapeHtml(RETEST_LABELS[s.status] || s.label)}</b></div>
    <p>${escapeHtml(s.reason)}</p>
    <div class="pattern-card-volume">거래대금 ${fmtVolume(row.quoteVolume)} · 패턴 ${escapeHtml(s.timeframe || "5m")} · 1시간 구조 ${structure} · 4시간 ${escapeHtml(s.context4h?.direction === "long" ? "상승 참고" : s.context4h?.direction === "short" ? "하락 참고" : "방향 미확인")}</div>
    <div class="fractal-card-levels"><span><small>고정 돌파선</small><b>${fmtPrice(s.pattern.trigger)}</b></span><span><small>패턴 무효화</small><b>${fmtPrice(s.pattern.invalidation)}</b></span><span><small>패턴 목표</small><b>${fmtPrice(s.pattern.projection)}</b></span></div>
    ${plan ? `<div class="pattern-entry-candidate retest-plan"><b>전환 확인 · 검토 가격</b><div class="pattern-entry-levels">
      <span><small>검토 구간</small><b>${prices[0]} – ${prices[1]}</b></span>
      <span><small>SL · 비용 포함 손절폭</small><b>${prices[2]} · ${plan.lossWithCostPct.toFixed(2)}%</b></span>
      <span><small>TP1 · 1R 참고</small><b>${prices[3]}</b></span><span><small>TP2 · 중간 목표</small><b>${prices[4]}</b></span>
      <span><small>TP3 · 패턴 목표</small><b>${prices[5]}</b></span><span><small>비용 후 손익비</small><b>1:${plan.netRR.toFixed(2)}</b></span>
    </div><small>왕복 비용 ${plan.roundTripCostPct}% 가정 · 금액·레버리지 자동 계산 없음 · 확인 ${fmtTime(s.confirmedAt)}</small></div>` : ""}
    <div class="retest-supply"><div><b>세력 감지 · 수급 관측</b><span>${supporting}개 같은 방향 · ${opposing}개 반대 방향</span></div>
      <p>${escapeHtml(supply?.available ? supply.label : "수급 자료 부족")}${supply?.at ? ` · 기준 ${fmtTime(supply.at)}` : ""}</p>
      <p>거래량 ${volume} · 공격적 매수 ${buy} · Delta ${delta} (코인 수량)</p>
      <ul>${evidence.length ? evidence.map(item => `<li class="${item.side === "long" ? "pattern-bullish" : item.side === "short" ? "pattern-bearish" : ""}">${escapeHtml(item.text)}</li>`).join("") : "<li>관측 문턱을 넘은 수급 근거 없음</li>"}</ul>
      <p>OI 15분 ${escapeHtml(oi)} · 펀딩 ${escapeHtml(funding)}</p>
      <small>대량 거래·흡수 추정입니다. 세력의 신원·매집 의도나 상승·하락 확률은 확인할 수 없습니다.</small>
    </div>
    <div class="fractal-card-foot"><span>마감 기준 ${fmtTime(s.asOf)}</span><span>${s.expiresAt ? `유효 기한 ${fmtTime(s.expiresAt)}` : "확인 전 관찰"}</span></div>
    <div class="pattern-card-actions"><button type="button" class="btn-mini tv" data-pattern-tv="${escapeHtml(row.symbol)}">TradingView 차트</button></div>
  </section>`;
}
