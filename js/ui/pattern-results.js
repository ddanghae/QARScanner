// ui/pattern-results.js — 패턴 검색 결과의 필터링·정렬·카드 렌더링.

import { state } from "../state.js";
import { fmtPrice, fmtPriceList, fmtVolume, fmtTime, escapeHtml } from "./format.js";
import { openTradingView } from "./tradingview.js";
import { buildPatternTvSnapshot } from "./pattern-tv-export.js";
import { toast } from "./notifications.js";
import { patternCompletionPct, patternFamilyLabel } from "../core/chart-patterns.js";
import { assessSymbolDirection } from "../core/pattern-direction.js";
import { derivePatternEntryCandidate } from "../core/pattern-entry.js";
import { recordPatternTrade } from "./paper.js";

let patternScanSide = "long";

export function renderPatternResults(resultsEl) {
  const family = state.settings.patternFamily || "all";
  let baseRows = state.patternResults;
  if (state.settings.showFavoritesOnly) baseRows = baseRows.filter((row) => state.settings.favorites.includes(row.symbol));
  if (state.settings.excludeNewListing) baseRows = baseRows.filter((row) => !row.newListing);
  if (state.settings.excluded.length) baseRows = baseRows.filter((row) => !state.settings.excluded.includes(row.symbol));
  const fractalRows = baseRows.filter((row) => row.fractalContinuation?.matched)
    .sort((a, b) => Number(b.fractalContinuation.freshness?.status === "fresh") - Number(a.fractalContinuation.freshness?.status === "fresh")
      || Number(b.fractalContinuation.pattern?.fitScore) - Number(a.fractalContinuation.pattern?.fitScore)
      || b.quoteVolume - a.quoteVolume);
  const rows = baseRows.map((row) => ({
    ...row,
    patterns: row.patterns.filter((p) => family === "all" || p.family === family),
  })).filter((row) => row.patterns.length).map((row) => ({
    ...row,
    entryCandidate: derivePatternEntryCandidate({
      patterns: row.patterns,
      ema200ByTimeframe: row.ema200ByTimeframe,
      timeframes: row.scannedTimeframes || [],
      atrByTimeframe: row.atrByTimeframe,
      price: row.price,
    }),
  }));
  const longRows = rows.filter((row) => row.entryCandidate.direction === "long")
    .sort((a, b) => (b.entryCandidate.assessment.overall?.longPct || 0) - (a.entryCandidate.assessment.overall?.longPct || 0)
      || bestRowPatternFit(b) - bestRowPatternFit(a) || b.quoteVolume - a.quoteVolume);
  const shortRows = rows.filter((row) => row.entryCandidate.direction === "short")
    .sort((a, b) => (b.entryCandidate.assessment.overall?.shortPct || 0) - (a.entryCandidate.assessment.overall?.shortPct || 0)
      || bestRowPatternFit(b) - bestRowPatternFit(a) || b.quoteVolume - a.quoteVolume);
  const visibleRows = patternScanSide === "fractal" ? fractalRows : patternScanSide === "short" ? shortRows : longRows;
  const rankedRows = visibleRows.map((row, index) => ({ ...row, rank: index + 1, scanSide: patternScanSide }));
  const emptySideMessage = patternScanSide === "fractal" && !(state.patternScanMeta.requestedTimeframes || []).includes("5m") && state.scan.phase === "done"
    ? "5분봉을 선택한 뒤 다시 스캔하세요."
    : patternScanSide === "fractal" && state.scan.phase === "done"
      ? "지금은 5분 지속형 패턴과 확정 프랙탈 방향이 일치하는 종목이 없습니다."
      : !rows.length && state.scan.phase !== "done"
    ? "시간봉과 조건을 선택하고 스캔을 시작하세요."
    : state.scan.phase !== "done"
      ? "스캔 결과를 계산하고 있습니다."
      : "선택한 방향의 조건에 맞는 종목이 없습니다. 필터를 조정해 보세요.";
  const meta = state.patternScanMeta;
  const scanMetaText = meta?.candidateCount
    ? `검사 범위 ${meta.candidateCount}종목 · 시간봉 요청 ${meta.completedRequests}/${meta.candidateCount * meta.requestedTimeframes.length}${meta.failedRequests ? ` · 요청 실패 ${meta.failedRequests}건` : ""}`
    : "";
  resultsEl.innerHTML = `
    <div class="pattern-scan-tabs" role="group" aria-label="패턴 스캔 결과 보기">
      <button type="button" class="pattern-scan-tab ${patternScanSide === "long" ? "active long" : ""}" data-pattern-scan-side="long" aria-pressed="${patternScanSide === "long"}">롱 스캔 <b>${longRows.length}</b></button>
      <button type="button" class="pattern-scan-tab ${patternScanSide === "short" ? "active short" : ""}" data-pattern-scan-side="short" aria-pressed="${patternScanSide === "short"}">숏 스캔 <b>${shortRows.length}</b></button>
      <button type="button" class="pattern-scan-tab ${patternScanSide === "fractal" ? "active fractal" : ""}" data-pattern-scan-side="fractal" aria-pressed="${patternScanSide === "fractal"}">프랙탈 후보 <b>${fractalRows.length}</b></button>
    </div>
    ${scanMetaText ? `<p class="pattern-scan-meta" role="status">${escapeHtml(scanMetaText)}</p>` : ""}
    ${patternScanSide === "fractal" ? `<p class="fractal-scan-note">5분봉 마감 기준 · 지속형 패턴 · 좌우 3봉으로 확정된 프랙탈 방향 일치. 과거 검증 대상은 주요 10종목이므로 현재 종목의 승률로 읽지 마세요. 패턴 분류 선택과 별도로 표시합니다.</p>` : ""}
    <div class="pattern-cards">${rankedRows.length ? rankedRows.map(patternScanSide === "fractal" ? fractalCardHtml : patternCardHtml).join("") : `<div class="empty pattern-side-empty"><div class="scan-empty-icon" aria-hidden="true">⌖</div><strong>다음 움직임을 탐색하세요</strong><p>${emptySideMessage}</p><span class="empty-timeframes">${escapeHtml(selectedPatternTimeframes().join(" · "))}</span></div>`}</div>
    <details class="pattern-method"><summary>TradingView에서 패턴 직접 감지</summary><p><a href="https://raw.githubusercontent.com/ddanghae/QARScanner/main/pine/qar_pattern_detector.pine" target="_blank" rel="noopener">멀티 시간봉 패턴 탐지 지표 코드 보기</a>를 Pine Editor에 붙여넣으면 차트 종목의 5분·15분·1시간·4시간 패턴을 각각 계산합니다. 패널에서 롱·숏 방향, 적합도, 완성률을 확인하고 새 패턴 알림을 설정할 수 있습니다. 패턴 결과를 스캐너와 대조해 보고 싶다면 <a href="./pine/qar_pattern_snapshot.pine" target="_blank" rel="noopener">스캐너 결과 표시 지표</a>와 종목 카드의 ‘표시 데이터 복사’를 사용하세요. <a href="./docs/TRADINGVIEW-PATTERNS.md" target="_blank" rel="noopener">사용 방법</a></p></details>
    <details class="pattern-method"><summary>비율·타점 산정 방식</summary><p>종목별 롱/숏 비율은 패턴 근거 60%, EMA200 위치 40%를 반영하며 4시간봉에 더 큰 가중치를 둡니다. 타점 후보는 종합 방향 60%·패턴 방향 55% 이상, 구조선 완비, 손익비 1.5 이상일 때만 표시합니다. 진입 후보 구간은 기준선 ± 0.1 ATR이며 각 방향 최대 기준 가격의 0.15%로 제한합니다. 돌파나 되돌림 확인을 기다리는 값이며, 비율과 적합도는 승률이나 실제 확률이 아닙니다. 자세한 내용은 <a href="./docs/CHART-PATTERNS.md" target="_blank" rel="noopener">패턴 안내</a>를 확인하세요.</p></details>
  `;
  resultsEl.querySelectorAll("[data-pattern-scan-side]").forEach((button) => button.addEventListener("click", () => {
    patternScanSide = button.dataset.patternScanSide;
    renderPatternResults(resultsEl);
  }));
  resultsEl.querySelectorAll("[data-pattern-tv]").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    openTradingView(button.dataset.patternTv);
  }));
  resultsEl.querySelectorAll("[data-pattern-tv-copy]").forEach((button) => button.addEventListener("click", async (event) => {
    event.stopPropagation();
    const row = rows.find((item) => item.symbol === button.dataset.patternTvCopy);
    if (!row) return;
    try {
      const snapshot = buildPatternTvSnapshot(row, { includeRealtimeCandle: state.settings.includeRealtimeCandle });
      if (!snapshot.count) { toast("차트에 표시할 패턴 시각 정보가 없습니다. 다시 스캔해 주세요.", "warn"); return; }
      if (!await copyText(snapshot.text)) { toast("자동 복사가 실패했습니다. 브라우저의 클립보드 권한을 확인해 주세요.", "error"); return; }
      toast(`${snapshot.count}개 패턴 표시 데이터를 복사했습니다.${snapshot.omitted ? ` ${snapshot.omitted}개는 표시 한도로 제외됐습니다.` : ""} 지표 설정의 ‘스캔 데이터’에 붙여넣으세요.`, snapshot.omitted ? "warn" : "success", 6500);
    } catch (error) {
      toast(error?.message || "패턴 데이터 복사에 실패했습니다.", "error");
    }
  }));
  resultsEl.querySelectorAll("[data-pattern-record]").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    const row = rows.find((item) => item.symbol === button.dataset.patternRecord);
    if (row) recordPatternTrade(row);
  }));
}

async function copyText(value) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(value); return true; }
  } catch { /* Legacy clipboard fallback below. */ }
  const input = document.createElement("textarea");
  input.value = value;
  input.readOnly = true;
  input.style.cssText = "position:fixed;left:-9999px;opacity:0";
  document.body.appendChild(input);
  input.select();
  let copied = false;
  try { copied = document.execCommand("copy"); } catch { /* Clipboard unavailable. */ }
  input.remove();
  return copied;
}

function patternSymbolJudgmentHtml(row) {
  const frames = row.scannedTimeframes || [];
  const judgment = row.entryCandidate?.assessment || assessSymbolDirection(row.patterns, row.ema200ByTimeframe, frames);
  const overall = judgment.overall;
  const overallText = overall ? `롱 ${overall.longPct}% · 숏 ${overall.shortPct}%` : "롱/숏 근거 부족";
  const overallClass = !overall ? "pattern-neutral" : overall.longPct > overall.shortPct ? "pattern-bullish"
    : overall.shortPct > overall.longPct ? "pattern-bearish" : "pattern-neutral";
  const side = row.scanSide || row.entryCandidate?.direction || "long";
  const sidePct = overall ? (side === "short" ? overall.shortPct : overall.longPct) : null;
  const sideLabel = side === "short" ? "숏 근거 비중" : "롱 근거 비중";
  const patternText = judgment.pattern
    ? `패턴 근거 롱 ${judgment.pattern.longPct}% / 숏 ${judgment.pattern.shortPct}% · 상승 ${judgment.pattern.bullishCount} · 하락 ${judgment.pattern.bearishCount} · 중립 ${judgment.pattern.neutralCount}`
    : `방향성 패턴 없음 · 중립 ${judgment.timeframes.reduce((sum, frame) => sum + frame.neutralCount, 0)}개`;
  const emaText = judgment.ema200
    ? `EMA200 근거 롱 ${judgment.ema200.longPct}% / 숏 ${judgment.ema200.shortPct}% · 위 ${judgment.ema200.aboveCount} · 아래 ${judgment.ema200.belowCount}`
    : "EMA200 방향 근거 산출 불가";
  const emaFrames = judgment.timeframes.map((frame) => {
    const position = frame.ema200Position;
    const failed = (row.failedTimeframes || []).includes(frame.timeframe);
    const label = position === "above" ? `위 ${signedPct(frame.ema200DistancePct)}`
      : position === "below" ? `아래 ${Math.abs(frame.ema200DistancePct).toFixed(1)}%`
        : position === "equal" ? "선 부근" : failed ? "요청 오류" : "산출 불가";
    const cls = position === "above" ? "pattern-bullish" : position === "below" ? "pattern-bearish" : "pattern-neutral";
    return `<span class="pattern-ema-chip ${cls}">${frame.timeframe} EMA200 ${label}</span>`;
  }).join("");
  return `<div class="pattern-symbol-judgment">
    <div class="pattern-symbol-overall"><strong class="${side === "short" ? "pattern-bearish" : overallClass}">${overall ? `${sideLabel} ${sidePct}%` : "방향 근거 부족"}</strong><span>${side === "short" ? "숏 스캔" : "롱 스캔"}</span></div>
    ${overall ? `<div class="pattern-ratio-track ${side}" role="img" aria-label="${escapeHtml(sideLabel)} ${sidePct}% · ${escapeHtml(overallText)}"><span style="width:${sidePct}%"></span></div>` : ""}
    <details class="pattern-evidence"><summary>판단 근거</summary><div class="pattern-symbol-sources"><span>${patternText}</span><span>${emaText}</span></div><div class="pattern-ema-frames">${emaFrames}</div></details>
  </div>`;
}

export function patternEntryCandidateHtml(row) {
  const candidate = row.entryCandidate;
  const directionClass = candidate.direction === "long" ? "pattern-bullish"
    : candidate.direction === "short" ? "pattern-bearish" : "pattern-neutral";
  if (candidate.entryLow == null) {
    return `<div class="pattern-entry-candidate ${directionClass}">
      <div class="pattern-entry-heading"><b>${escapeHtml(candidate.title)}</b></div>
      <p>${escapeHtml(candidate.reason)}</p>
    </div>`;
  }
  const [entryLow, entryHigh, stop, tp1, tp2, tp3] = fmtPriceList([
    candidate.entryLow, candidate.entryHigh, candidate.stop,
    candidate.tp1, candidate.tp2, candidate.tp3,
  ]);
  return `<div class="pattern-entry-candidate ${directionClass}">
    <div class="pattern-entry-heading"><b>${escapeHtml(candidate.title)}</b><span>근거 ${escapeHtml(candidate.reason)}</span></div>
    <div class="pattern-entry-levels">
      <span><small>진입 후보 구간</small><b>${entryLow} – ${entryHigh}</b></span>
      <span><small>SL · 구조 무효화</small><b>${stop} · -${candidate.riskPct.toFixed(2)}%</b></span>
      <span><small>TP1 · 1R</small><b>${tp1} · +${candidate.tp1Pct.toFixed(2)}%</b></span>
      <span><small>TP2 · 중간 목표</small><b>${tp2} · +${candidate.tp2Pct.toFixed(2)}%</b></span>
      <span><small>TP3 · 패턴 투영</small><b>${tp3} · +${candidate.rewardPct.toFixed(2)}%</b></span>
      <span><small>TP3 기준 손익비</small><b>1 : ${candidate.rr.toFixed(2)}</b></span>
    </div>
    <p>확정 봉 기준 조건부 후보입니다. 손절 폭은 수수료·슬리피지 전 추정치이며, 돌파/되돌림 확인 전에는 진입 신호가 아닙니다. 페이퍼 기록은 SL 또는 TP3 도달만 판정하며 TP1·TP2 분할 익절은 집계하지 않습니다.</p>
    <button class="btn-mini pattern-record" data-pattern-record="${escapeHtml(row.symbol)}">페이퍼 기록</button>
  </div>`;
}

function signedPct(value) {
  if (!Number.isFinite(value)) return "";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}
function patternBiasLabel(bias) { return bias === "bullish" ? "상승" : bias === "bearish" ? "하락" : "방향 대기"; }
function patternStatusLabel(status) { return status === "breakout" ? "종가 돌파" : status === "reaction" ? "반응 확인" : "형성 중"; }
function selectedPatternTimeframes() {
  const valid = ["5m", "15m", "1h", "4h"];
  const selected = Array.isArray(state.settings.patternTimeframes)
    ? valid.filter((tf) => state.settings.patternTimeframes.includes(tf)) : valid;
  return selected.length ? selected : valid;
}
function patternFit(pattern) {
  return Math.max(0, ...Object.values(pattern.timeframes || {}).map((frame) => Number(frame.fitScore) || 0));
}
function patternBestFrame(pattern) {
  return Object.entries(pattern.timeframes || {})
    .sort((a, b) => (Number(b[1].fitScore) || 0) - (Number(a[1].fitScore) || 0))[0] || null;
}
function bestRowPatternFit(row) { return Math.max(0, ...row.patterns.map(patternFit)); }
function patternTimeframeCell(row, pattern, timeframe) {
  const found = pattern.timeframes?.[timeframe];
  if (found) {
    return `<div class="pattern-fit-cell pattern-${escapeHtml(found.bias)}" title="${escapeHtml(patternStatusLabel(found.status))}">
      <span>${timeframe}</span><b>적합 ${found.fitScore}점</b>
      <small>완성 ${found.completionPct == null ? "—" : `${found.completionPct}%`}</small>
      <small>${patternStatusLabel(found.status)}</small>
    </div>`;
  }
  const failed = (row.failedTimeframes || []).includes(timeframe);
  const scanned = (row.scannedTimeframes || []).includes(timeframe);
  return `<div class="pattern-fit-cell pattern-fit-empty" title="${failed ? "시간봉 데이터 요청 실패" : scanned ? "이 시간봉에서 감지되지 않음" : "이번 스캔에서 검사하지 않음"}">
    <span>${timeframe}</span><small>${failed ? "오류" : scanned ? "없음" : "미검사"}</small>
  </div>`;
}
function patternResultHtml(row, pattern) {
  const grid = ["5m", "15m", "1h", "4h"].map((timeframe) => patternTimeframeCell(row, pattern, timeframe)).join("");
  return `<div class="pattern-result">
    <div class="pattern-result-title"><span class="pattern-badge pattern-${escapeHtml(pattern.bias)}">${escapeHtml(pattern.name)} · ${patternBiasLabel(pattern.bias)}</span><small>${escapeHtml(patternFamilyLabel(pattern.family))}</small></div>
    <div class="pattern-timeframe-grid">${grid}</div>
    ${patternDetailsHtml(pattern)}
  </div>`;
}
function patternDetailsHtml(pattern) {
  const frames = ["5m", "15m", "1h", "4h"].filter((timeframe) => pattern.timeframes?.[timeframe]).map((timeframe) => {
    const detail = pattern.timeframes[timeframe];
    const levels = [
      detail.trigger != null ? `<span>기준선 ${fmtPrice(detail.trigger)}</span>` : "",
      detail.invalidation != null ? `<span>구조 무효화 ${fmtPrice(detail.invalidation)}</span>` : "",
      detail.projection != null ? `<span>기계적 투영 ${fmtPrice(detail.projection)}</span>` : "",
      detail.zone ? `<span>PRZ ${fmtPrice(detail.zone.low)}–${fmtPrice(detail.zone.high)}</span>` : "",
    ].filter(Boolean).join("");
    const evidence = (detail.evidence || []).slice(0, 3).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
    return `<div class="pattern-frame-detail"><b>${timeframe} · ${patternStatusLabel(detail.status)} · 적합도 ${detail.fitScore}점 · 완성률 ${detail.completionPct == null ? "—" : `${detail.completionPct}%`}</b>${levels ? `<div class="pattern-levels">${levels}</div>` : ""}${evidence ? `<ul>${evidence}</ul>` : ""}</div>`;
  }).join("");
  return `<details class="pattern-details"><summary>구조 근거와 기준선</summary>${frames}</details>`;
}
function fractalCardHtml(row) {
  const signal = row.fractalContinuation;
  const pattern = signal.pattern;
  const long = pattern.bias === "bullish";
  const [trigger, invalidation, projection] = fmtPriceList([
    pattern.trigger, pattern.invalidation, pattern.projection,
  ]);
  const status = pattern.status === "breakout" ? "종가 돌파 확인"
    : pattern.status === "reaction" ? "반응 확인" : "기준선 돌파 대기";
  const freshness = { fresh: "최신 마감 봉", delayed: "데이터 지연", stale: "오래된 신호", unknown: "시각 확인 불가" }[signal.freshness?.status] || "시각 확인 불가";
  const trend = long ? "프랙탈 고점·저점 상승" : "프랙탈 고점·저점 하락";
  const completion = patternCompletionPct(pattern, signal.price);
  return `<section class="pattern-card fractal-card ${long ? "scan-long" : "scan-short"}">
    <div class="pattern-card-top"><div class="pattern-card-symbol"><small>#${row.rank}</small><strong>${escapeHtml(row.symbol)}</strong></div><span class="pattern-card-price">${fmtPrice(signal.price)}</span></div>
    <div class="fractal-card-heading"><span class="pattern-badge ${long ? "pattern-bullish" : "pattern-bearish"}">${long ? "롱" : "숏"} · ${escapeHtml(pattern.name)}</span><span>${escapeHtml(status)}</span></div>
    <p class="fractal-card-meta">${escapeHtml(trend)} · 적합도 ${Number(pattern.fitScore)}점 · 완성률 ${completion == null ? "—" : `${completion}%`}</p>
    <div class="fractal-card-levels"><span><small>패턴 기준선</small><b>${trigger}</b></span><span><small>구조 무효화</small><b>${invalidation}</b></span><span><small>패턴 목표</small><b>${projection}</b></span></div>
    <div class="fractal-card-foot"><span>${escapeHtml(freshness)} · ${fmtTime(signal.closedAt)}</span><span>향후 12봉 관찰</span></div>
    <p class="fractal-card-caution">과거 검증과 같은 패턴·프랙탈 조건의 관찰 후보입니다. 기준선 체결과 거래 비용은 검증 결과에 포함되지 않았습니다.</p>
    <div class="pattern-card-actions"><button class="btn-mini tv" data-pattern-tv="${escapeHtml(row.symbol)}">TradingView 차트</button></div>
  </section>`;
}
function patternCardHtml(row) {
  const rankedPatterns = [...row.patterns].sort((a, b) => patternFit(b) - patternFit(a));
  const preview = rankedPatterns.slice(0, 4).map((pattern) => {
    const best = patternBestFrame(pattern);
    const frame = best ? `${best[0]} · ${best[1].fitScore}점` : "시간봉 없음";
    return `<span class="pattern-chip pattern-${escapeHtml(pattern.bias)}">${escapeHtml(pattern.name)} <small>${frame}</small></span>`;
  }).join("");
  const blocks = rankedPatterns.map((pattern) => patternResultHtml(row, pattern)).join("");
  const freshness = freshnessHtml(row);
  const validation = validationHtml(row);
  return `<section class="pattern-card ${row.scanSide === "short" ? "scan-short" : "scan-long"}">
    <div class="pattern-card-top"><div class="pattern-card-symbol"><small>#${row.rank}</small><strong>${escapeHtml(row.symbol)}</strong></div><span class="pattern-card-price">${fmtPrice(row.price)}</span></div>
    <div class="pattern-card-volume">거래대금 ${fmtVolume(row.quoteVolume)} · 검사 ${(row.scannedTimeframes || []).join(" · ")}${row.latestCandleTime ? ` · 기준봉 ${fmtTime(row.latestCandleTime)}` : ""}</div>
    ${freshness}${validation}
    ${patternSymbolJudgmentHtml(row)}
    ${patternEntryCandidateHtml(row)}
    <div class="pattern-preview">${preview}</div>
    <details class="pattern-all"><summary>패턴 ${row.patterns.length}개 · 시간봉별 상세 보기</summary><div class="pattern-block-list">${blocks}</div></details>
    <div class="pattern-card-actions"><button class="btn-mini tv" data-pattern-tv="${escapeHtml(row.symbol)}">TradingView 차트</button><button class="btn-mini" data-pattern-tv-copy="${escapeHtml(row.symbol)}">표시 데이터 복사</button></div>
  </section>`;
}

function freshnessHtml(row) {
  const frames = Object.entries(row.freshnessByTimeframe || {});
  if (!frames.length) return "";
  const label = { fresh: "최신", delayed: "지연", stale: "오래됨", unknown: "확인 불가" };
  const chips = frames.map(([timeframe, item]) => `<span class="pattern-freshness-chip freshness-${item?.status || "unknown"}">${timeframe} ${label[item?.status] || label.unknown}</span>`).join("");
  return `<div class="pattern-freshness" aria-label="신호 신선도">${chips}</div>`;
}

function validationHtml(row) {
  const items = Object.entries(row.validationByTimeframe || {}).filter(([, value]) => value?.sampleCount);
  if (!items.length) return `<div class="pattern-validation muted">시간순 검증 표본 부족</div>`;
  const text = items.map(([timeframe, value]) => {
    const v = value.validation || {};
    return `${timeframe} 학습 ${value.train?.n || 0} · 검증 ${v.n || 0}건${v.winRate == null ? "" : ` · 검증 승률 ${v.winRate}%`}`;
  }).join(" · ");
  return `<div class="pattern-validation">시간순 검증 · ${escapeHtml(text)} <small>${escapeHtml(items[0][1].label || "표본 부족")}</small></div>`;
}
