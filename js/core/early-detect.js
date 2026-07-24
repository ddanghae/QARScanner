// core/early-detect.js — 조기 포착 모드 계산.
// 큰 상승 이전 흔적(변동성 압축 + 거래량 고갈 + 미결제약정 증가)을 4시간봉에서 판정한다.
// 모든 함수는 순수 함수이며 마감 캔들만 사용한다(미래 참조 없음).

// 최근 lookback 봉의 박스(고/저)와 그 안에서의 현재 위치.
export function boxRange(candles, lookback) {
  const n = candles.length;
  if (n < lookback) return null;
  const win = candles.slice(n - lookback);
  let boxHigh = -Infinity, boxLow = Infinity;
  for (const c of win) {
    if (c.high > boxHigh) boxHigh = c.high;
    if (c.low < boxLow) boxLow = c.low;
  }
  const mid = (boxHigh + boxLow) / 2;
  const span = boxHigh - boxLow;
  const price = candles[n - 1].close;
  return {
    boxHigh,
    boxLow,
    boxWidthPct: mid > 0 ? (span / mid) * 100 : 0,
    rangePos: span > 0 ? (price - boxLow) / span : 0,
  };
}

// 볼린저 폭 배열에서 "현재 폭이 최근 lookback 중 몇 %ile 로 좁은가".
// 0 에 가까울수록 압축. 현재보다 작은 값의 개수 비율.
export function squeezePercentile(widths, lookback) {
  const valid = widths.filter((w) => w != null);
  if (valid.length < lookback) return null;
  const win = valid.slice(valid.length - lookback);
  const cur = win[win.length - 1];
  let smaller = 0;
  for (const w of win) if (w < cur) smaller++;
  return (smaller / win.length) * 100;
}

// 최근 recentN 봉 평균 거래량 ÷ 그 이전 priorN 봉 평균 거래량. 낮을수록 고갈.
export function volDryRatio(candles, recentN, priorN) {
  const n = candles.length;
  if (n < recentN + priorN) return null;
  const recent = candles.slice(n - recentN);
  const prior = candles.slice(n - recentN - priorN, n - recentN);
  const avg = (arr) => arr.reduce((s, c) => s + c.volume, 0) / arr.length;
  const prev = avg(prior);
  if (!(prev > 0)) return null;
  return avg(recent) / prev;
}

// OI 시계열(1시간 간격, 과거→현재)에서 변화율 3종.
// change72h: 72시간 변화, change12h: 최근 12시간, prev12h: 그 이전 12시간(가속 비교용).
export function analyzeOi(series) {
  const pct = (from, to) => (from > 0 ? ((to - from) / from) * 100 : null);
  const n = Array.isArray(series) ? series.length : 0;
  const at = (backHours) => (n > backHours ? series[n - 1 - backHours].oi : null);
  const now = n > 0 ? series[n - 1].oi : null;
  const h72 = at(72), h12 = at(12), h24 = at(24);
  return {
    change72h: now != null && h72 != null ? pct(h72, now) : null,
    change12h: now != null && h12 != null ? pct(h12, now) : null,
    prev12h: h12 != null && h24 != null ? pct(h24, h12) : null,
  };
}

// 제외 사유. 없으면 null. OI·펀딩이 null 이면 해당 조건은 건너뛴다.
export function earlyExclusion(m, cfg) {
  const e = cfg.earlyDetect;
  if (m.change24h != null && m.change24h > e.pumpedMaxPct) return "이미 급등";
  if (m.oi.change72h != null && m.oi.change72h <= e.oiDumpPct) return "미결제약정 급감";
  if (m.funding != null && Math.abs(m.funding) > e.fundingMaxAbs) return "펀딩 과열";
  return null;
}

// 3단계 분류. 위 단계부터 판정하고, 어디에도 안 걸리면 null(결과에서 제외).
export function classifyEarlyStage(m, cfg) {
  const e = cfg.earlyDetect;

  // 3단계 돌파 — 박스 상단을 종가로 뚫고, 거래량 급증 + 변동성 확장. 단 아직 초입일 때만.
  if (m.breakoutClose && m.relVol3 >= e.breakoutRelVol && m.atrRising) {
    return m.runFromBreakoutPct <= e.breakoutMaxRunPct
      ? stage(3, "breakout", "3 돌파", "purple")
      : null; // 이미 많이 감 → 추격 방지
  }

  // 1단계 조건(매집)을 먼저 확인. OI 데이터가 없으면 OI 조건은 통과로 간주한다.
  const oiOk = m.oi.change72h == null || m.oi.change72h >= e.oiChangeMinPct;
  const trendOk = m.closeAboveEma200 || m.ema200SlopeOk;
  const accumulation =
    m.boxWidthPct <= e.boxWidthMaxPct &&
    m.squeezePct != null && m.squeezePct <= e.squeezePctMax &&
    m.volDry != null && m.volDry <= e.volDryMax &&
    oiOk && trendOk;
  if (!accumulation) return null;

  // 2단계 임박 — 압축 극단 + 박스 상단 근접 + 거래량 회복 + OI 가속
  const oiAccel = m.oi.change12h != null && m.oi.prev12h != null && m.oi.change12h > m.oi.prev12h;
  if (
    m.squeezePct <= e.squeezePctTight &&
    m.rangePos >= e.rangePosMin &&
    m.relVol3 >= e.relVolMin &&
    oiAccel
  ) {
    return stage(2, "imminent", "2 임박", "yellow");
  }

  return stage(1, "accumulation", "1 매집", "blue");
}

function stage(n, key, label, badge) {
  return { stage: n, key, label, badge };
}

export default { boxRange, squeezePercentile, volDryRatio, analyzeOi, classifyEarlyStage, earlyExclusion };
