// Deterministic chart-pattern geometry. fitScore describes shape fit, never win probability.
const FAMILY = { continuation: "지속형", reversal: "반전형", harmonic: "하모닉", candlestick: "캔들" };

export function patternFamilyLabel(key) { return FAMILY[key] || key; }

// Completion is a stage estimate: proximity to the pattern trigger, not success probability.
export function patternCompletionPct(pattern, currentPrice) {
  if (pattern?.status === "breakout" || pattern?.status === "reaction") return 100;
  if (pattern?.trigger == null || pattern?.invalidation == null || !Number.isFinite(Number(currentPrice))) return null;
  const trigger = Number(pattern.trigger), invalidation = Number(pattern.invalidation), price = Number(currentPrice);
  const span = Math.abs(trigger - invalidation);
  if (!(span > 0)) return null;
  const proximity = 1 - Math.abs(trigger - price) / span;
  return Math.round(Math.max(0, Math.min(0.95, proximity)) * 100);
}

export function detectChartPatterns(input, options = {}) {
  if (!Array.isArray(input)) return [];
  const bars = input.slice(-240).filter(validBar);
  if (bars.length < 30) return [];
  const atr = calcAtr(bars);
  if (!(atr > 0)) return [];
  const depth = Math.max(2, Math.min(5, Number(options.pivotDepth) || 3));
  const swings = pivots(bars, depth);
  const all = [
    ...flags(bars, atr),
    ...triangles(bars, atr, swings),
    ...wedges(bars, atr, swings),
    ...rectangle(bars, atr, swings),
    ...cupHandle(bars, atr),
    ...reversals(bars, atr, swings),
    ...harmonics(bars, atr, swings),
    ...candles(bars),
  ];
  const best = new Map();
  for (const p of all) if (!best.has(p.id) || best.get(p.id).fitScore < p.fitScore) best.set(p.id, p);
  return [...best.values()].sort((a, b) => b.fitScore - a.fitScore || a.name.localeCompare(b.name));
}

function validBar(c) {
  return c && Number.isFinite(+c.open) && Number.isFinite(+c.high) && Number.isFinite(+c.low)
    && Number.isFinite(+c.close) && +c.low > 0 && +c.high >= +c.low;
}
function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function calcAtr(bars, period = 14) {
  const xs = [];
  for (let i = Math.max(1, bars.length - period); i < bars.length; i++) {
    const c = bars[i], p = bars[i - 1];
    xs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  return mean(xs);
}
function pivots(bars, depth) {
  const out = [];
  for (let i = depth; i < bars.length - depth; i++) {
    let hi = true, lo = true;
    for (let j = i - depth; j <= i + depth; j++) {
      if (i === j) continue;
      if (bars[i].high <= bars[j].high) hi = false;
      if (bars[i].low >= bars[j].low) lo = false;
    }
    if (hi) out.push({ kind: "H", index: i, price: bars[i].high });
    if (lo) out.push({ kind: "L", index: i, price: bars[i].low });
  }
  return out.sort((a, b) => a.index - b.index || a.kind.localeCompare(b.kind));
}
function line(points) {
  const mx = mean(points.map((p) => p.index)), my = mean(points.map((p) => p.price));
  let num = 0, den = 0;
  for (const p of points) { num += (p.index - mx) * (p.price - my); den += (p.index - mx) ** 2; }
  const slope = den ? num / den : 0, intercept = my - slope * mx;
  return { slope, at: (x) => slope * x + intercept };
}
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function make(id, name, family, bias, status, fitScore, more = {}) {
  return { id, name, family, bias, status, fitScore: Math.round(clamp(fitScore, 0, 100)), ...more };
}
function match(value, spec, tol = 0.05) {
  if (!Number.isFinite(value)) return null;
  if (Array.isArray(spec)) {
    const [lo, hi] = spec, miss = value < lo ? lo - value : value > hi ? value - hi : 0;
    if (miss > tol) return null;
    return Math.max(0, 100 - 35 * miss / tol - 7 * Math.abs(value - (lo + hi) / 2) / Math.max(hi - lo, tol));
  }
  const err = Math.abs(value - spec);
  return err <= tol ? Math.max(0, 100 - 32 * err / tol) : null;
}
function breakout(bars, upper, lower, atr) {
  const c = bars[bars.length - 1], prevVol = mean(bars.slice(-21, -1).map((x) => x.volume || 0));
  const relVol = prevVol > 0 ? (c.volume || 0) / prevVol : 1, pad = atr * 0.12;
  if (c.close > upper + pad) return { bias: "bullish", confirmed: true, relVol };
  if (c.close < lower - pad) return { bias: "bearish", confirmed: true, relVol };
  return { bias: "neutral", confirmed: false, relVol };
}

function flags(bars, atr) {
  const out = [], n = bars.length;
  for (let len = 6; len <= 16; len++) {
    const start = n - len, cons = bars.slice(start);
    if (start < 8) continue;
    const top = line(cons.map((c, i) => ({ index: start + i, price: c.high })));
    const bot = line(cons.map((c, i) => ({ index: start + i, price: c.low })));
    const width0 = top.at(start) - bot.at(start), width1 = top.at(n - 1) - bot.at(n - 1);
    if (!(width0 > atr && width1 > 0)) continue;
    const narrowing = width1 / width0 < 0.72, span = len - 1;
    for (let poleLen = 5; poleLen <= 18 && start >= poleLen; poleLen++) {
      const ps = start - poleLen, pole = bars.slice(ps, start), base = bars[ps].close;
      const hi = Math.max(...pole.map((c) => c.high)), lo = Math.min(...pole.map((c) => c.low)), height = hi - lo;
      if (height < Math.max(base * 0.055, atr * 3.5)) continue;
      const up = bars[start - 1].close > base, down = bars[start - 1].close < base;
      const topMove = top.slope * span / atr, botMove = bot.slope * span / atr;
      const parallel = Math.abs(topMove - botMove) <= 1.35, last = bars[n - 1];
      const prevVol = mean(bars.slice(Math.max(0, start - 20), start).map((c) => c.volume || 0));
      const relVol = prevVol ? (last.volume || 0) / prevVol : 1;
      const bullRetrace = (hi - Math.min(...cons.map((c) => c.low))) / height;
      const bearRetrace = (Math.max(...cons.map((c) => c.high)) - lo) / height;
      if (up && bullRetrace >= -0.12 && bullRetrace <= 0.58 && topMove < 0.25 && botMove < 0.35
        && (parallel || narrowing) && last.close >= bot.at(n - 1) - atr * 0.35) {
        const pennant = narrowing, trigger = top.at(n - 1), status = last.close > trigger + atr * 0.12 ? "breakout" : "forming";
        out.push(make(pennant ? "bullish-pennant" : "bullish-flag", pennant ? "상승 페넌트" : "상승 플래그",
          "continuation", "bullish", status, 58 + Math.min(18, height / atr) + Math.max(0, 14 - bullRetrace * 20)
          + (status === "breakout" && relVol >= 1.2 ? 8 : 0), {
            trigger, invalidation: bot.at(n - 1), projection: trigger + height,
            evidence: ["상승 임펄스 " + (height / base * 100).toFixed(1) + "%", "조정폭 " + (bullRetrace * 100).toFixed(0) + "%", "거래량 " + relVol.toFixed(2) + "x"],
          }));
        break;
      }
      if (down && bearRetrace >= -0.12 && bearRetrace <= 0.58 && topMove > -0.35 && botMove > -0.25
        && (parallel || narrowing) && last.close <= top.at(n - 1) + atr * 0.35) {
        const pennant = narrowing, trigger = bot.at(n - 1), status = last.close < trigger - atr * 0.12 ? "breakout" : "forming";
        out.push(make(pennant ? "bearish-pennant" : "bearish-flag", pennant ? "하락 페넌트" : "하락 플래그",
          "continuation", "bearish", status, 58 + Math.min(18, height / atr) + Math.max(0, 14 - bearRetrace * 20)
          + (status === "breakout" && relVol >= 1.2 ? 8 : 0), {
            trigger, invalidation: top.at(n - 1), projection: trigger - height,
            evidence: ["하락 임펄스 " + (height / base * 100).toFixed(1) + "%", "되돌림 " + (bearRetrace * 100).toFixed(0) + "%", "거래량 " + relVol.toFixed(2) + "x"],
          }));
        break;
      }
    }
  }
  return out;
}

// Group the same formation across intervals while preserving each interval's own score and status.
export function groupPatternsByTimeframe(resultsByTimeframe) {
  const grouped = new Map();
  for (const [timeframe, patterns] of Object.entries(resultsByTimeframe || {})) {
    for (const pattern of patterns || []) {
      if (!grouped.has(pattern.id)) {
        const {
          timeframe: _timeframe, status: _status, fitScore: _fitScore, completionPct: _completionPct,
          trigger: _trigger, invalidation: _invalidation, projection: _projection,
          zone: _zone, evidence: _evidence, points: _points, ...identity
        } = pattern;
        grouped.set(pattern.id, { ...identity, timeframes: {} });
      }
      grouped.get(pattern.id).timeframes[timeframe] = { ...pattern, timeframe };
    }
  }
  return [...grouped.values()];
}

function swingLines(bars, swings, maxBars = 65) {
  const cut = bars.length - maxBars;
  const highs = swings.filter((p) => p.kind === "H" && p.index >= cut).slice(-6);
  const lows = swings.filter((p) => p.kind === "L" && p.index >= cut).slice(-6);
  if (highs.length < 3 || lows.length < 3) return null;
  const top = line(highs), bot = line(lows), start = Math.max(highs[0].index, lows[0].index), end = bars.length - 1;
  const top0 = top.at(start), bot0 = bot.at(start), top1 = top.at(end), bot1 = bot.at(end), atr = calcAtr(bars);
  if (!(top0 > bot0 && top1 > bot1 && atr > 0)) return null;
  return { highs, lows, top, bot, start, end, top0, bot0, top1, bot1,
    topMove: top.slope * (end - start) / atr, botMove: bot.slope * (end - start) / atr,
    shrink: (top1 - bot1) / (top0 - bot0) };
}

function triangles(bars, atr, swings) {
  const s = swingLines(bars, swings);
  if (!s || s.shrink < 0.12 || s.shrink > 0.82) return [];
  let name, bias = "neutral", id;
  if (Math.abs(s.topMove) < 0.7 && s.botMove > 0.65) { name = "상승 삼각형"; bias = "bullish"; id = "ascending"; }
  else if (Math.abs(s.botMove) < 0.7 && s.topMove < -0.65) { name = "하락 삼각형"; bias = "bearish"; id = "descending"; }
  else if (s.topMove < -0.55 && s.botMove > 0.55) { name = "대칭 삼각형"; id = "symmetrical"; }
  else return [];
  const b = breakout(bars, s.top1, s.bot1, atr), dir = b.confirmed ? b.bias : bias;
  const height = s.top1 - s.bot1;
  return [make("triangle-" + id, name, "continuation", dir, b.confirmed ? "breakout" : "forming",
    60 + Math.min(20, (1 - s.shrink) * 24) + Math.min(8, s.highs.length + s.lows.length), {
      trigger: dir === "bearish" ? s.bot1 : s.top1, invalidation: dir === "bearish" ? s.top1 : s.bot1,
      projection: dir === "bearish" ? s.bot1 - height : dir === "bullish" ? s.top1 + height : null,
      evidence: ["고점 " + s.highs.length + "회·저점 " + s.lows.length + "회", "수렴 폭 " + (s.shrink * 100).toFixed(0) + "%", "돌파 거래량 " + b.relVol.toFixed(2) + "x"],
    })];
}
function wedges(bars, atr, swings) {
  const s = swingLines(bars, swings);
  if (!s || s.shrink < 0.12 || s.shrink > 0.8) return [];
  let name, bias, id;
  if (s.topMove > 0.45 && s.botMove > s.topMove + 0.3) { name = "상승 쐐기"; bias = "bearish"; id = "rising"; }
  else if (s.botMove < -0.45 && s.topMove > s.botMove + 0.3) { name = "하락 쐐기"; bias = "bullish"; id = "falling"; }
  else return [];
  const b = breakout(bars, s.top1, s.bot1, atr), dir = b.confirmed ? b.bias : bias, width = s.top1 - s.bot1;
  return [make(id + "-wedge", name, "reversal", dir, b.confirmed ? "breakout" : "forming",
    60 + Math.min(20, (1 - s.shrink) * 25) + Math.min(8, s.highs.length + s.lows.length), {
      trigger: dir === "bearish" ? s.bot1 : s.top1, invalidation: dir === "bearish" ? s.top1 : s.bot1,
      projection: dir === "bearish" ? s.bot1 - width : s.top1 + width,
      evidence: ["양쪽 추세선 수렴", "상단 변화 " + s.topMove.toFixed(1) + " ATR", "하단 변화 " + s.botMove.toFixed(1) + " ATR"],
    })];
}
function rectangle(bars, atr, swings) {
  // Freeze the box before the candle being tested for a breakout.
  const win = bars.slice(-33, -1), hi = Math.max(...win.map((c) => c.high)), lo = Math.min(...win.map((c) => c.low)), mid = (hi + lo) / 2, w = hi - lo;
  if (!(mid > 0) || w / mid > 0.12 || w / atr < 3.5 || w / atr > 22) return [];
  const nearby = swings.filter((p) => p.index >= bars.length - 32), tol = Math.max(atr * 0.8, w * 0.1);
  const ht = nearby.filter((p) => p.kind === "H" && Math.abs(p.price - hi) <= tol).length;
  const lt = nearby.filter((p) => p.kind === "L" && Math.abs(p.price - lo) <= tol).length;
  if (ht < 2 || lt < 2) return [];
  const b = breakout(bars, hi, lo, atr), bias = b.confirmed ? b.bias : "neutral";
  return [make("rectangle", "직사각형 박스", "continuation", bias, b.confirmed ? "breakout" : "forming",
    64 + Math.min(20, ht * 3 + lt * 3), {
      trigger: bias === "bearish" ? lo : hi, invalidation: bias === "bearish" ? hi : lo,
      projection: bias === "bearish" ? lo - w : bias === "bullish" ? hi + w : null,
      evidence: ["상단 접촉 " + ht + "회", "하단 접촉 " + lt + "회", "박스 폭 " + (w / mid * 100).toFixed(1) + "%"],
    })];
}

function cupHandle(bars, atr) {
  const n = bars.length, out = [];
  if (n < 60) return out;
  for (let len = 52; len <= Math.min(120, n); len += 4) {
    for (let handleLen = 5; handleLen <= 12; handleLen++) {
      if (len <= handleLen + 30) continue;
      const start = n - len, cupEnd = n - handleLen, cup = bars.slice(start, cupEnd);
      const split = Math.floor(cup.length * 0.32), leftPart = cup.slice(0, split);
      const rightPart = cup.slice(Math.floor(cup.length * 0.68));
      const handle = bars.slice(cupEnd);
      if (!leftPart.length || !rightPart.length || handle.length < 4) continue;
      const hiAt = (items, offset) => {
        const k = items.reduce((best, c, i) => c.high > items[best].high ? i : best, 0);
        return { index: offset + k, price: items[k].high };
      };
      const loAt = (items, offset) => {
        const k = items.reduce((best, c, i) => c.low < items[best].low ? i : best, 0);
        return { index: offset + k, price: items[k].low };
      };
      const leftHi = hiAt(leftPart, start), rightHi = hiAt(rightPart, start + cup.length - rightPart.length);
      const lowBetween = bars.slice(leftHi.index, rightHi.index + 1);
      const trough = loAt(lowBetween, leftHi.index);
      const rim = mean([leftHi.price, rightHi.price]), depth = rim - trough.price;
      const rimTol = Math.max(atr * 1.5, rim * 0.015);
      const handleLow = Math.min(...handle.map((c) => c.low));
      const handlePullback = (rightHi.price - handleLow) / Math.max(depth, atr);
      const nearBottom = lowBetween.filter((c) => c.low <= trough.price + depth * 0.45).length;
      if (Math.abs(leftHi.price - rightHi.price) <= rimTol && depth >= Math.max(atr * 3, rim * 0.07)
        && depth <= rim * 0.42 && nearBottom >= Math.max(3, Math.floor(lowBetween.length * 0.06))
        && handlePullback >= 0.08 && handlePullback <= 0.58) {
        const last = bars[n - 1], status = last.close > rim + atr * 0.12 ? "breakout" : "forming";
        out.push(make("cup-and-handle", "컵 앤 핸들", "continuation", "bullish", status,
          64 + Math.max(0, 16 - Math.abs(leftHi.price - rightHi.price) / rimTol * 10)
            + Math.max(0, 12 - handlePullback * 18), {
            trigger: rim, invalidation: Math.min(...handle.map((c) => c.low)), projection: rim + depth,
            evidence: ["컵 깊이 " + (depth / rim * 100).toFixed(1) + "%", "핸들 되돌림 " + (handlePullback * 100).toFixed(0) + "%"],
          }));
        break;
      }

      const leftLo = loAt(leftPart, start), rightLo = loAt(rightPart, start + cup.length - rightPart.length);
      const highBetween = bars.slice(leftLo.index, rightLo.index + 1);
      const peak = hiAt(highBetween, leftLo.index);
      const floor = mean([leftLo.price, rightLo.price]), invDepth = peak.price - floor;
      const invHandleHigh = Math.max(...handle.map((c) => c.high));
      const invPullback = (invHandleHigh - rightLo.price) / Math.max(invDepth, atr);
      const nearTop = highBetween.filter((c) => c.high >= peak.price - invDepth * 0.45).length;
      if (Math.abs(leftLo.price - rightLo.price) <= Math.max(atr * 1.5, floor * 0.015)
        && invDepth >= Math.max(atr * 3, floor * 0.07) && invDepth <= floor * 0.42
        && nearTop >= Math.max(3, Math.floor(highBetween.length * 0.06))
        && invPullback >= 0.08 && invPullback <= 0.58) {
        const last = bars[n - 1], status = last.close < floor - atr * 0.12 ? "breakout" : "forming";
        out.push(make("inverted-cup-and-handle", "역컵 앤 핸들", "continuation", "bearish", status,
          64 + Math.max(0, 16 - Math.abs(leftLo.price - rightLo.price) / Math.max(atr * 1.5, floor * 0.015) * 10)
            + Math.max(0, 12 - invPullback * 18), {
            trigger: floor, invalidation: Math.max(...handle.map((c) => c.high)), projection: floor - invDepth,
            evidence: ["역컵 깊이 " + (invDepth / floor * 100).toFixed(1) + "%", "핸들 반등 " + (invPullback * 100).toFixed(0) + "%"],
          }));
        break;
      }
    }
  }
  return out;
}

function reversals(bars, atr, swings) {
  const out = [], n = bars.length, pts = swings.filter((p) => p.index >= n - 90);
  for (const kind of ["H", "L"]) {
    const same = pts.filter((p) => p.kind === kind);
    for (const count of [3, 2]) {
      if (same.length < count) continue;
      const group = same.slice(-count);
      if (group[count - 1].index < n - 24) continue;
      const values = group.map((p) => p.price), level = mean(values), tol = Math.max(atr * 1.35, level * 0.012);
      if (Math.max(...values) - Math.min(...values) > tol) continue;
      const reactions = [];
      for (let i = 1; i < count; i++) {
        const part = bars.slice(group[i - 1].index, group[i].index + 1);
        reactions.push(kind === "H" ? Math.min(...part.map((c) => c.low)) : Math.max(...part.map((c) => c.high)));
      }
      const neck = kind === "H" ? Math.min(...reactions) : Math.max(...reactions), depth = kind === "H" ? level - neck : neck - level;
      if (depth < Math.max(atr * 1.6, level * 0.012)) continue;
      const last = bars[n - 1];
      if (kind === "H" ? last.close > level + tol : last.close < level - tol) continue;
      const broke = crossedRecently(bars, neck, kind === "H" ? "below" : "above", group.at(-1).index);
      const near = kind === "H" ? last.close >= neck - depth * 0.5 : last.close <= neck + depth * 0.5;
      if (!near && !broke) continue;
      const triple = count === 3;
      out.push(make((kind === "H" ? "top-" : "bottom-") + (triple ? "triple" : "double"),
        kind === "H" ? (triple ? "삼중 천정" : "이중 천정") : (triple ? "삼중 바닥" : "이중 바닥"),
        "reversal", kind === "H" ? "bearish" : "bullish", broke ? "breakout" : "forming",
        62 + Math.max(0, 18 - (Math.max(...values) - Math.min(...values)) / tol * 18) + (triple ? 5 : 0), {
          trigger: neck, invalidation: kind === "H" ? Math.max(...values) + atr * 0.25 : Math.min(...values) - atr * 0.25,
          projection: kind === "H" ? neck - depth : neck + depth,
          evidence: ["유사 고점/저점 " + count + "회", "넥라인 반응폭 " + (depth / level * 100).toFixed(1) + "%",
            broke ? "종가가 넥라인을 이탈" : "넥라인 이탈 전"],
        }));
      break;
    }
  }
  for (let i = Math.max(0, pts.length - 12); i <= pts.length - 5; i++) {
    const q = pts.slice(i, i + 5), types = q.map((p) => p.kind).join("");
    const bear = types === "HLHLH", bull = types === "LHLHL";
    if (q.length !== 5 || (!bear && !bull) || q[4].index < n - 30 || q[0].index < n - 85) continue;
    const s1 = q[0].price, head = q[2].price, s2 = q[4].price;
    if (bear ? head <= Math.max(s1, s2) : head >= Math.min(s1, s2)) continue;
    const headSize = bear ? head - (s1 + s2) / 2 : (s1 + s2) / 2 - head;
    if (headSize < atr * 1.25 || Math.abs(s1 - s2) > Math.max(atr * 1.6, head * 0.022)) continue;
    const n1 = q[1].price, n2 = q[3].price;
    if (Math.abs(n1 - n2) > Math.max(atr * 2, mean([n1, n2]) * 0.025)) continue;
    const neck = mean([n1, n2]), last = bars[n - 1];
    if (bear ? last.close > head + atr * 0.25 : last.close < head - atr * 0.25) continue;
    const broke = crossedRecently(bars, neck, bear ? "below" : "above", q[4].index);
    const near = bear ? last.close >= neck - headSize * 0.45 : last.close <= neck + headSize * 0.45;
    if (!near && !broke) continue;
    out.push(make(bear ? "head-and-shoulders" : "inverse-head-and-shoulders", bear ? "헤드앤숄더" : "역헤드앤숄더",
      "reversal", bear ? "bearish" : "bullish", broke ? "breakout" : "forming",
      63 + Math.max(0, 16 - Math.abs(s1 - s2) / atr * 5) + Math.max(0, 10 - Math.abs(n1 - n2) / atr * 4), {
        trigger: neck, invalidation: bear ? head + atr * 0.25 : head - atr * 0.25,
        projection: bear ? neck - headSize : neck + headSize,
        evidence: ["머리 높이 " + (headSize / atr).toFixed(1) + " ATR", "어깨 차이 " + (Math.abs(s1 - s2) / atr).toFixed(1) + " ATR",
          broke ? "종가가 넥라인을 이탈" : "넥라인 이탈 전"],
      }));
  }
  return out;
}

function crossedRecently(bars, level, direction, formedAt = 0) {
  const last = bars.at(-1).close;
  if (direction === "below" ? last >= level : last <= level) return false;
  const start = Math.max(1, bars.length - 4, formedAt + 1);
  for (let i = start; i < bars.length; i++) {
    if (direction === "below" && bars[i].close < level && bars[i - 1].close >= level) return true;
    if (direction === "above" && bars[i].close > level && bars[i - 1].close <= level) return true;
  }
  return false;
}

const HARMONICS = [
  { id: "gartley", name: "가틀리", b: 0.618, c: [0.382, 0.886], cd: [1.272, 1.618], d: 0.786 },
  { id: "bat", name: "배트", b: [0.382, 0.5], c: [0.382, 0.886], cd: [1.618, 2.618], d: 0.886 },
  { id: "alternate-bat", name: "얼터네이트 배트", b: 0.382, c: [0.382, 0.886], cd: [2, 3.618], d: 1.13 },
  { id: "butterfly", name: "버터플라이", b: 0.786, c: [0.382, 0.886], cd: [1.618, 2.24], d: 1.272 },
  { id: "crab", name: "크랩", b: [0.382, 0.618], c: [0.382, 0.886], cd: [2.24, 3.618], d: 1.618 },
  { id: "deep-crab", name: "딥 크랩", b: 0.886, c: [0.382, 0.886], cd: [2, 3.618], d: 1.618 },
  { id: "shark", name: "샤크", b: [0.382, 0.618], c: [1.13, 1.618], cd: [1.618, 2.24], d: [0.886, 1.13] },
];
function harmonics(bars, atr, swings) {
  const out = [], n = bars.length, pts = swings.filter((p) => p.index >= n - 90);
  for (let i = Math.max(0, pts.length - 10); i <= pts.length - 5; i++) {
    const q = pts.slice(i, i + 5), types = q.map((p) => p.kind).join("");
    if (q.length !== 5 || (types !== "LHLHL" && types !== "HLHLH") || q[4].index < n - 12 || q[0].index < n - 85) continue;
    const [x, a, b, c, d] = q.map((p) => p.price);
    const xa = Math.abs(a - x), ab = Math.abs(b - a), bc = Math.abs(c - b), cd = Math.abs(d - c), ad = Math.abs(d - a);
    if (Math.min(xa, ab, bc, cd, ad) < atr * 0.8) continue;
    const r = { b: ab / xa, c: bc / ab, cd: cd / bc, d: ad / xa }, bull = types === "LHLHL";
    for (const h of HARMONICS) {
      const fs = [match(r.b, h.b, 0.055), match(r.c, h.c, 0.06), match(r.cd, h.cd, 0.08), match(r.d, h.d, 0.065)];
      if (fs.some((v) => v == null)) continue;
      const close = bars[n - 1].close;
      const invalidation = bull ? Math.min(d, x) - atr * 0.25 : Math.max(d, x) + atr * 0.25;
      if (bull ? close < invalidation : close > invalidation) continue;
      const reacted = bull ? close > d + atr * 0.45 : close < d - atr * 0.45;
      out.push(make("harmonic-" + h.id + "-" + (bull ? "bull" : "bear"), h.name, "harmonic",
        bull ? "bullish" : "bearish", reacted ? "reaction" : "forming", mean(fs), {
          trigger: d, invalidation,
          projection: bull ? d + Math.min(xa * 0.382, atr * 4) : d - Math.min(xa * 0.382, atr * 4),
          zone: { low: d - atr * 0.5, high: d + atr * 0.5 },
          evidence: ["AB/XA " + r.b.toFixed(3), "BC/AB " + r.c.toFixed(3), "CD/BC " + r.cd.toFixed(3), "AD/XA " + r.d.toFixed(3)],
          points: q.map((p, k) => ({ label: ["X", "A", "B", "C", "D"][k], index: p.index, price: p.price })),
        }));
    }
  }
  for (let i = Math.max(0, pts.length - 9); i <= pts.length - 4; i++) {
    const q = pts.slice(i, i + 4), types = q.map((p) => p.kind).join("");
    if (q.length !== 4 || (types !== "LHLH" && types !== "HLHL") || q[3].index < n - 12) continue;
    const [a, b, c, d] = q.map((p) => p.price), ab = Math.abs(b - a), bc = Math.abs(c - b), cd = Math.abs(d - c);
    if (Math.min(ab, bc, cd) < atr * 0.8) continue;
    const r1 = bc / ab, r2 = cd / bc, r3 = cd / ab;
    // Equal AB/CD implies CD/BC is the reciprocal of the BC retracement.
    const fs = [match(r1, [0.382, 0.886], 0.06), match(r2 * r1, 1, 0.12), match(r3, 1, 0.12)];
    if (fs.some((v) => v == null)) continue;
    const bull = types === "HLHL", close = bars[n - 1].close;
    const invalidation = bull ? d - atr * 0.5 : d + atr * 0.5;
    if (bull ? close < invalidation : close > invalidation) continue;
    const reacted = bull ? close > d + atr * 0.45 : close < d - atr * 0.45;
    out.push(make("harmonic-abcd-" + (bull ? "bull" : "bear"), "AB=CD", "harmonic", bull ? "bullish" : "bearish",
      reacted ? "reaction" : "forming", mean(fs), {
        trigger: d, invalidation,
        projection: bull ? d + Math.min(ab * 0.382, atr * 4) : d - Math.min(ab * 0.382, atr * 4),
        zone: { low: d - atr * 0.5, high: d + atr * 0.5 },
        evidence: ["BC/AB " + r1.toFixed(3), "CD/BC " + r2.toFixed(3), "CD/AB " + r3.toFixed(3)],
        points: q.map((p, k) => ({ label: ["A", "B", "C", "D"][k], index: p.index, price: p.price })),
      }));
  }
  return out;
}

function candles(bars) {
  const n = bars.length, c = bars[n - 1], p = bars[n - 2], body = Math.max(Math.abs(c.close - c.open), 1e-12);
  const range = Math.max(c.high - c.low, 1e-12), upper = c.high - Math.max(c.open, c.close), lower = Math.min(c.open, c.close) - c.low;
  const prevBody = Math.abs(p.close - p.open), out = [];
  if (p.close < p.open && c.close > c.open && c.open <= p.close && c.close >= p.open)
    out.push(make("bullish-engulfing", "상승 장악형", "candlestick", "bullish", "reaction", 82, { evidence: ["직전 음봉 실체를 양봉이 감쌈"] }));
  if (p.close > p.open && c.close < c.open && c.open >= p.close && c.close <= p.open)
    out.push(make("bearish-engulfing", "하락 장악형", "candlestick", "bearish", "reaction", 82, { evidence: ["직전 양봉 실체를 음봉이 감쌈"] }));
  if (body / range <= 0.34 && lower >= body * 2 && upper <= body * 0.8 && c.close >= c.open)
    out.push(make("hammer", "망치형", "candlestick", "bullish", "reaction", 75 + Math.min(15, lower / body * 3), { evidence: ["긴 아래꼬리", "작은 실체"] }));
  if (body / range <= 0.34 && upper >= body * 2 && lower <= body * 0.8 && c.close <= c.open)
    out.push(make("shooting-star", "유성형", "candlestick", "bearish", "reaction", 75 + Math.min(15, upper / body * 3), { evidence: ["긴 위꼬리", "작은 실체"] }));
  const a = bars[n - 3], m = bars[n - 2], aBody = Math.abs(a.close - a.open), mBody = Math.abs(m.close - m.open);
  if (a.close < a.open && aBody > mBody * 1.2 && mBody < aBody * 0.55 && c.close > c.open && c.close >= (a.open + a.close) / 2)
    out.push(make("morning-star", "샛별형", "candlestick", "bullish", "reaction", 78, { evidence: ["큰 음봉 뒤 짧은 실체", "종가가 첫 봉 중간 위"] }));
  if (a.close > a.open && aBody > mBody * 1.2 && mBody < aBody * 0.55 && c.close < c.open && c.close <= (a.open + a.close) / 2)
    out.push(make("evening-star", "저녁별형", "candlestick", "bearish", "reaction", 78, { evidence: ["큰 양봉 뒤 짧은 실체", "종가가 첫 봉 중간 아래"] }));
  return out;
}

