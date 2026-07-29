// ui/paper.js — 페이퍼 트레이딩 기록. 실제 주문 없음, 전부 localStorage.
//
// 백테스트는 과거고 이건 미래다. 이 도구 말대로 했으면 실제로 어땠는지 앞으로 쌓인다.
// 3개월쯤 모이면 백테스트 숫자를 믿어도 되는지에 대한 진짜 답이 나온다.
//
// 결과 판정은 기록 시점의 계획(진입·손절·목표) 그대로. 4시간봉 마감가로만 판정한다
// — 봉 안에서 손절과 목표가 같이 닿으면 손절을 먼저 본다(봉 내부 순서를 알 수 없다).

import { getKlines } from "../api/binance.js";
import { state } from "../state.js";
import { fmtPrice, fmtWon, escapeHtml } from "./format.js";
import { toast } from "./notifications.js";

const KEY = "qar-paper";
let listEl = null;

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; }
}
function save(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* 용량 초과 무시 */ }
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
  const risk = rec.entry - rec.stop;
  const rOf = (px) => (risk > 0 ? (px - rec.entry) / risk : 0);
  for (const c of after) {
    if (c.low <= rec.stop) return { status: "loss", exitPx: rec.stop, exitAt: c.time, r: rOf(rec.stop) };
    if (c.high >= rec.tp2) return { status: "win", exitPx: rec.tp2, exitAt: c.time, r: rOf(rec.tp2) };
  }
  const last = after[after.length - 1];
  return { status: "open", exitPx: last ? last.close : rec.entry, exitAt: null, r: rOf(last ? last.close : rec.entry) };
}

// 금액 = R 배수 × 리스크 금액. 기록 당시의 시드·레버리지를 그대로 쓴다.
function moneyOf(rec, r) {
  const riskPct = (rec.entry - rec.stop) / rec.entry;
  return rec.seed * rec.leverage * riskPct * r;
}

export function recordTrade(result) {
  const p = result.plan;
  if (!p?.valid) { toast("계획이 유효하지 않아 기록할 수 없습니다.", "error"); return; }
  const list = load();
  if (list.some((x) => x.symbol === result.symbol && x.status !== "closed")) {
    toast(`${result.symbol} 은 이미 열린 기록이 있습니다.`, "info");
    return;
  }
  list.unshift({
    id: `${result.symbol}-${Date.now()}`,
    symbol: result.symbol,
    at: Date.now(),
    entry: p.entry, stop: p.invalidation, tp2: p.tp2,
    score: result.score,
    // 기록 시점의 시드·레버리지를 박아둔다. 나중에 설정을 바꿔도 과거 기록의 금액은 안 흔들린다.
    seed: state.settings.seedMoney, leverage: state.settings.leverage,
  });
  save(list);
  toast(`${result.symbol} 기록했습니다.`, "success");
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
    listEl.innerHTML = `<p class="muted">스캔 결과에서 <b>기록</b> 을 누르면 여기에 쌓입니다. 실제 주문은 없습니다.</p>`;
    return;
  }
  listEl.innerHTML = `<p class="muted">불러오는 중…</p>`;

  const rows = [];
  for (const rec of list) {
    let res;
    try {
      const candles = await getKlines(rec.symbol, "4h", 200);
      res = resolveTrade(rec, candles);
    } catch {
      res = { status: "open", exitPx: rec.entry, exitAt: null, r: 0 };
    }
    rows.push({ rec, res });
  }

  const closed = rows.filter((x) => x.res.status !== "open");
  const wins = closed.filter((x) => x.res.status === "win").length;
  const totalR = closed.reduce((s, x) => s + x.res.r, 0);
  const totalWon = closed.reduce((s, x) => s + moneyOf(x.rec, x.res.r), 0);

  const summary = closed.length
    ? `닫힘 ${closed.length}건 · 승률 ${(wins / closed.length * 100).toFixed(0)}% · 합계 ${totalR.toFixed(2)}R · ${fmtWon(totalWon)}`
    : `닫힌 기록 없음 — 열린 ${rows.length}건`;

  listEl.innerHTML = `
    <p class="paper-summary"><b>${escapeHtml(summary)}</b></p>
    <table class="result-table paper-table">
      <thead><tr><th>종목</th><th>기록 시각</th><th>점수</th><th>진입</th><th>손절</th><th>목표</th><th>상태</th><th>R</th><th>금액</th><th></th></tr></thead>
      <tbody>${rows.map(rowHtml).join("")}</tbody>
    </table>
    <p class="muted">4시간봉 마감가 기준 · 봉 안에서 손절·목표가 같이 닿으면 손절 우선 · 왕복 비용 미반영</p>`;
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
    <td>${recAt(rec.at)}</td>
    <td>${rec.score}</td>
    <td>${fmtPrice(rec.entry)}</td>
    <td>${fmtPrice(rec.stop)}</td>
    <td>${fmtPrice(rec.tp2)}</td>
    <td class="${cls}">${label}</td>
    <td class="${res.r >= 0 ? "up" : "down"}">${res.r >= 0 ? "+" : ""}${res.r.toFixed(2)}R</td>
    <td class="${money >= 0 ? "up" : "down"}">${money >= 0 ? "+" : ""}${fmtWon(money)}</td>
    <td><button class="btn-mini" data-paper-del="${rec.id}">삭제</button></td>
  </tr>`;
}

export default { initPaper, render, recordTrade, resolveTrade };
