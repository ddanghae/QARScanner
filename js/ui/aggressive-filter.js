// Display-only refinement; does not change detection or turn evidence into probabilities.
import { currentRetestSignal } from "../core/trend-retest.js";
export const FILTER_LEVELS = [["all", "전체"], ["aligned", "방향 일치"], ["plan", "타점 조건"], ["near", "타점 근접"]];
const durations = { "5m":300000, "15m":900000, "1h":3600000, "4h":14400000 };
const number = value => typeof value === "number" && Number.isFinite(value);
function fresh(row, tf, now) {
  const at = row.candleTimeByTimeframe?.[tf];
  return number(at) && at < now && now - at <= (durations[tf] || 0) + 2000;
}
export function passesAggressiveFilter(row, level, tab, now = Date.now()) {
  if (level === "all" || row.scanProfile !== "aggressive") return true;
  if (tab === "retest") {
    const s = currentRetestSignal(row.trendRetest, now);
    if (!s?.direction || !s.pattern || s.pattern.fitScore < 65 || s.context?.direction !== s.direction
      || !number(s.asOf) || now - s.asOf > 302000 || now < s.asOf || s.status === "expired" || s.status === "invalid") return false;
    if (level === "aligned") return true;
    return s.status === "ready" && !!s.plan && s.plan.netRR >= 1.5 && s.plan.riskPct >= .3 && s.plan.riskPct <= 8;
  }
  const candidate = row.entryCandidate;
  const direction = tab === "early" ? row.earlyObservation?.direction
    : tab === "fractal" ? (row.fractalContinuation?.pattern?.bias === "bullish" ? "long"
      : row.fractalContinuation?.pattern?.bias === "bearish" ? "short" : null) : tab;
  if (!["long", "short"].includes(direction) || !candidate?.assessment) return false;
  const share = candidate.assessment.overall?.[direction === "long" ? "longPct" : "shortPct"];
  const bias = direction === "long" ? "bullish" : "bearish";
  const fitting = row.patterns?.some(p => Object.values(p.timeframes || {}).some(d => d.bias === bias && number(d.fitScore) && d.fitScore >= 65));
  if (!(share >= 70) || !fitting || !fresh(row, "1h", now)
    || row.ema200ByTimeframe?.["1h"]?.position !== (direction === "long" ? "above" : "below")) return false;
  if (level === "aligned") return true;
  if (candidate.direction !== direction || !(candidate.fitScore >= 65) || !fresh(row, candidate.timeframe, now)
    || ![candidate.entryLow, candidate.entryHigh, candidate.stop, candidate.target, row.price].every(number)
    || candidate.entryLow <= 0 || candidate.entryHigh < candidate.entryLow) return false;
  const long = direction === "long", entry = long ? candidate.entryHigh : candidate.entryLow;
  const risk = long ? entry - candidate.stop : candidate.stop - entry;
  const reward = long ? candidate.target - entry : entry - candidate.target;
  const cost = entry * .002, riskPct = risk / entry * 100;
  if (risk <= 0 || reward <= 0 || riskPct < .3 || riskPct > 8 || (reward - cost) / (risk + cost) < 1.5
    || (long ? row.price <= candidate.stop || row.price >= candidate.target : row.price >= candidate.stop || row.price <= candidate.target)) return false;
  return level !== "near" || (row.price >= candidate.entryLow && row.price <= candidate.entryHigh
    && ["zone-now", "wait-retest", "wait-pullback"].includes(candidate.state));
}
export function aggressiveFilterHtml(level) {
  return `<div class="aggressive-filter" role="group" aria-label="공격적 결과 추가 필터"><b>한 번 더 걸러내기</b>
    ${FILTER_LEVELS.map(([value,label]) => `<button type="button" class="btn-mini ${level === value ? "selected" : ""}" data-aggressive-filter="${value}" aria-pressed="${level === value}">${label}</button>`).join("")}
    <small>방향 일치: 방향 근거 70%·적합도 65·최신 1시간 EMA200 일치. 타점 조건: 비용 후 RR≥1.5·손절폭 0.3~8%. 타점 근접: 반응/돌파 후 검토 구간 도달. 추세·수급은 자체 전환 확인 규칙 적용. 후보 0개도 정상이며 조건은 승률이 아닙니다.</small></div>`;
}
