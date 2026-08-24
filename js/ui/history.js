// Scanner history dashboard: local records, causal forward-paper metrics, filters, and exports.

import { state, on } from "../state.js";
import {
  filterHistoryEvents,
  historyEventStatus,
  historyJsonPayload,
  historyToCsv,
  summarizeHistory,
} from "../core/signal-history.js";
import { clearHistoryRecords, refreshHistoryOutcomes } from "../history/history-controller.js";
import { escapeHtml, fmtPct, fmtPrice } from "./format.js";
import { toast } from "./notifications.js";

const MODE_LABELS = {
  reversal: "급락 반등",
  early: "조기 매집",
  pump_fade: "급등 후 급락",
};
const STATUS_LABELS = {
  COMPLETE: "24h 완료",
  PENDING: "성과 대기",
  INCOMPLETE: "자료 불완전",
  PROVISIONAL: "임시 신호",
  HIT: "TP1 선도달",
  STOP: "손절 선도달",
  MISS: "둘 다 미도달",
  AMBIGUOUS: "같은 봉 동시 도달",
  INVALID: "계획 평가 제외",
};

let initialized = false;

export function initHistoryUI() {
  if (initialized) return;
  initialized = true;
  ["history-period", "history-mode", "history-direction", "history-status"].forEach((id) => {
    document.getElementById(id)?.addEventListener("change", renderHistory);
  });
  document.getElementById("history-refresh")?.addEventListener("click", async () => {
    try {
      const result = await refreshHistoryOutcomes({ force: true });
      if (!result.requested) toast("지금 갱신할 성과가 없습니다.", "info");
      else if (result.failed) toast(`성과 갱신: ${result.updated}건 완료, ${result.failed}건 실패`, "warn");
      else toast(`성과 ${result.updated}건을 갱신했습니다.`, "success");
    } catch (error) {
      setRefreshState(false);
      toast(`성과 갱신 실패: ${error.message}`, "error");
    }
  });
  document.getElementById("history-export-json")?.addEventListener("click", () => exportJson());
  document.getElementById("history-export-csv")?.addEventListener("click", () => exportCsv());
  document.getElementById("history-clear")?.addEventListener("click", () => {
    if (!window.confirm("이 브라우저에 저장된 스캔 기록을 모두 지울까요? 내보내지 않은 기록은 복구할 수 없습니다.")) return;
    const result = clearHistoryRecords();
    if (result.ok) toast("스캔 기록을 삭제했습니다.", "success");
    else toast("기록을 삭제하지 못했습니다.", "error");
  });

  on("history:changed", renderHistory);
  on("history:refresh:start", ({ requested }) => setRefreshState(true, `갱신 중 0/${requested}`));
  on("history:refresh:progress", ({ done, total }) => setRefreshState(true, `갱신 중 ${done}/${total}`));
  on("history:refresh:done", () => setRefreshState(false));
  on("history:error", () => renderStorageNotice());
  on("nav:changed", ({ nav }) => {
    if (nav !== "history") return;
    renderHistory();
    refreshHistoryOutcomes().catch((error) => toast(`성과 갱신 실패: ${error.message}`, "error"));
  });
  renderHistory();
}

function currentFilters() {
  return {
    period: document.getElementById("history-period")?.value || "all",
    mode: document.getElementById("history-mode")?.value || "all",
    direction: document.getElementById("history-direction")?.value || "all",
    status: document.getElementById("history-status")?.value || "all",
  };
}

function filteredEvents() {
  return filterHistoryEvents(state.history.events, currentFilters());
}

function ratioText(value) {
  return value == null ? "-" : `${(value * 100).toFixed(1)}%`;
}

function fmtDateTime(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString("ko-KR", {
    year: "2-digit", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

function metricCard(label, value, detail = "") {
  return `<div class="stat-card"><span class="stat-label">${escapeHtml(label)}</span><span class="stat-val">${escapeHtml(value)}</span>${detail ? `<small class="history-metric-detail">${escapeHtml(detail)}</small>` : ""}</div>`;
}

function renderSummary(events) {
  const el = document.getElementById("history-summary");
  if (!el) return;
  const summary = summarizeHistory(events);
  el.innerHTML = [
    metricCard("기록된 사건", String(summary.recordedCount), `확인 신호 ${summary.confirmedCount} · 임시 ${summary.provisionalCount}`),
    metricCard("24시간 완료", String(summary.completedCount), "마감 캔들 신호만"),
    metricCard("24h 방향 수익 +", ratioText(summary.positive24hRate), `분모 ${summary.completedCount}건`),
    metricCard("평균 24h 방향 수익", summary.average24hReturnPct == null ? "-" : fmtPct(summary.average24hReturnPct), "비용 전 가상 성과"),
    metricCard("TP1 선도달", ratioText(summary.tp1BeforeStopRate), `평가 가능 ${summary.planEvaluableCount}건`),
    metricCard("대기 / 문제", `${summary.pendingCount} / ${summary.incompleteCount}`, "문제 항목은 성과 분모 제외"),
  ].join("");
}

function renderModeBreakdown(events) {
  const el = document.getElementById("history-mode-breakdown");
  if (!el) return;
  const rows = Object.keys(MODE_LABELS).map((mode) => {
    const summary = summarizeHistory(events.filter((event) => event.scanMode === mode));
    return `<tr>
      <td>${MODE_LABELS[mode]}</td>
      <td>${summary.recordedCount}</td>
      <td>${summary.completedCount}</td>
      <td>${ratioText(summary.positive24hRate)}</td>
      <td class="${summary.average24hReturnPct > 0 ? "up" : summary.average24hReturnPct < 0 ? "down" : ""}">${summary.average24hReturnPct == null ? "-" : fmtPct(summary.average24hReturnPct)}</td>
      <td>${ratioText(summary.tp1BeforeStopRate)}</td>
    </tr>`;
  }).join("");
  el.innerHTML = `<table class="history-table history-mode-table">
    <thead><tr><th>모드</th><th>기록</th><th>24h 완료</th><th>24h 양수 비율</th><th>평균 24h</th><th>TP1 선도달</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function statusBadge(status) {
  const css = status === "COMPLETE" || status === "HIT" ? "ok"
    : status === "PENDING" || status === "MISS" ? "pending"
      : status === "PROVISIONAL" ? "provisional" : "issue";
  return `<span class="history-status history-status-${css}">${escapeHtml(STATUS_LABELS[status] || status || "-")}</span>`;
}

function checkpointValue(event, key) {
  const checkpoint = event.paper?.checkpoints?.[key];
  if (checkpoint?.status === "COMPLETE") {
    const value = checkpoint.returnPct;
    return `<span class="${value > 0 ? "up" : value < 0 ? "down" : ""}">${fmtPct(value)}</span>`;
  }
  if (checkpoint?.status === "INCOMPLETE") return `<span title="${escapeHtml(checkpoint.reason || "")}">불완전</span>`;
  return "대기";
}

function historyRow(event) {
  const status = historyEventStatus(event);
  const stage = event.signal?.stage?.value;
  const planStatus = event.paper?.planOutcome?.status || "PENDING";
  return `<tr>
    <td>${fmtDateTime(event.detectedAt)}<br><small>최근 ${fmtDateTime(event.lastSeenAt)}</small></td>
    <td class="sym">${escapeHtml(event.symbol)}<br><small>${event.seenCount || 1}회 포착</small></td>
    <td>${escapeHtml(MODE_LABELS[event.scanMode] || event.scanMode)}</td>
    <td><span class="dir dir-${event.direction}">${event.direction.toUpperCase()}</span></td>
    <td>${event.signal?.score ?? "-"}<br><small>${stage == null ? "-" : `${stage}단계`}</small></td>
    <td>${fmtPrice(event.signal?.price)}<br><small>${event.paper?.entryPrice ? fmtPrice(event.paper.entryPrice) : "진입 대기"}</small></td>
    <td>${checkpointValue(event, "1h")}</td>
    <td>${checkpointValue(event, "6h")}</td>
    <td>${checkpointValue(event, "24h")}</td>
    <td>${event.paper?.mfePct == null ? "-" : fmtPct(event.paper.mfePct)} / ${event.paper?.maePct == null ? "-" : fmtPct(-event.paper.maePct)}</td>
    <td>${statusBadge(planStatus)}</td>
    <td>${statusBadge(status)}</td>
  </tr>`;
}

function renderTable(events) {
  const el = document.getElementById("history-results");
  if (!el) return;
  if (!events.length) {
    el.innerHTML = `<div class="empty">선택한 조건의 기록이 없습니다. 다음 성공 스캔부터 결과가 쌓입니다.</div>`;
    return;
  }
  el.innerHTML = `<div class="history-table-wrap"><table class="history-table">
    <thead><tr>
      <th>최초 / 최근</th><th>코인</th><th>모드</th><th>방향</th><th>점수 / 단계</th>
      <th>신호가 / 가상 진입</th><th>1h</th><th>6h</th><th>24h</th><th>24h MFE / MAE</th><th>TP1·손절</th><th>상태</th>
    </tr></thead>
    <tbody>${events.map(historyRow).join("")}</tbody>
  </table></div>`;
}

function renderStorageNotice() {
  const el = document.getElementById("history-storage-notice");
  if (!el) return;
  if (state.history.storageIssue) {
    el.textContent = "브라우저 저장소를 사용할 수 없어 이 세션의 기록이 새로고침 후 사라질 수 있습니다.";
    el.hidden = false;
  } else {
    el.textContent = "";
    el.hidden = true;
  }
}

export function renderHistory() {
  const events = filteredEvents();
  renderSummary(events);
  renderModeBreakdown(events);
  renderTable(events);
  renderStorageNotice();
  const count = document.getElementById("history-filter-count");
  if (count) count.textContent = `${events.length}건 표시`;
}

function setRefreshState(busy, label = "성과 갱신") {
  const button = document.getElementById("history-refresh");
  if (!button) return;
  button.disabled = busy;
  button.textContent = busy ? label : "성과 갱신";
}

function download(name, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function dateStamp() {
  return new Date().toISOString().slice(0, 10);
}

function exportJson() {
  const events = filteredEvents();
  download(`qar-scan-history-${dateStamp()}.json`, JSON.stringify(historyJsonPayload(events), null, 2), "application/json;charset=utf-8");
}

function exportCsv() {
  const events = filteredEvents();
  download(`qar-scan-history-${dateStamp()}.csv`, `\uFEFF${historyToCsv(events)}`, "text/csv;charset=utf-8");
}

export default { initHistoryUI, renderHistory };
