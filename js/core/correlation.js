// core/correlation.js — 후보끼리 같이 움직이는지 판정.
//
// 화면에 3개가 떠도 셋이 같이 움직이면 분산이 아니라 한 종목에 3배 실은 것이다.
// 4시간봉 종가 수익률의 피어슨 상관을 본다. 마감 캔들만 쓰므로 리페인트 없음.

// 마지막 n+1 개 종가로 만든 n 개 수익률. 표본이 모자라면 null.
export function returnsFrom(candles, n) {
  if (!Array.isArray(candles) || candles.length < n + 1) return null;
  const win = candles.slice(candles.length - (n + 1));
  const out = [];
  for (let i = 1; i < win.length; i++) {
    const prev = win[i - 1].close;
    if (!(prev > 0)) return null;
    out.push((win[i].close - prev) / prev);
  }
  return out;
}

export function pearson(a, b) {
  const n = Math.min(a?.length ?? 0, b?.length ?? 0);
  if (n < 2) return null;
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb = sb / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den > 0 ? num / den : null;
}

// [{ symbol, returns }] → symbol 별 [{ symbol, r }] (상관 높은 순).
// 임계값 미만은 버린다 — 목록이 길어지면 아무도 안 읽는다.
export function correlationMap(series, threshold = 0.7) {
  const map = new Map();
  for (const s of series) map.set(s.symbol, []);
  for (let i = 0; i < series.length; i++) {
    for (let k = i + 1; k < series.length; k++) {
      const r = pearson(series[i].returns, series[k].returns);
      if (r == null || r < threshold) continue;
      map.get(series[i].symbol).push({ symbol: series[k].symbol, r });
      map.get(series[k].symbol).push({ symbol: series[i].symbol, r });
    }
  }
  for (const list of map.values()) list.sort((a, b) => b.r - a.r);
  return map;
}

export default { returnsFrom, pearson, correlationMap };
