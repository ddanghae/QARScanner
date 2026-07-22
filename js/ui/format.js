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
