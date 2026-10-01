// ui/paper.js — 페이퍼 트레이딩 기록. 실제 주문 없음, 전부 localStorage.
//
// 백테스트는 과거고 이건 미래다. 이 도구 말대로 했으면 실제로 어땠는지 앞으로 쌓인다.
// 3개월쯤 모이면 백테스트 숫자를 믿어도 되는지에 대한 진짜 답이 나온다.
//
// 결과 판정은 기록 시점의 계획(진입·손절·최종 목표) 그대로. 완료된 4시간봉의
// 고·저가로 판정하며, 같은 봉에서 둘 다 닿으면 순서를 모르므로 손절을 먼저 본다.

import { getKlines } from "../api/binance.js";
import { state } from "../state.js";
import { fmtPrice, fmtWon, escapeHtml } from "./format.js";
import { toast } from "./notifications.js";

const KEY = "qar-paper";
let listEl = null;
let renderSequence = 0;
const finalTargetOf = (rec) => rec.tp3 ?? rec.tp2;

function load() {
  try {
    const records = JSON.parse(localStorage.getItem(KEY) || "[]");
    if (!Array.isArray(records) || records.some(row => !row || typeof row !== "object")) throw new Error("일지 형식 오류");
    return records;
  } catch { toast("기존 기록을 읽지 못했습니다. 원본 저장 데이터를 보존합니다.", "error"); return null; }
}
function save(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); return true; }
  catch { toast("기록을 저장하지 못했습니다. 브라우저 저장 공간을 확인하세요.", "error"); return false; }
}

// 순수 함수 — 기록 + 진입 이후 캔들 → 결말. 테스트가 이걸 본다.
// candles 는 진입 시각 이후 마감봉만 들어온다고 가정하지 않는다(여기서 자른다).
export function resolveTrade(rec, candles) {
  // api/binance.js 의 parseKlines 는 openTime/closeTime 을 쓴다(time 아님).
  // 필드 이름을 잘못 보면 조용히 빈 배열이 되어 모든 기록이 영원히 "진행 중" 이 된다.
  const startOf = (c) => c.openTime ?? c.time ?? 0;
  const endOf = (c) => c.closeTime ?? startOf(c);
  const now = Date.now();
  // 기록 이후에 시작한 마감봉만. 진행 중인 봉은 고·저가 아직 안 굳어서 제외한다.
  const after = (candles || []).filter((c) => startOf(c) >= rec.at && endOf(c) <= now);
  const short = rec.direction === "short";
  const finalTarget = finalTargetOf(rec);
  const risk = short ? rec.stop - rec.entry : rec.entry - rec.stop;
  const rOf = (px) => (risk > 0 ? (short ? rec.entry - px : px - rec.entry) / risk : 0);
  for (const c of after) {
    // exitAt 도 startOf 로 읽는다 — 위에서 openTime/closeTime 을 쓰는 이유와 같다.
    // c.time 은 실제 캔들에 없어서 조용히 undefined 가 된다.
    if (short ? c.high >= rec.stop : c.low <= rec.stop)
      return { status: "loss", exitPx: rec.stop, exitAt: startOf(c), r: rOf(rec.stop) };
    if (short ? c.low <= finalTarget : c.high >= finalTarget)
      return { status: "win", exitPx: finalTarget, exitAt: startOf(c), r: rOf(finalTarget) };
  }
  const last = after[after.length - 1];
  return { status: "open", exitPx: last ? last.close : rec.entry, exitAt: null, r: rOf(last ? last.close : rec.entry) };
}

// 금액 = R 배수 × 리스크 금액. 기록 당시의 시드·레버리지를 그대로 쓴다.
function moneyOf(rec, r) {
  const riskPct = Math.abs(rec.entry - rec.stop) / rec.entry;
  return rec.seed * rec.leverage * riskPct * r;
}

function appendRecord(record) {
  const list = load();
  if (!list) return;
  if (list.some((x) => x.symbol === record.symbol && x.status !== "closed")) {
    toast(`${record.symbol} 은 이미 열린 기록이 있습니다.`, "info");
    return;
  }
  list.unshift({ ...record, status: "open", id: `${record.symbol}-${Date.now()}`, at: Date.now(), seed: state.settings.seedMoney, leverage: state.settings.leverage });
  if (!save(list)) return;
  toast(`${record.symbol} 기록했습니다.`, "success");
  render();
}

export function recordTrade(result) {
  const p = result.plan;
  if (!p?.valid) { toast("계획이 유효하지 않아 기록할 수 없습니다.", "error"); return; }
  appendRecord({
    symbol: result.symbol, direction: "long", entry: p.entry, stop: p.invalidation, tp2: p.tp2,
    score: result.score, signals: result.topSignals || [], kind: "legacy",
  });
}

/** Record a pattern candidate for paper-only follow-up. */
export function recordPatternTrade(row) {
  const candidate = row?.entryCandidate;
  if (!candidate?.entryLow || candidate.tp1 == null || candidate.tp2 == null
    || candidate.tp3 == null || candidate.stop == null) {
    toast("진입·무효화·목표가 모두 있는 패턴만 기록할 수 있습니다.", "error");
    return;
  }
  const direction = candidate.direction === "short" ? "short" : "long";
  const entry = direction === "short" ? candidate.entryLow : candidate.entryHigh;
  const pattern = row.patterns?.find((item) => item.id === candidate.patternId);
  appendRecord({
    symbol: row.symbol, direction, entry, stop: candidate.stop,
    tp1: candidate.tp1, tp2: candidate.tp2, tp3: candidate.tp3,
    score: Math.round((candidate.assessment?.overall?.[direction === "short" ? "shortPct" : "longPct"] || candidate.fitScore || 0)),
    signals: [`패턴 · ${candidate.patternName}`, `${candidate.timeframe} · 적합도 ${candidate.fitScore}점`],
    kind: "pattern", patternName: candidate.patternName, patternFamily: pattern?.family || "",
    fitScore: candidate.fitScore, completionPct: candidate.completionPct ?? null,
  });
}

// 신호별 승률. 닫힌 기록만 센다 — 진행 중은 결말을 모르니 분모에 넣으면 승률이 거짓으로 낮아진다.
// 한 기록에 신호 3개면 3개 전부에 계상한다(신호는 배타적이지 않다).
export function signalStats(rows) {
  const byName = new Map();
  for (const { rec, res } of rows) {
    if (res.status === "open") continue;
    for (const name of rec.signals || []) {
      const s = byName.get(name) || { name, n: 0, wins: 0, totalR: 0 };
      s.n++;
      if (res.status === "win") s.wins++;
      s.totalR += res.r;
      byName.set(name, s);
    }
  }
  // 표본 많은 순 — 2건짜리 100% 승률이 맨 위에 오면 오해한다.
  return [...byName.values()].sort((a, b) => b.n - a.n);
}

export function initPaper() {
  listEl = document.getElementById("paper");
  if (!listEl) return;
  listEl.addEventListener("click", (e) => {
    const del = e.target.dataset?.paperDel;
    if (!del) return;
    const list = load();
    if (!list || !save(list.filter((x) => x.id !== del))) return;
    render();
  });
  render();
}

export async function render() {
  if (!listEl) return;
  const sequence = ++renderSequence;
  const list = load();
  if (!list) { listEl.innerHTML = `<p class="muted">기록을 읽지 못했습니다. 원본 저장 데이터는 유지됩니다.</p>`; return; }
  if (!list.length) {
    listEl.innerHTML = `<p class="muted">스캔 결과에서 <b>기록</b> 을 누르면 여기에 쌓입니다. 실제 주문은 없습니다.</p>`;
    return;
  }
  listEl.innerHTML = `<p class="muted">불러오는 중…</p>`;

  const rows = [];
  let changed = false;
  for (const rec of list) {
    let res;
    try {
      if (rec.status === "closed" && rec.outcome) res = rec.outcome;
      else {
        const candles = await getKlines(rec.symbol, "4h", 200);
        res = resolveTrade(rec, candles);
        if (res.status !== "open") { rec.status = "closed"; rec.outcome = res; rec.closeTs = res.exitAt; changed = true; }
      }
    } catch {
      res = { status: "open", exitPx: rec.entry, exitAt: null, r: 0 };
    }
    rows.push({ rec, res });
  }
  if (sequence !== renderSequence) return;
  if (changed) save(list);

  const closed = rows.filter((x) => x.res.status !== "open");
  const wins = closed.filter((x) => x.res.status === "win").length;
  const totalR = closed.reduce((s, x) => s + x.res.r, 0);
  const totalWon = closed.reduce((s, x) => s + moneyOf(x.rec, x.res.r), 0);

  const summary = closed.length
    ? `닫힘 ${closed.length}건 · 승률 ${(wins / closed.length * 100).toFixed(0)}% · 합계 ${totalR.toFixed(2)}R · ${fmtWon(totalWon)}`
    : `닫힌 기록 없음 — 열린 ${rows.length}건`;

  const sig = signalStats(rows);
  const sigHtml = sig.length
    ? `<p class="muted">신호별 — ${sig.map((s) =>
        `${escapeHtml(s.name)} ${s.n}건 ${(s.wins / s.n * 100).toFixed(0)}% ${s.totalR >= 0 ? "+" : ""}${s.totalR.toFixed(1)}R`
      ).join(" · ")}</p>`
    : "";

  listEl.innerHTML = `
    <p class="paper-summary"><b>${escapeHtml(summary)}</b></p>
    ${sigHtml}
    <table class="result-table paper-table">
      <thead><tr><th>종목</th><th>방향</th><th>근거</th><th>기록 시각</th><th>점수</th><th>진입</th><th>손절</th><th>최종 목표</th><th>상태</th><th>R</th><th>금액</th><th></th></tr></thead>
      <tbody>${rows.map(rowHtml).join("")}</tbody>
    </table>
    <p class="muted">완료된 4시간봉 고·저가 기준 · 봉 안에서 손절·최종 목표가 같이 닿으면 손절 우선 · TP1·TP2 분할 익절 및 왕복 비용 미반영</p>`;
}

// 기록은 며칠씩 열려 있으므로 날짜가 있어야 한다 — format.js 의 fmtTime 은 시:분만 준다.
const recAt = (ms) =>
  new Date(ms).toLocaleString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

function rowHtml({ rec, res }) {
  const label = { open: "진행 중", win: "목표 도달", loss: "손절" }[res.status];
  const cls = res.status === "win" ? "up" : res.status === "loss" ? "down" : "muted";
  const money = moneyOf(rec, res.r);
  return `<tr>
    <td class="sym">${escapeHtml(rec.symbol)}</td>
    <td class="${rec.direction === "short" ? "down" : "up"}">${rec.direction === "short" ? "숏" : "롱"}</td>
    <td>${escapeHtml(rec.patternName || (rec.signals || []).slice(0, 2).join(" · ") || "기존 스캐너")}</td>
    <td>${recAt(rec.at)}</td>
    <td>${rec.score}</td>
    <td>${fmtPrice(rec.entry)}</td>
    <td>${fmtPrice(rec.stop)}</td>
    <td>${rec.tp3 != null ? "TP3 " : ""}${fmtPrice(finalTargetOf(rec))}</td>
    <td class="${cls}">${label}</td>
    <td class="${res.r >= 0 ? "up" : "down"}">${res.r >= 0 ? "+" : ""}${res.r.toFixed(2)}R</td>
    <td class="${money >= 0 ? "up" : "down"}">${money >= 0 ? "+" : ""}${fmtWon(money)}</td>
    <td><button class="btn-mini" data-paper-del="${rec.id}">삭제</button></td>
  </tr>`;
}

export default { initPaper, render, recordTrade, recordPatternTrade, resolveTrade, signalStats };
