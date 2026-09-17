// ui/paper.js — 신호 발생 시점의 계획·시장국면·전망을 고정하는 Forward Paper Ledger.
// 실제 주문은 없으며 localStorage에만 저장한다. 기존 qar-paper 기록도 그대로 읽는다.

import { getKlines } from "../api/binance.js";
import { CONFIG } from "../config.js";
import { state } from "../state.js";
import { fmtPrice, fmtWon, escapeHtml } from "./format.js";
import { toast } from "./notifications.js";

const KEY = "qar-paper";
const SCHEMA_VERSION = 2;
const FORWARD_HOURS = [1, 3, 6, 24];
let listEl = null;

const finite = Number.isFinite;
const directionOf = (rec) => rec?.direction === "short" || (rec?.stop > rec?.entry) ? "short" : "long";
const sideOf = (rec) => directionOf(rec) === "short" ? -1 : 1;
const startOf = (c) => Number(c?.openTime ?? c?.time ?? 0);
const endOf = (c) => Number(c?.closeTime ?? c?.time ?? c?.openTime ?? 0);

function normalizeRecord(rec) {
  if (!rec || typeof rec !== "object") return null;
  return {
    ...rec,
    schemaVersion: rec.schemaVersion ?? 1,
    direction: directionOf(rec),
    status: rec.status || (rec.settlement ? "closed" : "open"),
  };
}

function load() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY));
    return Array.isArray(parsed) ? parsed.map(normalizeRecord).filter(Boolean) : [];
  } catch { return []; }
}

function save(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* 용량 초과 시 기존 기록 유지 */ }
}

function closedAfter(rec, candles, now = Date.now()) {
  return (candles || []).filter((c) => startOf(c) >= rec.at && endOf(c) <= now);
}

export function pathStats(rec, candles, now = Date.now()) {
  const risk = Math.abs(Number(rec.entry) - Number(rec.stop));
  if (!(risk > 0)) return { mfeR: 0, maeR: 0 };
  const side = sideOf(rec);
  let mfeR = 0;
  let maeR = 0;
  for (const c of closedAfter(rec, candles, now)) {
    const favorablePx = side > 0 ? Number(c.high) : Number(c.low);
    const adversePx = side > 0 ? Number(c.low) : Number(c.high);
    if (finite(favorablePx)) mfeR = Math.max(mfeR, ((favorablePx - rec.entry) * side) / risk);
    if (finite(adversePx)) maeR = Math.min(maeR, ((adversePx - rec.entry) * side) / risk);
  }
  return { mfeR, maeR };
}

// 기록 당시 계획과 이후 마감봉으로 결말을 판정한다. 같은 봉에서 양쪽 가격이 닿으면
// 순서를 알 수 없으므로 승패에서 제외할 ambiguous로 보존한다.
export function resolveTrade(rec, candles, now = Date.now()) {
  const risk = Math.abs(Number(rec.entry) - Number(rec.stop));
  const side = sideOf(rec);
  const rOf = (px) => risk > 0 ? ((px - rec.entry) * side) / risk : 0;
  const after = closedAfter(rec, candles, now);
  const stats = pathStats(rec, after, now);

  for (const c of after) {
    const high = Number(c.high), low = Number(c.low);
    const stopHit = side > 0 ? low <= rec.stop : high >= rec.stop;
    const targetHit = side > 0 ? high >= rec.tp2 : low <= rec.tp2;
    const exitAt = endOf(c);
    if (stopHit && targetHit) return { status: "ambiguous", exitPx: null, exitAt, r: null, ...stats };
    if (stopHit) return { status: "loss", exitPx: rec.stop, exitAt, r: rOf(rec.stop), ...stats };
    if (targetHit) return { status: "win", exitPx: rec.tp2, exitAt, r: rOf(rec.tp2), ...stats };
  }
  const last = after[after.length - 1];
  const exitPx = last && finite(Number(last.close)) ? Number(last.close) : rec.entry;
  return { status: "open", exitPx, exitAt: null, r: rOf(exitPx), ...stats };
}

// 1/3/6/24시간 시점의 마감가를 신호 당시 진입가와 비교한다. 거래 방향 기준 R도 함께 남긴다.
export function forwardSnapshots(rec, candles, horizons = FORWARD_HOURS, now = Date.now()) {
  const after = closedAfter(rec, candles, now);
  const risk = Math.abs(Number(rec.entry) - Number(rec.stop));
  const riskPct = risk > 0 && rec.entry > 0 ? risk / rec.entry : null;
  const side = sideOf(rec);
  return horizons.map((hours) => {
    const deadline = rec.at + hours * 60 * 60 * 1000;
    if (now < deadline) return { hours, status: "pending" };
    const eligible = after.filter((c) => endOf(c) <= deadline);
    const candle = eligible[eligible.length - 1];
    if (!candle || !finite(Number(candle.close))) return { hours, status: "unavailable" };
    const price = Number(candle.close);
    const changePct = ((price / rec.entry) - 1) * 100;
    return {
      hours,
      status: "ready",
      at: endOf(candle),
      price,
      changePct,
      directionalR: riskPct > 0 ? (changePct / 100) * side / riskPct : null,
    };
  });
}

export function netRFor(rec, grossR) {
  if (!finite(grossR)) return null;
  const riskPct = Math.abs(Number(rec.entry) - Number(rec.stop)) / Number(rec.entry);
  const costPct = Number(rec.costPct ?? 0) / 100;
  return riskPct > 0 ? grossR - costPct / riskPct : grossR;
}

function moneyOf(rec, netR) {
  if (!finite(netR)) return null;
  const riskPct = Math.abs(rec.entry - rec.stop) / rec.entry;
  return rec.seed * rec.leverage * riskPct * netR;
}

function copyForecast(forecast) {
  if (!forecast || typeof forecast !== "object") return null;
  const { available, up, down, neutral, lead, confidence, horizonHours, thresholdPct, asOf, reason } = forecast;
  return { available, up, down, neutral, lead, confidence, horizonHours, thresholdPct, asOf, reason };
}

function copyRegime(regime) {
  if (!regime || typeof regime !== "object") return null;
  const { available, key, label, bias, volatility, confidence, asOf, reason } = regime;
  return { available, key, label, bias, volatility, confidence, asOf, reason };
}

export function buildPaperRecord(result, settings = state.settings, now = Date.now()) {
  const p = result?.plan;
  if (!p?.valid) return null;
  const direction = result.direction === "short" ? "short" : "long";
  const entry = Number(p.entry), stop = Number(p.invalidation), tp2 = Number(p.tp2);
  const risk = Math.abs(entry - stop);
  if (!(entry > 0) || !(risk > 0) || !finite(tp2)) return null;
  const geometryValid = direction === "long" ? stop < entry && tp2 > entry : stop > entry && tp2 < entry;
  if (!geometryValid) return null;

  return {
    schemaVersion: SCHEMA_VERSION,
    id: `${result.symbol}-${now}`,
    symbol: result.symbol,
    at: now,
    status: "open",
    scanMode: result.scanMode || result.mode || "reversal",
    direction,
    entry,
    stop,
    tp1: finite(Number(p.tp1)) ? Number(p.tp1) : null,
    tp2,
    tp3: finite(Number(p.tp3)) ? Number(p.tp3) : null,
    plannedRR: Math.abs(tp2 - entry) / risk,
    score: Number(result.score),
    stage: result.stage ? { stage: result.stage.stage, label: result.stage.label } : null,
    grade: result.grade ? { key: result.grade.key, label: result.grade.label } : null,
    topSignals: Array.isArray(result.topSignals) ? result.topSignals.slice(0, 5) : [],
    forecast: copyForecast(result.forecast),
    marketRegime: copyRegime(result.marketRegime || state.marketRegime),
    regimeFit: result.regimeFit ? { ...result.regimeFit } : null,
    costPct: CONFIG.tradeCostRoundTripPct,
    seed: Number(settings.seedMoney) || 0,
    leverage: Math.max(1, Number(settings.leverage) || 1),
  };
}

export function recordTrade(result) {
  const rec = buildPaperRecord(result);
  if (!rec) { toast("계획이 유효하지 않아 기록할 수 없습니다.", "error"); return; }
  const list = load();
  if (list.some((x) => x.symbol === result.symbol && x.status !== "closed" && !x.settlement)) {
    toast(`${result.symbol} 은 이미 열린 기록이 있습니다.`, "info");
    return;
  }
  list.unshift(rec);
  save(list);
  toast(`${result.symbol} 신호 시점을 고정 기록했습니다.`, "success");
  render();
}

export function initPaper() {
  listEl = document.getElementById("paper");
  if (!listEl) return;
  listEl.addEventListener("click", (e) => {
    const del = e.target.dataset?.paperDel;
    if (!del) return;
    save(load().filter((x) => x.id !== del));
    render();
  });
  render();
}

export async function render() {
  if (!listEl) return;
  const list = load();
  if (!list.length) {
    listEl.innerHTML = `<p class="muted">스캔 결과에서 <b>기록</b>을 누르면 신호 당시 계획·시장국면·24시간 경로가 여기에 쌓입니다. 실제 주문은 없습니다.</p>`;
    return;
  }
  listEl.innerHTML = `<p class="muted">과거 신호의 실제 경로를 확인하는 중…</p>`;

  const rows = [];
  let changed = false;
  for (const rec of list) {
    let candles = [];
    try { candles = await getKlines(rec.symbol, "1h", 1000); } catch { /* 산출 보류 */ }
    const liveResult = rec.settlement || resolveTrade(rec, candles);
    const snapshots = forwardSnapshots(rec, candles);
    if (!rec.settlement && ["win", "loss", "ambiguous"].includes(liveResult.status)) {
      rec.settlement = {
        status: liveResult.status,
        exitPx: liveResult.exitPx,
        exitAt: liveResult.exitAt,
        grossR: liveResult.r,
        netR: netRFor(rec, liveResult.r),
        mfeR: liveResult.mfeR,
        maeR: liveResult.maeR,
      };
      rec.status = "closed";
      rec.closeTs = liveResult.exitAt;
      changed = true;
    }
    rows.push({ rec, res: rec.settlement || liveResult, snapshots });
  }
  if (changed) save(list);

  const decided = rows.filter((x) => ["win", "loss"].includes(x.res.status));
  const ambiguous = rows.filter((x) => x.res.status === "ambiguous").length;
  const wins = decided.filter((x) => x.res.status === "win").length;
  const totalR = decided.reduce((sum, x) => sum + (x.res.netR ?? netRFor(x.rec, x.res.r) ?? 0), 0);
  const totalWon = decided.reduce((sum, x) => sum + (moneyOf(x.rec, x.res.netR ?? netRFor(x.rec, x.res.r)) ?? 0), 0);
  const open = rows.filter((x) => x.res.status === "open").length;
  const summary = decided.length
    ? `판정 ${decided.length}건 · 승률 ${(wins / decided.length * 100).toFixed(0)}% · 비용 후 ${totalR.toFixed(2)}R · ${fmtWon(totalWon)} · 진행 ${open}건${ambiguous ? ` · 모호 ${ambiguous}건` : ""}`
    : `판정 가능한 기록 없음 · 진행 ${open}건${ambiguous ? ` · 모호 ${ambiguous}건` : ""}`;

  listEl.innerHTML = `
    <p class="paper-summary"><b>${escapeHtml(summary)}</b></p>
    <table class="result-table paper-table">
      <thead><tr><th>종목</th><th>전략·방향</th><th>기록 시각</th><th>시장국면</th><th>계획</th><th>결과</th><th>1·3·6·24h</th><th></th></tr></thead>
      <tbody>${rows.map(rowHtml).join("")}</tbody>
    </table>
    <p class="muted">1시간 마감봉 기준 · 같은 봉에서 손절/목표가가 모두 닿으면 모호 사례로 제외 · 왕복비용 ${CONFIG.tradeCostRoundTripPct}% 반영</p>`;
}

const recAt = (ms) => new Date(ms).toLocaleString("ko-KR", {
  month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});

function forwardText(snapshots) {
  return snapshots.map((s) => {
    if (s.status === "pending") return `${s.hours}h 대기`;
    if (s.status !== "ready") return `${s.hours}h —`;
    const sign = s.changePct >= 0 ? "+" : "";
    return `${s.hours}h ${sign}${s.changePct.toFixed(1)}%`;
  }).join(" · ");
}

function rowHtml({ rec, res, snapshots }) {
  const label = { open: "진행 중", win: "목표 도달", loss: "손절", ambiguous: "동일 봉 모호" }[res.status] || "산출 보류";
  const cls = res.status === "win" ? "up" : res.status === "loss" ? "down" : "muted";
  const netR = res.netR ?? netRFor(rec, res.r);
  const money = moneyOf(rec, netR);
  const outcome = finite(netR)
    ? `${label} · ${netR >= 0 ? "+" : ""}${netR.toFixed(2)}R${finite(money) ? ` · ${money >= 0 ? "+" : ""}${fmtWon(money)}` : ""}`
    : label;
  const mode = { early: "조기", pump_fade: "펌프페이드", reversal: "반등" }[rec.scanMode] || rec.scanMode || "기존";
  const direction = directionOf(rec).toUpperCase();
  const regime = rec.marketRegime?.label || "미기록";
  return `<tr>
    <td class="sym">${escapeHtml(rec.symbol)}</td>
    <td>${escapeHtml(mode)} · ${direction}<br><span class="muted">점수 ${finite(rec.score) ? rec.score : "—"}</span></td>
    <td>${recAt(rec.at)}</td>
    <td>${escapeHtml(regime)}<br><span class="muted">${escapeHtml(rec.regimeFit?.label || "")}</span></td>
    <td>진입 ${fmtPrice(rec.entry)}<br>손절 ${fmtPrice(rec.stop)} · 목표 ${fmtPrice(rec.tp2)}<br><span class="muted">계획 ${finite(rec.plannedRR) ? rec.plannedRR.toFixed(2) : "—"}R</span></td>
    <td class="${cls}">${escapeHtml(outcome)}</td>
    <td class="paper-forward">${escapeHtml(forwardText(snapshots))}</td>
    <td><button class="btn-mini" data-paper-del="${rec.id}">삭제</button></td>
  </tr>`;
}

export default {
  initPaper, render, recordTrade, buildPaperRecord, resolveTrade, forwardSnapshots, pathStats, netRFor,
};
