// ui/paper.js — LONG 결과의 가상 기록. 실제 주문은 없고 브라우저에만 저장한다.
// SHORT 계산기는 아직 별도로 검증되지 않았으므로 기록 단계에서 차단한다.

import { getKlines } from "../api/binance.js";
import { state } from "../state.js";
import { validatePlan } from "../core/plan-validation.js";
import { resultMode, SCAN_MODE_META } from "../scan-modes.js";
import { fmtPrice, fmtWon, escapeHtml } from "./format.js";
import { toast } from "./notifications.js";

const KEY = "qar-paper";
export const PAPER_SCHEMA_VERSION = 2;
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
let listEl = null;

function load() {
  try {
    const value = JSON.parse(localStorage.getItem(KEY));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function save(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* 저장 공간 부족 */ }
}

// 화면 버튼과 실제 저장 함수가 함께 쓰는 최종 허용 검사.
export function paperRecordState(result) {
  const plan = result?.plan;
  const checked = validatePlan(plan, result?.direction);
  if (plan?.valid === false || !checked.valid) {
    return {
      allowed: false,
      reason: plan?.validationError || checked.reason || "가격 계획이 올바르지 않아 기록할 수 없습니다.",
    };
  }
  if (result?.provisional) {
    return { allowed: false, reason: "아직 끝나지 않은 봉을 포함한 결과는 기록할 수 없습니다." };
  }
  if (result?.direction !== "long" || resultMode(result) === "pump_fade") {
    return { allowed: false, reason: "하락 예상 결과는 아직 가상 기록 계산이 준비되지 않았습니다." };
  }
  return { allowed: true, reason: null };
}

// 기록 + 진입 이후 마감봉 → LONG 결말.
export function resolveTrade(rec, candles) {
  const startOf = (c) => c.openTime ?? c.time ?? 0;
  const endOf = (c) => c.closeTime ?? startOf(c);
  const now = Date.now();
  const trackingFrom = Number.isFinite(rec.trackingFrom) ? rec.trackingFrom : rec.at;
  const after = (candles || []).filter((c) => startOf(c) >= trackingFrom && endOf(c) <= now);
  const risk = rec.entry - rec.stop;
  const rOf = (price) => (risk > 0 ? (price - rec.entry) / risk : 0);
  for (const candle of after) {
    if (candle.low <= rec.stop) {
      return { status: "loss", exitPx: rec.stop, exitAt: endOf(candle), r: rOf(rec.stop) };
    }
    if (candle.high >= rec.tp2) {
      return { status: "win", exitPx: rec.tp2, exitAt: endOf(candle), r: rOf(rec.tp2) };
    }
  }
  const latest = after[after.length - 1];
  const price = latest ? latest.close : rec.entry;
  return { status: "open", exitPx: price, exitAt: null, r: rOf(price) };
}

function moneyOf(rec, r) {
  const riskPct = (rec.entry - rec.stop) / rec.entry;
  return rec.seed * rec.leverage * riskPct * r;
}

export function recordTrade(result) {
  const permission = paperRecordState(result);
  if (!permission.allowed) {
    toast(permission.reason, "error");
    return false;
  }

  const mode = resultMode(result);
  const list = load();
  const duplicate = list.some((item) =>
    item.schemaVersion === PAPER_SCHEMA_VERSION &&
    item.symbol === result.symbol &&
    item.scanMode === mode &&
    item.status !== "closed");
  if (duplicate) {
    toast(result.symbol + "의 열린 기록이 이미 있습니다.", "info");
    return false;
  }

  const plan = result.plan;
  const at = Date.now();
  const trackingFrom = Math.ceil(at / FOUR_HOURS_MS) * FOUR_HOURS_MS;
  list.unshift({
    schemaVersion: PAPER_SCHEMA_VERSION,
    id: mode + "-" + result.symbol + "-" + at,
    scanMode: mode,
    direction: result.direction,
    provisional: false,
    status: "open",
    symbol: result.symbol,
    at,
    trackingFrom,
    entry: plan.entry,
    stop: plan.invalidation,
    tp2: plan.tp2,
    score: result.score,
    seed: state.settings.seedMoney,
    leverage: state.settings.leverage,
  });
  save(list);
  toast(result.symbol + "을 가상 기록에 추가했습니다.", "success");
  render();
  return true;
}

export function initPaper() {
  listEl = document.getElementById("paper");
  if (!listEl) return;
  listEl.addEventListener("click", (event) => {
    const id = event.target.dataset?.paperDel;
    if (!id) return;
    save(load().filter((item) => item.id !== id));
    render();
  });
  render();
}

function isLegacy(rec) {
  return rec?.schemaVersion !== PAPER_SCHEMA_VERSION || rec?.direction !== "long" || !rec?.scanMode;
}

export async function render() {
  if (!listEl) return;
  const list = load();
  if (!list.length) {
    listEl.innerHTML = '<p class="muted">LONG 결과에서 <b>기록</b>을 누르면 여기에 쌓입니다. 실제 주문은 없습니다.</p>' + paperLimitNote();
    return;
  }
  listEl.innerHTML = '<p class="muted">기록 결과를 확인하는 중…</p>';

  const rows = [];
  let changed = false;
  for (const rec of list) {
    if (isLegacy(rec)) {
      rows.push({ rec, res: { status: "legacy", r: null } });
      continue;
    }
    if (rec.status === "closed" && rec.outcome) {
      rows.push({ rec, res: rec.outcome });
      continue;
    }

    let res;
    try {
      const candles = await getKlines(rec.symbol, "4h", 1000);
      res = resolveTrade(rec, candles);
      if (res.status === "win" || res.status === "loss") {
        rec.status = "closed";
        rec.outcome = res;
        changed = true;
      } else if (rec.status !== "open") {
        rec.status = "open";
        changed = true;
      }
    } catch (error) {
      res = { status: "data-error", r: null, message: error?.message || "자료 확인 실패" };
    }
    rows.push({ rec, res });
  }
  if (changed) save(list);

  const closed = rows.filter((item) => item.res.status === "win" || item.res.status === "loss");
  const open = rows.filter((item) => item.res.status === "open").length;
  const errors = rows.filter((item) => item.res.status === "data-error").length;
  const legacy = rows.filter((item) => item.res.status === "legacy").length;
  const wins = closed.filter((item) => item.res.status === "win").length;
  const totalR = closed.reduce((sum, item) => sum + item.res.r, 0);
  const totalWon = closed.reduce((sum, item) => sum + moneyOf(item.rec, item.res.r), 0);

  const parts = closed.length
    ? ["끝난 기록 " + closed.length + "건", "성공 " + Math.round(wins / closed.length * 100) + "%",
      "합계 " + totalR.toFixed(2) + "R", fmtWon(totalWon)]
    : ["끝난 기록 없음"];
  if (open) parts.push("진행 중 " + open + "건");
  if (errors) parts.push("자료 오류 " + errors + "건");
  if (legacy) parts.push("이전 형식 " + legacy + "건");

  listEl.innerHTML =
    '<p class="paper-summary"><b>' + escapeHtml(parts.join(" · ")) + '</b></p>' +
    '<table class="result-table paper-table">' +
      '<thead><tr><th>스캐너</th><th>종목</th><th>방향</th><th>기록 시각</th><th>점수</th><th>진입</th><th>손절</th><th>목표</th><th>상태</th><th>R</th><th>금액</th><th></th></tr></thead>' +
      '<tbody>' + rows.map(rowHtml).join("") + '</tbody>' +
    '</table>' +
    '<p class="muted">새 기록은 LONG만 지원합니다. 이전 형식 기록은 삭제하지 않지만 결과 합계에서는 뺍니다.</p>' +
    paperLimitNote();
}

function paperLimitNote() {
  return '<p class="warn"><b>가상 기록 한계:</b> 기록 뒤 새로 시작한 4시간봉부터 판정하므로 첫 최대 4시간은 빠질 수 있습니다. 수수료와 실제 체결 가격 차이는 금액에 포함하지 않습니다.</p>';
}

const recAt = (ms) =>
  new Date(ms).toLocaleString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

function rowHtml({ rec, res }) {
  const labels = {
    open: "진행 중",
    win: "목표 도달",
    loss: "손절",
    "data-error": "자료 오류",
    legacy: "이전 형식 · 계산 제외",
  };
  const cls = res.status === "win" ? "up" : res.status === "loss" ? "down" : "muted";
  const supported = Number.isFinite(res.r);
  const money = supported ? moneyOf(rec, res.r) : null;
  const modeLabel = rec.scanMode ? (SCAN_MODE_META[rec.scanMode]?.shortLabel || rec.scanMode) : "-";
  const rText = supported ? (res.r >= 0 ? "+" : "") + res.r.toFixed(2) + "R" : "-";
  const moneyText = money == null ? "-" : (money >= 0 ? "+" : "") + fmtWon(money);
  return '<tr>' +
    '<td>' + escapeHtml(modeLabel) + '</td>' +
    '<td class="sym">' + escapeHtml(rec.symbol || "-") + '</td>' +
    '<td>' + (rec.direction === "long" ? "LONG" : "-") + '</td>' +
    '<td>' + (Number.isFinite(rec.at) ? recAt(rec.at) : "-") + '</td>' +
    '<td>' + (rec.score ?? "-") + '</td>' +
    '<td>' + fmtPrice(rec.entry) + '</td>' +
    '<td>' + fmtPrice(rec.stop) + '</td>' +
    '<td>' + fmtPrice(rec.tp2) + '</td>' +
    '<td class="' + cls + '" title="' + escapeHtml(res.message || "") + '">' + (labels[res.status] || res.status) + '</td>' +
    '<td class="' + (supported ? (res.r >= 0 ? "up" : "down") : "muted") + '">' + rText + '</td>' +
    '<td class="' + (money == null ? "muted" : money >= 0 ? "up" : "down") + '">' + moneyText + '</td>' +
    '<td><button class="btn-mini" data-paper-del="' + escapeHtml(rec.id || "") + '">삭제</button></td>' +
  '</tr>';
}

export default { initPaper, render, recordTrade, resolveTrade, paperRecordState };
