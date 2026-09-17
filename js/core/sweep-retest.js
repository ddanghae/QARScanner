// Experimental, causal LONG pattern detector. Thresholds are hypotheses, not fitted probabilities.
import { CONFIG } from "../config.js";

export const SWEEP_DEFAULTS = Object.freeze({ ...CONFIG.sweepRetest });
const H = 3600000, M = 60000;
const avg = a => a.reduce((s, v) => s + v, 0) / a.length;
const low = a => Math.min(...a.map(c => c.low));
const high = a => Math.max(...a.map(c => c.high));
const pct = (a, b) => (a / b - 1) * 100;
const last = a => a[a.length - 1];

// Do not sort or fill holes: duplicated/out-of-order/missing market bars must fail closed.
export function patternCandles(raw, interval, now) {
  const a = (raw || []).filter(c => c.closeTime < now);
  if (!a.length || now - last(a).closeTime > interval + 2000) return null;
  for (let i = 0; i < a.length; i++) {
    const c = a[i];
    if (![c.open, c.high, c.low, c.close, c.volume, c.openTime, c.closeTime].every(Number.isFinite)
      || c.low <= 0 || c.volume < 0 || c.high < Math.max(c.open, c.close)
      || c.low > Math.min(c.open, c.close) || c.closeTime - c.openTime !== interval - 1
      || (i && c.openTime - a[i - 1].openTime !== interval)) return null;
  }
  return a;
}

// Crash must PRECEDE the base; using the latest 6h return would miss this setup.
export function findSweepBase(raw, now = Date.now(), overrides = {}, beforeTime = Infinity) {
  const cfg = { ...SWEEP_DEFAULTS, ...overrides };
  const a = patternCandles(raw, H, now);
  if (!a) return null;
  for (let end = a.length - 1; end >= cfg.baseMin + 5; end--) {
    if (a[end].closeTime >= beforeTime) continue;
    if (now - a[end].closeTime > cfg.setupHours * H) break;
    for (let n = cfg.baseMax; n >= cfg.baseMin; n--) {
      const start = end - n + 1;
      if (start < 6) continue;
      const crash = a.slice(start - 6, start), base = a.slice(start, end + 1);
      const drop = pct(last(crash).close, crash[0].open);
      const support = low(base), ceiling = high(base);
      const volumeRatio = avg(base.map(c => c.volume)) / avg(crash.map(c => c.volume));
      if (drop <= cfg.crashPct && pct(ceiling, support) <= cfg.baseRangePct
        && Math.abs(pct(last(base).close, base[0].open)) <= 3
        && Number.isFinite(volumeRatio) && volumeRatio <= cfg.quietRatio) {
        return { startTime: base[0].openTime, endTime: last(base).closeTime,
          crashTime: crash[0].openTime, drop, bars: n, support, ceiling, volumeRatio };
      }
    }
  }
  return null;
}

function pivotLow(a, i) {
  return i >= 2 && i + 2 < a.length && a[i].low < a[i - 1].low
    && a[i].low <= a[i - 2].low && a[i].low < a[i + 1].low && a[i].low <= a[i + 2].low;
}
function expansion(a, i, ratio) {
  const baseline = a.slice(i - 20, i);
  return baseline.length === 20 && avg(baseline.map(c => c.volume)) > 0
    && a[i].close > a[i].open && a[i].volume >= avg(baseline.map(c => c.volume)) * ratio;
}
function ema(a, period) {
  if (a.length < period) return null;
  let value = avg(a.slice(0, period).map(c => c.close));
  for (const c of a.slice(period)) value += 2 / (period + 1) * (c.close - value);
  return value;
}
function confluence(a, reclaim, retest, band) {
  const before = a.slice(0, retest + 1), bar = a[retest];
  const levels = [["EMA20", ema(before, 20)], ["EMA50", ema(before, 50)],
    ["BB 중심선", before.length >= 20 ? avg(before.slice(-20).map(c => c.close)) : null]];
  const session = before.filter(c => Math.floor(c.openTime / (24 * H)) === Math.floor(bar.openTime / (24 * H)));
  const volume = session.reduce((s, c) => s + c.volume, 0);
  levels.push(["UTC 일간 VWAP", volume ? session.reduce((s, c) => s + (c.high + c.low + c.close) / 3 * c.volume, 0) / volume : null]);
  const hits = levels.filter(([, p]) => p !== null && p >= bar.low * (1 - band) && p <= bar.high * (1 + band)).map(([name]) => name);
  for (let i = reclaim + 2; i < retest; i++) {
    const bottom = a[i - 2].high, top = a[i].low;
    if (top > bottom && !a.slice(i + 1, retest).some(c => c.low <= bottom)
      && bar.low <= top && bar.high >= bottom) { hits.push("미충족 상승 FVG"); break; }
  }
  // A last bearish candle is only an OB proxy, not proof of institutional orders.
  const ob = a.slice(reclaim, retest).reverse().find(c => c.close < c.open);
  if (ob && bar.low <= ob.open && bar.high >= ob.low) hits.push("마지막 음봉 OB 후보");
  return hits;
}

export function detectSweepRetest({ h1, m15, m5, btc4h, now = Date.now(), config = {} }) {
  const cfg = { ...SWEEP_DEFAULTS, ...config };
  let base = findSweepBase(h1, now, cfg);
  const result = { status: "waiting", stage: base ? 1 : 0, label: "급락·매집 대기",
    reason: "6시간 급락 뒤 20~40시간 저거래량 횡보가 필요합니다.", base, events: [], confluence: [],
    confirmed: false, expiresAt: null };
  const done = (status, label, reason) => ({ ...result, status, label, reason });
  const a = patternCandles(m15, 15 * M, now), b = patternCandles(m5, 5 * M, now);
  if (!base) return result;
  if (!a || !b || a.length < 30 || b.length < 25) return done("unavailable", "자료 보류", "마감봉 부족·누락 또는 오래된 데이터입니다.");
  // Freeze the earliest W that has a preceding 1h base. Finding the base before the
  // first W low prevents the event itself from being absorbed into a later 20h range.
  let second = -1, first = -1;
  for (let j = 4; j + 2 < a.length; j++) {
    if (!pivotLow(a, j)) continue;
    for (let i = j - 4; i >= Math.max(2, j - 40); i--) {
      if (!pivotLow(a, i)) continue;
      if (a[j].low < a[i].low * (1 - cfg.sweepDepthPct / 100)
        || a[j].low > a[i].low * (1 + cfg.defendPct / 100)) continue;
      const precedingBase = findSweepBase(h1, now, cfg, a[i].openTime);
      if (!precedingBase || Math.abs(pct(a[i].low, precedingBase.support)) > cfg.defendPct) continue;
      base = precedingBase;
      first = i; second = j; break;
    }
    if (second >= 0) break;
  }
  result.base = base;
  result.stage = 1;
  result.events = [{ label: "급락", time: base.crashTime }, { label: "매집 완료", time: base.endTime }];
  result.expiresAt = base.endTime + cfg.setupHours * H;
  if (second < 0) return done("waiting", "W·스윕 대기", "15분봉 두 번째 저점의 스윕 또는 방어를 기다립니다.");
  const support = Math.max(base.support, a[first].low), neckline = high(a.slice(first + 1, second));
  const swept = a[second].low < support;
  result.levels = { support, neckline, sweepLow: a[second].low };
  result.events.push({ label: "W 첫 저점", time: a[first].closeTime },
    { label: swept ? "저점 스윕" : "저점 방어", time: a[second].closeTime });
  let reclaim = -1;
  for (let i = second; i <= Math.min(second + cfg.reclaimBars - 1, a.length - 1); i++) {
    if (a[i].close >= support) { reclaim = i; break; }
  }
  if (reclaim < 0) return done("invalid", "회수 실패", "3개 15분봉 이내에 전저점을 회수하지 못했습니다.");
  result.stage = 2;
  result.events.push({ label: "전저점 회수", time: a[reclaim].closeTime });
  if (a.slice(reclaim + 1).some(c => c.close < support || c.low < a[second].low)
    || b.some(c => c.openTime > a[reclaim].closeTime && (c.close < support || c.low < a[second].low)))
    return done("invalid", "저점 재이탈", "회수 뒤 전저점 종가 이탈 또는 스윕 저점 갱신이 발생했습니다.");
  let breakout = -1;
  // Pivot becomes observable only after two RIGHT bars close; no retrospective triggers.
  for (let i = Math.max(reclaim + 1, second + 2); i < a.length; i++) {
    if (a[i].close > neckline) { breakout = i; break; }
  }
  if (breakout < 0) return done("waiting", "넥라인 돌파 대기", "W 넥라인 종가 돌파로 구조전환을 확인합니다.");
  if (!expansion(a, breakout, cfg.volumeRatio)) return done("invalid", "거래량 없는 돌파", "첫 넥라인 돌파에 상승 거래량 확대가 없습니다.");
  result.stage = 3;
  result.events.push({ label: "넥라인 돌파·거래량 확대", time: a[breakout].closeTime });
  const band = cfg.retestBandPct / 100;
  let retest = -1, peak = a[breakout].high;
  for (let i = breakout + 1; i < a.length; i++) {
    // First meaningful retracement, even if it never reaches the neckline.
    if (a[i].low <= peak - (peak - a[second].low) * 0.25) { retest = i; break; }
    peak = Math.max(peak, a[i].high);
  }
  if (retest < 0) return done("waiting", "첫 눌림 대기", "돌파봉 추격 없이 첫 되돌림을 기다립니다.");
  if (a[retest].low > neckline * (1 + band)) return done("invalid", "눌림 위치 불일치", "첫 되돌림이 넥라인 근처에 오지 않았습니다. 다음 눌림을 첫 눌림으로 재사용하지 않습니다.");
  if (a[retest].low <= a[second].low || a[retest].close < neckline * (1 - band))
    return done("invalid", "눌림 방어 실패", "Higher Low 또는 넥라인 방어가 무너졌습니다.");
  result.stage = 4;
  result.events.push({ label: "첫 눌림 후보", time: a[retest].closeTime });
  result.confluence = confluence(a, reclaim, retest, band);
  let resumed = false;
  for (const c of a.slice(retest + 1)) {
    if (resumed && c.low <= neckline * (1 + band)) return done("invalid", "두 번째 눌림", "첫 눌림 뒤 재상승 이후의 재접근은 제외합니다.");
    if (c.close > peak) resumed = true;
    if (c.close < neckline * (1 - band)) return done("invalid", "넥라인 재이탈", "첫 눌림 이후 넥라인 방어에 실패했습니다.");
  }
  let trigger = -1;
  for (let i = 20; i < b.length; i++) {
    if (b[i].openTime <= a[retest].closeTime) continue;
    if (b[i].close > high(b.slice(i - 5, i)) && expansion(b, i, cfg.volumeRatio)) { trigger = i; break; }
  }
  if (trigger < 0) return done("waiting", "5분봉 확인 대기", "첫 눌림 마감 이후 5분봉 직전 5봉 고점 돌파와 거래량 재증가를 기다립니다.");
  result.events.push({ label: "5분 구조전환·거래량", time: b[trigger].closeTime });
  result.expiresAt = Math.min(result.expiresAt, b[trigger].closeTime + cfg.triggerMinutes * M);
  if (now >= result.expiresAt) return done("expired", "확인 신호 만료", "최초 5분봉 확인 후 15분 경과. 재진입 신호로 연장하지 않습니다.");
  if (last(b).close > neckline * (1 + band * 3) || last(b).close < neckline * (1 - band)
    || b.slice(trigger + 1).some(c => c.low < a[retest].low))
    return done("invalid", "추격·HL 이탈 제외", "현재 가격이 눌림 구간에서 멀어졌거나 Higher Low를 이탈했습니다.");
  const btc = patternCandles(btc4h, 4 * H, now);
  if (!btc || btc.length < 2) return done("unavailable", "BTC 확인 보류", "BTC 마감 4시간봉이 없거나 오래되어 최종 확정을 보류합니다.");
  result.btcChange = pct(last(btc).close, btc[btc.length - 2].close);
  if (result.btcChange <= cfg.btcDropPct) return done("blocked", "BTC 급락 제외", "BTC 최근 마감 4시간 수익률이 -3% 이하입니다.");
  result.stage = 5;
  result.confirmed = true;
  return done("confirmed", "첫 눌림 검토 후보", "패턴 순서 충족. 실제 매수 신호나 수익 보장이 아닙니다.");
}

export function buildSweepResult(item, data) {
  const pattern = detectSweepRetest(data);
  if (!pattern.base) return null;
  const bars = patternCandles(data.h1, H, data.now), price = last(patternCandles(data.m5, 5 * M, data.now) || bars).close;
  return { ...item, scanMode: "sweep_retest", direction: "long", price,
    change6h: bars.length > 6 ? pct(last(bars).close, bars[bars.length - 7].close) : null,
    score: pattern.stage * 20, grade: { key: pattern.confirmed ? "strong" : "watch", label: pattern.label },
    stage: { stage: pattern.stage, label: pattern.label, badge: pattern.confirmed ? "green" : "yellow" },
    absorption: { label: "저거래량 횡보의 대용 지표 · 실제 매집 주체는 확인 불가" },
    topSignals: [pattern.reason, `과거 급락 ${pattern.base.drop.toFixed(1)}% · 횡보 ${pattern.base.bars}시간`,
      ...pattern.confluence], sweepRetest: pattern, timeframes: {}, penalties: [],
    breakdown: [1, 2, 3, 4, 5].map((stage, i) => ({ key: `pattern${stage}`,
      label: ["급락·매집", "W·회수", "구조전환", "첫 눌림", "5분봉·BTC 확인"][i], hit: pattern.stage >= stage,
      got: pattern.stage >= stage ? 1 : 0, weight: 1 })),
    // Detection is deliberately separate from execution/risk sizing. No invented profit targets.
    plan: { valid: false, entry: null, invalidation: pattern.levels?.sweepLow ?? null,
      tp1: null, tp2: null, tp3: null, rrText: "계획 미산출", note: "패턴 탐지 전용입니다. 진입·목표·포지션 크기는 산출하지 않으며 자동 주문하지 않습니다." },
  };
}
