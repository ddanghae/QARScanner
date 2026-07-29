// ui/format.js — 표시용 숫자/문자 포맷 헬퍼. (권장 구조 §4 보조 모듈)

export function fmtPrice(x) {
  if (x == null || isNaN(x)) return "-";
  const a = Math.abs(x);
  let d = 2;
  if (a < 0.001) d = 8;
  else if (a < 0.1) d = 6;
  else if (a < 1) d = 5;
  else if (a < 100) d = 3;
  else d = 2;
  return Number(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function fmtPct(x, digits = 2) {
  if (x == null || isNaN(x)) return "-";
  const sign = x > 0 ? "+" : "";
  return `${sign}${x.toFixed(digits)}%`;
}

// 거래대금 축약: 8.74B, 120.3M
export function fmtVolume(x) {
  if (x == null || isNaN(x)) return "-";
  const a = Math.abs(x);
  if (a >= 1e9) return (x / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return (x / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return (x / 1e3).toFixed(1) + "K";
  return String(Math.round(x));
}

export function fmtTime(ms) {
  if (!ms) return "-";
  const d = new Date(ms);
  return d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// 원화 축약: 1,234원 / 12.3만원 / 1.23억원. 자릿수 세는 걸 사용자에게 시키지 않는다.
export function fmtWon(x) {
  if (x == null || isNaN(x)) return "-";
  const sign = x < 0 ? "-" : "";
  const a = Math.abs(x);
  if (a >= 1e8) return `${sign}${(a / 1e8).toFixed(2)}억원`;
  if (a >= 1e4) return `${sign}${(a / 1e4).toFixed(1)}만원`;
  return `${sign}${Math.round(a).toLocaleString("ko-KR")}원`;
}

// 시드머니를 이 종목에 넣었을 때의 손익 금액.
// 손절/목표는 가격이므로 거리를 비율로 바꿔 시드에 곱한다 — 레버리지 없음(현물 1배 기준).
// 왕복 수수료+슬리피지를 양쪽에서 뺀다(백테스트와 같은 0.2%). 빼지 않으면 둘 다 과대평가된다.
export function planMoney(plan, seed, roundTripPct) {
  if (!plan?.valid || !(seed > 0)) return null;
  const cost = seed * (roundTripPct / 100);
  const lossPct = (plan.entry - plan.invalidation) / plan.entry;
  const gainPct = (plan.tp2 - plan.entry) / plan.entry;
  return {
    loss: -(seed * Math.abs(lossPct) + cost),   // 손절 맞았을 때
    gain: seed * Math.abs(gainPct) - cost,      // 주 목표(tp2) 도달했을 때
    lossPct: Math.abs(lossPct) * 100,
    gainPct: Math.abs(gainPct) * 100,
  };
}

export function pctClass(x) {
  if (x == null) return "";
  return x > 0 ? "up" : x < 0 ? "down" : "";
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

export default { fmtPrice, fmtPct, fmtVolume, fmtTime, pctClass, escapeHtml };
