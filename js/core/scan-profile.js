// Exploration presets. Candidate breadth is independent of entry/risk guards.
export const SCAN_PROFILES = {
  standard: { label: "기본", minQuoteVolume: 20_000_000, limit: 100, pivotDepth: 3 },
  aggressive: { label: "공격적", minQuoteVolume: 5_000_000, limit: 200, pivotDepth: 2 },
};
export function scanProfile(name) { return SCAN_PROFILES[name] || SCAN_PROFILES.standard; }

export function selectPatternCandidates(items, settings, limit) {
  const excluded = new Set(settings.excluded || []);
  const valid = items.filter(item => !excluded.has(item.symbol));
  if (settings.scanProfile !== "aggressive") return valid.slice(0, limit);
  const selected = new Map();
  const add = (rows, reason, slots) => {
    let added = 0;
    for (const row of rows) {
      if (selected.size >= limit || added >= slots) break;
      if (selected.has(row.symbol)) continue;
      selected.set(row.symbol, { ...row, explorationReason: reason }); added++;
    }
  };
  const byVolume = valid.slice().sort((a,b) => b.quoteVolume-a.quoteVolume);
  add(valid.filter(row => (settings.favorites || []).includes(row.symbol)), "관심 종목", limit);
  add(byVolume, "거래대금", Math.ceil(limit * 0.5));
  add(valid.slice().sort((a,b) => Math.abs(b.change24h)-Math.abs(a.change24h)), "등락 확대", Math.ceil(limit * 0.3));
  add(valid.slice().sort((a,b) => b.count-a.count), "거래활동", limit);
  add(byVolume, "거래대금", limit);
  return [...selected.values()];
}

// A pre-entry watch item. No stop, target, or entry price is invented here.
export function earlyObservation(row) {
  const evidence = [];
  for (const pattern of row.patterns || []) {
    for (const [timeframe, detail] of Object.entries(pattern.timeframes || {})) {
      if (!["5m", "15m"].includes(timeframe) || !["bullish", "bearish"].includes(detail.bias)
        || !Number.isFinite(Number(detail.fitScore)) || Number(detail.fitScore) < 45) continue;
      const direction = detail.bias === "bullish" ? "long" : "short";
      const proximity = Number(detail.completionPct) || 0;
      const stage = detail.status === "breakout" ? "눌림 대기"
        : detail.status === "reaction" ? "돌파 확인" : proximity >= 75 ? "돌파 접근" : "조기 관찰";
      evidence.push({ direction, timeframe, patternName: pattern.name, fitScore: Number(detail.fitScore), stage,
        reason: `${timeframe} ${pattern.name} · 적합도 ${detail.fitScore}점` });
    }
  }
  for (const [timeframe, activity] of Object.entries(row.activityByTimeframe || {})) {
    if (!["5m", "15m"].includes(timeframe) || !activity?.direction) continue;
    if (activity.volumeRatio >= 1.5 || activity.rangeRatio >= 1.5) evidence.push({
      direction: activity.direction, timeframe, stage: "조기 관찰", fitScore: 0,
      reason: `${timeframe} 거래량 ${activity.volumeRatio.toFixed(1)}배 · 봉 변동폭 ${activity.rangeRatio.toFixed(1)}배`,
    });
  }
  evidence.sort((a,b) => b.fitScore-a.fitScore);
  const best = evidence[0];
  if (!best) return null;
  const higher = ["1h", "4h"].filter(tf => {
    const position = row.ema200ByTimeframe?.[tf]?.position;
    return best.direction === "long" ? position === "below" : position === "above";
  });
  return { ...best, warnings: ["조기 관찰 근거이며 진입 조건은 별도로 계산합니다.",
    ...(higher.length ? [`${higher.join("·")} EMA200 반대 방향`] : [])] };
}

export function barActivity(bars) {
  if (!Array.isArray(bars) || bars.length < 22) return null;
  const recent = bars.slice(-21,-1), last=bars.at(-1);
  const volume = recent.reduce((sum,bar) => sum+bar.volume,0)/recent.length;
  const range = recent.reduce((sum,bar) => sum+bar.high-bar.low,0)/recent.length;
  if (!(volume > 0) || !(range > 0) || ![last.volume,last.high,last.low,last.open,last.close].every(Number.isFinite)) return null;
  return { volumeRatio: last.volume/volume, rangeRatio: (last.high-last.low)/range,
    direction: last.close>last.open ? "long" : last.close<last.open ? "short" : null };
}
