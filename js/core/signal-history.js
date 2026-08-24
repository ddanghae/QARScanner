// Scanner history and causal forward-paper outcome helpers.
// This module is pure: no DOM, localStorage, network, or mutable global state.

export const HISTORY_SCHEMA_VERSION = 1;
export const FIVE_MIN_MS = 5 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;
export const EPISODE_GAP_MS = 6 * HOUR_MS;
export const MAX_HISTORY_EVENTS = 500;
export const HISTORY_HORIZONS = Object.freeze({
  "1h": HOUR_MS,
  "6h": 6 * HOUR_MS,
  "24h": 24 * HOUR_MS,
});

const MODES = new Set(["reversal", "early", "pump_fade"]);
const DIRECTIONS = new Set(["long", "short"]);
const CHECKPOINT_KEYS = Object.keys(HISTORY_HORIZONS);
const PLAN_TERMINAL = new Set(["HIT", "STOP", "MISS", "AMBIGUOUS", "INVALID"]);

const finite = (value) => Number.isFinite(value);
const round = (value, digits = 6) => finite(value) ? Number(value.toFixed(digits)) : null;
const numberOrNull = (value) => value == null || value === "" ? null : finite(Number(value)) ? Number(value) : null;
const textOrEmpty = (value) => typeof value === "string" ? value : "";

export function nextFiveMinuteBoundary(timestamp) {
  if (!finite(timestamp) || timestamp < 0) return null;
  return Math.floor(timestamp / FIVE_MIN_MS) * FIVE_MIN_MS + FIVE_MIN_MS;
}

function snapshotPlan(plan = {}) {
  const entry = numberOrNull(plan.entry);
  const stop = numberOrNull(plan.stop ?? plan.invalidation);
  const tp1 = numberOrNull(plan.tp1);
  return {
    entry,
    stop,
    tp1,
    tp2: numberOrNull(plan.tp2),
    tp3: numberOrNull(plan.tp3),
    rrText: textOrEmpty(plan.rrText),
    valid: plan.valid !== false && entry > 0 && stop > 0 && tp1 > 0,
  };
}

function pendingCheckpoint(entryTime, horizonMs) {
  return {
    status: "PENDING",
    endTime: entryTime + horizonMs,
    returnPct: null,
    closePrice: null,
    reason: null,
  };
}

export function createHistoryEvent(result, detectedAt, options = {}) {
  const symbol = textOrEmpty(result?.symbol).trim().toUpperCase();
  const scanMode = textOrEmpty(result?.scanMode || "reversal").toLowerCase();
  const direction = textOrEmpty(result?.direction).toLowerCase();
  const entryTime = nextFiveMinuteBoundary(detectedAt);
  if (!/^[A-Z0-9_]+$/.test(symbol) || !MODES.has(scanMode) || !DIRECTIONS.has(direction) || entryTime == null) return null;

  const provisional = Boolean(options.provisional ?? result?.provisional);
  const plan = snapshotPlan(result?.plan);
  const id = `${detectedAt}:${symbol}:${scanMode}:${direction}:${provisional ? "p" : "c"}`;
  return {
    version: HISTORY_SCHEMA_VERSION,
    id,
    symbol,
    baseAsset: textOrEmpty(result?.baseAsset),
    scanMode,
    direction,
    detectedAt,
    lastSeenAt: detectedAt,
    seenCount: 1,
    provisional,
    signal: {
      price: numberOrNull(result?.price),
      score: numberOrNull(result?.score),
      stage: {
        value: numberOrNull(result?.stage?.stage),
        label: textOrEmpty(result?.stage?.label),
        badge: textOrEmpty(result?.stage?.badge),
      },
      grade: {
        key: textOrEmpty(result?.grade?.key),
        label: textOrEmpty(result?.grade?.label),
      },
      change6h: numberOrNull(result?.change6h),
      change24h: numberOrNull(result?.change24h),
      quoteVolume: numberOrNull(result?.quoteVolume),
      plan,
    },
    paper: {
      entryTime,
      entryPrice: null,
      checkpoints: Object.fromEntries(
        CHECKPOINT_KEYS.map((key) => [key, pendingCheckpoint(entryTime, HISTORY_HORIZONS[key])]),
      ),
      mfePct: null,
      maePct: null,
      planOutcome: {
        status: plan.valid ? "PENDING" : "INVALID",
        resolvedAt: null,
        reason: plan.valid ? null : "SIGNAL_PLAN_INVALID",
      },
      status: "PENDING",
      lastAttemptAt: null,
      updatedAt: null,
    },
  };
}

export function isHistoryEvent(event) {
  return event?.version === HISTORY_SCHEMA_VERSION
    && typeof event.id === "string"
    && typeof event.symbol === "string"
    && /^[A-Z0-9_]+$/.test(event.symbol)
    && MODES.has(event.scanMode)
    && DIRECTIONS.has(event.direction)
    && finite(event.detectedAt)
    && event.detectedAt >= 0
    && finite(event.lastSeenAt)
    && event.lastSeenAt >= event.detectedAt
    && finite(event?.paper?.entryTime)
    && event.paper.entryTime === nextFiveMinuteBoundary(event.detectedAt);
}

export function sanitizeHistoryEvents(events, maxEvents = MAX_HISTORY_EVENTS) {
  const limit = Math.max(1, Math.floor(maxEvents) || MAX_HISTORY_EVENTS);
  const byId = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    if (!isHistoryEvent(event) || byId.has(event.id)) continue;
    byId.set(event.id, event);
  }
  return [...byId.values()]
    .sort((a, b) => b.detectedAt - a.detectedAt || a.id.localeCompare(b.id))
    .slice(0, limit);
}

export function mergeScanResults(existingEvents, results, detectedAt, options = {}) {
  const gapMs = finite(options.episodeGapMs) ? Math.max(0, options.episodeGapMs) : EPISODE_GAP_MS;
  const maxEvents = options.maxEvents ?? MAX_HISTORY_EVENTS;
  const provisional = Boolean(options.provisional);
  const events = sanitizeHistoryEvents(existingEvents, maxEvents).slice();
  const seenBatchKeys = new Set();
  let created = 0;
  let updated = 0;
  let ignored = 0;

  for (const result of Array.isArray(results) ? results : []) {
    const candidate = createHistoryEvent(result, detectedAt, {
      provisional: result?.provisional ?? provisional,
    });
    if (!candidate) { ignored++; continue; }
    const batchKey = `${candidate.symbol}:${candidate.scanMode}:${candidate.direction}:${candidate.provisional}`;
    if (seenBatchKeys.has(batchKey)) { ignored++; continue; }
    seenBatchKeys.add(batchKey);

    const index = events.findIndex((event) => {
      const gap = detectedAt - event.lastSeenAt;
      return event.symbol === candidate.symbol
        && event.scanMode === candidate.scanMode
        && event.direction === candidate.direction
        && event.provisional === candidate.provisional
        && gap >= 0
        && gap <= gapMs;
    });
    if (index >= 0) {
      const prior = events[index];
      events[index] = {
        ...prior,
        lastSeenAt: detectedAt,
        seenCount: Math.max(1, Number(prior.seenCount) || 1) + 1,
      };
      updated++;
    } else {
      events.push(candidate);
      created++;
    }
  }

  return {
    events: sanitizeHistoryEvents(events, maxEvents),
    created,
    updated,
    ignored,
  };
}

function validCandle(candle) {
  if (!candle || !finite(candle.openTime) || !finite(candle.closeTime)) return false;
  const open = Number(candle.open);
  const high = Number(candle.high);
  const low = Number(candle.low);
  const close = Number(candle.close);
  if (!(open > 0) || !(high > 0) || !(low > 0) || !(close > 0)) return false;
  if (high < Math.max(open, close) || low > Math.min(open, close) || high < low) return false;
  return candle.openTime % FIVE_MIN_MS === 0
    && candle.closeTime >= candle.openTime
    && candle.closeTime < candle.openTime + FIVE_MIN_MS;
}

function orderedClosedCandles(candles, entryTime, now) {
  return (Array.isArray(candles) ? candles : [])
    .filter((candle) => finite(candle?.openTime)
      && candle.openTime >= entryTime
      && candle.openTime < entryTime + HISTORY_HORIZONS["24h"]
      && finite(candle?.closeTime)
      && candle.closeTime < now)
    .slice()
    .sort((a, b) => a.openTime - b.openTime || a.closeTime - b.closeTime);
}

function continuousWindow(candles, startTime, endExclusive) {
  const expectedCount = (endExclusive - startTime) / FIVE_MIN_MS;
  if (!Number.isInteger(expectedCount) || expectedCount <= 0) {
    return { ok: false, candles: [], reason: "INVALID_WINDOW" };
  }
  const window = candles.filter((candle) => candle.openTime >= startTime && candle.openTime < endExclusive);
  if (window.length !== expectedCount) {
    return { ok: false, candles: window, reason: "MISSING_CANDLES" };
  }
  for (let i = 0; i < window.length; i++) {
    if (window[i].openTime !== startTime + i * FIVE_MIN_MS || !validCandle(window[i])) {
      return { ok: false, candles: window, reason: "INVALID_OR_GAPPED_CANDLES" };
    }
  }
  return { ok: true, candles: window, reason: null };
}

export function directionalReturnPct(direction, entryPrice, closePrice) {
  if (!DIRECTIONS.has(direction) || !(entryPrice > 0) || !(closePrice > 0)) return null;
  const value = direction === "long"
    ? (closePrice / entryPrice - 1) * 100
    : (entryPrice / closePrice - 1) * 100;
  return round(value);
}

function evaluateCheckpoint(existing, direction, entryTime, entryPrice, candles, now, horizonMs, entryMismatch) {
  if (existing?.status === "COMPLETE") return existing;
  const endTime = entryTime + horizonMs;
  if (now < endTime) return pendingCheckpoint(entryTime, horizonMs);
  if (!(entryPrice > 0)) {
    return { status: "INCOMPLETE", endTime, returnPct: null, closePrice: null, reason: "ENTRY_CANDLE_MISSING" };
  }
  if (entryMismatch) {
    return { status: "INCOMPLETE", endTime, returnPct: null, closePrice: null, reason: "ENTRY_PRICE_CHANGED" };
  }
  const coverage = continuousWindow(candles, entryTime, endTime);
  if (!coverage.ok) {
    return { status: "INCOMPLETE", endTime, returnPct: null, closePrice: null, reason: coverage.reason };
  }
  const closePrice = Number(coverage.candles[coverage.candles.length - 1].close);
  return {
    status: "COMPLETE",
    endTime,
    returnPct: directionalReturnPct(direction, entryPrice, closePrice),
    closePrice,
    reason: null,
  };
}

function planGeometry(plan, direction, entryPrice) {
  const target = Number(plan?.tp1);
  const stop = Number(plan?.stop ?? plan?.invalidation);
  if (plan?.valid === false || !(target > 0) || !(stop > 0) || !(entryPrice > 0)) return null;
  if (direction === "long" && stop < entryPrice && entryPrice < target) return { target, stop };
  if (direction === "short" && target < entryPrice && entryPrice < stop) return { target, stop };
  return null;
}

function evaluatePlanOutcome(existing, plan, direction, entryTime, entryPrice, candles, now, entryMismatch) {
  if (PLAN_TERMINAL.has(existing?.status)) return existing;
  if (!(entryPrice > 0)) return { status: "PENDING", resolvedAt: null, reason: null };
  if (entryMismatch) return { status: "INCOMPLETE", resolvedAt: null, reason: "ENTRY_PRICE_CHANGED" };
  const geometry = planGeometry(plan, direction, entryPrice);
  if (!geometry) return { status: "INVALID", resolvedAt: null, reason: "PLAN_GEOMETRY_INVALID_AT_PAPER_ENTRY" };

  const horizonEnd = entryTime + HISTORY_HORIZONS["24h"];
  const closedBoundary = Math.floor(now / FIVE_MIN_MS) * FIVE_MIN_MS;
  const availableEnd = Math.min(horizonEnd, closedBoundary);
  if (availableEnd <= entryTime) return { status: "PENDING", resolvedAt: null, reason: null };
  const expectedCount = (availableEnd - entryTime) / FIVE_MIN_MS;
  const available = candles.filter((candle) => candle.openTime >= entryTime && candle.openTime < availableEnd);

  for (let i = 0; i < expectedCount; i++) {
    const candle = available[i];
    if (!candle || candle.openTime !== entryTime + i * FIVE_MIN_MS || !validCandle(candle)) {
      return { status: "INCOMPLETE", resolvedAt: null, reason: "INVALID_OR_GAPPED_CANDLES" };
    }
    const hitTarget = direction === "long" ? candle.high >= geometry.target : candle.low <= geometry.target;
    const hitStop = direction === "long" ? candle.low <= geometry.stop : candle.high >= geometry.stop;
    if (hitTarget && hitStop) {
      return { status: "AMBIGUOUS", resolvedAt: candle.closeTime, reason: "TARGET_AND_STOP_SAME_CANDLE" };
    }
    if (hitTarget) return { status: "HIT", resolvedAt: candle.closeTime, reason: null };
    if (hitStop) return { status: "STOP", resolvedAt: candle.closeTime, reason: null };
  }
  if (available.length !== expectedCount) {
    return { status: "INCOMPLETE", resolvedAt: null, reason: "MISSING_CANDLES" };
  }
  return availableEnd >= horizonEnd
    ? { status: "MISS", resolvedAt: horizonEnd - 1, reason: null }
    : { status: "PENDING", resolvedAt: null, reason: null };
}

function excursions(direction, entryPrice, candles) {
  const maxHigh = Math.max(...candles.map((candle) => Number(candle.high)));
  const minLow = Math.min(...candles.map((candle) => Number(candle.low)));
  if (direction === "long") {
    return {
      mfePct: round(Math.max(0, (maxHigh / entryPrice - 1) * 100)),
      maePct: round(Math.max(0, (1 - minLow / entryPrice) * 100)),
    };
  }
  return {
    mfePct: round(Math.max(0, (1 - minLow / entryPrice) * 100)),
    maePct: round(Math.max(0, (maxHigh / entryPrice - 1) * 100)),
  };
}

export function evaluateHistoryEvent(event, candles5m, now = Date.now()) {
  if (!isHistoryEvent(event) || !finite(now)) return event;
  const entryTime = event.paper.entryTime;
  const candles = orderedClosedCandles(candles5m, entryTime, now);
  const fetchedEntry = candles.find((candle) => candle.openTime === entryTime && validCandle(candle));
  const storedEntryPrice = numberOrNull(event.paper.entryPrice);
  const fetchedEntryPrice = fetchedEntry ? Number(fetchedEntry.open) : null;
  const entryPrice = storedEntryPrice ?? fetchedEntryPrice;
  const entryMismatch = storedEntryPrice != null && fetchedEntryPrice != null
    && Math.abs(storedEntryPrice - fetchedEntryPrice) > Math.max(1e-12, storedEntryPrice * 1e-10);

  const checkpoints = {};
  for (const key of CHECKPOINT_KEYS) {
    checkpoints[key] = evaluateCheckpoint(
      event.paper.checkpoints?.[key],
      event.direction,
      entryTime,
      entryPrice,
      candles,
      now,
      HISTORY_HORIZONS[key],
      entryMismatch,
    );
  }

  let mfePct = event.paper.mfePct ?? null;
  let maePct = event.paper.maePct ?? null;
  if (checkpoints["24h"].status === "COMPLETE" && (mfePct == null || maePct == null)) {
    const coverage = continuousWindow(candles, entryTime, entryTime + HISTORY_HORIZONS["24h"]);
    if (coverage.ok) ({ mfePct, maePct } = excursions(event.direction, entryPrice, coverage.candles));
  }

  const planOutcome = evaluatePlanOutcome(
    event.paper.planOutcome,
    event.signal.plan,
    event.direction,
    entryTime,
    entryPrice,
    candles,
    now,
    entryMismatch,
  );
  const status = checkpoints["24h"].status;
  return {
    ...event,
    paper: {
      ...event.paper,
      entryPrice,
      checkpoints,
      mfePct,
      maePct,
      planOutcome,
      status,
      lastAttemptAt: now,
      updatedAt: now,
    },
  };
}

export function historyEventStatus(event) {
  if (event?.provisional) return "PROVISIONAL";
  const status = event?.paper?.checkpoints?.["24h"]?.status;
  if (status === "COMPLETE") return "COMPLETE";
  if (status === "INCOMPLETE") return "INCOMPLETE";
  return "PENDING";
}

function hasIssue(event) {
  const planStatus = event?.paper?.planOutcome?.status;
  return historyEventStatus(event) === "INCOMPLETE"
    || ["AMBIGUOUS", "INCOMPLETE", "INVALID"].includes(planStatus);
}

export function filterHistoryEvents(events, filters = {}, now = Date.now()) {
  const mode = filters.mode || "all";
  const direction = filters.direction || "all";
  const status = filters.status || "all";
  const period = filters.period || "all";
  const days = period === "7d" ? 7 : period === "30d" ? 30 : period === "90d" ? 90 : null;
  const since = days ? now - days * 24 * HOUR_MS : null;
  return sanitizeHistoryEvents(events).filter((event) => {
    if (mode !== "all" && event.scanMode !== mode) return false;
    if (direction !== "all" && event.direction !== direction) return false;
    if (since != null && event.detectedAt < since) return false;
    if (status === "all") return true;
    if (status === "issue") return !event.provisional && hasIssue(event);
    return historyEventStatus(event).toLowerCase() === status;
  });
}

function average(values) {
  const valid = values.filter(finite);
  return valid.length ? round(valid.reduce((sum, value) => sum + value, 0) / valid.length) : null;
}

export function summarizeHistory(events) {
  const all = sanitizeHistoryEvents(events);
  const confirmed = all.filter((event) => !event.provisional);
  const completed = confirmed.filter((event) => event.paper?.checkpoints?.["24h"]?.status === "COMPLETE"
    && finite(event.paper.checkpoints["24h"].returnPct));
  const returns = completed.map((event) => event.paper.checkpoints["24h"].returnPct).filter(finite);
  const planEvaluable = confirmed.filter((event) => ["HIT", "STOP", "MISS"].includes(event.paper?.planOutcome?.status));
  const hitCount = planEvaluable.filter((event) => event.paper.planOutcome.status === "HIT").length;
  return {
    recordedCount: all.length,
    confirmedCount: confirmed.length,
    completedCount: completed.length,
    positive24hCount: returns.filter((value) => value > 0).length,
    positive24hRate: returns.length ? round(returns.filter((value) => value > 0).length / returns.length) : null,
    average24hReturnPct: average(returns),
    planEvaluableCount: planEvaluable.length,
    tp1BeforeStopRate: planEvaluable.length ? round(hitCount / planEvaluable.length) : null,
    pendingCount: confirmed.filter((event) => historyEventStatus(event) === "PENDING").length,
    incompleteCount: confirmed.filter((event) => hasIssue(event)).length,
    provisionalCount: all.filter((event) => event.provisional).length,
  };
}

export function outcomeRefreshDue(event, now = Date.now(), options = {}) {
  if (!isHistoryEvent(event) || !finite(now)) return false;
  const cooldownMs = finite(options.cooldownMs) ? Math.max(0, options.cooldownMs) : 5 * 60 * 1000;
  if (!options.force && finite(event.paper.lastAttemptAt) && now - event.paper.lastAttemptAt < cooldownMs) return false;
  const entryTime = event.paper.entryTime;
  if (now < entryTime + FIVE_MIN_MS) return false;
  if (!(event.paper.entryPrice > 0)) return true;
  for (const key of CHECKPOINT_KEYS) {
    const checkpoint = event.paper.checkpoints?.[key];
    if (checkpoint?.status === "INCOMPLETE") return true;
    if (checkpoint?.status !== "COMPLETE" && now >= entryTime + HISTORY_HORIZONS[key]) return true;
  }
  return event.paper.planOutcome?.status === "INCOMPLETE";
}

export function historyRangeEnd(event, now = Date.now()) {
  if (!isHistoryEvent(event) || !finite(now)) return null;
  const closedExclusive = Math.floor(now / FIVE_MIN_MS) * FIVE_MIN_MS;
  const horizonExclusive = event.paper.entryTime + HISTORY_HORIZONS["24h"];
  const endExclusive = Math.min(closedExclusive, horizonExclusive);
  return endExclusive > event.paper.entryTime ? endExclusive - 1 : null;
}

function csvCell(value) {
  if (value == null) return "\"\"";
  let text = String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function historyToCsv(events) {
  const headers = [
    "detected_at", "last_seen_at", "symbol", "mode", "direction", "provisional", "seen_count",
    "score", "stage", "signal_price", "paper_entry_time", "paper_entry_price",
    "return_1h_pct", "return_6h_pct", "return_24h_pct", "mfe_24h_pct", "mae_24h_pct",
    "tp1_before_stop", "record_status",
  ];
  const rows = sanitizeHistoryEvents(events).map((event) => [
    new Date(event.detectedAt).toISOString(),
    new Date(event.lastSeenAt).toISOString(),
    event.symbol,
    event.scanMode,
    event.direction,
    event.provisional,
    event.seenCount,
    event.signal?.score,
    event.signal?.stage?.value,
    event.signal?.price,
    new Date(event.paper.entryTime).toISOString(),
    event.paper.entryPrice,
    event.paper.checkpoints?.["1h"]?.returnPct,
    event.paper.checkpoints?.["6h"]?.returnPct,
    event.paper.checkpoints?.["24h"]?.returnPct,
    event.paper.mfePct,
    event.paper.maePct,
    event.paper.planOutcome?.status,
    historyEventStatus(event),
  ]);
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

export function historyJsonPayload(events, exportedAt = Date.now()) {
  return {
    version: HISTORY_SCHEMA_VERSION,
    exportedAt,
    metricNote: "Gross hypothetical forward paper outcomes; excludes fees, funding, slippage, and position sizing.",
    events: sanitizeHistoryEvents(events),
  };
}

export default {
  createHistoryEvent,
  mergeScanResults,
  evaluateHistoryEvent,
  filterHistoryEvents,
  summarizeHistory,
  historyEventStatus,
  outcomeRefreshDue,
  historyRangeEnd,
  historyToCsv,
  historyJsonPayload,
};
