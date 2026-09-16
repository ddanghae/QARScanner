import { fmtPrice, escapeHtml } from "./format.js";
import { crtMatchesCandidate } from "../core/crt-tbs.js";

export function crtBadge(r) {
  const c = r.crtTbs;
  if (!c) return "";
  const aligned = crtMatchesCandidate(r);
  const direction = c.direction === "long" ? "LONG" : c.direction === "short" ? "SHORT" : "";
  const label = c.confirmed && !aligned ? "방향 충돌" : c.label;
  return `<span class="badge badge-${aligned ? "green" : "yellow"}" title="${escapeHtml(c.reason || "")} · 마지막 스캔 기준">CRT ${direction} · ${escapeHtml(label)}</span>`;
}

const time = (v) => new Date(v).toLocaleString("ko-KR", { hour12: false });
export function crtSection(r) {
  const c = r.crtTbs;
  if (!c) return "";
  const range = c.range;
  const p = c.plan;
  const conflict = c.direction && c.direction !== r.direction;
  return `<section class="detail-section crt-detail">
    <h3>CRT + TBS <small>4시간 범위 · 5분 확인 · 실험</small></h3>
    ${crtBadge(r)}
    <p>${escapeHtml(c.reason || "산출 보류")}</p>
    ${conflict ? '<p class="warn">기존 후보와 CRT 방향이 다릅니다. ‘CRT + TBS 확인만’ 필터에서는 제외됩니다.</p>' : ""}
    ${range ? `<table class="plan-table">
      <tr><td>기준 4시간 봉 마감</td><td>${time(range.closeTime)}</td></tr>
      <tr><td>상자 위 / 중앙 / 아래</td><td>${fmtPrice(range.high)} / ${fmtPrice(range.mid)} / ${fmtPrice(range.low)}</td></tr>
      <tr><td>마지막 확인 시세</td><td>${time(c.asOf)}</td></tr>
      <tr><td>범위 교체 시각</td><td>${time(range.expiresAt)}</td></tr>
    </table>` : ""}
    ${p ? `<h3>CRT 전용 검토 가격 <small>${p.direction === "long" ? "LONG" : "SHORT"}</small></h3>
    <table class="plan-table">
      <tr><td>진입 검토 기준가 (5분 마감)</td><td>${fmtPrice(p.entry)}</td></tr>
      <tr><td>손절 (스윕 바깥 + 여유)</td><td>${fmtPrice(p.invalidation)}</td></tr>
      <tr><td>손절 손실률 (1배·비용 포함)</td><td class="down">-${p.lossPct.toFixed(2)}%</td></tr>
      <tr><td>목표 1 · 상자 중앙</td><td>${fmtPrice(p.tp1)}</td></tr>
      <tr><td>목표 2 · 상자 반대편</td><td>${fmtPrice(p.tp2)}</td></tr>
      <tr><td>비용 반영 손익비 (목표 2)</td><td>1 : ${p.netRR.toFixed(2)}</td></tr>
    </table>` : ""}
    <p class="plan-note">상자 밖 종가 마감 → 안으로 복귀 → 복귀 봉 반대편 돌파 마감 순서입니다.
    꼬리만 이탈한 경우는 TBS 확인으로 세지 않습니다. 확인은 15분까지만 유효하며 재스캔으로 갱신하세요.
    아래 기존 전략의 진입·손절·기록과는 별도의 검토 계획입니다. CRT 승률은 아직 측정하지 않았으며 24시간 확률에도 가산하지 않습니다.</p>
  </section>`;
}
