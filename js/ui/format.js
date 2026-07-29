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
// 손절/목표는 가격이므로 거리를 비율로 바꿔 포지션 크기(시드 × 레버리지)에 곱한다.
// 왕복 수수료+슬리피지도 명목가 기준이라 같이 배가 된다(백테스트와 같은 0.2%).
//
// 레버리지가 1 을 넘으면 청산이 생긴다. 배수만 곱하고 끝내면 "손절 -38%, 3배면 -114만원"
// 같은 도달 불가능한 숫자를 보여주게 된다 — 그 전에 증거금이 사라져 강제 청산된다.
// liquidated 로 그 경우를 알린다. 배수를 곱하는 것보다 이 판정이 더 중요하다.
export function planMoney(plan, seed, roundTripPct, leverage = 1, mmrPct = 0.5) {
  if (!plan?.valid || !(seed > 0)) return null;
  const lev = Math.max(1, Number(leverage) || 1);
  const notional = seed * lev;
  const cost = notional * (roundTripPct / 100);
  const lossPct = Math.abs((plan.entry - plan.invalidation) / plan.entry) * 100;
  const gainPct = Math.abs((plan.tp2 - plan.entry) / plan.entry) * 100;

  // 증거금이 유지증거금까지 줄어드는 가격 하락폭. 1배면 청산 없음(가격이 0 이 돼야 함).
  const liqDropPct = lev > 1 ? 100 / lev - mmrPct : 100;
  const liquidated = lossPct >= liqDropPct;

  // 격리 마진에서는 증거금보다 더 잃을 수 없다. 배수를 그대로 곱하면 청산 구간에서
  // 도달 불가능한 손실(예: 100만원 넣고 -114만원)이 나온다 — 시드에서 자른다.
  const rawLoss = -(notional * lossPct / 100 + cost);
  const loss = Math.max(rawLoss, -seed);

  return {
    leverage: lev,
    notional,
    loss,                                       // 손절(또는 청산) 맞았을 때
    gain: notional * gainPct / 100 - cost,      // 주 목표(tp2) 도달했을 때 — 위쪽은 청산과 무관
    lossPct, gainPct,
    liqDropPct,
    liqPrice: lev > 1 ? plan.entry * (1 - liqDropPct / 100) : null,
    liquidated,                                  // 손절선이 청산가보다 아래 = 청산이 먼저
    maxSafeLeverage: Math.max(1, Math.floor(100 / (lossPct + mmrPct))),
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
